import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AccountStore } from '../src/accounts';
import type { AccountsPanel } from '../src/accountsPanel';
import { CLAUDE_SHARED_ENTRIES, ensureClaudeLinks, isSharedClaudeAccount } from '../src/claudeShare';
import { CONFIRM_SWITCH_SETTING, registerCommands, shQuote, validateName } from '../src/commands';
import { t } from '../src/i18n';
import { LabelStore } from '../src/labels';
import { accountDir } from '../src/paths';
import type { FromWebview, ToWebview } from '../src/protocol';
import type { StatusBar } from '../src/statusBar';
import { commands, resetConfig, setConfig, updates, window } from './stubs/vscode';
import { LINUX_ONLY, makeTempHome, MemoryMemento, snapshot, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
before(() => {
  tmp = makeTempHome('commands');
  home = tmp.home;
});
after(() => tmp.restore());

describe('validateName', () => {
  const make = async (): Promise<{ store: AccountStore; labels: LabelStore }> => {
    const memento = new MemoryMemento();
    const store = new AccountStore(memento);
    const labels = new LabelStore(memento, 'claude.labels');
    await store.add({ name: 'a', dir: path.join(home, '.claude-a') });
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

  test('the default name, existing names and display names are compared case-insensitively', async () => {
    const { store, labels } = await make();
    assert.equal(validateName('Default', store, labels), t('name.reserved', { name: 'default' }));
    assert.equal(validateName('A', store, labels), t('name.exists'));
    assert.equal(validateName('WORK', store, labels), t('name.dupLabel'));
  });

  test('a name whose directory exists as a symbolic link is rejected', async () => {
    const { store, labels } = await make();
    const target = path.join(home, 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(home, '.claude-lnk'), 'junction');
    try {
      assert.equal(validateName('lnk', store, labels), t('name.dirIsSymlink'));
      assert.equal(validateName('lnk2', store, labels), undefined);
    } finally {
      fs.unlinkSync(path.join(home, '.claude-lnk'));
      fs.rmSync(target, { recursive: true });
    }
  });

  test('a name whose directory is the default directory (via CLAUDE_CONFIG_DIR) is rejected', async () => {
    const { store, labels } = await make();
    const dir = path.join(home, '.claude-main');
    fs.mkdirSync(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      assert.equal(validateName('main', store, labels), t('name.sameAsDefaultDir'));
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('a name whose directory contains the default directory is rejected without writing', async () => {
    const { store, labels } = await make();
    const dir = accountDir('parent');
    const nested = path.join(dir, 'agents', 'main');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'settings.json'), '{}');
    process.env.CLAUDE_CONFIG_DIR = nested;
    try {
      const before = snapshot(home);
      assert.equal(validateName('parent', store, labels), t('account.containsDefaultDir', { dir, default: nested }));
      assert.deepEqual(snapshot(home), before);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe('shQuote', () => {
  test('wraps in single quotes and escapes embedded single quotes', () => {
    assert.equal(shQuote('/home/u/.claude-a'), `'/home/u/.claude-a'`);
    assert.equal(shQuote(`it's`), `'it'\\''s'`);
    assert.equal(shQuote(''), `''`);
  });

  test('bash reads the quoted value back byte for byte', LINUX_ONLY, () => {
    for (const s of [`/tmp/a b`, `it's`, `$HOME`, '`id`', `a"b\\c`, `x;rm -rf y`, `line\nbreak`]) {
      assert.equal(execFileSync('bash', ['-c', `printf %s ${shQuote(s)}`], { encoding: 'utf8' }), s);
    }
  });
});

describe('panel message handlers (Claude)', () => {
  const procRoot = (): string => path.join(home, 'fakeproc');
  // Fake process tree: <procRoot>/<pid>/environ with CLAUDE_CONFIG_DIR=<dir>, plus the session file that names the pid
  const runningIn = (dir: string, pid: number): void => {
    fs.mkdirSync(path.join(procRoot(), String(pid)), { recursive: true });
    fs.writeFileSync(path.join(procRoot(), String(pid), 'environ'), `PATH=/bin\0CLAUDE_CONFIG_DIR=${dir}\0`);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid }));
  };
  const setCurrent = (dir: string | undefined): void =>
    setConfig('claudeCode', 'environmentVariables', dir ? [{ name: 'CLAUDE_CONFIG_DIR', value: dir }] : []);
  const configured = (): string | undefined => {
    const last = updates.at(-1)?.value as Array<{ name: string; value: string }> | undefined;
    return last?.find((e) => e.name === 'CLAUDE_CONFIG_DIR')?.value;
  };

  interface Harness {
    memento: MemoryMemento;
    store: AccountStore;
    labels: LabelStore;
    handle(msg: FromWebview): Promise<void>;
    posted: ToWebview[];
    switchedTo: string | undefined;
    dispose(): void;
  }
  function harness(): Harness {
    const memento = new MemoryMemento();
    const store = new AccountStore(memento);
    const labels = new LabelStore(memento, 'claude.labels');
    const h = { memento, store, labels, posted: [] as ToWebview[], switchedTo: undefined as string | undefined } as Harness;
    const panel = {
      setHandler(_mode: string, handler: Harness['handle']) { h.handle = handler; },
      resolve(_mode: string, dir: string) {
        const a = store.findByDir(dir);
        return a && { ...a, kind: a.name === 'default' ? 'default' : 'named' };
      },
      refresh() {},
      post(msg: ToWebview) { h.posted.push(msg); },
      setSwitchedTo(label: string | undefined) { h.switchedTo = label; },
      visible: true,
      focusAdd() {},
    } as unknown as AccountsPanel;
    const statusBar = { update() {} } as unknown as StatusBar;
    const disposables = registerCommands({ store, panel, statusBar, labels, tools: {}, procRoot: procRoot() });
    h.dispose = () => disposables.forEach((d) => d.dispose());
    return h;
  }
  const add = async (h: Harness, name: string, shared: boolean): Promise<string> => {
    const dir = accountDir(name);
    fs.mkdirSync(dir, { mode: 0o700 });
    if (shared) ensureClaudeLinks(dir);
    await h.store.add({ name, dir });
    return dir;
  };

  before(() => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  });
  afterEach(() => {
    resetConfig();
    for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.claude'), { mode: 0o700 });
  });

  test('account picks distinguish signed-in accounts without an email from signed-out accounts', async (ctx) => {
    const h = harness();
    const signedIn = await add(h, 'signed-in', false);
    const withEmail = await add(h, 'with-email', false);
    await add(h, 'signed-out', false);
    fs.writeFileSync(path.join(signedIn, '.credentials.json'), '');
    fs.writeFileSync(path.join(withEmail, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'person@example.com' } }));
    const pick = ctx.mock.method(window, 'showQuickPick', async () => undefined);
    try {
      await commands.registered['planswap.switchAccount']();
      const items = pick.mock.calls[0].arguments[0] as Array<{ label: string; description: string }>;
      assert.deepEqual(items.map(({ label, description }) => [label, description]), [
        ['signed-in', t('common.loggedIn')],
        ['signed-out', t('common.notLoggedIn')],
        ['with-email', 'person@example.com'],
      ]);
    } finally {
      h.dispose();
    }
  });

  test('adding a kept independent directory does not claim that linking succeeded', LINUX_ONLY, async (ctx) => {
    const h = harness();
    const dir = accountDir('kept');
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    try {
      await h.handle({ type: 'add', mode: 'claude', name: 'kept', shared: true });
      assert.ok(h.store.find('kept'));
      assert.equal(isSharedClaudeAccount(dir), false);
      assert.match(String(warning.mock.calls[0].arguments[0]), /^Account kept was added\. Linking reported: /);
      assert.match(String(warning.mock.calls[0].arguments[0]), /projects/);
    } finally {
      h.dispose();
    }
  });

  test('a conversion that leaves the marker unlinked reports an incomplete link', LINUX_ONLY, async (ctx) => {
    const h = harness();
    const dir = await add(h, 'conflict', false);
    const elsewhere = path.join(home, 'other-projects');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(dir, 'projects'), 'junction');
    ctx.mock.method(window, 'showWarningMessage', async () => t('share.confirmButton'));
    const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      await h.handle({ type: 'share', mode: 'claude', dir });
      assert.equal(isSharedClaudeAccount(dir), false);
      assert.deepEqual(info.mock.calls[0].arguments, [t('share.incomplete', {
        label: 'conflict', summary: t('share.r.conflicts', { list: 'projects' }),
      })]);
    } finally {
      h.dispose();
    }
  });

  test('remove refuses the current account', async (ctx) => {
    const h = harness();
    const dir = await add(h, 'a', false);
    setCurrent(dir);
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    try {
      await h.handle({ type: 'remove', mode: 'claude', dir });
      assert.deepEqual(warning.mock.calls[0].arguments, [t('claude.removeCurrent', { label: 'a' })]);
      assert.ok(h.store.find('a'));
      assert.ok(fs.existsSync(dir));
    } finally {
      h.dispose();
    }
  });

  test('remove refuses an account with a running Claude process; another account\'s process does not block', async (ctx) => {
    const h = harness();
    const dir = await add(h, 'a', false);
    runningIn(dir, 41);
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => t('common.deleteDir'));
    try {
      await h.handle({ type: 'remove', mode: 'claude', dir });
      assert.deepEqual(warning.mock.calls[0].arguments, [t('share.busy', { name: 'a' })]);
      assert.ok(h.store.find('a'));
      assert.ok(fs.existsSync(dir));
      // The session file is now from a process of another account
      runningIn(accountDir('other'), 41);
      fs.writeFileSync(path.join(dir, 'sessions', '41.json'), JSON.stringify({ pid: 41 }));
      await h.handle({ type: 'remove', mode: 'claude', dir });
      assert.equal(h.store.find('a'), undefined);
      assert.ok(!fs.existsSync(dir));
    } finally {
      h.dispose();
    }
  });

  test('remove captures the alias and the shared mode before clearing the alias, and unignores the directory only after deletion', async (ctx) => {
    const h = harness();
    const dir = await add(h, 'a', true);
    await h.labels.set('a', 'Work');
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => t('common.deleteDir'));
    const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    try {
      await h.handle({ type: 'remove', mode: 'claude', dir });
      assert.deepEqual(warning.mock.calls[0].arguments, [
        t('account.removeDirPrompt', { label: 'Work', dir }),
        { modal: true, detail: t('claude.removeDirDetailShared') },
        t('common.deleteDir'),
      ]);
      assert.equal(h.labels.get('a'), undefined);
      assert.ok(!fs.existsSync(dir));
      assert.ok(fs.existsSync(path.join(home, '.claude', 'projects')), 'the default content survives');
      assert.deepEqual(h.memento.get('ignoredDirs'), []);
      assert.equal(error.mock.callCount(), 0);

      // A directory that cannot be deleted (a symlink) stays ignored
      const real = path.join(home, 'real-b');
      fs.mkdirSync(real);
      const link = accountDir('b');
      fs.symlinkSync(real, link, 'junction');
      await h.store.add({ name: 'b', dir: link });
      await h.handle({ type: 'remove', mode: 'claude', dir: link });
      assert.deepEqual(warning.mock.calls.at(-1)?.arguments[1], { modal: true, detail: t('claude.removeDirDetail') });
      assert.equal(error.mock.callCount(), 1);
      assert.ok(fs.existsSync(real));
      assert.deepEqual(h.memento.get('ignoredDirs'), [link]);
    } finally {
      h.dispose();
    }
  });

  test('switch to a shared account re-links and mirrors first; problems only warn and the switch proceeds', LINUX_ONLY, async (ctx) => {
    const h = harness();
    const dir = await add(h, 's', true);
    // A link replaced by a real file is a conflict; a running session keeps a purged history from being merged
    fs.unlinkSync(path.join(dir, 'CLAUDE.md'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'own');
    fs.unlinkSync(path.join(dir, 'history.jsonl'));
    fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"a":1}\n');
    runningIn(dir, 42);
    let confirm = false;
    ctx.mock.method(window, 'showInformationMessage', async () => (confirm ? t('claude.switchButton') : undefined));
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    try {
      await h.handle({ type: 'switch', mode: 'claude', dir });
      assert.equal(updates.length, 0, 'cancelled confirmation');
      confirm = true;
      await h.handle({ type: 'switch', mode: 'claude', dir });
      const notes = [t('share.r.conflicts', { list: 'CLAUDE.md' }), t('share.r.busy', { list: 'history.jsonl' })].join(t('common.listSep'));
      assert.deepEqual(warning.mock.calls[0].arguments, [t('share.refreshWarning', { label: 's', notes })]);
      assert.equal(configured(), dir);
      assert.equal(h.switchedTo, 's');
      assert.equal(fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8'), '{"a":1}\n');

      // An exception of the mirroring step warns too
      setCurrent(undefined);
      fs.writeFileSync(path.join(home, '.claude.json'), '[]');
      await h.handle({ type: 'switch', mode: 'claude', dir });
      assert.equal(warning.mock.callCount(), 2);
      assert.equal(warning.mock.calls[1].arguments[0], t('share.refreshWarning', { label: 's', notes: t('share.badSource', { file: path.join(home, '.claude.json') }) }));
      assert.equal(configured(), dir);

      // An independent account is not re-linked and gets no warning
      setCurrent(undefined);
      const solo = await add(h, 'i', false);
      await h.handle({ type: 'switch', mode: 'claude', dir: solo });
      assert.equal(warning.mock.callCount(), 2);
      assert.equal(configured(), solo);
    } finally {
      h.dispose();
    }
  });

  test('switch with planswap.claude.confirmSwitch on asks first, off switches without asking', async (ctx) => {
    const h = harness();
    const dir = await add(h, 'quick', false);
    const asked = (calls: ReadonlyArray<{ arguments: unknown[] }>): number =>
      calls.filter((c) => c.arguments[0] === t('claude.switchConfirm', { label: 'quick' })).length;
    const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      setConfig('planswap', CONFIRM_SWITCH_SETTING, true);
      await h.handle({ type: 'switch', mode: 'claude', dir });
      assert.equal(asked(info.mock.calls), 1);
      assert.notEqual(configured(), dir, 'a dismissed confirmation does not switch');
      setConfig('planswap', CONFIRM_SWITCH_SETTING, false);
      await h.handle({ type: 'switch', mode: 'claude', dir });
      assert.equal(asked(info.mock.calls), 1, 'no second confirmation');
      assert.equal(configured(), dir);
    } finally {
      h.dispose();
    }
  });

  test('terminal: a sign-in tip is shown only when the account still has to sign in', async (ctx) => {
    const h = harness();
    const dir = await add(h, 'tip', false);
    const infos = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      await h.handle({ type: 'terminal', mode: 'claude', dir });
      assert.deepEqual(infos.mock.calls.map((c) => c.arguments[0]), [t('account.loginTip', { vendor: 'Claude' })]);
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'tip@example.com' } }));
      await h.handle({ type: 'terminal', mode: 'claude', dir });
      assert.equal(infos.mock.callCount(), 1);
    } finally {
      h.dispose();
    }
  });

  test('share and unshare refuse the current account', async (ctx) => {
    const h = harness();
    const solo = await add(h, 'i', false);
    const shared = await add(h, 's', true);
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => t('share.confirmButton'));
    try {
      setCurrent(solo);
      await h.handle({ type: 'share', mode: 'claude', dir: solo });
      assert.deepEqual(warning.mock.calls[0].arguments, [t('share.current', { label: 'i' })]);
      assert.equal(isSharedClaudeAccount(solo), false);
      setCurrent(shared);
      await h.handle({ type: 'unshare', mode: 'claude', dir: shared });
      assert.deepEqual(warning.mock.calls[1].arguments, [t('unshare.current', { label: 's' })]);
      assert.equal(isSharedClaudeAccount(shared), true);
      assert.equal(warning.mock.callCount(), 2);
    } finally {
      h.dispose();
    }
  });

  test('the share command picks only an independent non-current account and converts it after confirmation', LINUX_ONLY, async (ctx) => {
    const h = harness();
    const current = await add(h, 'current', false);
    const shared = await add(h, 'shared', true);
    const solo = await add(h, 'solo', false);
    await h.labels.set('solo', 'Work');
    setCurrent(current);
    fs.writeFileSync(path.join(solo, 'history.jsonl'), '{"from":"solo"}\n');
    let choose = false;
    const pick = ctx.mock.method(window, 'showQuickPick', async (items: Array<{ label: string; account: { dir: string } }>) => choose ? items[0] : undefined);
    let confirmed = false;
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => confirmed ? t('share.confirmButton') : undefined);
    try {
      const command = commands.registered['planswap.shareAccount'];
      assert.equal(typeof command, 'function');
      await command();
      assert.equal(warning.mock.callCount(), 0, 'cancelled QuickPick does not ask to convert');
      assert.equal(isSharedClaudeAccount(solo), false);
      const items = pick.mock.calls[0].arguments[0] as Array<{ label: string; account: { dir: string } }>;
      assert.deepEqual(items.map((item) => [item.label, item.account.dir]), [['Work', solo]]);
      assert.deepEqual(pick.mock.calls[0].arguments[1], { placeHolder: t('claude.pick.share') });
      choose = true;
      await command();
      assert.deepEqual(warning.mock.calls[0].arguments, [t('share.confirm', { label: 'Work', dir: solo }), { modal: true }, t('share.confirmButton')]);
      assert.equal(isSharedClaudeAccount(solo), false);
      assert.equal(fs.readFileSync(path.join(solo, 'history.jsonl'), 'utf8'), '{"from":"solo"}\n');
      confirmed = true;
      await command();
      assert.equal(isSharedClaudeAccount(solo), true);
      assert.equal(fs.readFileSync(path.join(home, '.claude', 'history.jsonl'), 'utf8'), '{"from":"solo"}\n');
      assert.equal(fs.readFileSync(path.join(solo, 'history.jsonl'), 'utf8'), '{"from":"solo"}\n');
      assert.equal(isSharedClaudeAccount(shared), true);
    } finally {
      h.dispose();
    }
  });

  test('the share command reports no accounts when every named account is current or shared', async (ctx) => {
    const h = harness();
    const current = await add(h, 'current', false);
    await add(h, 'shared', true);
    setCurrent(current);
    const pick = ctx.mock.method(window, 'showQuickPick', async () => undefined);
    const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      await commands.registered['planswap.shareAccount']();
      assert.equal(pick.mock.callCount(), 0);
      assert.deepEqual(info.mock.calls[0].arguments, [t('common.noAccounts')]);
    } finally {
      h.dispose();
    }
  });

  test('unshare: confirmed conversion, cancellation, busy account, and ignored rows', LINUX_ONLY, async (ctx) => {
    const h = harness();
    const shared = await add(h, 's', true);
    const solo = await add(h, 'i', false);
    let answer: string | undefined;
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => answer);
    const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    try {
      // Cancelled
      await h.handle({ type: 'unshare', mode: 'claude', dir: shared });
      assert.deepEqual(warning.mock.calls[0].arguments.slice(0, 2), [t('unshare.confirm', { label: 's', dir: shared }), { modal: true }]);
      assert.equal(isSharedClaudeAccount(shared), true);
      // Busy
      answer = t('unshare.confirmButton');
      runningIn(shared, 43);
      await h.handle({ type: 'unshare', mode: 'claude', dir: shared });
      assert.deepEqual(warning.mock.calls.at(-1)?.arguments, [t('share.busy', { name: 's' })]);
      assert.equal(isSharedClaudeAccount(shared), true);
      // Confirmed
      fs.rmSync(path.join(procRoot(), '43'), { recursive: true });
      await h.handle({ type: 'unshare', mode: 'claude', dir: shared });
      assert.equal(isSharedClaudeAccount(shared), false);
      assert.deepEqual(info.mock.calls[0].arguments, [
        t('unshare.done', { label: 's', removed: CLAUDE_SHARED_ENTRIES.length, copied: 'settings.json, CLAUDE.md, agents, commands, output-styles, hooks, rules' }),
      ]);
      // The default and independent rows are ignored without a dialog
      const calls = warning.mock.callCount();
      await h.handle({ type: 'unshare', mode: 'claude', dir: path.join(home, '.claude') });
      await h.handle({ type: 'unshare', mode: 'claude', dir: solo });
      assert.equal(warning.mock.callCount(), calls);
      assert.equal(info.mock.callCount(), 1);
    } finally {
      h.dispose();
    }
  });
});
