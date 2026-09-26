import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codexPanelSource, manualRestartMessages, registerCodexCommands, restartInfo, restartServerInteractive, validateName } from '../src/codex/codexCommands';
import { CodexAccountStore } from '../src/codex/codexStore';
import { setLocale, t } from '../src/i18n';
import { LabelStore } from '../src/labels';
import { env, window, commands } from './stubs/vscode';
import type { AccountsPanel } from '../src/accountsPanel';
import type { FromWebview } from '../src/protocol';
import { readSelectedDir, writeSelectedDir } from '../src/codex/codexState';
import { makeTempHome, MemoryMemento, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
before(() => {
  tmp = makeTempHome('codex-commands');
  home = tmp.home;
});
after(() => tmp.restore());

describe('manual restart guidance by editor connection', () => {
  after(() => setLocale('en'));

  for (const locale of ['en', 'zh-cn'] as const) {
    test(`${locale}: local desktop guidance applies even when a server kind is recognized`, () => {
      setLocale(locale);
      for (const kind of ['unknown', 'vscode', 'antigravity', 'vscodium'] as const) {
        const messages = manualRestartMessages(kind, undefined);
        const hint = t('codex.manualRestartHintLocal');
        assert.deepEqual(messages, {
          hint,
          required: t('codex.manualRestartRequiredLocal', { hint }),
          switchConfirm: t('codex.switchConfirmManualLocal', { hint }),
        });
        assert.doesNotMatch(Object.values(messages).join(' '), /WSL|wsl --shutdown/);
      }
    });

    test(`${locale}: WSL guidance preserves each editor's manual method`, () => {
      setLocale(locale);
      const hints = {
        vscode: t('codex.manualRestartHintVscode'),
        unknown: t('codex.manualRestartHintUnknown'),
        antigravity: t('codex.manualRestartHint', { editor: 'Antigravity' }),
        vscodium: t('codex.manualRestartHint', { editor: 'VSCodium' }),
      };
      for (const kind of ['vscode', 'unknown', 'antigravity', 'vscodium'] as const) {
        const hint = hints[kind];
        assert.deepEqual(manualRestartMessages(kind, 'wsl'), {
          hint,
          required: t('codex.manualRestartRequired', { hint }),
          switchConfirm: t('codex.switchConfirmManual', { hint }),
        });
      }
    });

    test(`${locale}: SSH and container windows receive remote guidance`, () => {
      setLocale(locale);
      for (const remoteName of ['ssh-remote', 'dev-container']) {
        const hint = t('codex.manualRestartHintRemote');
        assert.deepEqual(manualRestartMessages('vscode', remoteName), {
          hint,
          required: t('codex.manualRestartRequiredRemote', { hint }),
          switchConfirm: t('codex.switchConfirmManualRemote', { hint }),
        });
      }
    });
  }
});

describe('local selection with manual restart', () => {
  test('local and other remote connections never advertise automatic restart', () => {
    for (const remoteName of [undefined, 'ssh-remote', 'dev-container']) {
      env.remoteName = remoteName;
      assert.deepEqual(restartInfo(), { context: remoteName === undefined ? 'local' : 'remote', auto: false });
    }
    env.remoteName = undefined;
  });

  test('the restart action only shows local instructions', async (ctx) => {
    env.remoteName = undefined;
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => {});
    await restartServerInteractive();
    assert.deepEqual(warning.mock.calls[0].arguments, [manualRestartMessages('unknown', undefined).required]);
    assert.equal(execute.mock.callCount(), 0);
  });

  test('confirmed named/default selections stay pending without changing the running host or quitting', async (ctx) => {
    const fixture = makeTempHome('manual-selection');
    const home = fixture.home;
    env.remoteName = undefined;
    const state = new MemoryMemento();
    const store = new CodexAccountStore(state);
    const labels = new LabelStore(state, 'codex.labels');
    const named = { name: 'manual-test', dir: path.join(home, '.codex-manual-test') };
    const def = { name: 'default', dir: path.join(home, '.codex') };
    fs.mkdirSync(named.dir, { recursive: true });
    fs.mkdirSync(def.dir, { recursive: true });
    await store.add(named);
    let handle!: (message: FromWebview) => Promise<void>;
    let refreshes = 0;
    const panel = {
      setHandler(_mode: string, callback: typeof handle) { handle = callback; },
      resolve(_mode: string, dir: string) { return dir === named.dir ? named : def; },
      refresh() { refreshes++; },
    } as unknown as AccountsPanel;
    const execute = ctx.mock.method(commands, 'executeCommand', async () => {});
    let confirm = false;
    ctx.mock.method(window, 'showWarningMessage', async () => confirm ? t('common.continue') : undefined);
    const disposables = registerCodexCommands({ store, labels, panel, tools: {} });
    const source = codexPanelSource(store, labels);
    try {
      writeSelectedDir(undefined);
      await handle({ type: 'switch', mode: 'codex', dir: named.dir });
      assert.equal(readSelectedDir(), undefined);
      assert.equal(refreshes, 0);
      confirm = true;
      await handle({ type: 'switch', mode: 'codex', dir: named.dir });
      assert.equal(readSelectedDir(), named.dir);
      assert.equal(process.env.CODEX_HOME, undefined);
      assert.equal(source.pendingDir?.(), named.name);
      assert.equal(source.accounts().find((a) => a.dir === named.dir)?.isSelected, true);
      assert.equal(source.accounts().find((a) => a.dir === def.dir)?.isSelected, false);
      // Model a host started with the named account, then select default without modifying that host's environment.
      process.env.CODEX_HOME = named.dir;
      await handle({ type: 'switch', mode: 'codex', dir: def.dir });
      assert.equal(readSelectedDir(), undefined);
      assert.equal(process.env.CODEX_HOME, named.dir);
      assert.equal(source.pendingDir?.(), 'default');
      assert.equal(source.accounts().find((a) => a.dir === named.dir)?.isSelected, false);
      assert.equal(source.accounts().find((a) => a.dir === def.dir)?.isSelected, true);
      assert.equal(refreshes, 2);
      assert.equal(execute.mock.callCount(), 0);
    } finally {
      delete process.env.CODEX_HOME;
      for (const disposable of disposables) disposable.dispose();
      fixture.restore();
    }
  });
});

