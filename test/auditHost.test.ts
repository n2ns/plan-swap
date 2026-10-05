// Host-side audit fixes: account safety re-checks, panel message robustness, terminal command lines, Windows
// re-enable, status bar and palette matching, environment warnings. Every file-system step runs in a temporary HOME.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { AccountStore } from '../src/accounts';
import { AccountsPanel, checkMessage, type PanelSource } from '../src/accountsPanel';
import { ensureClaudeLinks, isSharedClaudeAccount } from '../src/claudeShare';
import { isExplicitConfigDir } from '../src/claudeSettings';
import { registerCodexCommands } from '../src/codex/codexCommands';
import { CODEX_DEFAULT_NAME, codexAccountDir, type CodexAccount } from '../src/codex/codexPaths';
import { STATE_FILE, installRcBlocks, writeSelectedDir } from '../src/codex/codexState';
import { CodexAccountStore } from '../src/codex/codexStore';
import { hasControlChars, registerCommands } from '../src/commands';
import { showEnvironmentWarnings } from '../src/extension';
import { STATE_JSON } from '../src/fileState';
import { setLocale, t } from '../src/i18n';
import { LabelStore } from '../src/labels';
import { accountDir, type Account } from '../src/paths';
import type { FromWebview, ToWebview } from '../src/protocol';
import { StatusBar } from '../src/statusBar';
import { runTool, type TerminalCheck } from '../src/tools';
import { commands, resetConfig, setConfig, statusBarItems, tooltipText, window, type StubTerminal } from './stubs/vscode';
import { LINUX_ONLY, makeTempHome, MemoryMemento, onWindows, read, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
before(() => {
  setLocale('en');
  tmp = makeTempHome('audit-host');
  home = tmp.home;
});
after(() => tmp.restore());
afterEach(() => {
  resetConfig();
  delete process.env.CODEX_HOME;
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
});

type Ctx = { mock: { method: typeof import('node:test').mock.method } };

// Runs fn with process.platform reported as win32 (isWindows() reads it on every call)
async function asWindows<T>(fn: () => T | Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

// Records created terminals instead of the stub's default
function captureTerminals(ctx: Ctx): StubTerminal[] {
  const created: StubTerminal[] = [];
  ctx.mock.method(window, 'createTerminal', (options: { name: string }) => {
    const terminal: StubTerminal = { name: options.name, sent: [], shown: 0, sendText(text) { terminal.sent.push(text); }, show() { terminal.shown++; } };
    created.push(terminal);
    return terminal;
  });
  return created;
}

const setCurrent = (dir: string | undefined): void =>
  setConfig('claudeCode', 'environmentVariables', dir ? [{ name: 'CLAUDE_CONFIG_DIR', value: dir }] : []);

// ---------------------------------------------------------------------------------------------------------------
// Claude harness
interface ClaudeHarness {
  store: AccountStore;
  labels: LabelStore;
  handle(msg: FromWebview): Promise<void>;
  posted: ToWebview[];
  terminalOpen: TerminalCheck;
  closeTerminal?: (terminal: unknown) => void;
  dispose(): void;
}
const procRoot = (): string => path.join(home, 'fakeproc');
// Fake process tree entry: a Claude process of dir with pid, plus the session file that names it
function claudeRunningIn(dir: string, pid: number): void {
  fs.mkdirSync(path.join(procRoot(), String(pid)), { recursive: true });
  fs.writeFileSync(path.join(procRoot(), String(pid), 'environ'), `PATH=/bin\0CLAUDE_CONFIG_DIR=${dir}\0`);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid }));
}
function claudeHarness(ctx?: Ctx): ClaudeHarness {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  const memento = new MemoryMemento();
  const store = new AccountStore(memento);
  const labels = new LabelStore(memento, 'claude.labels');
  const h = { store, labels, posted: [] as ToWebview[] } as unknown as ClaudeHarness;
  if (ctx) {
    ctx.mock.method(window, 'onDidCloseTerminal', (listener: (terminal: unknown) => void) => {
      h.closeTerminal = listener;
      return { dispose() {} };
    });
  }
  const panel = {
    setHandler(_mode: string, handler: ClaudeHarness['handle']) { h.handle = handler; },
    resolve(_mode: string, dir: string) {
      const a = store.findByDir(dir);
      return a && { ...a, kind: a.name === 'default' ? 'default' : 'named' };
    },
    refresh() {},
    post(msg: ToWebview) { h.posted.push(msg); },
    setSwitchedTo() {},
    visible: true,
    focusAdd() {},
  } as unknown as AccountsPanel;
  const statusBar = { update() {} } as unknown as StatusBar;
  const disposables = registerCommands({
    store, panel, statusBar, labels, tools: {}, procRoot: procRoot(),
    provideTerminalCheck: (check) => { h.terminalOpen = check; },
  });
  h.dispose = () => disposables.forEach((d) => d.dispose());
  return h;
}
async function addClaude(h: ClaudeHarness, name: string, shared: boolean): Promise<string> {
  const dir = accountDir(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (shared) ensureClaudeLinks(dir);
  await h.store.add({ name, dir });
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------
// Codex harness
interface CodexHarness {
  store: CodexAccountStore;
  labels: LabelStore;
  handle(msg: FromWebview): Promise<void>;
  posted: ToWebview[];
  terminalOpen: TerminalCheck;
  dispose(): void;
}
async function codexHarness(accounts: CodexAccount[] = []): Promise<CodexHarness> {
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
  const state = new MemoryMemento();
  const store = new CodexAccountStore(state);
  const labels = new LabelStore(state, 'codex.labels');
  for (const a of accounts) {
    fs.mkdirSync(a.dir, { recursive: true, mode: 0o700 });
    await store.add(a);
  }
  const h = { store, labels, posted: [] as ToWebview[] } as unknown as CodexHarness;
  const panel = {
    setHandler(_mode: string, handler: CodexHarness['handle']) { h.handle = handler; },
    resolve(_mode: string, dir: string) {
      const a = store.findByDir(dir);
      return a && { name: a.name, dir: a.dir, kind: a.name === CODEX_DEFAULT_NAME ? 'default' : 'named' };
    },
    refresh() {},
    post(msg: ToWebview) { h.posted.push(msg); },
  } as unknown as AccountsPanel;
  const disposables = registerCodexCommands({ store, labels, panel, tools: {}, provideTerminalCheck: (check) => { h.terminalOpen = check; } });
  h.dispose = () => disposables.forEach((d) => d.dispose());
  return h;
}
const codexNamed = (name: string): CodexAccount => ({ name, dir: codexAccountDir(name) });
// A live app-server daemon pid file of this process (Linux: with its start ticks), as codexDaemonAlive reads it
function codexDaemonRunning(dir: string): void {
  const data: Record<string, unknown> = { pid: process.pid };
  if (!onWindows) {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    data.processIdentity = { startTicks: Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]) };
  }
  fs.mkdirSync(path.join(dir, 'app-server-daemon'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-server-daemon', 'daemon.pid'), JSON.stringify(data));
}

// ---------------------------------------------------------------------------------------------------------------
describe('adding a shared Claude account never replaces an existing account\'s own MCP servers', () => {
  test('an existing folder that cannot be linked keeps its servers and only gains the default ones', async (ctx) => {
    ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { def: { command: 'd' } } }));
    const h = claudeHarness();
    // Kept from earlier: a real projects folder (a conflict, so it stays independent) and its own MCP server
    const dir = accountDir('keep');
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'p.jsonl'), 'x');
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { own: { command: 'o' } }, other: 1 }));
    try {
      await h.handle({ type: 'add', mode: 'claude', name: 'keep', shared: true });
      assert.deepEqual(h.posted.at(-1), { type: 'addResult', mode: 'claude', error: undefined });
      assert.equal(isSharedClaudeAccount(dir), false);
      const json = JSON.parse(read(path.join(dir, '.claude.json')));
      assert.deepEqual(json.mcpServers, { own: { command: 'o' }, def: { command: 'd' } });
      assert.equal(json.other, 1);

      // A fresh shared account is mirrored as before
      await h.handle({ type: 'add', mode: 'claude', name: 'fresh', shared: true });
      assert.equal(isSharedClaudeAccount(accountDir('fresh')), true);
      assert.deepEqual(JSON.parse(read(path.join(accountDir('fresh'), '.claude.json'))).mcpServers, { def: { command: 'd' } });
    } finally {
      h.dispose();
    }
  });
});

