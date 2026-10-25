import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { parseAccountUri } from '../src/accountUri';
import { AccountStore } from '../src/accounts';
import type { AccountsPanel } from '../src/accountsPanel';
import { currentDir } from '../src/claudeSettings';
import { ensureClaudeLinks } from '../src/claudeShare';
import { registerCommands } from '../src/commands';
import { t } from '../src/i18n';
import { LabelStore } from '../src/labels';
import { accountDir, defaultDir } from '../src/paths';
import type { StatusBar } from '../src/statusBar';
import { commands, dispatchUri, env, resetConfig, setConfig, updates, uriHandlers, window, workspace } from './stubs/vscode';
import { LINUX_ONLY, makeTempHome, MemoryMemento, restoreEnv, type TempHome } from './helpers';

type UriParts = Pick<vscode.Uri, 'scheme' | 'authority' | 'path' | 'query' | 'fragment'>;
const uri = (query = 'account=default', overrides: Partial<UriParts> = {}): UriParts => ({
  scheme: 'vscode', authority: 'n2ns.planswap', path: '/switch', query, fragment: '', ...overrides,
});
const wsl = { uriScheme: 'vscode', platform: 'linux' as const, remoteName: 'wsl', distro: 'Ubuntu_26' };

describe('account URI parsing', () => {
  test('accepts default and named accounts, encoded characters, and the active editor scheme', () => {
    assert.deepEqual(parseAccountUri(uri(), wsl), { account: 'default', reload: false });
    assert.deepEqual(parseAccountUri(uri('account=Work%5F2&reload=1&distro=Ubuntu_26'), wsl), { account: 'Work_2', reload: true });
    assert.deepEqual(parseAccountUri(uri('account=default', { scheme: 'vscodium' }), { ...wsl, uriScheme: 'vscodium' }), { account: 'default', reload: false });
  });

  test('rejects an unsupported endpoint, scheme, authority or fragment', () => {
    for (const overrides of [{ scheme: 'vscodium' }, { authority: 'other.extension' }, { path: '/other' }, { path: '/switch/' }, { fragment: 'reload=1' }]) {
      assert.throws(() => parseAccountUri(uri('account=default', overrides), wsl), JSON.stringify(overrides));
    }
  });

  test('rejects missing, empty, invalid, duplicate and unknown parameters', () => {
    for (const query of ['', 'reload=1', 'account=', 'account=a+b', 'account=../work', 'account=a%00',
      'account=work&account=default', 'account=work&%61ccount=default', 'account=work&extra=1',
      'account=work&reload=1&reload=1', 'account=work&target=wsl&target=wsl',
      'account=work&distro=Ubuntu_26&distro=Ubuntu_26', 'account=work&target=', 'account=work&target=linux', 'account=work&distro=']) {
      assert.throws(() => parseAccountUri(uri(query), wsl), query);
    }
  });

  test('rejects malformed percent encoding and does not decode account values twice', () => {
    for (const query of ['account=%', 'account=%GG', 'account=%C3%28', 'account=work&distro=%FF', 'account=%2564efault']) {
      assert.throws(() => parseAccountUri(uri(query), wsl), query);
    }
  });

  test('reload is either absent or exactly 1', () => {
    assert.equal(parseAccountUri(uri('account=default&reload=1'), wsl).reload, true);
    for (const value of ['', '0', 'true', '2', '01', '1+']) {
      assert.throws(() => parseAccountUri(uri(`account=default&reload=${value}`), wsl), value);
    }
  });

  test('the default WSL target requires a WSL remote host and an optional matching distribution', () => {
    assert.deepEqual(parseAccountUri(uri('account=default&target=wsl&distro=Ubuntu_26'), wsl), { account: 'default', reload: false });
    for (const context of [{ ...wsl, platform: 'win32' as const }, { ...wsl, remoteName: undefined },
      { ...wsl, remoteName: 'ssh-remote' }, { ...wsl, distro: undefined }, { ...wsl, distro: '' }]) {
      assert.throws(() => parseAccountUri(uri(), context), { message: t('uri.wslRequired') });
    }
    assert.throws(() => parseAccountUri(uri('account=default&distro=ubuntu_26'), wsl), { message: t('uri.distroMismatch', { distro: 'ubuntu_26' }) });
  });

  test('Windows requires an explicit target and refuses WSL distribution constraints', () => {
    const windows = { ...wsl, platform: 'win32' as const, remoteName: undefined, distro: undefined };
    assert.throws(() => parseAccountUri(uri(), windows), { message: t('uri.wslRequired') });
    assert.deepEqual(parseAccountUri(uri('account=default&target=windows'), windows), { account: 'default', reload: false });
    assert.throws(() => parseAccountUri(uri('account=default&target=windows'), wsl), { message: t('uri.windowsRequired') });
    assert.throws(() => parseAccountUri(uri('account=default&target=windows'), { ...windows, remoteName: 'ssh-remote' }));
    assert.throws(() => parseAccountUri(uri('account=default&target=windows&distro=Ubuntu_26'), windows));
  });
});

