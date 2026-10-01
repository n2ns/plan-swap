import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as path from 'node:path';
import { codexPanelSource, codexRunsInWsl, manualRestartMessages, registerCodexCommands, restartInfo, restartServerInteractive, validateName } from '../src/codex/codexCommands';
import { CodexAccountStore } from '../src/codex/codexStore';
import { setLocale, t } from '../src/i18n';
import { LabelStore } from '../src/labels';
import { env, window, commands, setConfig, type StubTerminal } from './stubs/vscode';
import type { AccountsPanel } from '../src/accountsPanel';
import type { FromWebview, ToWebview } from '../src/protocol';
import { RC_BEGIN, STATE_FILE, installRcBlocks, rcBlock, rcStatus, readSelectedDir, writeSelectedDir } from '../src/codex/codexState';
import { CODEX_DEFAULT_NAME, codexAccountDir, deleteCodexDir, readCodexAccountInfo, type CodexAccount } from '../src/codex/codexPaths';
import { isSharedCodexAccount } from '../src/codex/codexShare';
import { labelFor } from '../src/labels';
import { assertTempHome, inLocale, LINUX_ONLY, makeTempHome, MemoryMemento, read, restoreEnv, snapshot, type TempHome } from './helpers';

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
      inLocale(locale, () => {
        for (const kind of ['unknown', 'vscode', 'antigravity', 'vscodium'] as const) {
          const messages = manualRestartMessages(kind, undefined, false);
          const hint = t('codex.manualRestartHintLocal');
          assert.deepEqual(messages, {
            hint,
            required: t('codex.manualRestartRequiredLocal', { hint }),
            switchConfirm: t('codex.switchConfirmManualLocal', { hint }),
          });
          assert.doesNotMatch(Object.values(messages).join(' '), /WSL|wsl --shutdown/);
        }
      });
    });

    test(`${locale}: WSL guidance preserves each editor's manual method`, () => {
      inLocale(locale, () => {
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
    });

    test(`${locale}: SSH and container windows receive remote guidance`, () => {
      inLocale(locale, () => {
        for (const remoteName of ['ssh-remote', 'dev-container']) {
          const hint = t('codex.manualRestartHintRemote');
          assert.deepEqual(manualRestartMessages('vscode', remoteName), {
            hint,
            required: t('codex.manualRestartRequiredRemote', { hint }),
            switchConfirm: t('codex.switchConfirmManualRemote', { hint }),
          });
        }
      });
    });
  }
});

describe('local selection with manual restart', () => {
  test('local and other remote connections never advertise automatic restart', () => {
    try {
      for (const remoteName of [undefined, 'ssh-remote', 'dev-container']) {
        env.remoteName = remoteName;
        const expected = { context: remoteName === undefined ? 'local' : 'remote', auto: false };
        // Native Windows also reports that the selection lives in the user environment, not in rc files
        assert.deepEqual(restartInfo(), process.platform === 'win32' ? { ...expected, userEnv: true } : expected);
      }
    } finally {
      env.remoteName = undefined;
    }
  });

  test('the restart action only shows local instructions', async (ctx) => {
    env.remoteName = undefined;
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => {});
    await restartServerInteractive();
    assert.deepEqual(warning.mock.calls[0].arguments, [manualRestartMessages('unknown', undefined).required]);
    assert.equal(execute.mock.callCount(), 0);
  });

  test('confirmed named/default selections stay pending without changing the running host or quitting', LINUX_ONLY, async (ctx) => {
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
    ctx.mock.method(window, 'showWarningMessage', async () => confirm ? t('codex.saveSelectionButton') : undefined);
    const disposables = registerCodexCommands({ store, labels, panel, tools: {} });
    const source = codexPanelSource(store, labels);
    const savedCodexHome = process.env.CODEX_HOME;
    try {
      writeSelectedDir(undefined);
      // Not enabled: switching is refused with a warning and nothing changes
      const warnings: unknown[][] = [];
      const refused = ctx.mock.method(window, 'showWarningMessage', async (...args: unknown[]) => (warnings.push(args), undefined));
      confirm = true;
      await handle({ type: 'switch', mode: 'codex', dir: named.dir });
      assert.deepEqual(warnings, [[t('codex.notEnabled')]]);
      assert.equal(readSelectedDir(), undefined);
      refused.mock.restore();
      const selectionWarning = ctx.mock.method(window, 'showWarningMessage', async () => confirm ? t('codex.saveSelectionButton') : undefined);
      confirm = false;
      // Enabled from here on
      installRcBlocks();
      await handle({ type: 'switch', mode: 'codex', dir: named.dir });
      assert.equal(readSelectedDir(), undefined);
      assert.equal(refreshes, 0);
      assert.deepEqual(selectionWarning.mock.calls[0].arguments, [
        manualRestartMessages('unknown', undefined).switchConfirm, { modal: true }, t('codex.saveSelectionButton'),
      ]);
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
      restoreEnv('CODEX_HOME', savedCodexHome);
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
    fs.mkdirSync(def, { recursive: true });
    fs.symlinkSync(def, path.join(home, '.codex-main'), 'junction');
    try {
      assert.equal(validateName('main', store, labels), t('name.sameAsDefaultDir'));
    } finally {
      fs.rmSync(path.join(home, '.codex-main'));
      fs.rmSync(def, { recursive: true });
    }
  });

  test('a name whose directory contains the linked default directory is rejected without changing either tree', () => {
    const fixture = makeTempHome('codex-name-ancestor');
    try {
      const acc = codexAccountDir('work');
      const def = path.join(fixture.home, '.codex');
      const target = path.join(acc, 'sessions', 'main');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'keep.txt'), 'default data');
      fs.symlinkSync(target, def, 'junction');
      const before = snapshot(fixture.home);
      const state = new MemoryMemento();
      const store = new CodexAccountStore(state);
      const labels = new LabelStore(state, 'codex.labels');

      assert.equal(validateName('work', store, labels), t('account.containsDefaultDir', { dir: acc, default: def }));
      assert.deepEqual(snapshot(fixture.home), before);
    } finally {
      fixture.restore();
    }
  });
});