describe('account terminals count as busy for the linking steps', () => {
  test('both command modules provide a check that is true only for a folder with an open account terminal on Windows', async (ctx) => {
    captureTerminals(ctx);
    ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const claude = claudeHarness();
    const a = await addClaude(claude, 'a', false);
    const b = await addClaude(claude, 'b', false);
    const cx = codexNamed('c');
    const codex = await codexHarness([cx, codexNamed('d')]);
    try {
      await asWindows(async () => {
        assert.equal(claude.terminalOpen(a), false);
        await claude.handle({ type: 'terminal', mode: 'claude', dir: a });
        assert.equal(claude.terminalOpen(a), true);
        assert.equal(claude.terminalOpen(b), false);
        assert.equal(codex.terminalOpen(cx.dir), false);
        await codex.handle({ type: 'terminal', mode: 'codex', dir: cx.dir });
        assert.equal(codex.terminalOpen(cx.dir), true);
        assert.equal(codex.terminalOpen(codexAccountDir('d')), false);
      });
      // Linux: /proc already sees terminal processes, so the terminal itself is no extra signal
      if (!onWindows) assert.equal(claude.terminalOpen(a), false);
    } finally {
      claude.dispose();
      codex.dispose();
    }
  });

  test('Re-link (sync) passes the caller\'s busy predicate for each account into the linking step', async (ctx) => {
    ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    const dirs = [path.join(home, '.codex-x'), path.join(home, '.codex-y')];
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    const received: Array<{ dir: string; busy: boolean | undefined }> = [];
    const asked: string[] = [];
    await runTool('codex', 'sync', {
      codexDirs: () => dirs,
      codexShareOps: {
        isShared: () => true,
        refresh(dir, options) {
          received.push({ dir, busy: options?.busy?.() });
          return { linked: [], created: [], conflicts: [], refused: [] } as never;
        },
      },
      accountBusy: (mode, dir) => {
        asked.push(`${mode}:${dir}`);
        return dir === dirs[1];
      },
    });
    assert.deepEqual(received, [{ dir: dirs[0], busy: false }, { dir: dirs[1], busy: true }]);
    assert.deepEqual(asked, dirs.map((d) => `codex:${d}`));
  });
});

