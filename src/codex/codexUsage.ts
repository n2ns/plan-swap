// Usage limits (rate limits) of a Codex account. PlanSwap never reads auth.json itself: it starts the official CLI's
// app server with CODEX_HOME=<account dir>, so Codex reads (and may refresh) its own credentials, and asks it over the
// stdio protocol (one JSON object per line) for account/rateLimits/read. No vscode import.
import * as childProcess from 'node:child_process';
import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

export interface UsageWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number /* unix seconds */ }

export interface CodexUsage {
  /** Primary then secondary window, only those present; usedPercent clamped to 0..100 */
  windows: UsageWindow[];
  /** The server reported a rateLimitReachedType */
  limitReached: boolean;
  /** ms epoch, from the injected clock */
  checkedAt: number;
}

// authExpired: auth.json exists but the service refused it (401), i.e. the account has to sign in again
export type UsageFailure = 'notLoggedIn' | 'authExpired' | 'cliMissing' | 'timeout' | 'homeMismatch' |
  'noRateLimits' | 'protocolTooLong' | 'exited' | 'unknownError' | 'failed';
export type UsageResult = { ok: true; usage: CodexUsage } | { ok: false; reason: UsageFailure; detail?: string };

/** The part of a ChildProcess readCodexUsage uses; node's ChildProcess satisfies it. */
export interface UsageChild extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export type UsageSpawn = (command: string, args: string[], options: childProcess.SpawnOptions) => UsageChild;

export interface UsageOptions {
  spawn?: UsageSpawn;
  /** Executable to start; default 'codex' (only the default gets the Windows codex.cmd fallback) */
  command?: string;
  /** Whole operation, including start-up; default 15000 */
  timeoutMs?: number;
  now?: () => number;
  /** Sent as clientInfo.version; default '0' */
  clientVersion?: string;
  /** How long the child may take to exit after stdin is closed before it is killed; default 1000 */
  graceMs?: number;
  /** Platform override for tests; default process.platform */
  platform?: NodeJS.Platform;
  /** Ends the process tree of a child started through cmd.exe (Windows codex.cmd fallback); default taskkill /T /F */
  killTree?: (pid: number) => void;
}

// kill() on a child started through cmd.exe ends only cmd.exe; taskkill /T also ends the codex it started. Only the
// pid of the child this module started is ever passed
function taskkillTree(pid: number): void {
  childProcess.execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => undefined);
}

const DEFAULT_COMMAND = 'codex';
const ARGS = ['app-server'];
const DETAIL_MAX = 200;
// A protocol line longer than this without a newline means something is wrong; stop buffering
const MAX_BUFFER = 1024 * 1024;
const INIT_ID = 1;
const LIMITS_ID = 2;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// First finite number among the given keys (camelCase first, snake_case tolerated)
function num(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function parseWindow(v: unknown): UsageWindow | undefined {
  if (!isPlainObject(v)) return undefined;
  const used = num(v, 'usedPercent', 'used_percent');
  if (used === undefined) return undefined;
  const w: UsageWindow = { usedPercent: Math.min(100, Math.max(0, used)) };
  const minutes = num(v, 'windowDurationMins', 'window_duration_mins', 'window_minutes', 'windowMinutes');
  if (minutes !== undefined) w.windowMinutes = minutes;
  const resets = num(v, 'resetsAt', 'resets_at');
  if (resets !== undefined) w.resetsAt = resets;
  return w;
}

function parseSnapshot(v: unknown, now: number): CodexUsage | undefined {
  if (!isPlainObject(v)) return undefined;
  const windows: UsageWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = parseWindow(v[key]);
    if (w) windows.push(w);
  }
  const limitReached = pick(v, 'rateLimitReachedType', 'rate_limit_reached_type') != null;
  if (windows.length === 0 && !limitReached) return undefined;
  return { windows, limitReached, checkedAt: now };
}

/**
 * Pure: turns the `result` of account/rateLimits/read into CodexUsage; undefined when nothing usable. Prefers the
 * `codex` bucket of rateLimitsByLimitId, falling back to rateLimits.
 */
export function parseRateLimits(result: unknown, now: number): CodexUsage | undefined {
  if (!isPlainObject(result)) return undefined;
  const byId = pick(result, 'rateLimitsByLimitId', 'rate_limits_by_limit_id');
  const bucket = isPlainObject(byId) ? parseSnapshot(byId.codex, now) : undefined;
  return bucket ?? parseSnapshot(pick(result, 'rateLimits', 'rate_limits'), now);
}