describe('panel message handlers', () => {
  let fx: TempHome;
  let fxHome: string;
  let def: string;
  before(() => {
    fx = makeTempHome('codex-handlers');
    fxHome = fx.home;
    def = path.join(fxHome, '.codex');
    process.env.SHELL = '/bin/bash';
    env.remoteName = undefined;
  });
  after(() => fx.restore());

  interface Harness {
    store: CodexAccountStore;
    labels: LabelStore;
    handle(message: FromWebview): Promise<void>;
    posted: ToWebview[];
    refreshes(): number;
    dispose(): void;
  }
  const harness = async (accounts: CodexAccount[] = []): Promise<Harness> => {
    assertTempHome(fxHome);
    fs.mkdirSync(def, { recursive: true, mode: 0o700 });
    const state = new MemoryMemento();
    const store = new CodexAccountStore(state);
    const labels = new LabelStore(state, 'codex.labels');
    for (const a of accounts) {
      fs.mkdirSync(a.dir, { recursive: true, mode: 0o700 });
      await store.add(a);
    }
    let handle!: (message: FromWebview) => Promise<void>;
    const posted: ToWebview[] = [];
    let refreshes = 0;
    const panel = {
      setHandler(_mode: string, callback: typeof handle) { handle = callback; },
      resolve(_mode: string, dir: string) {
        const a = store.findByDir(dir);
        return a && { name: a.name, dir: a.dir, kind: a.name === CODEX_DEFAULT_NAME ? 'default' : 'named' };
      },
      refresh() { refreshes++; },
      post(message: ToWebview) { posted.push(message); },
    } as unknown as AccountsPanel;
    const disposables = registerCodexCommands({ store, labels, panel, tools: {} });
    return { store, labels, handle: (m) => handle(m), posted, refreshes: () => refreshes, dispose: () => disposables.forEach((d) => d.dispose()) };
  };
  const named = (name: string): CodexAccount => ({ name, dir: codexAccountDir(name) });
  const bashrc = (): string => path.join(fxHome, '.bashrc');
  const profile = (): string => path.join(fxHome, '.profile');
  // selfCheck spawns a real login shell that inherits process.env; keep it minimal so nothing leaks in (as in codexState.test)
  const inCleanEnv = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const saved = process.env;
    process.env = { HOME: fxHome, PATH: saved.PATH, SHELL: '/bin/bash', TERM: 'dumb', LANG: 'C.UTF-8' } as NodeJS.ProcessEnv;
    try {
      return await fn();
    } finally {
      process.env = saved;
    }
  };
  const modal = (ctx: { mock: { method: typeof import('node:test').mock.method } }, answer: (message: string) => string | undefined) =>
    ctx.mock.method(window, 'showWarningMessage', async (message: string) => answer(message));

  test('enable: pre-check, confirmation, rc blocks written, self-check passes, state file untouched', LINUX_ONLY, async (ctx) => {
    fs.writeFileSync(bashrc(), 'x=1\n');
    fs.writeFileSync(profile(), '. ~/.bashrc\n');
    writeSelectedDir(path.join(fxHome, 'keep'));
    const h = await harness();
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    let confirm = false;
    modal(ctx, () => (confirm ? t('codex.enableButton') : undefined));
    try {
      await inCleanEnv(() => h.handle({ type: 'enable', mode: 'codex' }));
      assert.equal(read(bashrc()), 'x=1\n', 'cancelled: nothing written');
      confirm = true;
      await inCleanEnv(() => h.handle({ type: 'enable', mode: 'codex' }));
      assert.equal(errors.mock.callCount(), 0);
      assert.equal(read(bashrc()), 'x=1\n\n' + rcBlock());
      assert.equal(read(profile()), '. ~/.bashrc\n\n' + rcBlock());
      assert.equal(readSelectedDir(), path.join(fxHome, 'keep'));
      assert.equal(h.refreshes(), 1);
      assert.equal(codexPanelSource(h.store, h.labels).enabled(), true);
    } finally {
      h.dispose();
    }
  });

  test('enable: a failed self-check rolls back only the files newly written this time', LINUX_ONLY, async (ctx) => {
    // ~/.bash_profile mentions .bashrc (pre-check passes) but does not source it, so the login shell never sees the block
    fs.writeFileSync(path.join(fxHome, '.bash_profile'), ': ~/.bashrc\n');
    fs.writeFileSync(bashrc(), 'x=1\n\n' + rcBlock());
    fs.writeFileSync(profile(), 'p=1\n');
    writeSelectedDir(undefined);
    const h = await harness();
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    modal(ctx, () => t('codex.enableButton'));
    try {
      await inCleanEnv(() => h.handle({ type: 'enable', mode: 'codex' }));
      assert.equal(errors.mock.callCount(), 1);
      assert.match(String(errors.mock.calls[0].arguments[0]), /^Self-check failed; rc files were rolled back: /);
      assert.equal(read(profile()), 'p=1\n', 'rolled back');
      assert.equal(read(bashrc()), 'x=1\n\n' + rcBlock(), 'the pre-existing block is kept');
      assert.equal(read(STATE_FILE()), '', 'the state file is restored');
      assert.equal(h.refreshes(), 1);
    } finally {
      h.dispose();
      fs.rmSync(path.join(fxHome, '.bash_profile'));
    }
  });

  test('enable: pre-check failures are reported without a confirmation', LINUX_ONLY, async (ctx) => {
    fs.rmSync(path.join(fxHome, '.bash_profile'), { force: true });
    fs.writeFileSync(bashrc(), 'export CODEX_HOME=/mine\n');
    fs.writeFileSync(profile(), 'p=1\n');
    const h = await harness();
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const warnings = modal(ctx, () => t('codex.enableButton'));
    try {
      await h.handle({ type: 'enable', mode: 'codex' });
      assert.equal(warnings.mock.callCount(), 0);
      assert.equal(errors.mock.calls[0].arguments[0], t('codex.enableFailedReasons', { reasons: t('codex.pre.userExport', { file: bashrc() }) }));
      assert.equal(read(bashrc()), 'export CODEX_HOME=/mine\n');
    } finally {
      h.dispose();
    }
  });

  test('disable: removes both blocks and the state file after confirmation; a cancel changes nothing', LINUX_ONLY, async (ctx) => {
    fs.writeFileSync(bashrc(), 'x=1\n');
    fs.writeFileSync(profile(), 'p=1\n');
    installRcBlocks();
    writeSelectedDir(path.join(fxHome, '.codex-x'));
    const h = await harness();
    let confirm = false;
    modal(ctx, () => (confirm ? t('codex.disableButton') : undefined));
    try {
      await commands.registered['planswap.codex.disable']();
      assert.equal(readSelectedDir(), path.join(fxHome, '.codex-x'));
      assert.equal(read(bashrc()), 'x=1\n\n' + rcBlock());
      confirm = true;
      await commands.registered['planswap.codex.disable']();
      assert.equal(read(bashrc()), 'x=1\n');
      assert.equal(read(profile()), 'p=1\n');
      assert.ok(!fs.existsSync(STATE_FILE()));
      assert.equal(codexPanelSource(h.store, h.labels).enabled(), false);
    } finally {
      h.dispose();
    }
  });

  test('enabled(): a start marker without its end marker counts as not enabled so the repair guidance is reachable', LINUX_ONLY, async () => {
    fs.writeFileSync(bashrc(), 'x=1\n\n' + rcBlock());
    fs.writeFileSync(profile(), 'p=1\n\n' + RC_BEGIN + '\n');
    const h = await harness();
    try {
      const source = codexPanelSource(h.store, h.labels);
      assert.deepEqual(rcStatus().map((s) => [s.hasBlock, s.broken]), [[true, true], [true, false]]);
      assert.equal(source.enabled(), false);
      fs.writeFileSync(profile(), 'p=1\n\n' + rcBlock());
      assert.equal(source.enabled(), true);
    } finally {
      h.dispose();
    }
  });

  for (const locale of ['en', 'zh-cn', 'zh-tw', 'es', 'ja'] as const) {
    for (const [serverDir, editor] of [['.antigravity-ide-server', 'Antigravity'], ['.vscodium-server', 'VSCodium']] as const) {
      test(`switch: ${locale} ${editor} offers switch and restart; cancelling preserves selection`, LINUX_ONLY, async (ctx) => {
        fs.writeFileSync(bashrc(), 'x=1\n');
        fs.writeFileSync(profile(), 'p=1\n');
        installRcBlocks();
        const account = named('auto-confirm');
        const h = await harness([account]);
        writeSelectedDir(undefined);
        const realRead = fs.readFileSync;
        ctx.mock.method(fsDefault, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
          if (file === `/proc/${process.ppid}/cmdline`) {
            return `node\0${path.join(fxHome, serverDir, 'bin', 'fake', 'out', 'server-main.js')}\0--start-server\0`;
          }
          return (realRead as (...args: unknown[]) => unknown)(file, ...args);
        }) as typeof fs.readFileSync);
        const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
        try {
          setLocale(locale);
          env.remoteName = 'wsl';
          await h.handle({ type: 'switch', mode: 'codex', dir: account.dir });
          assert.deepEqual(warning.mock.calls[0].arguments, [
            t('codex.switchConfirm', { editor }), { modal: true }, t('codex.switchAndRestartButton'),
          ]);
          assert.equal(readSelectedDir(), undefined);
          assert.equal(h.refreshes(), 0);
        } finally {
          setLocale('en');
          env.remoteName = undefined;
          h.dispose();
        }
      });
    }
  }

  test('switch: an account already effective in this window only realigns the state file; no confirmation, no restart', LINUX_ONLY, async (ctx) => {
    // Enabled: rc blocks in place (the confirmed switch back to the default needs them)
    fs.writeFileSync(bashrc(), 'x=1\n');
    fs.writeFileSync(profile(), 'p=1\n');
    installRcBlocks();
    const a = named('eff');
    const h = await harness([a]);
    const warnings = modal(ctx, () => t('codex.saveSelectionButton'));
    const savedCodexHome = process.env.CODEX_HOME;
    try {
      env.remoteName = 'wsl';
      process.env.CODEX_HOME = a.dir;
      writeSelectedDir(undefined);
      await h.handle({ type: 'switch', mode: 'codex', dir: a.dir });
      assert.equal(readSelectedDir(), a.dir);
      assert.equal(warnings.mock.callCount(), 0, 'neither the confirmation nor a manual-restart warning');
      assert.equal(h.refreshes(), 1);
      // Back to the default while a named account is effective: the ordinary confirmed switch
      await h.handle({ type: 'switch', mode: 'codex', dir: def });
      assert.equal(readSelectedDir(), undefined);
      assert.equal(warnings.mock.callCount() >= 1, true);
    } finally {
      restoreEnv('CODEX_HOME', savedCodexHome);
      env.remoteName = undefined;
      h.dispose();
    }
  });

  for (const deleteDirectory of [true, false]) {
    test(`switch: an account removed during confirmation is not selected (delete directory: ${deleteDirectory})`, LINUX_ONLY, async (ctx) => {
      fs.writeFileSync(bashrc(), 'x=1\n');
      fs.writeFileSync(profile(), 'p=1\n');
      installRcBlocks();
      const a = named(deleteDirectory ? 'switch-deleted' : 'switch-removed');
      const selected = named('switch-keep');
      const h = await harness([a, selected]);
      writeSelectedDir(selected.dir);
      const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
      ctx.mock.method(window, 'showWarningMessage', async () => {
        await h.store.remove(a.name);
        if (deleteDirectory) await deleteCodexDir(a.dir);
        return t('codex.saveSelectionButton');
      });
      try {
        await h.handle({ type: 'switch', mode: 'codex', dir: a.dir });
        assert.equal(readSelectedDir(), selected.dir);
        assert.equal(h.store.find(a.name), undefined);
        assert.equal(fs.existsSync(a.dir), !deleteDirectory);
        if (deleteDirectory) assert.equal(errors.mock.calls[0]?.arguments[0], t('account.dirMissing', { dir: a.dir }));
      } finally {
        h.dispose();
      }
    });
  }

  test('add: a linked account is created and linked; an independent one gets a copy; invalid names are reported', LINUX_ONLY, async () => {
    fs.mkdirSync(def, { recursive: true });
    fs.writeFileSync(path.join(def, 'config.toml'), 'model = "m"\n');
    fs.mkdirSync(path.join(def, 'sessions'), { recursive: true });
    const h = await harness();
    try {
      await h.handle({ type: 'add', mode: 'codex', name: 'linked', shared: true });
      assert.deepEqual(h.posted.at(-1), { type: 'addResult', mode: 'codex', error: undefined });
      assert.ok(h.store.find('linked'));
      assert.equal(isSharedCodexAccount(codexAccountDir('linked')), true);
      assert.ok(fs.lstatSync(path.join(codexAccountDir('linked'), 'config.toml')).isSymbolicLink());

      await h.handle({ type: 'add', mode: 'codex', name: 'own', shared: false });
      assert.deepEqual(h.posted.at(-1), { type: 'addResult', mode: 'codex', error: undefined });
      assert.equal(isSharedCodexAccount(codexAccountDir('own')), false);
      assert.ok(fs.lstatSync(path.join(codexAccountDir('own'), 'config.toml')).isFile());
      assert.equal(read(path.join(codexAccountDir('own'), 'config.toml')), 'model = "m"\n');
      assert.ok(!fs.existsSync(path.join(codexAccountDir('own'), 'sessions')));

      await h.handle({ type: 'add', mode: 'codex', name: 'own', shared: false });
      assert.deepEqual(h.posted.at(-1), { type: 'addResult', mode: 'codex', error: t('name.exists') });
      assert.equal(h.refreshes(), 2);
    } finally {
      h.dispose();
    }
  });

  test('remove: the directory of a non-effective, non-selected account is deleted through deleteCodexDir', async (ctx) => {
    const a = named('gone');
    const h = await harness([a]);
    await h.labels.set(a.name, 'Old');
    fs.writeFileSync(path.join(a.dir, 'auth.json'), '{}');
    writeSelectedDir(undefined);
    modal(ctx, (message) => (message === t('account.removeDirPrompt', { label: 'Old', dir: a.dir }) ? t('common.deleteDir') : undefined));
    try {
      await h.handle({ type: 'remove', mode: 'codex', dir: a.dir });
      assert.equal(h.store.find('gone'), undefined);
      assert.equal(labelFor('gone', h.labels), 'gone', 'alias cleared');
      assert.ok(!fs.existsSync(a.dir));
      assert.ok(fs.existsSync(def));
    } finally {
      h.dispose();
    }
  });

  test('remove: an account selected or made effective while the modal was open is not deleted', async (ctx) => {
    const a = named('raced');
    const h = await harness([a]);
    writeSelectedDir(undefined);
    const shown: string[] = [];
    modal(ctx, (message) => {
      shown.push(message);
      if (message !== t('account.removeDirPrompt', { label: 'raced', dir: a.dir })) return undefined;
      writeSelectedDir(a.dir);   // another window selects it meanwhile
      return t('common.deleteDir');
    });
    try {
      await h.handle({ type: 'remove', mode: 'codex', dir: a.dir });
      assert.ok(fs.existsSync(a.dir), 'the directory survives');
      assert.equal(shown.at(-1), t('codex.removeSelected', { label: 'raced' }));
      assert.equal(h.store.find('raced'), undefined, 'the list entry was already removed');
    } finally {
      h.dispose();
    }
  });

  test('remove: the effective account is refused before any modal', async (ctx) => {
    const a = named('active');
    const h = await harness([a]);
    writeSelectedDir(undefined);
    const savedCodexHome = process.env.CODEX_HOME;
    const warnings = modal(ctx, () => t('common.deleteDir'));
    try {
      process.env.CODEX_HOME = a.dir;
      await h.handle({ type: 'remove', mode: 'codex', dir: a.dir });
      assert.deepEqual(warnings.mock.calls.map((c) => c.arguments[0]), [t('codex.removeEffective', { label: 'active' })]);
      assert.ok(h.store.find('active'));
      assert.ok(fs.existsSync(a.dir));
    } finally {
      restoreEnv('CODEX_HOME', savedCodexHome);
      h.dispose();
    }
  });

  test('share then unshare: conversion after confirmation; the selected account is refused', LINUX_ONLY, async (ctx) => {
    fs.mkdirSync(def, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(def, 'config.toml'), 'model = "m"\n');
    const a = named('conv');
    const h = await harness([a]);
    fs.mkdirSync(path.join(a.dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(a.dir, 'sessions', 'x.jsonl'), 'x');
    fs.writeFileSync(path.join(a.dir, 'auth.json'), 'secret');
    writeSelectedDir(undefined);
    const infos = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const warnings = modal(ctx, (message) =>
      message.startsWith('Link ') ? t('share.confirmButton') : message.startsWith('Unlink ') ? t('unshare.confirmButton') : undefined);
    try {
      await h.handle({ type: 'share', mode: 'codex', dir: a.dir });
      assert.equal(errors.mock.callCount(), 0);
      assert.equal(isSharedCodexAccount(a.dir), true);
      assert.equal(read(path.join(def, 'sessions', 'x.jsonl')), 'x');
      assert.equal(read(path.join(a.dir, 'auth.json')), 'secret');
      assert.match(String(infos.mock.calls[0].arguments[0]), /^conv is now linked to the default account\. /);

      await h.handle({ type: 'unshare', mode: 'codex', dir: a.dir });
      assert.equal(errors.mock.callCount(), 0);
      assert.equal(isSharedCodexAccount(a.dir), false);
      assert.equal(read(path.join(a.dir, 'config.toml')), 'model = "m"\n');
      assert.ok(!fs.existsSync(path.join(a.dir, 'sessions')));
      assert.match(String(infos.mock.calls[1].arguments[0]), /^conv is now independent: removed \d+ links?, copied /);
      assert.equal(h.refreshes(), 2);

      writeSelectedDir(a.dir);
      await h.handle({ type: 'share', mode: 'codex', dir: a.dir });
      assert.equal(warnings.mock.calls.at(-1)?.arguments[0], t('share.current', { label: 'conv' }));
      assert.equal(isSharedCodexAccount(a.dir), false);
    } finally {
      writeSelectedDir(undefined);
      h.dispose();
    }
  });

  test('adding a kept independent directory does not claim that linking succeeded', LINUX_ONLY, async (ctx) => {
    const a = named('kept-unlinked');
    fs.mkdirSync(path.join(a.dir, 'sessions'), { recursive: true });
    const h = await harness();
    const warnings = modal(ctx, () => undefined);
    try {
      await h.handle({ type: 'add', mode: 'codex', name: a.name, shared: true });
      assert.ok(h.store.find(a.name));
      assert.equal(isSharedCodexAccount(a.dir), false);
      assert.match(String(warnings.mock.calls[0].arguments[0]), /^Account kept-unlinked was added\. Linking reported: /);
      assert.match(String(warnings.mock.calls[0].arguments[0]), /sessions/);
    } finally {
      h.dispose();
    }
  });

  test('a conversion that leaves the marker unlinked reports an incomplete link', LINUX_ONLY, async (ctx) => {
    const a = named('marker-conflict');
    const h = await harness([a]);
    const elsewhere = path.join(fxHome, 'other-sessions');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(a.dir, 'sessions'), 'junction');
    writeSelectedDir(undefined);
    modal(ctx, () => t('share.confirmButton'));
    const infos = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      await h.handle({ type: 'share', mode: 'codex', dir: a.dir });
      assert.equal(isSharedCodexAccount(a.dir), false);
      assert.deepEqual(infos.mock.calls[0].arguments, [t('share.incomplete', {
        label: a.name, summary: t('share.r.conflicts', { list: 'sessions' }),
      })]);
    } finally {
      h.dispose();
    }
  });

  test('Windows conversion confirmations describe independent thread databases', async (ctx) => {
    const independent = named('windows-confirm-independent');
    const shared = named('windows-confirm-shared');
    const h = await harness([independent, shared]);
    fs.mkdirSync(path.join(def, 'sessions'), { recursive: true });
    fs.symlinkSync(path.join(def, 'sessions'), path.join(shared.dir, 'sessions'), 'junction');
    writeSelectedDir(undefined);
    const warnings = modal(ctx, () => undefined);
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await h.handle({ type: 'share', mode: 'codex', dir: independent.dir });
      await h.handle({ type: 'unshare', mode: 'codex', dir: shared.dir });
      assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]), [
        t('share.confirmCodexWindows', { label: independent.name, dir: independent.dir }),
        t('unshare.confirmCodexWindows', { label: shared.name, dir: shared.dir }),
      ]);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      h.dispose();
    }
  });

  test('share command picks only independent named accounts outside the effective and selected directories', LINUX_ONLY, async (ctx) => {
    const candidate = named('palette-share-choice');
    const effective = named('palette-share-effective');
    const selected = named('palette-share-selected');
    const shared = named('palette-share-linked');
    const h = await harness([candidate, effective, selected, shared]);
    fs.mkdirSync(path.join(def, 'sessions'), { recursive: true });
    fs.symlinkSync(path.join(def, 'sessions'), path.join(shared.dir, 'sessions'), 'junction');
    await h.labels.set(candidate.name, 'Choice Alias');
    writeSelectedDir(selected.dir);
    const savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = effective.dir;
    const picks: Array<Array<{ label: string; account: CodexAccount }>> = [];
    const quickPick = ctx.mock.method(window, 'showQuickPick', async (items: Array<{ label: string; account: CodexAccount }>) => {
      picks.push(items);
      return undefined;
    });
    const infos = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      assert.ok(commands.registered['planswap.codex.shareAccount']);
      await commands.registered['planswap.codex.shareAccount']();
      assert.deepEqual(picks[0].map((item) => [item.label, item.account.dir]), [['Choice Alias', candidate.dir]]);
      assert.equal((quickPick.mock.calls[0].arguments[1] as { placeHolder?: string } | undefined)?.placeHolder, t('codex.pick.share'));
      await h.store.remove(effective.name);
      await h.store.remove(selected.name);
      writeSelectedDir(candidate.dir);
      await commands.registered['planswap.codex.shareAccount']();
      assert.equal(quickPick.mock.callCount(), 1);
      assert.equal(infos.mock.calls.at(-1)?.arguments[0], t('common.noAccounts'));
    } finally {
      restoreEnv('CODEX_HOME', savedCodexHome);
      writeSelectedDir(undefined);
      h.dispose();
    }
  });

  test('share command cancellation leaves files unchanged and confirmation converts the picked account', LINUX_ONLY, async (ctx) => {
    const account = named('palette-share-convert');
    const h = await harness([account]);
    const source = path.join(account.dir, 'sessions', 'entry.jsonl');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'session\n');
    writeSelectedDir(undefined);
    ctx.mock.method(window, 'showQuickPick', async (items: Array<{ account: CodexAccount }>) => items[0]);
    let confirm = false;
    const warnings = modal(ctx, () => confirm ? t('share.confirmButton') : undefined);
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    try {
      await commands.registered['planswap.codex.shareAccount']();
      assert.equal(read(source), 'session\n');
      assert.equal(isSharedCodexAccount(account.dir), false);
      assert.equal(h.refreshes(), 0);

      confirm = true;
      await commands.registered['planswap.codex.shareAccount']();
      assert.equal(errors.mock.callCount(), 0);
      assert.equal(warnings.mock.callCount(), 2);
      assert.equal(isSharedCodexAccount(account.dir), true);
      assert.equal(read(path.join(def, 'sessions', 'entry.jsonl')), 'session\n');
      assert.equal(h.refreshes(), 1);
    } finally {
      writeSelectedDir(undefined);
      h.dispose();
    }
  });

  test('rename: named rows get an alias; a colliding label is reported; the default row is ignored', async () => {
    const a = named('rn');
    const b = named('other');
    const h = await harness([a, b]);
    try {
      await h.handle({ type: 'rename', mode: 'codex', dir: a.dir, label: 'Work' });
      assert.deepEqual(h.posted.at(-1), { type: 'renameResult', mode: 'codex', dir: a.dir, error: undefined });
      assert.equal(labelFor('rn', h.labels), 'Work');
      await h.handle({ type: 'rename', mode: 'codex', dir: a.dir, label: 'other' });
      assert.equal((h.posted.at(-1) as { error?: string }).error, t('label.dupName'));
      assert.equal(labelFor('rn', h.labels), 'Work');
      await h.handle({ type: 'rename', mode: 'codex', dir: a.dir, label: 'rn' });
      assert.equal(labelFor('rn', h.labels), 'rn', 'a label equal to the name clears the alias');
      await h.handle({ type: 'rename', mode: 'codex', dir: def, label: 'Main' });
      assert.deepEqual(h.posted.at(-1), { type: 'renameResult', mode: 'codex', dir: def, error: undefined });
      assert.equal(labelFor(CODEX_DEFAULT_NAME, h.labels), CODEX_DEFAULT_NAME);
    } finally {
      h.dispose();
    }
  });

  test('terminal: runs codex login without auth.json, codex with it, and env -u for the default account', LINUX_ONLY, async (ctx) => {
    const a = named('term');
    const h = await harness([a]);
    await h.labels.set(a.name, 'Term Label');
    const created: StubTerminal[] = [];
    ctx.mock.method(window, 'createTerminal', (options: { name: string }) => {
      const terminal: StubTerminal = { name: options.name, sent: [], shown: 0, sendText(text) { terminal.sent.push(text); }, show() { terminal.shown++; } };
      created.push(terminal);
      return terminal;
    });
    try {
      await h.handle({ type: 'terminal', mode: 'codex', dir: a.dir });
      fs.writeFileSync(path.join(a.dir, 'auth.json'), '{}');
      await h.handle({ type: 'terminal', mode: 'codex', dir: a.dir });
      await h.handle({ type: 'terminal', mode: 'codex', dir: def });
      assert.deepEqual(created.map((c) => [c.name, c.sent, c.shown]), [
        ['Codex (Term Label)', [`env CODEX_HOME='${a.dir}' codex login`], 1],
        ['Codex (Term Label)', [`env CODEX_HOME='${a.dir}' codex`], 1],
        ['Codex (default)', ['env -u CODEX_HOME codex login'], 1],
      ]);
    } finally {
      h.dispose();
    }
  });

  test('terminal: a sign-in tip is shown only when the account still has to sign in', async (ctx) => {
    const a = named('tip');
    const h = await harness([a]);
    const infos = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      await h.handle({ type: 'terminal', mode: 'codex', dir: a.dir });
      assert.deepEqual(infos.mock.calls.map((c) => c.arguments[0]), [t('account.loginTip', { vendor: 'Codex' })]);
      fs.writeFileSync(path.join(a.dir, 'auth.json'), '{}');
      await h.handle({ type: 'terminal', mode: 'codex', dir: a.dir });
      assert.equal(infos.mock.callCount(), 1);
    } finally {
      h.dispose();
    }
  });

  test('Windows with Codex run inside WSL: enable and switch are refused with guidance, nothing is written', async (ctx) => {
    const a = named('wslrun');
    const h = await harness([a]);
    const warnings = modal(ctx, () => t('codex.saveSelectionButton'));
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    const stateBefore = fs.existsSync(STATE_FILE()) ? read(STATE_FILE()) : undefined;
    setConfig('chatgpt', 'runCodexInWindowsSubsystemForLinux', true);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await h.handle({ type: 'enable', mode: 'codex' });
      await h.handle({ type: 'switch', mode: 'codex', dir: a.dir });
      assert.deepEqual(warnings.mock.calls.map((c) => c.arguments[0]), [t('codex.win.runsInWsl'), t('codex.win.runsInWsl')]);
      assert.equal(fs.existsSync(STATE_FILE()) ? read(STATE_FILE()) : undefined, stateBefore);
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      setConfig('chatgpt', 'runCodexInWindowsSubsystemForLinux', undefined);
      h.dispose();
    }
  });
});