describe('removal and conversion re-check the account after every modal', () => {
  test('Claude: an account made current while the delete-folder prompt was open is not deleted', async (ctx) => {
    const h = claudeHarness();
    const dir = await addClaude(h, 'raced', false);
    const shown: string[] = [];
    ctx.mock.method(window, 'showWarningMessage', async (message: string) => {
      shown.push(message);
      if (message !== t('account.removeDirPrompt', { label: 'raced', dir })) return undefined;
      setCurrent(dir); // another window switches to it meanwhile
      return t('common.deleteDir');
    });
    try {
      await h.handle({ type: 'remove', mode: 'claude', dir });
      assert.ok(fs.existsSync(dir), 'the directory survives');
      assert.equal(shown.at(-1), t('claude.removeCurrent', { label: 'raced' }));
      assert.equal(h.store.find('raced'), undefined, 'the list entry was already removed');
    } finally {
      h.dispose();
    }
  });

  test('Claude: an account whose Claude process started while the prompts were open is not deleted', async (ctx) => {
    const h = claudeHarness();
    const dir = await addClaude(h, 'late', false);
    const shown: string[] = [];
    ctx.mock.method(window, 'showWarningMessage', async (message: string) => {
      shown.push(message);
      if (message === t('claude.removeConfirm', { label: 'late' })) return t('common.delete');
      if (message !== t('account.removeDirPrompt', { label: 'late', dir })) return undefined;
      claudeRunningIn(dir, 61);
      return t('common.deleteDir');
    });
    ctx.mock.method(window, 'showQuickPick', async (items: Array<{ account: Account }>) => items.find((i) => i.account.name === 'late'));
    try {
      // Command Palette entry: its own confirmation, then the folder prompt
      await commands.registered['planswap.removeAccount']();
      assert.ok(fs.existsSync(dir));
      assert.equal(shown.at(-1), t('share.busy', { name: 'late' }));
    } finally {
      h.dispose();
    }
  });

  test('Claude: share and unshare re-check the current account after their confirmation', async (ctx) => {
    const h = claudeHarness();
    const solo = await addClaude(h, 'solo', false);
    const shared = await addClaude(h, 'linked', true);
    const shown: string[] = [];
    ctx.mock.method(window, 'showWarningMessage', async (message: string) => {
      shown.push(message);
      if (message === t('share.confirm', { label: 'solo', dir: solo })) {
        setCurrent(solo);
        return t('share.confirmButton');
      }
      if (message === t('unshare.confirm', { label: 'linked', dir: shared })) {
        setCurrent(shared);
        return t('unshare.confirmButton');
      }
      return undefined;
    });
    try {
      await h.handle({ type: 'share', mode: 'claude', dir: solo });
      assert.equal(shown.at(-1), t('share.current', { label: 'solo' }));
      assert.equal(isSharedClaudeAccount(solo), false);
      setCurrent(undefined);
      await h.handle({ type: 'unshare', mode: 'claude', dir: shared });
      assert.equal(shown.at(-1), t('unshare.current', { label: 'linked' }));
      assert.equal(isSharedClaudeAccount(shared), true);
    } finally {
      h.dispose();
    }
  });

  test('Codex: a busy account is refused before any modal and again right before deletion', async (ctx) => {
    const a = codexNamed('busy');
    const b = codexNamed('later');
    const h = await codexHarness([a, b]);
    writeSelectedDir(undefined);
    const shown: string[] = [];
    ctx.mock.method(window, 'showWarningMessage', async (message: string) => {
      shown.push(message);
      if (message !== t('account.removeDirPrompt', { label: 'later', dir: b.dir })) return undefined;
      codexDaemonRunning(b.dir); // a Codex daemon of the account starts meanwhile
      return t('common.deleteDir');
    });
    try {
      codexDaemonRunning(a.dir);
      await h.handle({ type: 'remove', mode: 'codex', dir: a.dir });
      assert.deepEqual(shown, [t('share.busyCodex', { name: 'busy' })]);
      assert.ok(h.store.find('busy'));
      assert.ok(fs.existsSync(a.dir));

      await h.handle({ type: 'remove', mode: 'codex', dir: b.dir });
      assert.equal(shown.at(-1), t('share.busyCodex', { name: 'later' }));
      assert.ok(fs.existsSync(b.dir), 'the directory survives');
      assert.equal(h.store.find('later'), undefined);
    } finally {
      h.dispose();
    }
  });

  test('Codex: an open account terminal on Windows blocks removal', async (ctx) => {
    captureTerminals(ctx);
    ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const a = codexNamed('term');
    const h = await codexHarness([a]);
    const warnings = ctx.mock.method(window, 'showWarningMessage', async () => t('common.deleteDir'));
    try {
      await asWindows(async () => {
        await h.handle({ type: 'terminal', mode: 'codex', dir: a.dir });
        await h.handle({ type: 'remove', mode: 'codex', dir: a.dir });
      });
      assert.deepEqual(warnings.mock.calls.map((c) => c.arguments[0]), [t('share.busyCodex', { name: 'term' })]);
      assert.ok(h.store.find('term'));
    } finally {
      h.dispose();
    }
  });

  test('Codex: share and unshare re-check the selection after their confirmation', async (ctx) => {
    const a = codexNamed('conv');
    const h = await codexHarness([a]);
    writeSelectedDir(undefined);
    const shown: string[] = [];
    ctx.mock.method(window, 'showWarningMessage', async (message: string) => {
      shown.push(message);
      if (message === t(onWindows ? 'share.confirmCodexWindows' : 'share.confirmCodex', { label: 'conv', dir: a.dir })) {
        writeSelectedDir(a.dir);
        return t('share.confirmButton');
      }
      return undefined;
    });
    try {
      await h.handle({ type: 'share', mode: 'codex', dir: a.dir });
      assert.equal(shown.at(-1), t('share.current', { label: 'conv' }));
      assert.ok(!fs.existsSync(path.join(a.dir, 'sessions')), 'nothing was linked');
    } finally {
      h.dispose();
    }
  });
});

