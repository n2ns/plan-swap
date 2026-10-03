import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { findBundledCodex, parseRateLimits, readCodexUsage, readCodexUsageWithFallback, type UsageChild, type UsageOptions } from '../src/codex/codexUsage';
import { makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
let acct: string;
let signedOut: string;

before(() => {
  tmp = makeTempHome('codex-usage');
  acct = path.join(tmp.home, '.codex-work');
  signedOut = path.join(tmp.home, '.codex-out');
  fs.mkdirSync(acct);
  fs.mkdirSync(signedOut);
  fs.writeFileSync(path.join(acct, 'auth.json'), '{}'); // dummy content only
});
after(() => tmp.restore());

const NOW = 1_700_000_000_000;
const win = (usedPercent: number, windowDurationMins: number | null = 300, resetsAt: number | null = 1_700_001_000) =>
  ({ usedPercent, windowDurationMins, resetsAt });

describe('parseRateLimits', () => {
  test('primary then secondary with durations and reset times', () => {
    const u = parseRateLimits({ rateLimits: { primary: win(12), secondary: win(40, 10080, 1_700_500_000) }, rateLimitsByLimitId: null }, NOW);
    assert.deepEqual(u, {
      windows: [{ usedPercent: 12, windowMinutes: 300, resetsAt: 1_700_001_000 }, { usedPercent: 40, windowMinutes: 10080, resetsAt: 1_700_500_000 }],
      limitReached: false,
      checkedAt: NOW,
    });
  });
  test('prefers the codex bucket of rateLimitsByLimitId', () => {
    const u = parseRateLimits({ rateLimits: { primary: win(1) }, rateLimitsByLimitId: { other: { primary: win(2) }, codex: { primary: win(77) } } }, NOW);
    assert.equal(u?.windows[0]?.usedPercent, 77);
  });
  test('falls back to rateLimits when the codex bucket is absent or empty', () => {
    assert.equal(parseRateLimits({ rateLimits: { primary: win(5) }, rateLimitsByLimitId: { other: { primary: win(2) } } }, NOW)?.windows[0]?.usedPercent, 5);
    assert.equal(parseRateLimits({ rateLimits: { primary: win(6) }, rateLimitsByLimitId: { codex: {} } }, NOW)?.windows[0]?.usedPercent, 6);
  });
  test('clamps usedPercent to 0..100', () => {
    const u = parseRateLimits({ rateLimits: { primary: win(150), secondary: win(-3) } }, NOW);
    assert.deepEqual(u?.windows.map((w) => w.usedPercent), [100, 0]);
  });
  test('missing or null fields are omitted; windows without usedPercent are skipped', () => {
    const u = parseRateLimits({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: null, resetsAt: null }, secondary: { windowDurationMins: 60 } } }, NOW);
    assert.deepEqual(u?.windows, [{ usedPercent: 3 }]);
    assert.deepEqual(parseRateLimits({ rateLimits: { secondary: win(9) } }, NOW)?.windows.map((w) => w.usedPercent), [9]);
  });
  test('rejects non-finite numbers', () => {
    assert.equal(parseRateLimits({ rateLimits: { primary: { usedPercent: Number.NaN } } }, NOW), undefined);
    const u = parseRateLimits({ rateLimits: { primary: { usedPercent: 4, resetsAt: Number.POSITIVE_INFINITY, windowDurationMins: '300' } } }, NOW);
    assert.deepEqual(u?.windows, [{ usedPercent: 4 }]);
  });
  test('tolerates snake_case variants', () => {
    const u = parseRateLimits({ rate_limits: { primary: { used_percent: 8, window_minutes: 300, resets_at: 5 } } }, NOW);
    assert.deepEqual(u?.windows, [{ usedPercent: 8, windowMinutes: 300, resetsAt: 5 }]);
  });
  test('limitReached follows rateLimitReachedType', () => {
    assert.equal(parseRateLimits({ rateLimits: { primary: win(100), rateLimitReachedType: 'rate_limit_reached' } }, NOW)?.limitReached, true);
    assert.equal(parseRateLimits({ rateLimits: { primary: win(100), rateLimitReachedType: null } }, NOW)?.limitReached, false);
    // A reached limit without windows is still usable
    assert.deepEqual(parseRateLimits({ rateLimits: { rateLimitReachedType: 'workspace_member_usage_limit_reached' } }, NOW), { windows: [], limitReached: true, checkedAt: NOW });
  });
  test('nothing usable → undefined', () => {
    for (const r of [undefined, null, 1, [], {}, { rateLimits: null }, { rateLimits: {} }, { rateLimits: { primary: null, secondary: null } }]) {
      assert.equal(parseRateLimits(r, NOW), undefined);
    }
  });
});

