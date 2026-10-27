// macOS branch of Codex switching (src/codex/codexMac.ts and the darwin branches of codexState, codexPaths,
// codexShare, codexUsage and codexCommands), run on any host with process.platform reported as darwin. Every file
// operation stays in a temporary HOME; the self-check uses a fake shell runner or a shell path that does not exist.
import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as path from 'node:path';
import { t } from '../src/i18n';
import { tildify } from '../src/platform';
import {
  currentMacRcFile, macBlockFiles, macLoginShell, macRcFile, macShellKind, macStartupFiles, usesKeychainStore,
} from '../src/codex/codexMac';
import {
  RC_BEGIN, RC_END, STATE_FILE, installRcBlocks, isEnabled, preCheck, rcBlock, rcStatus, readSelectedDir,
  removeRcBlocks, selfCheck, stateFileFor, upgradeRcBlocks, writeSelectedDir, writeSelection, type ShellRunner,
} from '../src/codex/codexState';
import { codexDaemonAlive, topLevelConfigString, type CodexAccount } from '../src/codex/codexPaths';
import { codexAccountBusy } from '../src/codex/codexShare';
import { findBundledCodex, readCodexUsage } from '../src/codex/codexUsage';
import { codexPanelSource, manualRestartMessages, registerCodexCommands, restartInfo } from '../src/codex/codexCommands';
import { detectServerKind } from '../src/codex/codexServer';
import { CodexAccountStore } from '../src/codex/codexStore';
import { LabelStore } from '../src/labels';
import { commands, env, statusBarItems, tooltipText, window, type MarkdownString } from './stubs/vscode';
import { StatusBar } from '../src/statusBar';
import { AccountStore } from '../src/accounts';
import type { AccountsPanel } from '../src/accountsPanel';
import type { FromWebview } from '../src/protocol';
import { assertTempHome, makeTempHome, MemoryMemento, onWindows, read, withEnv, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const realOpenSync = fsDefault.openSync;
const savedZdotdir = process.env.ZDOTDIR;

// Reports darwin for the whole file. A Windows host cannot open a folder to fsync it (EPERM), which writeSelectedDir
// does off Windows, so there a folder opened read-only is replaced by a scratch file (only the fsync is skipped)
before(() => {
  tmp = makeTempHome('codex-mac');
  home = tmp.home;
  delete process.env.ZDOTDIR;
  process.env.SHELL = '/bin/zsh';
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  if (onWindows) {
    const scratch = path.join(home, '.fsync-scratch');
    fs.writeFileSync(scratch, '');
    mock.method(fsDefault, 'openSync', (p: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode) => {
      const isDir = flags === 'r' && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();
      // Windows cannot fsync a read-only handle either, so the scratch file is opened for writing
      return isDir ? realOpenSync(scratch, 'r+') : realOpenSync(p, flags, mode);
    });
  }
});
after(() => {
  mock.restoreAll();
  Object.defineProperty(process, 'platform', realPlatform);
  if (savedZdotdir === undefined) delete process.env.ZDOTDIR;
  else process.env.ZDOTDIR = savedZdotdir;
  tmp.restore();
});

const at = (name: string): string => path.join(home, name);
const reset = (): void => {
  for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.bash_profile', '.bash_login', '.profile', '.bashrc']) fs.rmSync(at(name), { force: true });
  fs.rmSync(path.dirname(STATE_FILE()), { recursive: true, force: true });
};

describe('login shell and block file', () => {
  test('macLoginShell: $SHELL first, then the user database, else undefined', () => {
    assert.equal(macLoginShell({ SHELL: '/bin/bash' }, () => '/bin/zsh'), '/bin/bash');
    assert.equal(macLoginShell({ SHELL: '' }, () => '/bin/zsh'), '/bin/zsh');
    assert.equal(macLoginShell({}, () => undefined), undefined);
    assert.equal(macLoginShell({}, () => { throw new Error('no passwd entry'); }), undefined);
  });

  test('macShellKind: zsh and bash by file name, other shells unsupported', () => {
    assert.equal(macShellKind('/bin/zsh'), 'zsh');
    assert.equal(macShellKind('/opt/homebrew/bin/bash'), 'bash');
    for (const shell of ['/opt/homebrew/bin/fish', '/bin/sh', '/bin/tcsh', '', undefined]) assert.equal(macShellKind(shell), undefined);
  });

  test('zsh: always ~/.zshenv, which the editor\'s login shell reads before any ZDOTDIR is set', () => {
    assertTempHome(home);
    assert.equal(macRcFile('zsh', {}), at('.zshenv'));
    // ~/.zshenv itself commonly sets ZDOTDIR; the host inherits it, but a Dock-started editor's shell never reads
    // $ZDOTDIR/.zshenv
    assert.equal(macRcFile('zsh', { ZDOTDIR: at('dots') }), at('.zshenv'));
    assert.deepEqual(macStartupFiles('zsh', {}), ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map(at));
    // The pre-check also covers the files zsh reads from ZDOTDIR after ~/.zshenv set it
    assert.deepEqual(macStartupFiles('zsh', { ZDOTDIR: at('dots') }),
      [at('.zshenv'), ...['.zprofile', '.zshrc', '.zlogin'].map((name) => path.join(home, 'dots', name))]);
  });

  test('bash: the first existing login file, ~/.bash_profile when there is none', () => {
    reset();
    assert.equal(macRcFile('bash', {}), at('.bash_profile'));
    fs.writeFileSync(at('.profile'), '');
    assert.equal(macRcFile('bash', {}), at('.profile'), 'creating ~/.bash_profile would stop bash reading ~/.profile');
    fs.writeFileSync(at('.bash_login'), '');
    assert.equal(macRcFile('bash', {}), at('.bash_login'));
    fs.writeFileSync(at('.bash_profile'), '');
    assert.equal(macRcFile('bash', {}), at('.bash_profile'));
    assert.deepEqual(macStartupFiles('bash', {}), [at('.bash_profile'), at('.bashrc')]);
    reset();
  });

  test('macBlockFiles lists both shells\' files once', () => {
    assert.deepEqual(macBlockFiles({}), ['.zshenv', '.bash_profile', '.bash_login', '.profile'].map(at));
    assert.deepEqual(macBlockFiles({ ZDOTDIR: at('dots') }), [path.join(home, 'dots', '.zshenv'), ...['.zshenv', '.bash_profile', '.bash_login', '.profile'].map(at)]);
  });

  test('currentMacRcFile follows $SHELL; another shell has none', () => {
    assert.equal(currentMacRcFile({ SHELL: '/bin/zsh' }), at('.zshenv'));
    assert.equal(currentMacRcFile({ SHELL: '/opt/homebrew/bin/fish' }), undefined);
  });
});

describe('rc block on macOS', () => {
  test('zsh: install writes exactly the rc block into ~/.zshenv only; enabled afterwards', () => {
    reset();
    assert.deepEqual(rcStatus(), [{ file: at('.zshenv'), hasBlock: false, broken: false, hasUserExport: false }]);
    assert.equal(isEnabled(), false);
    installRcBlocks();
    assert.equal(read(at('.zshenv')), rcBlock());
    assert.equal(isEnabled(), true);
    for (const name of ['.profile', '.bashrc', '.bash_profile']) assert.equal(fs.existsSync(at(name)), false, name);
    // Installing again changes nothing
    installRcBlocks();
    assert.equal(read(at('.zshenv')), rcBlock());
  });

  test('install then remove restores an existing file byte for byte', () => {
    reset();
    fs.writeFileSync(at('.zshenv'), 'export PATH=/opt/bin:$PATH\n');
    installRcBlocks();
    assert.equal(read(at('.zshenv')), 'export PATH=/opt/bin:$PATH\n\n' + rcBlock());
    removeRcBlocks();
    assert.equal(read(at('.zshenv')), 'export PATH=/opt/bin:$PATH\n');
  });

  test('bash: the block goes into the existing ~/.profile; removal covers both shells\' files and leaves ~/.bashrc alone', () => {
    reset();
    fs.writeFileSync(at('.profile'), 'p=1\n');
    fs.writeFileSync(at('.bashrc'), `b=1\n${rcBlock()}`);
    withEnv({ SHELL: '/bin/bash' }, () => {
      assert.equal(rcStatus()[0].file, at('.profile'));
      installRcBlocks();
      assert.equal(isEnabled(), true);
    });
    assert.equal(read(at('.profile')), 'p=1\n\n' + rcBlock());
    assert.equal(fs.existsSync(at('.bash_profile')), false);
    // The user switched to zsh meanwhile: disabling still removes the bash block
    fs.writeFileSync(at('.zshenv'), rcBlock());
    removeRcBlocks();
    assert.equal(read(at('.profile')), 'p=1\n');
    assert.equal(read(at('.zshenv')), '');
    assert.equal(read(at('.bashrc')), `b=1\n${rcBlock()}`, 'never written on macOS, so never edited there');
  });

  test('another login shell: not enabled, install refused without writing', () => {
    reset();
    withEnv({ SHELL: '/opt/homebrew/bin/fish' }, () => {
      assert.deepEqual(rcStatus(), []);
      assert.equal(isEnabled(), false);
      assert.throws(() => installRcBlocks(), { message: t('codex.mac.notShell', { shell: '/opt/homebrew/bin/fish' }) });
    });
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.z') || n.startsWith('.bash') || n === '.profile'), []);
  });

  test('upgradeRcBlocks rewrites an outdated block in a macOS file only', () => {
    reset();
    const old = `${RC_BEGIN}\nexport CODEX_HOME=old\n${RC_END}\n`;
    fs.writeFileSync(at('.zshenv'), 'z=1\n\n' + old);
    fs.writeFileSync(at('.bashrc'), old);
    assert.equal(upgradeRcBlocks(), true);
    assert.equal(read(at('.zshenv')), 'z=1\n\n' + rcBlock());
    assert.equal(read(at('.bashrc')), old);
    assert.equal(upgradeRcBlocks(), false);
  });
});

describe('preCheck on macOS', () => {
  test('zsh without conflicts passes', () => {
    reset();
    assert.deepEqual(preCheck(), { ok: true, reasons: [] });
  });

  test('another shell or none is refused', () => {
    withEnv({ SHELL: '/opt/homebrew/bin/fish' }, () => {
      assert.deepEqual(preCheck(), { ok: false, reasons: [t('codex.mac.notShell', { shell: '/opt/homebrew/bin/fish' })] });
    });
  });

  test('a user export or a broken block in any zsh startup file is refused', () => {
    reset();
    fs.writeFileSync(at('.zshrc'), 'export CODEX_HOME=~/.codex-mine\n');
    fs.writeFileSync(at('.zprofile'), `${RC_BEGIN}\n`);
    assert.deepEqual(preCheck(), {
      ok: false,
      reasons: [t('codex.pre.broken', { file: at('.zprofile') }), t('codex.pre.userExport', { file: at('.zshrc') })],
    });
    reset();
  });

  test('bash: a user export in ~/.bashrc is refused, ~/.bash_profile need not source it', () => {
    reset();
    withEnv({ SHELL: '/bin/bash' }, () => {
      fs.writeFileSync(at('.bash_profile'), 'echo hi\n');
      assert.deepEqual(preCheck(), { ok: true, reasons: [] });
      fs.writeFileSync(at('.bashrc'), 'export CODEX_HOME=/x\n');
      assert.deepEqual(preCheck().reasons, [t('codex.pre.userExport', { file: at('.bashrc') })]);
    });
    reset();
  });
});

describe('selection and self-check on macOS', () => {
  test('only the shared state file is read and written, never codex-home.<kind> or a server-env-setup hook', () => {
    reset();
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(stateFileFor('vscode'), at('.codex-other'));
    writeSelection(at('.codex-a'));
    assert.equal(read(STATE_FILE()), at('.codex-a'));
    assert.equal(readSelectedDir(), at('.codex-a'));
    assert.equal(fs.existsSync(path.join(home, '.vscode-server')), false);
    assert.equal(detectServerKind(), 'unknown');
  });

  // A fake login shell that applies the rc block: CODEX_HOME = the state file's directory when it exists
  const blockShell = (calls: Array<{ shell: string; args: string[]; env: NodeJS.ProcessEnv }>): ShellRunner => (shell, args, shellEnv) => {
    calls.push({ shell, args, env: shellEnv });
    const dir = fs.readFileSync(STATE_FILE(), 'utf8').trim();
    return { stdout: `motd line\n\n__PLANSWAP_CODEX_HOME__=${fs.existsSync(dir) ? dir : ''}\n`, stderr: '' };
  };

  test('runs the login shell with -i -l -c, without CODEX_HOME, and restores the selection', () => {
    reset();
    writeSelectedDir(at('.codex-a'));
    const calls: Array<{ shell: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const r = withEnv({ CODEX_HOME: at('.codex-host') }, () => selfCheck(blockShell(calls)));
    assert.equal(r.ok, true, r.detail);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].shell, '/bin/zsh');
    assert.deepEqual(calls[0].args.slice(0, 3), ['-i', '-l', '-c']);
    assert.equal(calls[0].env.CODEX_HOME, undefined);
    assert.equal(read(STATE_FILE()), at('.codex-a'));
    // Like a Dock-started editor, the shell starts without the host's ZDOTDIR, so it reads ~/.zshenv first
    withEnv({ ZDOTDIR: at('dots') }, () => selfCheck(blockShell(calls)));
    assert.equal(calls[1].env.ZDOTDIR, undefined);
    assert.deepEqual(fs.readdirSync(path.dirname(STATE_FILE())), ['codex-home'], 'scratch folder removed');
  });

  test('bash login shells are run by their own path', () => {
    reset();
    const calls: Array<{ shell: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    withEnv({ SHELL: '/opt/homebrew/bin/bash' }, () => assert.equal(selfCheck(blockShell(calls)).ok, true));
    assert.equal(calls[0].shell, '/opt/homebrew/bin/bash');
    assert.equal(fs.existsSync(STATE_FILE()), false, 'a state file created by the check is removed again');
  });

  test('a shell that does not report the scratch directory fails; a shell that cannot run fails', () => {
    reset();
    const wrong = selfCheck(() => ({ stdout: '__PLANSWAP_CODEX_HOME__=\n', stderr: '' }));
    assert.equal(wrong.ok, false);
    assert.match(wrong.detail, /^CODEX_HOME in the login shell is ""/);
    const missing = selfCheck(() => ({ error: new Error('spawn /bin/zsh ENOENT') }));
    assert.deepEqual(missing, { ok: false, detail: t('codex.mac.shellFailed', { shell: '/bin/zsh', error: 'spawn /bin/zsh ENOENT' }) });
  });

  test('another login shell fails without running anything', () => {
    let ran = false;
    const r = withEnv({ SHELL: '/bin/tcsh' }, () => selfCheck(() => { ran = true; return {}; }));
    assert.deepEqual(r, { ok: false, detail: t('codex.mac.notShell', { shell: '/bin/tcsh' }) });
    assert.equal(ran, false);
  });
});

describe('busy and daemon checks on macOS', () => {
  let dir: string;
  let dd: string;
  before(() => {
    dir = at('.codex-busy');
    dd = path.join(dir, 'app-server-daemon');
    fs.mkdirSync(dd, { recursive: true });
  });
  const pidFile = (text: string): void => fs.writeFileSync(path.join(dd, 'daemon.pid'), text);
  const clear = (): void => { for (const f of fs.readdirSync(dd)) fs.unlinkSync(path.join(dd, f)); };
  // A pid no process has (pids are far below this on macOS, Linux and Windows)
  const deadPid = 2_000_000_000;

  test('no pid file → not alive, and the account is not busy (no /proc to fail on)', () => {
    clear();
    assert.equal(codexDaemonAlive(dir), false);
    assert.equal(codexAccountBusy(dir), false);
  });

  test('a live pid counts with or without start ticks, as JSON or a bare number', () => {
    pidFile(JSON.stringify({ pid: process.pid }));
    assert.equal(codexDaemonAlive(dir), true);
    assert.equal(codexAccountBusy(dir), true);
    pidFile(String(process.pid));
    assert.equal(codexDaemonAlive(dir), true);
    clear();
  });

  test('a pid that is not alive → not alive', () => {
    pidFile(JSON.stringify({ pid: deadPid, processIdentity: { startTicks: 1 } }));
    assert.equal(codexDaemonAlive(dir), false);
    pidFile(`${deadPid}\n`);
    assert.equal(codexDaemonAlive(dir), false);
    clear();
  });

  test('an unrecognized pid file errs towards alive', () => {
    for (const text of ['{not json', '{"processIdentity":{}}', 'pid=12', '']) {
      pidFile(text);
      assert.equal(codexDaemonAlive(dir), true, JSON.stringify(text));
    }
    clear();
  });

  test('Windows keeps reading JSON pid files only', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      pidFile(String(process.pid));
      assert.equal(codexDaemonAlive(dir), false);
      pidFile('{not json');
      assert.equal(codexDaemonAlive(dir), false);
      pidFile(JSON.stringify({ pid: process.pid }));
      assert.equal(codexDaemonAlive(dir), true);
    } finally {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      clear();
    }
  });
});