describe('the panel never keeps waiting and never sees an unhandled rejection', () => {
  test('add and rename answer with the error text when a step throws (both vendors)', async (ctx) => {
    const claude = claudeHarness();
    const a = await addClaude(claude, 'a', false);
    const cx = codexNamed('c');
    const codex = await codexHarness([cx]);
    ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    ctx.mock.method(claude.store, 'add', async () => { throw new Error('state write failed'); });
    ctx.mock.method(codex.store, 'add', async () => { throw new Error('state write failed'); });
    ctx.mock.method(claude.labels, 'set', async () => { throw new Error('alias write failed'); });
    ctx.mock.method(codex.labels, 'set', async () => { throw new Error('alias write failed'); });
    try {
      await claude.handle({ type: 'add', mode: 'claude', name: 'n', shared: false });
      assert.deepEqual(claude.posted.at(-1), { type: 'addResult', mode: 'claude', error: 'state write failed' });
      await claude.handle({ type: 'rename', mode: 'claude', dir: a, label: 'Work' });
      assert.deepEqual(claude.posted.at(-1), { type: 'renameResult', mode: 'claude', dir: a, error: 'alias write failed' });
      await codex.handle({ type: 'add', mode: 'codex', name: 'n', shared: false });
      assert.deepEqual(codex.posted.at(-1), { type: 'addResult', mode: 'codex', error: 'state write failed' });
      await codex.handle({ type: 'rename', mode: 'codex', dir: cx.dir, label: 'Work' });
      assert.deepEqual(codex.posted.at(-1), { type: 'renameResult', mode: 'codex', dir: cx.dir, error: 'alias write failed' });
    } finally {
      claude.dispose();
      codex.dispose();
    }
  });

  function panelHarness() {
    let receive!: (msg: unknown) => void;
    const view = {
      visible: true,
      webview: {
        html: '', options: {}, cspSource: 'test-resource:',
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: async () => true,
        onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
      },
      onDidChangeVisibility: () => {},
      onDidDispose: () => {},
    };
    const source: PanelSource = { accounts: () => [], enabled: () => true, pendingDir: () => undefined, watchTargets: () => [] };
    const memento = new MemoryMemento();
    const panel = new AccountsPanel({ path: '/extension' } as vscode.Uri, { claude: source, codex: source }, memento);
    panel.resolveWebviewView(view as unknown as vscode.WebviewView);
    return { panel, memento, receive: (msg: unknown) => receive(msg) };
  }

  test('a handler failure is logged and shown as an error message', async (ctx) => {
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const logged = ctx.mock.method(console, 'error', () => {});
    const h = panelHarness();
    try {
      h.panel.setHandler('claude', async () => { throw new Error('boom'); });
      await h.panel.dispatch({ type: 'switch', mode: 'claude', dir: '/x' });
      assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), [t('panel.actionFailed', { error: 'boom' })]);
      assert.equal(logged.mock.callCount(), 1);
    } finally {
      h.panel.dispose();
    }
  });

  test('malformed messages never reach a handler or the memento', (ctx) => {
    ctx.mock.method(console, 'warn', () => {});
    const h = panelHarness();
    const seen: FromWebview[] = [];
    h.panel.setHandler('claude', (msg) => { seen.push(msg); });
    h.panel.setHandler('codex', (msg) => { seen.push(msg); });
    try {
      for (const bad of [
        null, 'switch', 42, {}, { type: 'nope', mode: 'claude' },
        { type: 'switch', mode: 'other', dir: '/x' }, { type: 'switch', dir: '/x' }, { type: 'switch', mode: '__proto__', dir: '/x' },
        { type: 'switch', mode: 'claude' }, { type: 'remove', mode: 'codex', dir: 1 }, { type: 'add', mode: 'claude', name: ['a'] },
        { type: 'rename', mode: 'claude', dir: '/x' }, { type: 'rename', mode: 'claude', dir: '/x', label: {} },
        { type: 'tool', mode: 'claude' }, { type: 'setTab', mode: 'toString' }, { type: 'toString', mode: 'claude' },
        { type: 'recommendExclude', mode: 'claude', excluded: true },
      ]) {
        assert.equal(checkMessage(bad), undefined, JSON.stringify(bad));
        h.receive(bad);
      }
      assert.deepEqual(seen, []);
      assert.equal(h.memento.get('panel.activeTab'), undefined);

      const good: FromWebview[] = [
        { type: 'switch', mode: 'claude', dir: '/x' },
        { type: 'rename', mode: 'codex', dir: '/x', label: 'L' },
        { type: 'add', mode: 'codex', name: 'n', shared: true },
        { type: 'recommendExclude', mode: 'claude', dir: '/x', excluded: true },
      ];
      for (const msg of good) {
        assert.equal(checkMessage(msg), msg);
        h.receive(msg);
      }
      assert.deepEqual(seen, good);
    } finally {
      h.panel.dispose();
    }
  });
});

