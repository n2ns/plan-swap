// Usage limits of a Claude account. PlanSwap never reads .credentials.json: it runs the official CLI's local `/usage`
// command with the account's directory, so Claude Code refreshes the usage cache (cachedUsageUtilization) in that
// account's own info file with its own credentials. Its structured report validates the query; displayed values and
// fetch times still come from that cache. No vscode import.
// Design and rationale: docs/design.md 6.9. Raw CLI output is never logged or returned.
import * as childProcess from 'node:child_process';
import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { claudeJsonPath } from './paths';
import { stripBom } from './platform';

export interface ClaudeUsageWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number /* unix seconds */; scope?: string }

export interface ClaudeUsage {
  /** Windows whose reset time has not passed; usedPercent clamped to 0..100 */
  windows: ClaudeUsageWindow[];
  /** ms epoch at which Claude Code fetched the values (fetchedAtMs) */
  checkedAt: number;
}

/** cliMissing: no `claude`, Windows `claude.cmd`, or available bundled CLI; timeout: the whole run exceeded timeoutMs;
 *  notRefreshed: valid report but the cache predates the run by more than 2 minutes or is too far in the future;
 *  noUsage: unavailable report, changed/missing identity, or no attributable cache supporting the report's empty state;
 *  failed: invalid report/result, unparsable output, abnormal exit, output over 1 MiB, spawn error or cancel. */
export type ClaudeUsageFailure = 'cliMissing' | 'timeout' | 'notRefreshed' | 'noUsage' | 'failed';
export type ClaudeQueryResult = { ok: true } | { ok: false; reason: ClaudeUsageFailure; detail?: string };

/** The part of a ChildProcess queryClaudeUsage uses; node's ChildProcess satisfies it. */
export interface ClaudeUsageChild extends EventEmitter {
  stdout: Readable | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ClaudeUsageSpawn = (command: string, args: string[], options: childProcess.SpawnOptions) => ClaudeUsageChild;

export interface ClaudeQueryOptions {
  spawn?: ClaudeUsageSpawn;
  /** Look up the official extension's binary only when the PATH commands are missing. */
  fallback?: () => string | undefined;
  /** Variables of the Claude Code setting (settingEnv) */
  env?: Record<string, string>;
  /** Ends the started child and settles as `failed` with detail 'cancelled' */
  signal?: AbortSignal;
  /** Whole run; default 30000 */
  timeoutMs?: number;
  now?: () => number;
  /** Platform override for tests; default process.platform */
  platform?: NodeJS.Platform;
  /** Ends the process tree of a child started through cmd.exe (Windows claude.cmd fallback); default taskkill /T /F */
  killTree?: (pid: number) => void;
}

// Observations older than this are not shown (Claude Code keeps the cache indefinitely)
export const CLAUDE_USAGE_MAX_AGE_MS = 24 * 60 * 60_000;
// Claude Code answers /usage from its cache for about a minute after a fetch; a fetch this recent counts as refreshed
const REFRESH_TOLERANCE_MS = 2 * 60_000;
// Only user settings are loaded (no project settings of the working directory), and the run leaves no session transcript
const ARGS = ['-p', '/usage', '--output-format', 'json', '--verbose', '--no-session-persistence', '--setting-sources', 'user'];
const DETAIL_MAX = 200;
const MAX_OUTPUT = 1024 * 1024;
const SESSION_MINUTES = 300;
const WEEK_MINUTES = 7 * 1440;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const truncate = (s: string): string => (s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX - 1) + '…' : s);