const truncate = (s: string): string => (s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX - 1) + '…' : s);

// A signed-out account is recognized by its message ("authentication required"); -32600 alone is the generic
// invalid-request code and would misreport other failures as signed out
function isAuthError(e: Record<string, unknown>): boolean {
  return typeof e.message === 'string' && /authenticat/i.test(e.message);
}

// Codex forwards the service's answer: an expired or revoked sign-in arrives as "... 401 Unauthorized ..." (-32603)
function isExpiredAuth(e: Record<string, unknown>): boolean {
  return typeof e.message === 'string' && /\b401\b|unauthorized/i.test(e.message);
}

/**
 * The codex binary shipped inside the Codex extension (<extension>/bin/<os>-<arch>/codex[.exe]), for users without the
 * CLI on PATH. The package also carries other platforms' binaries (a Windows install ships linux-x86_64 for WSL), so
 * only the folder of this OS and architecture is used.
 */
export function findBundledCodex(extensionPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
  if (!os) return undefined;
  const archName = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  const file = path.join(extensionPath, 'bin', `${os}-${archName}`, platform === 'win32' ? 'codex.exe' : 'codex');
  return fs.existsSync(file) ? file : undefined;
}

function errorMessage(message: string, code: unknown): string {
  return truncate(typeof code === 'number' ? `${message} (${code})` : message);
}

function comparable(p: string, platform: NodeJS.Platform): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    // keep the resolved path when it cannot be canonicalized
  }
  return platform === 'win32' ? r.toLowerCase() : r;
}

// Whether a file of that name exists in a PATH directory (Windows fallback only)
function onPath(file: string): boolean {
  // Windows PATH entries may be quoted ("C:\Program Files\nodejs"); cmd.exe accepts that, so the check must too
  const dirs = (process.env.PATH ?? '').split(path.delimiter).map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return dirs.some((d) => {
    try {
      return fs.statSync(path.join(d, file)).isFile();
    } catch {
      return false;
    }
  });
}

type Attempt = { kind: 'done'; result: UsageResult } | { kind: 'enoent' };

/**
 * Starts `codex app-server` with CODEX_HOME=dir, performs the handshake, reads the limits, and always ends the child
 * it started (closes stdin, then kills it if it has not exited within graceMs). Only that child is ever signalled.
 */
export async function readCodexUsage(dir: string, options: UsageOptions = {}): Promise<UsageResult> {
  // Existence check only; the file is never read
  if (!fs.existsSync(path.join(dir, 'auth.json'))) return { ok: false, reason: 'notLoggedIn' };
  const spawn: UsageSpawn = options.spawn ?? ((c, a, o) => childProcess.spawn(c, a, o));
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15000;
  const deadline = now() + timeoutMs;
  const home = path.resolve(dir);
  const base: childProcess.SpawnOptions = {
    env: { ...process.env, CODEX_HOME: home },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  };
  const run = (command: string, extra: childProcess.SpawnOptions = {}): Promise<Attempt> =>
    attempt(spawn, command, { ...base, ...extra }, home, platform, now, Math.max(0, deadline - now()), options);

  const command = options.command ?? DEFAULT_COMMAND;
  let a = await run(command);
  // npm installs a codex.cmd shim, which spawn without a shell neither finds nor may start. The command and arguments
  // are fixed literals (no user input reaches the command line), so running the shim through cmd.exe is safe. The app
  // server ends when its stdin closes; if it does not, the whole cmd.exe tree is ended (kill() would reach cmd.exe only).
  if (a.kind === 'enoent' && platform === 'win32' && options.command === undefined && onPath('codex.cmd')) {
    a = await run('codex.cmd', { shell: true });
  }
  return a.kind === 'enoent' ? { ok: false, reason: 'cliMissing' } : a.result;
}