describe('terminal command lines never carry control characters', () => {
  test('hasControlChars', () => {
    for (const s of ['a\nb', 'a\rb', 'a\tb', 'a\x00b', 'a\x1bb', 'a\x7fb']) assert.equal(hasControlChars(s), true, JSON.stringify(s));
    for (const s of ['/home/u/.claude-a', `it's`, '$HOME', 'ä b']) assert.equal(hasControlChars(s), false, s);
  });

  test('both vendors refuse a folder with a control character and create no terminal', LINUX_ONLY, async (ctx) => {
    const created = captureTerminals(ctx);
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const claude = claudeHarness();
    const codex = await codexHarness();
    const claudeDir = path.join(home, '.claude-a\nrm -rf x');
    const codexDir = path.join(home, '.codex-a\ntouch y');
    await claude.store.add({ name: 'a', dir: claudeDir });
    await codex.store.add({ name: 'a', dir: codexDir });
    try {
      await claude.handle({ type: 'terminal', mode: 'claude', dir: claudeDir });
      await codex.handle({ type: 'terminal', mode: 'codex', dir: codexDir });
      assert.equal(created.length, 0);
      assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), [
        t('terminal.badDir', { dir: JSON.stringify(claudeDir) }),
        t('terminal.badDir', { dir: JSON.stringify(codexDir) }),
      ]);
      // An ordinary folder still gets its env prefix
      const ok = await addClaude(claude, 'ok', false);
      await claude.handle({ type: 'terminal', mode: 'claude', dir: ok });
      assert.deepEqual(created.map((c) => c.sent), [[`env CLAUDE_CONFIG_DIR='${ok}' claude`]]);
    } finally {
      claude.dispose();
      codex.dispose();
    }
  });
});