describe('validateName (Codex)', () => {
  const make = async (): Promise<{ store: CodexAccountStore; labels: LabelStore }> => {
    const memento = new MemoryMemento();
    const store = new CodexAccountStore(memento);
    const labels = new LabelStore(memento, 'codex.labels');
    await store.add({ name: 'a', dir: path.join(home, '.codex-a') });
    await labels.set('a', 'work');
    return { store, labels };
  };

  test('a new valid name passes', async () => {
    const { store, labels } = await make();
    assert.equal(validateName('b-2_X', store, labels), undefined);
  });

  test('empty, invalid characters, the default name, an existing name or display name are rejected', async () => {
    const { store, labels } = await make();
    assert.equal(validateName('', store, labels), t('name.empty'));
    for (const n of ['a b', 'a/b', '..', 'ä']) assert.equal(validateName(n, store, labels), t('name.invalid'), n);
    assert.equal(validateName('default', store, labels), t('name.reserved', { name: 'default' }));
    assert.equal(validateName('a', store, labels), t('name.exists'));
    assert.equal(validateName('work', store, labels), t('name.dupLabel'));
  });

  test('the default name, existing names and display names are compared ignoring case', async () => {
    const { store, labels } = await make();
    assert.equal(validateName('Default', store, labels), t('name.reserved', { name: 'default' }));
    assert.equal(validateName('A', store, labels), t('name.exists'));
    assert.equal(validateName('WORK', store, labels), t('name.dupLabel'));
  });

  test('a name whose directory resolves to ~/.codex is rejected', async () => {
    const { store, labels } = await make();
    const def = path.join(home, '.codex');
    fs.mkdirSync(def);
    fs.symlinkSync(def, path.join(home, '.codex-main'));
    try {
      assert.equal(validateName('main', store, labels), t('name.sameAsDefaultDir'));
    } finally {
      fs.rmSync(path.join(home, '.codex-main'));
      fs.rmSync(def, { recursive: true });
    }
  });
});