describe('registered Claude account URI handler', () => {
  let tmp: TempHome;
  let savedDistro: string | undefined;
  let savedRemote: string | undefined;
  let savedScheme: string;
  let disposables: vscode.Disposable[];
  let store: AccountStore;
  let labels: LabelStore;
  let switchedTo: string | undefined;

  beforeEach(() => {
    tmp = makeTempHome('account-uri');
    savedDistro = process.env.WSL_DISTRO_NAME;
    savedRemote = env.remoteName;
    savedScheme = env.uriScheme;
    process.env.WSL_DISTRO_NAME = 'Ubuntu_26';
    env.remoteName = process.platform === 'win32' ? undefined : 'wsl';
    env.uriScheme = 'vscode';
    resetConfig();
    fs.mkdirSync(defaultDir());
    const state = new MemoryMemento();
    store = new AccountStore(state);
    labels = new LabelStore(state, 'claude.labels');
    switchedTo = undefined;
    const panel = {
      setHandler() {}, refresh() {}, visible: true,
      setSwitchedTo(label: string) { switchedTo = label; },
    } as unknown as AccountsPanel;
    disposables = registerCommands({ store, labels, panel, statusBar: { update() {} } as unknown as StatusBar,
      tools: {}, procRoot: path.join(tmp.home, 'fake-proc') });
  });
  afterEach(() => {
    for (const disposable of disposables) disposable.dispose();
    env.remoteName = savedRemote;
    env.uriScheme = savedScheme;
    restoreEnv('WSL_DISTRO_NAME', savedDistro);
    resetConfig();
    tmp.restore();
  });

  async function add(name = 'work'): Promise<string> {
    const dir = accountDir(name);
    fs.mkdirSync(dir);
    await store.add({ name, dir });
    return dir;
  }
  async function open(query: string, scheme = env.uriScheme): Promise<void> {
    const target = process.platform === 'win32' ? '&target=windows' : '';
    await dispatchUri(uri(query + target, { scheme }) as vscode.Uri);
  }

  test('registers one handler and disposes it with the other commands', () => {
    assert.equal(uriHandlers.size, 1);
    for (const disposable of disposables) disposable.dispose();
    assert.equal(uriHandlers.size, 0);
  });

  test('switches case-insensitive registered names and default without confirmation, preserving other settings', async (ctx) => {
    const dir = await add('Work');
    await labels.set('Work', 'Office');
    setConfig('planswap', 'claude.confirmSwitch', true);
    setConfig('claudeCode', 'environmentVariables', [{ name: 'KEEP', value: 'yes' }]);
    const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    await open('account=wORK');
    assert.equal(currentDir(), dir);
    assert.equal(switchedTo, 'Office');
    assert.deepEqual(updates.at(-1)?.value, [{ name: 'KEEP', value: 'yes' }, { name: 'CLAUDE_CONFIG_DIR', value: dir }]);
    await open('account=DEFAULT');
    assert.equal(currentDir(), defaultDir());
    assert.deepEqual(updates.at(-1)?.value, [{ name: 'KEEP', value: 'yes' }]);
    assert.equal(info.mock.callCount(), 0);
    assert.equal(warning.mock.callCount(), 0);
    assert.equal(execute.mock.callCount(), 0);
  });

  test('unknown names and display aliases produce errors without changing accounts or reloading', async (ctx) => {
    await add();
    await labels.set('work', 'Office');
    const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    for (const name of ['missing', 'Office']) {
      await open(`account=${name}&reload=1`);
      assert.deepEqual(error.mock.calls.at(-1)?.arguments, [t('uri.unknownAccount', { name })]);
    }
    assert.equal(updates.length, 0);
    assert.equal(execute.mock.callCount(), 0);
  });

  test('missing and non-directory registered paths are refused, including an already-current account', async (ctx) => {
    const dir = accountDir('missing');
    await store.add({ name: 'missing', dir });
    const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    for (const current of [false, true]) {
      if (current) setConfig('claudeCode', 'environmentVariables', [{ name: 'CLAUDE_CONFIG_DIR', value: dir }]);
      await open('account=missing&reload=1');
      assert.deepEqual(error.mock.calls.at(-1)?.arguments, [t('uri.directory', { dir })]);
    }
    fs.writeFileSync(dir, 'not a directory');
    await open('account=missing&reload=1');
    assert.deepEqual(error.mock.calls.at(-1)?.arguments, [t('uri.directory', { dir })]);
    assert.equal(updates.length, 0);
    assert.equal(execute.mock.callCount(), 0);
  });

  test('a missing default directory is refused even when default is current', async (ctx) => {
    const dir = defaultDir();
    fs.rmdirSync(dir);
    const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    await open('account=default&reload=1');
    assert.deepEqual(error.mock.calls[0].arguments, [t('uri.directory', { dir })]);
    assert.equal(updates.length, 0);
    assert.equal(execute.mock.callCount(), 0);
  });

  test('reload=1 reloads only after the account setting is applied and also permits an already-current account', async (ctx) => {
    const dir = await add();
    env.uriScheme = 'vscodium';
    const execute = ctx.mock.method(commands, 'executeCommand', async () => { assert.equal(currentDir(), dir); });
    await open('account=work&reload=1');
    await open('account=work&reload=1');
    assert.equal(updates.length, 1);
    assert.deepEqual(execute.mock.calls.map((call) => call.arguments), [['workbench.action.reloadWindow'], ['workbench.action.reloadWindow']]);
  });

  test('invalid parameters and misdelivered WSL requests do not reach the switch', LINUX_ONLY, async (ctx) => {
    await add();
    const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    await open('account=work&reload=0');
    await open('account=work&reload=1&distro=Other');
    env.remoteName = undefined;
    await open('account=work&reload=1');
    assert.equal(error.mock.callCount(), 3);
    assert.equal(updates.length, 0);
    assert.equal(execute.mock.callCount(), 0);
  });

  test('settings write failures keep the existing switch error and do not reload', async (ctx) => {
    await add();
    const original = workspace.getConfiguration;
    ctx.mock.method(workspace, 'getConfiguration', (section: string) => ({ ...original(section),
      async update(): Promise<void> { throw new Error('settings are read-only'); },
    }));
    const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    await open('account=work&reload=1');
    assert.deepEqual(error.mock.calls[0].arguments, [t('claude.switchFailed', { error: 'settings are read-only' })]);
    assert.equal(currentDir(), defaultDir());
    assert.equal(execute.mock.callCount(), 0);
  });

  test('URI switching retains shared-account synchronization and cancels on its failure', LINUX_ONLY, async (ctx) => {
    const dir = await add();
    ensureClaudeLinks(dir, path.join(tmp.home, 'fake-proc'));
    const source = path.join(tmp.home, '.claude.json');
    fs.writeFileSync(source, JSON.stringify({ mcpServers: { shared: { command: 'example' } } }));
    const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    await open('account=work');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers, { shared: { command: 'example' } });
    assert.equal(currentDir(), dir);
    setConfig('claudeCode', 'environmentVariables', []);
    updates.length = 0;
    fs.writeFileSync(source, '[]');
    await open('account=work&reload=1');
    assert.deepEqual(error.mock.calls[0].arguments, [t('share.mirrorFailed', { label: 'work', error: t('share.badSource', { file: source }) })]);
    assert.equal(updates.length, 0);
    assert.equal(execute.mock.callCount(), 0);
  });
});