describe('Windows Codex re-enable', () => {
  // The self-check writes a user variable through powershell.exe: refuse every child process (and hide PATH as a second
  // guard), so a failed self-check is simulated without touching the real user environment
  function blockChildProcesses(ctx: Ctx): { files: string[]; restore(): void } {
    const files: string[] = [];
    ctx.mock.method(childProcess, 'execFileSync', ((file: string) => {
      files.push(file);
      throw new Error(`blocked ${file}`);
    }) as unknown as typeof childProcess.execFileSync);
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    return { files, restore: () => { process.env.PATH = savedPath; } };
  }

  test('a failed self-check keeps a state file that existed before, and removes one this run created', async (ctx) => {
    const blocked = blockChildProcesses(ctx);
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    ctx.mock.method(window, 'showWarningMessage', async () => t('codex.enableButton'));
    const h = await codexHarness();
    const keep = path.join(home, '.codex-keep');
    try {
      await asWindows(async () => {
        writeSelectedDir(keep);
        await h.handle({ type: 'enable', mode: 'codex' });
        assert.equal(errors.mock.callCount(), 1);
        const failed = t('codex.win.selfCheckFailed', { detail: t('codex.self.error', { error: 'blocked powershell.exe' }) });
        assert.equal(errors.mock.calls[0].arguments[0], failed);
        assert.equal(read(STATE_FILE()), keep, 'the existing state file is kept');

        fs.rmSync(STATE_FILE());
        await h.handle({ type: 'enable', mode: 'codex' });
        assert.equal(errors.mock.callCount(), 2);
        assert.ok(!fs.existsSync(STATE_FILE()), 'the state file created by this run is rolled back');
      });
      assert.ok(blocked.files.length > 0 && blocked.files.every((f) => f === 'powershell.exe'), 'only the blocked stub ran');
    } finally {
      blocked.restore();
      h.dispose();
    }
  });
});