describe('bundled CLI on macOS', () => {
  test('bin/macos-<arch> with x64 → x86_64 and arm64 → aarch64', () => {
    const ext = at('ext-exact');
    for (const folder of ['macos-x86_64', 'macos-aarch64', 'linux-x86_64']) {
      fs.mkdirSync(path.join(ext, 'bin', folder), { recursive: true });
      fs.writeFileSync(path.join(ext, 'bin', folder, 'codex'), '');
    }
    assert.equal(findBundledCodex(ext, 'darwin', 'x64'), path.join(ext, 'bin', 'macos-x86_64', 'codex'));
    assert.equal(findBundledCodex(ext, 'darwin', 'arm64'), path.join(ext, 'bin', 'macos-aarch64', 'codex'));
    assert.equal(findBundledCodex(ext, 'darwin', 'ia32'), undefined);
  });

  test('another folder name of the same architecture is the fallback; other architectures never are', () => {
    const ext = at('ext-alias');
    for (const folder of ['macos-arm64', 'macos-amd64-empty', 'macos-x64']) fs.mkdirSync(path.join(ext, 'bin', folder), { recursive: true });
    fs.writeFileSync(path.join(ext, 'bin', 'macos-arm64', 'codex'), '');
    assert.equal(findBundledCodex(ext, 'darwin', 'arm64'), path.join(ext, 'bin', 'macos-arm64', 'codex'));
    // macos-x64 has no binary
    assert.equal(findBundledCodex(ext, 'darwin', 'x64'), undefined);
    fs.writeFileSync(path.join(ext, 'bin', 'macos-x64', 'codex'), '');
    assert.equal(findBundledCodex(ext, 'darwin', 'x64'), path.join(ext, 'bin', 'macos-x64', 'codex'));
    assert.equal(findBundledCodex(at('ext-missing'), 'darwin', 'arm64'), undefined);
    // Linux keeps the exact folder only
    assert.equal(findBundledCodex(ext, 'linux', 'arm64'), undefined);
  });
});