function resetSeconds(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function window(percent: unknown, minutes: number | undefined, resets: unknown, scope?: string): ClaudeUsageWindow | undefined {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
  const w: ClaudeUsageWindow = { usedPercent: Math.min(100, Math.max(0, percent)) };
  if (minutes !== undefined) w.windowMinutes = minutes;
  const resetsAt = resetSeconds(resets);
  if (resetsAt !== undefined) w.resetsAt = resetsAt;
  if (scope) w.scope = scope;
  return w;
}

// `limits` lists every window with its kind (session, weekly_all, weekly_scoped with a model); five_hour / seven_day
// are the older fields, used when limits is missing
function windowsOf(u: Record<string, unknown>): ClaudeUsageWindow[] {
  const out: ClaudeUsageWindow[] = [];
  if (Object.hasOwn(u, 'limits')) {
    if (!Array.isArray(u.limits)) return out;
    for (const l of u.limits) {
      if (!isPlainObject(l)) continue;
      const kind = typeof l.kind === 'string' ? l.kind : '';
      const minutes = kind === 'session' ? SESSION_MINUTES : kind.startsWith('weekly') ? WEEK_MINUTES : undefined;
      const model = isPlainObject(l.scope) && isPlainObject(l.scope.model) ? l.scope.model.display_name : undefined;
      const w = window(l.percent, minutes, l.resets_at, typeof model === 'string' ? model : undefined);
      if (w) out.push(w);
    }
    return out;
  }
  for (const [key, minutes] of [['five_hour', SESSION_MINUTES], ['seven_day', WEEK_MINUTES]] as const) {
    const v = u[key];
    const w = isPlainObject(v) ? window(v.utilization, minutes, v.resets_at) : undefined;
    if (w) out.push(w);
  }
  return out;
}

// The cache of a parsed info file when it belongs to the signed-in account (its accountUuid equals
// oauthAccount.accountUuid; compared here only, never returned) and carries a fetch time
function ownCache(data: unknown): { cache: Record<string, unknown>; checkedAt: number } | undefined {
  if (!isPlainObject(data)) return undefined;
  const cache = data.cachedUsageUtilization;
  const oauth = data.oauthAccount;
  if (!isPlainObject(cache) || !isPlainObject(oauth)) return undefined;
  const owner = oauth.accountUuid;
  if (typeof owner !== 'string' || !owner || cache.accountUuid !== owner) return undefined;
  const checkedAt = cache.fetchedAtMs;
  return typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? { cache, checkedAt } : undefined;
}

/**
 * Pure: the usage cache of a parsed account info file, or undefined when there is none worth showing. The cache must
 * belong to the signed-in account (cachedUsageUtilization.accountUuid equals a non-empty oauthAccount.accountUuid),
 * be younger than CLAUDE_USAGE_MAX_AGE_MS and not more than 2 minutes in the future. Windows come from
 * utilization.limits[] (kind session → 300 min, weekly* → 10080, otherwise none; scope.model.display_name → scope) or,
 * when limits is absent, five_hour / seven_day; an entry without a finite percentage is skipped and windows
 * past their reset time are dropped. No window left → undefined, never a 0% window.
 */
export function parseUsageCache(data: unknown, now: number): ClaudeUsage | undefined {
  const own = ownCache(data);
  if (!own) return undefined;
  const { cache, checkedAt } = own;
  const age = now - checkedAt;
  if (age >= CLAUDE_USAGE_MAX_AGE_MS || age < -REFRESH_TOLERANCE_MS) return undefined;
  if (!isPlainObject(cache.utilization)) return undefined;
  const windows = windowsOf(cache.utilization).filter((w) => w.resetsAt === undefined || w.resetsAt * 1000 > now);
  return windows.length ? { windows, checkedAt } : undefined;
}

function readInfo(dir: string, explicit: boolean): unknown {
  try {
    return JSON.parse(stripBom(fs.readFileSync(claudeJsonPath(dir, explicit), 'utf8')));
  } catch {
    return undefined; // missing, or being written by the CLI
  }
}

/** fetchedAtMs of the account's own usage cache, of any age; undefined when there is none attributable to the sign-in. */
export function readUsageFetchedAt(dir: string, explicit = false): number | undefined {
  return ownCache(readInfo(dir, explicit))?.checkedAt;
}

/** Usage cache of the account in dir (explicit: as for claudeJsonPath); undefined when missing, unreadable or
 *  half-written. Synchronous. */
export function readClaudeUsage(dir: string, explicit = false, now: number = Date.now()): ClaudeUsage | undefined {
  return parseUsageCache(readInfo(dir, explicit), now);
}

// kill() on a child started through cmd.exe ends only cmd.exe; taskkill /T also ends the claude it started
function taskkillTree(pid: number): void {
  childProcess.execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => undefined);
}

/** The official extension's native binary, using its platform-specific layout before its single-platform layout.
 * Windows ARM64 also supports the extension's x64 fallback. Only this extension host's installation is searched. */