describe('status bar', () => {
  test('a Codex account signed in without an email shows its label; pending only while switching is enabled', async () => {
    const state = new MemoryMemento();
    const store = new CodexAccountStore(state);
    const work = path.join(home, '.codex-work');
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'auth.json'), '{}');
    await store.add({ name: 'work', dir: work });
    process.env.CODEX_HOME = work;
    const bar = new StatusBar(new AccountStore(state), new LabelStore(state, 'claude.labels'), { store, labels: new LabelStore(state, 'codex.labels') });
    const item = statusBarItems.at(-1)!;
    try {
      assert.equal(item.text, '$(dashboard) Codex');
      assert.equal(tooltipText(item.tooltip), '| **work** |  |');
      // The selection (default) differs from the effective account, but PlanSwap does not manage CODEX_HOME
      assert.doesNotMatch(tooltipText(item.tooltip), /Pending:/);
      if (onWindows) writeSelectedDir(undefined);
      else installRcBlocks();
      bar.update();
      assert.match(tooltipText(item.tooltip), /^\| \*\*work\*\* \|  \|\n\| _Pending: default \(restart required\)_ \|$/);
    } finally {
      bar.dispose();
    }
  });

  test('another spelling of a registered folder shows that account, not the external row', async () => {
    const state = new MemoryMemento();
    const store = new AccountStore(state);
    const real = path.join(home, '.claude-real');
    fs.mkdirSync(real);
    const link = path.join(home, 'link-to-real');
    fs.symlinkSync(real, link, 'junction');
    await store.add({ name: 'real', dir: real });
    setCurrent(link);
    const bar = new StatusBar(store, new LabelStore(state, 'claude.labels'));
    try {
      assert.equal(statusBarItems.at(-1)!.text, '$(dashboard) Claude');
      // Not signed in, so the first line is the sign-in state; the registered label only shows with a signed-in account without email
      assert.equal(tooltipText(statusBarItems.at(-1)!.tooltip), '| **Not logged in** |  |');
    } finally {
      bar.dispose();
    }
  });
});

describe('another spelling of the configured Claude folder', () => {
  test('counts as explicit, and the Command Palette neither adds an external entry nor offers the current account', async (ctx) => {
    const h = claudeHarness();
    const real = await addClaude(h, 'real', false);
    const other = await addClaude(h, 'other', false);
    const link = path.join(home, 'link-to-real');
    fs.symlinkSync(real, link, 'junction');
    setCurrent(link);
    const offered: string[][] = [];
    ctx.mock.method(window, 'showQuickPick', async (items: Array<{ account: Account }>) => {
      offered.push(items.map((i) => i.account.name));
      return undefined;
    });
    try {
      assert.equal(isExplicitConfigDir(real), true);
      assert.equal(isExplicitConfigDir(other), false);
      await commands.registered['planswap.switchAccount']();
      await commands.registered['planswap.openTerminal']();
      assert.deepEqual(offered.map((names) => [...names].sort()), [['default', 'other'], ['default', 'other', 'real']]);
    } finally {
      h.dispose();
    }
  });
});