describe('credential store note', () => {
  const account = (name: string, config?: string): string => {
    const dir = at(`.codex-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.toml'), config);
    return dir;
  };

  test('topLevelConfigString reads only a top-level single-line string', () => {
    const key = 'cli_auth_credentials_store';
    assert.equal(topLevelConfigString(`${key} = "keyring"\n`, key), 'keyring');
    assert.equal(topLevelConfigString(`﻿  ${key}='auto' # comment\n`, key), 'auto');
    assert.equal(topLevelConfigString(`model = "x"\n[profiles.a]\n${key} = "keyring"\n`, key), undefined);
    assert.equal(topLevelConfigString(`notes = """\n${key} = "keyring"\n"""\n`, key), undefined);
    assert.equal(topLevelConfigString(`${key} = 1\n`, key), undefined);
    assert.equal(topLevelConfigString(`# ${key} = "keyring"\n`, key), undefined);
  });

  test('usesKeychainStore: any store but file, on macOS only', () => {
    assert.equal(usesKeychainStore(account('k1', 'cli_auth_credentials_store = "keyring"\n')), true);
    assert.equal(usesKeychainStore(account('k2', 'cli_auth_credentials_store = "auto"\n')), true);
    assert.equal(usesKeychainStore(account('k3', 'cli_auth_credentials_store = "ephemeral"\n')), true);
    assert.equal(usesKeychainStore(account('k4', 'cli_auth_credentials_store = "file"\n')), false);
    assert.equal(usesKeychainStore(account('k5', 'model = "gpt"\n')), false);
    assert.equal(usesKeychainStore(account('k6')), false);
    assert.equal(usesKeychainStore(at('.codex-k1'), 'linux'), false);
    assert.equal(usesKeychainStore(at('.codex-k1'), 'win32'), false);
  });

  test('usage of a Keychain-store account never starts the CLI on macOS, even with a leftover auth.json', async () => {
    const dir = account('kcu', 'cli_auth_credentials_store = "keyring"\n');
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
    let spawned = 0;
    const spawn = (() => { spawned++; throw new Error('not expected'); }) as never;
    assert.deepEqual(await readCodexUsage(dir, { platform: 'darwin', spawn }), { ok: false, reason: 'noRateLimits' });
    assert.equal(spawned, 0);
  });

  test('the panel row shows the note instead of sign-in, email and plan, and no usage', async () => {
    const dir = account('kc', 'cli_auth_credentials_store = "keyring"\n');
    // An auth.json left from before must not be shown either
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }));
    const plain = account('plain', 'model = "gpt"\n');
    const state = new MemoryMemento();
    const store = new CodexAccountStore(state);
    await store.add({ name: 'kc', dir });
    await store.add({ name: 'plain', dir: plain });
    const rows = codexPanelSource(store, new LabelStore(state, 'codex.labels')).accounts();
    const row = rows.find((r) => r.dir === dir)!;
    assert.equal(row.signInNote, t('codex.mac.keychainStore'));
    assert.equal(row.loggedIn, true);
    assert.equal(row.email, undefined);
    assert.equal(row.plan, undefined);
    assert.equal(row.usageEligible, undefined);
    const other = rows.find((r) => r.dir === plain)!;
    assert.equal(other.signInNote, undefined);
    assert.equal(other.loggedIn, false);
  });
});

