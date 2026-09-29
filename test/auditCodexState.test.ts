// Regression tests for the audit fixes in codexState, codexWindows, codexUsage, fileState and the account stores.
// Everything runs under a temporary HOME; the Windows user environment is an in-memory fake runner.
import { after, afterEach, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  RC_BEGIN, RC_END, SELF_CHECK_DIR_PREFIX, STATE_FILE, disableWindows, enableWindows, installRcBlocks, preCheck, rcBlock,
  rcStatus, readSelectedDir, removeRcBlocks, selfCheck, writeSelectedDir, writeSelection,
} from '../src/codex/codexState';
import { type Runner, getUserCodexHome, getUserEnv } from '../src/codex/codexWindows';
import { readCodexUsage, type UsageChild, type UsageOptions } from '../src/codex/codexUsage';
import { FileMemento } from '../src/fileState';
import { AccountStore } from '../src/accounts';
import { CodexAccountStore } from '../src/codex/codexStore';
import { LINUX_ONLY, MemoryMemento, assertTempHome, makeTempHome, read, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
before(() => {
  tmp = makeTempHome('audit-codex-state');
  home = tmp.home;
});
after(() => tmp.restore());

// In-memory HKCU\Environment behind the powershell.exe runner of codexWindows (as in codexState.test.ts), plus a
// failing read and a hook that runs on every write
function fakeUserEnv(
  initial: Record<string, string> = {},
  fail: { get?: boolean; set?: boolean } = {},
  onSet?: (name: string, value: string | undefined) => void,
): { vars: Map<string, string>; run: Runner } {
  const vars = new Map(Object.entries(initial));
  const run: Runner = (_file, _args, env) => {
    const name = env?.PLANSWAP_ENV_NAME ?? '';
    if (env && !('PLANSWAP_ENV_VALUE' in env)) {
      if (fail.get) throw new Error('powershell timed out');
      return Buffer.from(vars.get(name) ?? '', 'utf8').toString('base64') + '\r\n';
    }
    if (fail.set) throw new Error('powershell refused');
    onSet?.(name, env?.PLANSWAP_ENV_VALUE || undefined);
    if (env?.PLANSWAP_ENV_VALUE) vars.set(name, env.PLANSWAP_ENV_VALUE);
    else vars.delete(name);
    return '';
  };
  return { vars, run };
}

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const clearState = (): void => { fs.rmSync(STATE_FILE(), { force: true }); };

describe('Windows user variable reads: strict mode', () => {
  test('non-strict reads a failure as unset; strict throws', () => {
    const broken = fakeUserEnv({ CODEX_HOME: 'C:\\x' }, { get: true });
    assert.equal(getUserEnv('CODEX_HOME', broken.run), undefined);
    assert.equal(getUserCodexHome(broken.run), undefined);
    assert.throws(() => getUserEnv('CODEX_HOME', broken.run, true), /powershell timed out/);
    assert.throws(() => getUserCodexHome(broken.run, true), /powershell timed out/);
    const ok = fakeUserEnv({ CODEX_HOME: 'C:\\x' });
    assert.equal(getUserCodexHome(ok.run, true), 'C:\\x');
    assert.equal(getUserCodexHome(fakeUserEnv().run, true), undefined);
  });
});

describe('Windows enable / disable / switch', () => {
  before(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
  after(() => { Object.defineProperty(process, 'platform', realPlatform); });
  afterEach(() => { clearState(); });

  test('preCheck throws on a failed read instead of passing a user value as unset', () => {
    clearState();
    assert.throws(() => preCheck(fakeUserEnv({ CODEX_HOME: 'D:\\mine' }, { get: true }).run), /powershell timed out/);
    assert.deepEqual(preCheck(fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') }).run), { ok: true, reasons: [] });
    const r = preCheck(fakeUserEnv({ CODEX_HOME: 'D:\\mine' }).run);
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 1);
  });

  test('enableWindows adopts a ~/.codex-<name> value and not another', () => {
    enableWindows(fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') }).run);
    assert.equal(readSelectedDir(), path.join(home, '.codex-a'));
    clearState();
    for (const other of [path.join(home, 'codex-a'), path.join(home, 'sub', '.codex-a'), path.join(home, '.codex')]) {
      enableWindows(fakeUserEnv({ CODEX_HOME: other }).run);
      assert.equal(read(STATE_FILE()), '', other);
      clearState();
    }
    // An existing state file keeps its selection; the variable is not even read
    writeSelectedDir(path.join(home, '.codex-b'));
    enableWindows(fakeUserEnv({}, { get: true }).run);
    assert.equal(readSelectedDir(), path.join(home, '.codex-b'));
  });

  test('enableWindows refuses on a failed read and creates no state file', () => {
    assert.throws(() => enableWindows(fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') }, { get: true }).run));
    assert.equal(fs.existsSync(STATE_FILE()), false);
  });

  test('disableWindows aborts on a failed read: neither the variable nor the state file is removed', () => {
    writeSelectedDir(path.join(home, '.codex-a'));
    const env = fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') }, { get: true });
    assert.throws(() => disableWindows(env.run), /powershell timed out/);
    assert.equal(env.vars.get('CODEX_HOME'), path.join(home, '.codex-a'));
    assert.equal(readSelectedDir(), path.join(home, '.codex-a'));
  });

  test('switch writes the user variable first, then the state file', () => {
    writeSelectedDir(path.join(home, '.codex-a'));
    const seen: Array<string | undefined> = [];
    const env = fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') }, {}, () => { seen.push(readSelectedDir()); });
    writeSelection(path.join(home, 'x', '..', '.codex-b'), env.run);
    // While the variable was written, the state file still held the old selection
    assert.deepEqual(seen, [path.join(home, '.codex-a')]);
    assert.equal(env.vars.get('CODEX_HOME'), path.join(home, '.codex-b'));
    assert.equal(readSelectedDir(), path.join(home, '.codex-b'));
    // The default account removes the variable and empties the state file
    writeSelection(undefined, env.run);
    assert.equal(env.vars.has('CODEX_HOME'), false);
    assert.equal(read(STATE_FILE()), '');
  });

  test('a failing state-file write puts the previous user variable back', () => {
    writeSelectedDir(path.join(home, '.codex-a'));
    const env = fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') });
    const realOpen = fsModule.openSync;
    const open = mock.method(fsModule, 'openSync', ((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).includes('.codex-home.')) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    try {
      assert.throws(() => writeSelection(path.join(home, '.codex-b'), env.run), /ENOSPC/);
    } finally {
      open.mock.restore();
    }
    assert.equal(env.vars.get('CODEX_HOME'), path.join(home, '.codex-a'));
    assert.equal(readSelectedDir(), path.join(home, '.codex-a'));
  });

  test('switch refuses on a failed read: nothing is written, so a rollback can never clear the variable', () => {
    writeSelectedDir(path.join(home, '.codex-a'));
    const env = fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') }, { get: true });
    assert.throws(() => writeSelection(path.join(home, '.codex-b'), env.run), /powershell timed out/);
    assert.equal(env.vars.get('CODEX_HOME'), path.join(home, '.codex-a'));
    assert.equal(readSelectedDir(), path.join(home, '.codex-a'));
  });
});

describe('rcStatus with an unterminated block', () => {
  const bashrc = (): string => path.join(home, '.bashrc');
  const profile = (): string => path.join(home, '.profile');
  after(() => { fs.rmSync(bashrc(), { force: true }); fs.rmSync(profile(), { force: true }); });

  test("the block's own export line is not reported as the user's export", () => {
    const unterminated = rcBlock().split('\n').filter((l) => l !== RC_END).join('\n');
    assert.ok(unterminated.includes(RC_BEGIN) && unterminated.includes('export CODEX_HOME='));
    fs.writeFileSync(bashrc(), 'a=1\n' + unterminated);
    fs.writeFileSync(profile(), 'x\n');
    assert.deepEqual(rcStatus()[1], { file: bashrc(), hasBlock: true, broken: true, hasUserExport: false });
  });

  test('a user export after the unterminated block is still reported', () => {
    const unterminated = rcBlock().split('\n').filter((l) => l !== RC_END).join('\n');
    fs.writeFileSync(bashrc(), unterminated + 'export CODEX_HOME=/somewhere\n');
    assert.deepEqual(rcStatus()[1], { file: bashrc(), hasBlock: true, broken: true, hasUserExport: true });
  });
});

describe('atomic writers create their temp files exclusively', () => {
  test("state file, rc files and state.json open the temp file with 'wx'", async () => {
    const flags = new Map<string, unknown>();
    const realOpen = fsModule.openSync;
    const open = mock.method(fsModule, 'openSync', ((p: fs.PathLike, flag?: unknown, ...rest: unknown[]) => {
      if (String(p).endsWith('.tmp')) flags.set(path.basename(String(p)).replace(/^\.+/, '').split('.')[0] ?? '', flag);
      return (realOpen as (...a: unknown[]) => number)(p, flag, ...rest);
    }) as typeof fs.openSync);
    try {
      writeSelectedDir(path.join(home, '.codex-a'));
      await new FileMemento().update('k', 1);
      installRcBlocks();
    } finally {
      open.mock.restore();
    }
    assert.deepEqual(Object.fromEntries(flags), { 'codex-home': 'wx', state: 'wx', bashrc: 'wx', profile: 'wx' });
    removeRcBlocks();
    fs.rmSync(path.join(home, '.bashrc'), { force: true });
    fs.rmSync(path.join(home, '.profile'), { force: true });
    fs.rmSync(path.dirname(STATE_FILE()), { recursive: true, force: true });
  });
});

// Memento whose next get() of a key runs a hook after reading, as if another window wrote in between
class RacingMemento extends MemoryMemento {
  private readonly hooks = new Map<string, () => void>();
  race(key: string, hook: () => void): void { this.hooks.set(key, hook); }
  override get<T>(key: string): T | undefined;
  override get<T>(key: string, defaultValue: T): T;
  override get<T>(key: string, defaultValue?: T): T | undefined {
    const value = super.get<T>(key, defaultValue as T);
    const hook = this.hooks.get(key);
    if (hook) {
      this.hooks.delete(key);
      hook();
    }
    return value;
  }
}

describe('syncWithDisk keeps changes another window made meanwhile', () => {
  afterEach(() => {
    for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
  });

  for (const vendor of ['claude', 'codex'] as const) {
    const key = vendor === 'claude' ? 'accounts' : 'codex.accounts';
    const ignoredKey = vendor === 'claude' ? 'ignoredDirs' : 'codex.ignoredDirs';
    const make = (m: RacingMemento): AccountStore | CodexAccountStore =>
      vendor === 'claude' ? new AccountStore(m) : new CodexAccountStore(m);
    const acc = (name: string): { name: string; dir: string } => ({ name, dir: path.join(home, `.${vendor}-${name}`) });

    test(`${vendor}: a concurrent add and remove survive; only the pruned and discovered entries change`, async () => {
      assertTempHome(home);
      for (const n of ['keep', 'x', 'new']) fs.mkdirSync(acc(n).dir);
      const other = { name: 'other', dir: path.join(home, 'elsewhere') };
      fs.mkdirSync(other.dir);
      const memento = new RacingMemento();
      memento.data.set(key, [acc('keep'), acc('x'), acc('gone')]);
      const store = make(memento);
      memento.race(key, () => {
        // Another window removes x (ignoring its directory) and adds other
        memento.data.set(key, [acc('keep'), acc('gone'), other]);
        memento.data.set(ignoredKey, [acc('x').dir]);
      });
      await store.syncWithDisk();
      assert.deepEqual(store.named().map((a) => a.name), ['keep', 'new', 'other']);
    });

    test(`${vendor}: a directory ignored meanwhile is not registered`, async () => {
      fs.mkdirSync(acc('new').dir);
      const memento = new RacingMemento();
      const store = make(memento);
      memento.race(ignoredKey, () => { memento.data.set(ignoredKey, [acc('new').dir]); });
      await store.syncWithDisk();
      assert.deepEqual(store.named(), []);
    });

    test(`${vendor}: an account registered meanwhile under the discovered directory is not duplicated`, async () => {
      fs.mkdirSync(acc('new').dir);
      const memento = new RacingMemento();
      const store = make(memento);
      memento.race(key, () => { memento.data.set(key, [{ name: 'renamed', dir: acc('new').dir }]); });
      await store.syncWithDisk();
      assert.deepEqual(store.named(), [{ name: 'renamed', dir: acc('new').dir }]);
    });
  }
});

// Minimal fake `codex app-server` (see codexUsage.test.ts)
type Respond = (msg: Record<string, unknown>, write: (o: unknown) => void) => void;
function fakeSpawn(respond: Respond): { spawn: UsageOptions['spawn']; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const spawn = (): UsageChild => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill(): boolean { return true; },
    });
    let buf = '';
    stdin.on('data', (c: Buffer) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        sent.push(msg);
        respond(msg, (o) => { stdout.write(JSON.stringify(o) + '\n'); });
      }
    });
    stdin.on('finish', () => {
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0, null));
    });
    return child as unknown as UsageChild;
  };
  return { spawn, sent };
}