describe('closing a Claude account terminal', () => {
  test('warns about a missing sign-in only while the account is registered and its folder exists', async (ctx) => {
    const created = captureTerminals(ctx);
    ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const warnings = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    const h = claudeHarness(ctx);
    const kept = await addClaude(h, 'kept', false);
    const removed = await addClaude(h, 'removed', false);
    const deleted = await addClaude(h, 'deleted', false);
    try {
      for (const dir of [kept, removed, deleted]) await h.handle({ type: 'terminal', mode: 'claude', dir });
      await h.store.remove('removed');
      fs.rmSync(deleted, { recursive: true });
      for (const terminal of created) h.closeTerminal?.(terminal);
      const key = onWindows ? 'claude.win.loginNotLanded' : 'claude.loginNotLanded';
      assert.deepEqual(warnings.mock.calls.map((c) => c.arguments[0]), [t(key, { dir: kept })]);
    } finally {
      h.dispose();
    }
  });
});

describe('environment warnings', () => {
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ PATH: '/bin', ...extra });
  const noSetting = { set: [], cleared: [] };

  test('each condition warns once; "Don\'t Show Again" persists its id; a new set of variable names warns again', async (ctx) => {
    const state = new MemoryMemento();
    let answer: string | undefined = t('common.dontShowAgain');
    const warnings = ctx.mock.method(window, 'showWarningMessage', async () => answer);
    const e1 = env({ ANTHROPIC_API_KEY: 'x', CODEX_HOME: ' /c' });
    await showEnvironmentWarnings(state, e1, home, noSetting);
    assert.deepEqual(warnings.mock.calls.map((c) => c.arguments), [
      [t('warn.claudeEnvOverride', { names: 'ANTHROPIC_API_KEY' }), t('common.dontShowAgain')],
      [t('warn.pathSpaces', { names: 'CODEX_HOME' }), t('common.dontShowAgain')],
    ]);
    assert.deepEqual(state.get('warnings.dismissed'), ['claudeEnv:ANTHROPIC_API_KEY', 'pathSpaces:CODEX_HOME']);

    // Dismissed for good: nothing is shown again
    await showEnvironmentWarnings(state, e1, home, noSetting);
    assert.equal(warnings.mock.callCount(), 2);

    // Another variable joins: a new id, so the warning returns; closing it without the button keeps it undismissed
    answer = undefined;
    const e2 = env({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', CODEX_HOME: ' /c' });
    await showEnvironmentWarnings(state, e2, home, noSetting);
    assert.deepEqual(warnings.mock.calls.slice(2).map((c) => c.arguments[0]), [t('warn.claudeEnvOverride', { names: 'ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY' })]);
    await showEnvironmentWarnings(state, e2, home, noSetting);
    assert.equal(warnings.mock.callCount(), 4);
    assert.deepEqual(state.get('warnings.dismissed'), ['claudeEnv:ANTHROPIC_API_KEY', 'pathSpaces:CODEX_HOME']);
  });

  test('"Don\'t Show Again" that cannot be saved reports the state file instead of failing silently', async (ctx) => {
    const state = new MemoryMemento();
    ctx.mock.method(state, 'update', async () => { throw new Error('EACCES: permission denied'); });
    ctx.mock.method(window, 'showWarningMessage', async () => t('common.dontShowAgain'));
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    await showEnvironmentWarnings(state, env({ ANTHROPIC_API_KEY: 'x' }), home, noSetting);
    assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), [t('ext.stateSaveFailed', { file: STATE_JSON(), error: 'EACCES: permission denied' })]);
  });

  test('nothing to warn about shows nothing', async (ctx) => {
    const warnings = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    await showEnvironmentWarnings(new MemoryMemento(), env({}), home, noSetting);
    assert.equal(warnings.mock.callCount(), 0);
  });
});