describe('restart guidance and commands on macOS', () => {
  test('a local window gets the macOS manual guidance; Windows and Linux outputs are unchanged', () => {
    const hint = t('codex.manualRestartHintMac');
    const mac = { hint, required: t('codex.manualRestartRequiredMac', { hint }), switchConfirm: t('codex.switchConfirmManualWin', { hint }) };
    assert.deepEqual(manualRestartMessages('unknown', undefined), mac);
    assert.deepEqual(manualRestartMessages('vscode', undefined, 'darwin'), mac);
    assert.deepEqual(manualRestartMessages('unknown', undefined, 'win32'), manualRestartMessages('unknown', undefined, true));
    assert.deepEqual(manualRestartMessages('unknown', undefined, 'linux'), manualRestartMessages('unknown', undefined, false));
    assert.equal(manualRestartMessages('unknown', undefined, true).hint, t('codex.manualRestartHintWin'));
    assert.equal(manualRestartMessages('unknown', undefined, false).hint, t('codex.manualRestartHintLocal'));
    assert.equal(manualRestartMessages('vscode', 'ssh-remote', 'darwin').hint, t('codex.manualRestartHintRemote'));
    env.remoteName = undefined;
    assert.deepEqual(restartInfo(), { context: 'local', auto: false, shellFile: true });
  });

  const harness = async (accounts: CodexAccount[]) => {
    const state = new MemoryMemento();
    const store = new CodexAccountStore(state);
    const labels = new LabelStore(state, 'codex.labels');
    fs.mkdirSync(at('.codex'), { recursive: true });
    for (const a of accounts) {
      fs.mkdirSync(a.dir, { recursive: true });
      await store.add(a);
    }
    let handle!: (message: FromWebview) => Promise<void>;
    let refreshes = 0;
    const panel = {
      setHandler(_mode: string, callback: typeof handle) { handle = callback; },
      resolve(_mode: string, dir: string) {
        const a = store.findByDir(dir);
        return a && { name: a.name, dir: a.dir, kind: a.name === 'default' ? 'default' : 'named' };
      },
      refresh() { refreshes++; },
    } as unknown as AccountsPanel;
    const disposables = registerCodexCommands({ store, labels, panel, tools: {} });
    return { handle: (m: FromWebview) => handle(m), refreshes: () => refreshes, dispose: () => disposables.forEach((d) => d.dispose()) };
  };

  test('enable: the confirmation names ~/.zshenv; a self-check that cannot run the shell rolls the block back', async (ctx) => {
    reset();
    env.remoteName = undefined;
    fs.writeFileSync(at('.zshenv'), 'z=1\n');
    const h = await harness([]);
    const prompts: unknown[][] = [];
    ctx.mock.method(window, 'showWarningMessage', async (...args: unknown[]) => (prompts.push(args), t('codex.enableButton')));
    const errors = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
    try {
      // A shell path that does not exist: spawning fails on every host, so no real shell runs
      await withEnv({ SHELL: path.join(home, 'no-such-bin', 'zsh') }, () => h.handle({ type: 'enable', mode: 'codex' }));
      assert.deepEqual(prompts[0], [t('codex.mac.enableConfirm', { file: tildify(at('.zshenv')) }), { modal: true, detail: rcBlock() }, t('codex.enableButton')]);
      assert.equal(errors.mock.callCount(), 1);
      assert.match(String(errors.mock.calls[0].arguments[0]), /^Self-check failed; rc files were rolled back: Cannot run the login shell /);
      assert.equal(read(at('.zshenv')), 'z=1\n');
      assert.equal(fs.existsSync(at('.profile')), false);
    } finally {
      h.dispose();
    }
  });

  test('a Keychain-store account reads as signed in in the picker and its terminal runs codex, not codex login', async (ctx) => {
    reset();
    const a = { name: 'kcq', dir: at('.codex-kcq') };
    const h = await harness([a]);
    fs.writeFileSync(path.join(a.dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const picks: Array<Array<{ description?: string; account?: CodexAccount }>> = [];
    ctx.mock.method(window, 'showQuickPick', async (items: Array<{ description?: string; account?: CodexAccount }>) => {
      picks.push(items);
      return items.find((i) => i.account?.dir === a.dir);
    });
    const sent: string[] = [];
    ctx.mock.method(window, 'createTerminal', () => ({ sendText: (text: string) => sent.push(text), show() {}, dispose() {} }));
    try {
      await commands.registered['planswap.codex.openTerminal']();
      assert.equal(picks[0].find((i) => i.account?.dir === a.dir)?.description, t('common.loggedIn'));
      assert.equal(sent.length, 1);
      assert.doesNotMatch(sent[0], /codex login/);
    } finally {
      h.dispose();
    }
  });

  test('the status bar names a Keychain-store effective account with the note, not as signed out, and shows no usage', () => {
    reset();
    const dir = at('.codex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
    const state = new MemoryMemento();
    const bar = new StatusBar(new AccountStore(state), new LabelStore(state, 'claude.labels'), { store: new CodexAccountStore(state), labels: new LabelStore(state, 'codex.labels') });
    try {
      const text = tooltipText(statusBarItems.at(-1)!.tooltip as MarkdownString);
      assert.doesNotMatch(text, new RegExp(t('common.notLoggedIn')));
      assert.match(text, /\*\*Codex\*\*/);
      assert.ok(text.includes(t('codex.mac.keychainStore')), text);
    } finally {
      bar.dispose();
      fs.rmSync(path.join(dir, 'config.toml'));
    }
  });

  test('switch: saves the selection with the macOS guidance and never restarts', async (ctx) => {
    reset();
    env.remoteName = undefined;
    installRcBlocks();
    const a = { name: 'work', dir: at('.codex-work') };
    const h = await harness([a]);
    const prompts: unknown[][] = [];
    ctx.mock.method(window, 'showWarningMessage', async (...args: unknown[]) => (prompts.push(args), t('codex.saveSelectionButton')));
    const execute = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    try {
      await h.handle({ type: 'switch', mode: 'codex', dir: a.dir });
      assert.deepEqual(prompts, [[manualRestartMessages('unknown', undefined, 'darwin').switchConfirm, { modal: true }, t('codex.saveSelectionButton')]]);
      assert.equal(read(STATE_FILE()), a.dir);
      assert.equal(execute.mock.callCount(), 0);
    } finally {
      h.dispose();
    }
  });
});