function attempt(
  spawn: UsageSpawn, command: string, spawnOptions: childProcess.SpawnOptions, home: string,
  platform: NodeJS.Platform, now: () => number, timeoutMs: number, options: UsageOptions,
): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    let child: UsageChild;
    try {
      // Through a shell the fixed command line is passed as one string (arguments next to shell: true are deprecated)
      child = spawnOptions.shell ? spawn([command, ...ARGS].join(' '), [], spawnOptions) : spawn(command, ARGS, spawnOptions);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolve(err.code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'done', result: { ok: false, reason: 'failed', detail: truncate(String(err.message)) } });
      return;
    }
    let settled = false;
    let buffer = '';
    const stdin = child.stdin;
    const stdout = child.stdout;

    const send = (msg: unknown): void => {
      stdin?.write(JSON.stringify(msg) + '\n');
    };

    const onLine = (line: string): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not a protocol message; never echoed anywhere
      }
      // Only responses count: notifications have no id, and a request from the server may reuse our ids but carries a method
      if (!isPlainObject(msg) || (msg.id !== INIT_ID && msg.id !== LIMITS_ID) || Object.hasOwn(msg, 'method')) return;
      if (isPlainObject(msg.error)) {
        const e = msg.error;
        // 401 first: "authentication failed: 401 Unauthorized" is an expired sign-in, not a missing one
        finish(isExpiredAuth(e) ? { ok: false, reason: 'authExpired' }
          : isAuthError(e) ? { ok: false, reason: 'notLoggedIn' }
            : typeof e.message === 'string' ? { ok: false, reason: 'failed', detail: errorMessage(e.message, e.code) }
              : { ok: false, reason: 'unknownError', detail: typeof e.code === 'number' ? String(e.code) : undefined });
        return;
      }
      const result = msg.result;
      if (msg.id === INIT_ID) {
        // Proves which account the server serves before asking it anything
        const reported = isPlainObject(result) ? result.codexHome : undefined;
        if (typeof reported === 'string' && comparable(reported, platform) !== comparable(home, platform)) {
          finish({ ok: false, reason: 'homeMismatch', detail: truncate(reported) });
          return;
        }
        send({ method: 'initialized' });
        send({ id: LIMITS_ID, method: 'account/rateLimits/read' });
        return;
      }
      const usage = parseRateLimits(isPlainObject(result) ? result : undefined, now());
      finish(usage ? { ok: true, usage } : { ok: false, reason: 'noRateLimits' });
    };

    const onData = (chunk: string): void => {
      buffer += chunk;
      let nl: number;
      while (!settled && (nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
      if (!settled && buffer.length > MAX_BUFFER) finish({ ok: false, reason: 'protocolTooLong' });
    };

    const onError = (e: NodeJS.ErrnoException): void => {
      if (e.code === 'ENOENT') finishWith({ kind: 'enoent' });
      else finish({ ok: false, reason: 'failed', detail: truncate(e.message) });
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const status = code ?? signal;
      finish({ ok: false, reason: 'exited', detail: status === null ? undefined : String(status) });
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

    function finish(result: UsageResult): void {
      finishWith({ kind: 'done', result });
    }

    function finishWith(a: Attempt): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout?.removeListener('data', onData);
      stdout?.resume(); // drain whatever else arrives so the child never blocks on a full pipe
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.on('error', () => undefined); // a late error must not become an uncaught exception
      try {
        stdin?.end();
      } catch {
        // already closed
      }
      if (child.exitCode === null && child.signalCode === null) {
        const kill = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (platform === 'win32' && spawnOptions.shell && child.pid !== undefined) (options.killTree ?? taskkillTree)(child.pid);
          else child.kill();
        }, options.graceMs ?? 1000);
        kill.unref?.();
        child.once('exit', () => clearTimeout(kill));
      }
      resolve(a);
    }

    // EPIPE and the like after the child is gone are expected; the exit/error handlers report the outcome
    stdin?.on('error', () => undefined);
    stdout?.setEncoding('utf8'); // Decode multibyte characters across chunk boundaries before parsing JSON lines.
    stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
    send({ id: INIT_ID, method: 'initialize', params: { clientInfo: { name: 'planswap', version: options.clientVersion ?? '0' } } });
  });
}

/**
 * readCodexUsage with `codex` from PATH first; only when that is missing, the binary named by `fallback` (the one
 * bundled with the Codex extension), which is looked up lazily so nothing is searched while the CLI is installed.
 */
export async function readCodexUsageWithFallback(dir: string, fallback: () => string | undefined, options: UsageOptions = {}): Promise<UsageResult> {
  const first = await readCodexUsage(dir, options);
  if (first.ok || first.reason !== 'cliMissing' || options.command !== undefined) return first;
  const command = fallback();
  return command ? readCodexUsage(dir, { ...options, command }) : first;
}