// Fake `codex app-server`: parses the lines PlanSwap writes and answers through `respond`
interface FakeChild extends UsageChild {
  sent: Record<string, unknown>[];
  killed: number;
  stdinEnded: boolean;
}

type Responder = (msg: Record<string, unknown>, child: FakeChild, write: (o: unknown) => void) => void;

interface SpawnCall { command: string; args: string[]; options: SpawnOptions }

function fakeSpawn(respond: Responder, opts: { exitOnStdinEnd?: boolean; enoent?: (call: number) => boolean } = {}) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = (command: string, args: string[], options: SpawnOptions): UsageChild => {
    calls.push({ command, args, options });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      sent: [] as Record<string, unknown>[], killed: 0, stdinEnded: false,
      kill(signal?: NodeJS.Signals): boolean {
        child.killed++;
        child.signalCode = signal ?? 'SIGTERM';
        setImmediate(() => child.emit('exit', null, child.signalCode));
        return true;
      },
    }) as FakeChild;
    children.push(child);
    if (opts.enoent?.(calls.length)) {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      return child;
    }
    const write = (o: unknown): void => { stdout.write(JSON.stringify(o) + '\n'); };
    let buf = '';
    stdin.on('data', (c: Buffer) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        child.sent.push(msg);
        respond(msg, child, write);
      }
    });
    stdin.on('finish', () => {
      child.stdinEnded = true;
      if (opts.exitOnStdinEnd) {
        child.exitCode = 0;
        setImmediate(() => child.emit('exit', 0, null));
      }
    });
    return child;
  };
  return { spawn, calls, children };
}

const LIMITS = { rateLimits: { primary: win(25), secondary: win(60, 10080) }, rateLimitsByLimitId: null };

// Well-behaved server: initialize → codexHome of the account, then the given answer to rateLimits/read
function server(limits: (id: unknown) => unknown, codexHome?: string): Responder {
  return (msg, _child, write) => {
    if (msg.method === 'initialize') write({ id: msg.id, result: { userAgent: 'codex/0.139.0', codexHome: codexHome ?? acct, platformFamily: 'unix', platformOs: 'linux' } });
    else if (msg.method === 'account/rateLimits/read') write(limits(msg.id));
  };
}