describe('readCodexUsage: server requests are not responses', () => {
  test('a request from the server reusing id 1 or 2 is ignored', async () => {
    const acct = path.join(home, '.codex-usage');
    fs.mkdirSync(acct, { recursive: true });
    fs.writeFileSync(path.join(acct, 'auth.json'), '{}'); // dummy content only
    const f = fakeSpawn((msg, write) => {
      if (msg.method === 'initialize') {
        write({ id: 1, method: 'item/commandExecution/requestApproval', params: {} });
        write({ id: msg.id, result: { codexHome: acct } });
      } else if (msg.method === 'account/rateLimits/read') {
        write({ id: 2, method: 'account/chatgptAuthTokens/refresh', params: {} });
        write({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 30 } } } });
      }
    });
    const r = await readCodexUsage(acct, { spawn: f.spawn, now: () => 5, timeoutMs: 2000, graceMs: 20 });
    assert.deepEqual(r, { ok: true, usage: { windows: [{ usedPercent: 30 }], limitReached: false, checkedAt: 5 } });
    assert.deepEqual(f.sent.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
    fs.rmSync(acct, { recursive: true, force: true });
  });
});

describe('Linux self-check scratch directory (real bash -i -l)', LINUX_ONLY, () => {
  const bashrc = (): string => path.join(home, '.bashrc');
  const profile = (): string => path.join(home, '.profile');
  const configDir = (): string => path.dirname(STATE_FILE());
  // As in codexState.test.ts: a minimal environment so outer variables do not leak into the login shell
  const inCleanEnv = <T,>(fn: () => T): T => {
    const saved = process.env;
    process.env = { HOME: home, PATH: saved.PATH, SHELL: '/bin/bash', TERM: 'dumb', LANG: 'C.UTF-8' } as NodeJS.ProcessEnv;
    try {
      return fn();
    } finally {
      process.env = saved;
    }
  };
  const profileBase = 'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n';
  before(() => {
    fs.writeFileSync(bashrc(), 'case $- in\n    *i*) ;;\n      *) return;;\nesac\n');
    fs.writeFileSync(profile(), profileBase);
    installRcBlocks();
  });
  after(() => {
    fs.rmSync(bashrc(), { force: true });
    fs.rmSync(profile(), { force: true });
    fs.rmSync(configDir(), { recursive: true, force: true });
  });
  afterEach(() => {
    const text = read(profile());
    // Drop the test's extra lines after the installed content
    fs.writeFileSync(profile(), text.slice(0, text.indexOf('# test:') < 0 ? text.length : text.indexOf('# test:')));
  });

  test('the scratch directory lives in ~/.config/planswap and is removed; the state file is restored', () => {
    writeSelectedDir(path.join(home, '.codex-orig'));
    const r = inCleanEnv(selfCheck);
    assert.ok(r.ok, r.detail);
    const used = r.detail.slice('CODEX_HOME='.length);
    assert.equal(path.dirname(used), configDir());
    assert.ok(path.basename(used).startsWith(SELF_CHECK_DIR_PREFIX), used);
    assert.equal(fs.existsSync(used), false);
    assert.equal(readSelectedDir(), path.join(home, '.codex-orig'));
    assert.deepEqual(fs.readdirSync(configDir()), ['codex-home']);
  });

  test('a switch made meanwhile (state file no longer names the scratch directory) is kept', () => {
    writeSelectedDir(path.join(home, '.codex-orig'));
    fs.appendFileSync(profile(), '# test:\nprintf %s "$HOME/.codex-other" > "$HOME/.config/planswap/codex-home"\n');
    const r = inCleanEnv(selfCheck);
    assert.ok(r.ok, r.detail);
    assert.equal(readSelectedDir(), path.join(home, '.codex-other'));
    assert.deepEqual(fs.readdirSync(configDir()), ['codex-home']);
  });

  test('a scratch directory something wrote into is left in place, without a failure', () => {
    writeSelectedDir(path.join(home, '.codex-orig'));
    fs.appendFileSync(profile(), '# test:\n[ -n "$CODEX_HOME" ] && : > "$CODEX_HOME/leftover"\n');
    const r = inCleanEnv(selfCheck);
    assert.ok(r.ok, r.detail);
    const used = r.detail.slice('CODEX_HOME='.length);
    assert.deepEqual(fs.readdirSync(used), ['leftover']);
    assert.equal(readSelectedDir(), path.join(home, '.codex-orig'));
    fs.rmSync(used, { recursive: true });
  });
});