export function findBundledClaude(extensionPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform !== 'win32' && platform !== 'linux') return undefined;
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [path.join(extensionPath, 'resources', 'native-binaries', `${platform}-${arch}`, name)];
  if (platform === 'win32' && arch === 'arm64') {
    candidates.push(path.join(extensionPath, 'resources', 'native-binaries', 'win32-x64', name));
  }
  candidates.push(path.join(extensionPath, 'resources', 'native-binary', name));
  return candidates.find((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

// Whether a file of that name exists in a PATH directory (Windows fallback only)
function onPath(file: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return dirs.some((d) => {
    try {
      return fs.statSync(path.join(d, file)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * The environment of the CLI run: a copy of base with the setting variables applied (each value, '' included,
 * overrides the inherited one), then CLAUDE_CONFIG_DIR=dir (resolved) when Claude Code reads <dir>/.claude.json for it,
 * and no CLAUDE_CONFIG_DIR for the home-level ~/.claude.json of the default ~/.claude, so the CLI updates the file we read.
 */
export function usageEnv(
  dir: string, explicit: boolean, base: NodeJS.ProcessEnv = process.env, setting: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = { ...base, ...setting };
  if (path.resolve(path.dirname(claudeJsonPath(dir, explicit))) === path.resolve(dir)) env.CLAUDE_CONFIG_DIR = path.resolve(dir);
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/**
 * Runs the given tasks one after another in call order, so the scheduled check and a manual refresh of all accounts
 * never start two claude processes at once. A failed task does not stop the next one.
 */
export function oneAtATime(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export interface UsageTarget { dir: string; label: string }
// A query that threw is reported as failed with the error message (both products' results have this shape)
type QueryThrew = { ok: false; reason: 'failed'; detail: string };

/**
 * Queries the targets one after another (never two claude or codex processes at once); stops before the next target once
 * cancelled() is true. Returns the results of the targets actually queried, in order; onStep is called before each
 * query. A rejected query becomes { ok: false, reason: 'failed', detail: <message> } and the loop goes on.
 */
export async function queryEach<R = ClaudeQueryResult>(
  targets: UsageTarget[], query: (dir: string) => Promise<R>,
  onStep: (target: UsageTarget, index: number) => void = () => undefined, cancelled: () => boolean = () => false,
): Promise<Array<{ target: UsageTarget; result: R | QueryThrew }>> {
  const out: Array<{ target: UsageTarget; result: R | QueryThrew }> = [];
  for (const [index, target] of targets.entries()) {
    if (cancelled()) break;
    onStep(target, index);
    let result: R | QueryThrew;
    try {
      result = await query(target.dir);
    } catch (e) {
      result = { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
    out.push({ target, result });
  }
  return out;
}

type QueryOutcome = { ok: true; empty: boolean } | Extract<ClaudeQueryResult, { ok: false }>;
type Attempt = { kind: 'done'; result: QueryOutcome } | { kind: 'enoent' };

// Used only within one query; neither the identity nor the verbose report leaves this module.
function queryIdentity(data: unknown): string | undefined {
  if (!isPlainObject(data) || !isPlainObject(data.oauthAccount)) return undefined;
  const { accountUuid, organizationUuid } = data.oauthAccount;
  if (typeof accountUuid !== 'string' || !accountUuid || typeof organizationUuid !== 'string' || !organizationUuid) return undefined;
  return JSON.stringify([accountUuid, organizationUuid]);
}

/**
 * Runs `claude` with ARGS for the account (a local command: no prompt is sent), env usageEnv(dir, explicit,
 * process.env, options.env), cwd the home directory, hidden window, stdin and stderr ignored. On ENOENT on Windows,
 * when a claude.cmd is on PATH, retries through the shell as a fixed command line. If the PATH commands are missing,
 * tries options.fallback's binary directly without a shell. All attempts share timeoutMs and the abort signal;
 * cancellation or an exhausted deadline starts no further child. Only a child it started and still running is ever
 * signalled (the shell fallback's tree through killTree). Stdout is limited to 1 MiB of bytes. A normal exit and a
 * terminal successful local `usage` result must accompany one valid assistant usage report. Missing/null limits
 * are unavailable; [] is valid empty data. No version probing or cache-only downgrade. Raw output is never returned.
 * Success also requires stable account/organization identity and an owned, recent cache with matching emptiness.
 * Recent official cache hits need not advance fetchedAtMs (see ClaudeUsageFailure).
 */
export async function queryClaudeUsage(dir: string, explicit: boolean, options: ClaudeQueryOptions = {}): Promise<ClaudeQueryResult> {
  const spawn: ClaudeUsageSpawn = options.spawn ?? ((c, a, o) => childProcess.spawn(c, a, o));
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30000;
  const startedAt = now();
  const identity = queryIdentity(readInfo(dir, explicit));
  const base: childProcess.SpawnOptions = {
    env: usageEnv(dir, explicit, process.env, options.env),
    cwd: os.homedir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  const run = (command: string, extra: childProcess.SpawnOptions = {}): Promise<Attempt> => {
    if (options.signal?.aborted) return Promise.resolve({ kind: 'done', result: { ok: false, reason: 'failed', detail: 'cancelled' } });
    const remaining = startedAt + timeoutMs - now();
    if (remaining <= 0) return Promise.resolve({ kind: 'done', result: { ok: false, reason: 'timeout' } });
    return attempt(spawn, command, { ...base, ...extra }, platform, remaining, options);
  };
  let a = await run('claude');
  // npm installs a claude.cmd shim, which spawn without a shell can neither find nor start; the command line is a fixed literal
  if (a.kind === 'enoent' && platform === 'win32' && onPath('claude.cmd')) a = await run('claude.cmd', { shell: true });
  if (a.kind === 'enoent') {
    const bundled = options.fallback?.();
    if (bundled) a = await run(bundled);
  }
  if (a.kind === 'enoent') return { ok: false, reason: 'cliMissing' };
  if (!a.result.ok) return a.result;
  const info = readInfo(dir, explicit);
  if (!identity || queryIdentity(info) !== identity) return { ok: false, reason: 'noUsage' };
  const own = ownCache(info);
  if (!own) return { ok: false, reason: 'noUsage' };
  const completedAt = now();
  if (own.checkedAt < startedAt - REFRESH_TOLERANCE_MS || own.checkedAt > completedAt + REFRESH_TOLERANCE_MS) {
    return { ok: false, reason: 'notRefreshed' };
  }
  const utilization = own.cache.utilization;
  if (!isPlainObject(utilization)) return { ok: false, reason: 'noUsage' };
  const emptyCache = Array.isArray(utilization.limits) && utilization.limits.length === 0;
  if (a.result.empty ? !emptyCache : !parseUsageCache(info, completedAt)) return { ok: false, reason: 'noUsage' };
  return { ok: true };
}

// Inspect only fields needed for quota validation; unrelated experimental report fields are ignored.
function outcome(stdout: string): QueryOutcome {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const messages = Array.isArray(data) ? data : [data];
  const terminal = messages.at(-1);
  if (!isPlainObject(terminal) || terminal.type !== 'result' || terminal.is_error !== false
    || terminal.subtype !== 'success' || terminal.local_command !== 'usage') return { ok: false, reason: 'failed' };
  let report: unknown;
  let reports = 0;
  for (const message of messages.slice(0, -1)) {
    if (!isPlainObject(message) || message.type === 'result') return { ok: false, reason: 'failed' };
    if (message.type === 'assistant' && Object.hasOwn(message, 'usage_report')) {
      report = message.usage_report;
      reports++;
    }
  }
  if (reports === 0) return { ok: false, reason: 'noUsage' };
  if (reports !== 1 || !isPlainObject(report)) return { ok: false, reason: 'failed' };
  const rates = report.rate_limits;
  if (rates === undefined || rates === null) return { ok: false, reason: 'noUsage' };
  if (!isPlainObject(rates)) return { ok: false, reason: 'failed' };
  const limits = rates.limits;
  if (limits === undefined || limits === null) return { ok: false, reason: 'noUsage' };
  if (!Array.isArray(limits) || !limits.every((row) => isPlainObject(row)
    && typeof row.kind === 'string' && typeof row.percent === 'number' && Number.isFinite(row.percent)
    && (row.resets_at === null || resetSeconds(row.resets_at) !== undefined))) return { ok: false, reason: 'failed' };
  return { ok: true, empty: limits.length === 0 };
}

function attempt(
  spawn: ClaudeUsageSpawn, command: string, spawnOptions: childProcess.SpawnOptions,
  platform: NodeJS.Platform, timeoutMs: number, options: ClaudeQueryOptions,
): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    let child: ClaudeUsageChild;
    try {
      child = spawnOptions.shell ? spawn([command, ...ARGS.map((a) => (a.includes(' ') ? `"${a}"` : a))].join(' '), [], spawnOptions) : spawn(command, ARGS, spawnOptions);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolve(err.code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'done', result: { ok: false, reason: 'failed', detail: truncate(String(err.message)) } });
      return;
    }
    let settled = false;
    let out = '';
    let outputBytes = 0;
    const stdout = child.stdout;

    const finish = (a: Attempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      stdout?.removeListener('data', onData);
      stdout?.resume();
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.on('error', () => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        if (platform === 'win32' && spawnOptions.shell && child.pid !== undefined) (options.killTree ?? taskkillTree)(child.pid);
        else child.kill();
      }
      resolve(a);
    };
    const onData = (chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > MAX_OUTPUT) finish({ kind: 'done', result: { ok: false, reason: 'failed', detail: 'output too long' } });
      else out += chunk;
    };
    const onError = (e: NodeJS.ErrnoException): void => {
      finish(e.code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'done', result: { ok: false, reason: 'failed', detail: truncate(e.message) } });
    };
    // 'exit' can arrive before the last stdout chunk; 'close' would wait for every stdio stream, so read what is left first
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const done = (): void => {
        if (code !== 0 || signal !== null) finish({ kind: 'done', result: { ok: false, reason: 'failed', detail: String(code ?? signal) } });
        else finish({ kind: 'done', result: outcome(out) });
      };
      if (stdout && !stdout.readableEnded) stdout.once('end', done);
      else done();
    };
    const timer = setTimeout(() => finish({ kind: 'done', result: { ok: false, reason: 'timeout' } }), timeoutMs);
    const onAbort = (): void => finish({ kind: 'done', result: { ok: false, reason: 'failed', detail: 'cancelled' } });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    stdout?.setEncoding('utf8');
    stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}