const base = (spawn: UsageOptions['spawn']): UsageOptions => ({ spawn, now: () => NOW, timeoutMs: 2000, graceMs: 20, clientVersion: '9.9.9' });
const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('readCodexUsage', () => {
  test('no auth.json → notLoggedIn without spawning', async () => {
    const f = fakeSpawn(server(() => ({})));
    assert.deepEqual(await readCodexUsage(signedOut, base(f.spawn)), { ok: false, reason: 'notLoggedIn' });
    assert.equal(f.calls.length, 0);
  });

  test('success: handshake, limits, child env and cleanup', async () => {
    const f = fakeSpawn(server((id) => ({ id, result: LIMITS })), { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.deepEqual(r, {
      ok: true,
      usage: { windows: [{ usedPercent: 25, windowMinutes: 300, resetsAt: 1_700_001_000 }, { usedPercent: 60, windowMinutes: 10080, resetsAt: 1_700_001_000 }], limitReached: false, checkedAt: NOW },
    });
    const [call] = f.calls;
    assert.equal(call?.command, 'codex');
    assert.deepEqual(call?.args, ['app-server']);
    assert.equal(call?.options.env?.CODEX_HOME, path.resolve(acct));
    assert.equal(call?.options.windowsHide, true);
    assert.ok(!call?.options.shell);
    const child = f.children[0]!;
    assert.deepEqual(child.sent.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
    assert.deepEqual(child.sent[0]?.params, { clientInfo: { name: 'planswap', version: '9.9.9' } });
    assert.equal('id' in child.sent[1]!, false, 'initialized is a notification');
    await settle();
    assert.equal(child.stdinEnded, true);
    assert.equal(child.killed, 0, 'a child that exits on its own is not killed');
  });

  test('ignores unrelated notifications, blank and non-JSON lines, and responses split across chunks', async () => {
    const f = fakeSpawn((msg, child, write) => {
      const out = child.stdout as PassThrough;
      if (msg.method === 'initialize') {
        write({ method: 'remoteControl/status/changed', params: { id: 2 } });
        out.write('\nnot json\n');
        write({ id: 99, result: { rateLimits: { primary: win(1) } } });
        write({ id: msg.id, result: { codexHome: acct } });
      } else if (msg.method === 'account/rateLimits/read') {
        const line = JSON.stringify({ id: msg.id, result: LIMITS }) + '\r\n';
        out.write(line.slice(0, 10));
        setImmediate(() => out.write(line.slice(10)));
      }
    }, { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.usage.windows[0]?.usedPercent, 25);
  });

  test('limitReached is reported', async () => {
    const f = fakeSpawn(server((id) => ({ id, result: { rateLimits: { primary: win(100), rateLimitReachedType: 'rate_limit_reached' } } })), { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.equal(r.ok && r.usage.limitReached, true);
  });

  test('UTF-8 account paths survive protocol chunks split inside multibyte characters', async () => {
    const dir = path.join(tmp.home, '用户📁', '.codex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
    const f = fakeSpawn((msg, child, write) => {
      if (msg.method === 'initialize') {
        const line = Buffer.from(JSON.stringify({ id: msg.id, result: { codexHome: dir } }) + '\n');
        for (const byte of line) child.stdout!.push(Buffer.from([byte]));
      } else if (msg.method === 'account/rateLimits/read') {
        write({ id: msg.id, result: LIMITS });
      }
    }, { exitOnStdinEnd: true });
    const result = await readCodexUsage(dir, base(f.spawn));
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.usage.windows[0].usedPercent, 25);
    assert.deepEqual(f.children[0].sent.map((msg) => msg.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  });

  test('authentication error → notLoggedIn', async () => {
    const f = fakeSpawn(server((id) => ({ id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } })), { exitOnStdinEnd: true });
    assert.deepEqual(await readCodexUsage(acct, base(f.spawn)), { ok: false, reason: 'notLoggedIn' });
    await settle();
    assert.equal(f.children[0]!.stdinEnded, true);
  });

  test('a generic -32600 without an authentication message is a failure, not signed out', async () => {
    const f = fakeSpawn(server((id) => ({ id, error: { code: -32600, message: 'Invalid request' } })), { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.equal(!r.ok && r.reason, 'failed');
  });

  test('other error → failed with the server message, truncated', async () => {
    const f = fakeSpawn(server((id) => ({ id, error: { code: -32603, message: 'boom '.repeat(100) } })), { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'failed');
    const detail = (!r.ok && r.detail) || '';
    assert.ok(detail.startsWith('boom'));
    assert.ok(detail.length <= 200);
  });

  test('an error without a message keeps its code separately for localization', async () => {
    for (const code of [-32603, undefined]) {
      const f = fakeSpawn(server((id) => ({ id, error: code === undefined ? {} : { code } })), { exitOnStdinEnd: true });
      assert.deepEqual(await readCodexUsage(acct, base(f.spawn)), {
        ok: false, reason: 'unknownError', detail: code === undefined ? undefined : String(code),
      });
    }
  });

  test('a response without usable limits has a localizable reason', async () => {
    const f = fakeSpawn(server((id) => ({ id, result: { rateLimits: null } })), { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.deepEqual(r, { ok: false, reason: 'noRateLimits' });
  });

  test('an oversized protocol line has a localizable reason without including the line', async () => {
    const f = fakeSpawn((_msg, child) => {
      (child.stdout as PassThrough).write('x'.repeat(1024 * 1024 + 1));
    }, { exitOnStdinEnd: true });
    assert.deepEqual(await readCodexUsage(acct, base(f.spawn)), { ok: false, reason: 'protocolTooLong' });
  });

  test('exit before an answer keeps the exit code separately, without protocol lines', async () => {
    const f = fakeSpawn((msg, child) => {
      if (msg.method !== 'initialize') return;
      (child.stdout as PassThrough).write('{"secret":"token-like-output"}\n');
      child.exitCode = 3;
      setImmediate(() => child.emit('exit', 3, null));
    });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.deepEqual(r, { ok: false, reason: 'exited', detail: '3' });
    assert.doesNotMatch(JSON.stringify(r), /secret|token-like/);
    await settle();
    assert.equal(f.children[0]!.killed, 0, 'an exited child is not signalled');
  });

  test('timeout → timeout, and the silent child is killed after the grace period', async () => {
    const f = fakeSpawn(() => undefined);
    const r = await readCodexUsage(acct, { ...base(f.spawn), timeoutMs: 30 });
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    const child = f.children[0]!;
    await settle();
    assert.equal(child.stdinEnded, true);
    assert.equal(child.killed, 1);
  });

  test('aborting ends the query as cancelled and the child is ended; an aborted signal starts nothing', async () => {
    const f = fakeSpawn(() => undefined);
    const abort = new AbortController();
    const pending = readCodexUsage(acct, { ...base(f.spawn), signal: abort.signal });
    await settle(10);
    abort.abort();
    assert.deepEqual(await pending, { ok: false, reason: 'failed', detail: 'cancelled' });
    await settle();
    assert.equal(f.children[0]!.stdinEnded, true);
    assert.equal(f.children[0]!.killed, 1);
    assert.deepEqual(await readCodexUsage(acct, { ...base(f.spawn), signal: abort.signal }), { ok: false, reason: 'failed', detail: 'cancelled' });
    assert.equal(f.calls.length, 1);
  });

  test('a child that stays alive after answering is killed', async () => {
    const f = fakeSpawn(server((id) => ({ id, result: LIMITS })));
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.equal(r.ok, true);
    const child = f.children[0]!;
    assert.equal(child.killed, 0, 'not killed before the grace period');
    await settle();
    assert.equal(child.stdinEnded, true);
    assert.equal(child.killed, 1);
  });

  test('codexHome mismatch keeps the reported directory separately without asking for limits', async () => {
    const f = fakeSpawn(server((id) => ({ id, result: LIMITS }), path.join(tmp.home, '.codex')), { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.deepEqual(r, { ok: false, reason: 'homeMismatch', detail: path.join(tmp.home, '.codex') });
    assert.deepEqual(f.children[0]!.sent.map((m) => m.method), ['initialize']);
  });

  test('codexHome is compared case-insensitively on win32', async () => {
    const f = fakeSpawn(server((id) => ({ id, result: LIMITS }), acct.toUpperCase()), { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, { ...base(f.spawn), platform: 'win32' });
    assert.equal(r.ok, true);
  });

  test('initialize error → failed', async () => {
    const f = fakeSpawn((msg, _c, write) => { if (msg.method === 'initialize') write({ id: msg.id, error: { code: -32602, message: 'bad params' } }); }, { exitOnStdinEnd: true });
    const r = await readCodexUsage(acct, base(f.spawn));
    assert.deepEqual(r, { ok: false, reason: 'failed', detail: 'bad params (-32602)' });
  });

  test('ENOENT → cliMissing', async () => {
    const f = fakeSpawn(() => undefined, { enoent: () => true });
    assert.deepEqual(await readCodexUsage(acct, { ...base(f.spawn), platform: 'linux' }), { ok: false, reason: 'cliMissing' });
    assert.equal(f.calls.length, 1);
  });

  test('a synchronous spawn throw with ENOENT → cliMissing', async () => {
    const spawn = (): UsageChild => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); };
    assert.deepEqual(await readCodexUsage(acct, { ...base(spawn), platform: 'linux' }), { ok: false, reason: 'cliMissing' });
  });

  describe('win32 codex.cmd fallback', () => {
    let savedPath: string | undefined;
    let shimDir: string;
    before(() => {
      savedPath = process.env.PATH;
      shimDir = path.join(tmp.home, 'npm-bin');
      fs.mkdirSync(shimDir);
    });
    // Each test states whether PATH has a codex.cmd shim, so none depends on what an earlier one left behind
    const shim = (present: boolean): void => {
      if (present) fs.writeFileSync(path.join(shimDir, 'codex.cmd'), '');
      else fs.rmSync(path.join(shimDir, 'codex.cmd'), { force: true });
    };
    afterEach(() => {
      shim(false);
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    });

    test('no codex.cmd on PATH → cliMissing without a second spawn', async () => {
      shim(false);
      process.env.PATH = shimDir;
      const f = fakeSpawn(() => undefined, { enoent: () => true });
      assert.deepEqual(await readCodexUsage(acct, { ...base(f.spawn), platform: 'win32' }), { ok: false, reason: 'cliMissing' });
      assert.equal(f.calls.length, 1);
    });

    test('retries once with codex.cmd through the shell', async () => {
      shim(true);
      process.env.PATH = shimDir;
      const f = fakeSpawn(server((id) => ({ id, result: LIMITS })), { enoent: (n) => n === 1, exitOnStdinEnd: true });
      const r = await readCodexUsage(acct, { ...base(f.spawn), platform: 'win32' });
      assert.equal(r.ok, true);
      assert.deepEqual(f.calls.map((c) => [c.command, c.args, !!c.options.shell]), [['codex', ['app-server'], false], ['codex.cmd app-server', [], true]]);
      assert.equal(f.calls[1]?.options.env?.CODEX_HOME, path.resolve(acct));
    });

    test('a shim child that does not exit is ended as a tree by its own pid, not by kill()', async () => {
      shim(true);
      process.env.PATH = shimDir;
      const f = fakeSpawn(() => undefined, { enoent: (n) => n === 1 });
      const trees: number[] = [];
      const spawn: UsageOptions['spawn'] = (c, a, o) => Object.assign(f.spawn(c, a, o), { pid: 4242 });
      // The deadline leaves a slow CI runner time to report ENOENT for codex and start codex.cmd before it expires
      const r = await readCodexUsage(acct, { ...base(spawn), platform: 'win32', timeoutMs: 300, killTree: (pid) => trees.push(pid) });
      assert.deepEqual(r, { ok: false, reason: 'timeout' });
      await settle();
      assert.deepEqual(trees, [4242]);
      assert.equal(f.children[1]!.killed, 0);
    });

    test('a quoted PATH entry still finds codex.cmd', async () => {
      shim(true);
      process.env.PATH = `"${shimDir}"`;
      const f = fakeSpawn(server((id) => ({ id, result: LIMITS })), { enoent: (n) => n === 1, exitOnStdinEnd: true });
      const r = await readCodexUsage(acct, { ...base(f.spawn), platform: 'win32' });
      assert.equal(r.ok, true);
      assert.equal(f.calls.length, 2);
    });

    test('ENOENT from the retry too → cliMissing', async () => {
      shim(true);
      process.env.PATH = shimDir;
      const f = fakeSpawn(() => undefined, { enoent: () => true });
      assert.deepEqual(await readCodexUsage(acct, { ...base(f.spawn), platform: 'win32' }), { ok: false, reason: 'cliMissing' });
      assert.equal(f.calls.length, 2);
    });

    test('an explicit command gets no fallback', async () => {
      shim(true);   // even with codex.cmd on PATH
      process.env.PATH = shimDir;
      const f = fakeSpawn(() => undefined, { enoent: () => true });
      assert.deepEqual(await readCodexUsage(acct, { ...base(f.spawn), platform: 'win32', command: 'my-codex' }), { ok: false, reason: 'cliMissing' });
      assert.deepEqual(f.calls.map((c) => c.command), ['my-codex']);
    });
  });
});

describe('expired sign-in and the bundled codex', () => {
  test('a 401 from the service is an expired sign-in, not a generic failure', async () => {
    const message = 'failed to fetch codex rate limits: GET https://example.invalid/usage failed: 401 Unauthorized';
    const f = fakeSpawn(server((id) => ({ id, error: { code: -32603, message } })), { exitOnStdinEnd: true });
    assert.deepEqual(await readCodexUsage(acct, base(f.spawn)), { ok: false, reason: 'authExpired' });
  });

  test('a 401 wins over an authentication message; authentication alone stays notLoggedIn', async () => {
    const expired = fakeSpawn(server((id) => ({ id, error: { code: -32603, message: 'authentication failed: 401 Unauthorized' } })), { exitOnStdinEnd: true });
    assert.deepEqual(await readCodexUsage(acct, base(expired.spawn)), { ok: false, reason: 'authExpired' });
    const missing = fakeSpawn(server((id) => ({ id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } })), { exitOnStdinEnd: true });
    assert.deepEqual(await readCodexUsage(acct, base(missing.spawn)), { ok: false, reason: 'notLoggedIn' });
  });

  test('findBundledCodex picks only this OS and architecture', () => {
    const ext = path.join(tmp.home, 'ext');
    for (const [folder, exe] of [['windows-x86_64', 'codex.exe'], ['linux-x86_64', 'codex'], ['linux-aarch64', 'codex']]) {
      fs.mkdirSync(path.join(ext, 'bin', folder), { recursive: true });
      fs.writeFileSync(path.join(ext, 'bin', folder, exe), '');
    }
    assert.equal(findBundledCodex(ext, 'win32', 'x64'), path.join(ext, 'bin', 'windows-x86_64', 'codex.exe'));
    assert.equal(findBundledCodex(ext, 'linux', 'x64'), path.join(ext, 'bin', 'linux-x86_64', 'codex'));
    assert.equal(findBundledCodex(ext, 'linux', 'arm64'), path.join(ext, 'bin', 'linux-aarch64', 'codex'));
    assert.equal(findBundledCodex(ext, 'win32', 'arm64'), undefined);
    assert.equal(findBundledCodex(ext, 'darwin', 'x64'), undefined);
    assert.equal(findBundledCodex(path.join(tmp.home, 'missing'), 'linux', 'x64'), undefined);
  });

  test('the fallback binary is used only when codex is missing from PATH', async () => {
    const opts = (spawn: UsageOptions['spawn']): UsageOptions => ({ ...base(spawn), platform: 'linux' });
    // Missing from PATH: the bundled binary answers
    const missing = fakeSpawn(server((id) => ({ id, result: LIMITS })), { exitOnStdinEnd: true, enoent: (n) => n === 1 });
    let asked = 0;
    const r = await readCodexUsageWithFallback(acct, () => (asked++, '/ext/bin/linux-x86_64/codex'), opts(missing.spawn));
    assert.equal(r.ok, true);
    assert.deepEqual(missing.calls.map((c) => c.command), ['codex', '/ext/bin/linux-x86_64/codex']);
    assert.equal(asked, 1);
    // Installed: the fallback is never even looked up
    const installed = fakeSpawn(server((id) => ({ id, result: LIMITS })), { exitOnStdinEnd: true });
    asked = 0;
    assert.equal((await readCodexUsageWithFallback(acct, () => (asked++, 'unused'), opts(installed.spawn))).ok, true);
    assert.equal(asked, 0);
    // No fallback available: still cliMissing
    const none = fakeSpawn(server((id) => ({ id, result: LIMITS })), { exitOnStdinEnd: true, enoent: () => true });
    assert.deepEqual(await readCodexUsageWithFallback(acct, () => undefined, opts(none.spawn)), { ok: false, reason: 'cliMissing' });
  });
});