describe('codexRunsInWsl', () => {
  after(() => setConfig('chatgpt', 'runCodexInWindowsSubsystemForLinux', undefined));
  test('true only on Windows with the Codex extension set to run Codex in WSL', () => {
    setConfig('chatgpt', 'runCodexInWindowsSubsystemForLinux', undefined);
    assert.equal(codexRunsInWsl(true), false);
    setConfig('chatgpt', 'runCodexInWindowsSubsystemForLinux', false);
    assert.equal(codexRunsInWsl(true), false);
    setConfig('chatgpt', 'runCodexInWindowsSubsystemForLinux', true);
    assert.equal(codexRunsInWsl(true), true);
    assert.equal(codexRunsInWsl(false), false);
  });
});

describe('Codex panel rows', () => {
  test('show the email but never carry the identity comparison key', async () => {
    const fixture = makeTempHome('codex-panel-identity');
    try {
      const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
      const payload = { email: 'dummy@example.com', 'https://api.openai.com/auth': { chatgpt_user_id: 'dummy-user', chatgpt_account_id: 'dummy-workspace' } };
      const dir = path.join(fixture.home, '.codex-work');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { id_token: `${b64u({ alg: 'none' })}.${b64u(payload)}.sig`, access_token: 'FAKE_ACCESS', refresh_token: 'FAKE_REFRESH' },
      }));
      const state = new MemoryMemento();
      const store = new CodexAccountStore(state);
      await store.add({ name: 'work', dir });
      assert.ok(readCodexAccountInfo(dir).identity, 'the account info has an identity');

      const rows = codexPanelSource(store, new LabelStore(state, 'codex.labels')).accounts();
      const row = rows.find((r) => r.dir === dir);
      assert.equal(row?.email, 'dummy@example.com');
      assert.equal(row?.loggedIn, true);
      for (const r of rows) assert.ok(!('identity' in r), `row ${r.name} has no identity`);
    } finally {
      fixture.restore();
    }
  });
});
