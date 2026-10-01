// Usage limits of a Claude account. PlanSwap never reads .credentials.json: it runs the official CLI's local `/usage`
// command with the account's directory, so Claude Code refreshes the usage cache (cachedUsageUtilization) in that
// account's own info file with its own credentials, and the values are read from that cache. No vscode import.
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
  /** Variables of the Claude Code setting (settingEnv) */
  env?: Record<string, string>;
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
const ARGS = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'user'];
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
  if (Array.isArray(u.limits) && u.limits.length) {
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
 * belong to the signed-in account, be younger than CLAUDE_USAGE_MAX_AGE_MS, and windows past their reset time are dropped.
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

/** Usage cache of the account in dir (explicit: as for claudeJsonPath); undefined when missing or unreadable. */
export function readClaudeUsage(dir: string, explicit = false, now: number = Date.now()): ClaudeUsage | undefined {
  return parseUsageCache(readInfo(dir, explicit), now);
}

// kill() on a child started through cmd.exe ends only cmd.exe; taskkill /T also ends the claude it started
function taskkillTree(pid: number): void {
  childProcess.execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => undefined);
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
 * The environment of the CLI run: CLAUDE_CONFIG_DIR=dir when Claude Code reads <dir>/.claude.json for it, and no
 * CLAUDE_CONFIG_DIR for the home-level ~/.claude.json of the default ~/.claude, so the CLI updates the file we read.
 */
export function usageEnv(
  dir: string, explicit: boolean, base: NodeJS.ProcessEnv = process.env, setting: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env = { ...base, ...setting };
  if (path.resolve(path.dirname(claudeJsonPath(dir, explicit))) === path.resolve(dir)) env.CLAUDE_CONFIG_DIR = path.resolve(dir);
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

type Attempt = { kind: 'done'; result: ClaudeQueryResult } | { kind: 'enoent' };

/**
 * Runs `claude -p /usage --output-format json` for the account (a local command: no prompt is sent), then checks that
 * the account's usage cache was fetched during this run. The child it started is the only process ever signalled.
 */
export async function queryClaudeUsage(dir: string, explicit: boolean, options: ClaudeQueryOptions = {}): Promise<ClaudeQueryResult> {
  const spawn: ClaudeUsageSpawn = options.spawn ?? ((c, a, o) => childProcess.spawn(c, a, o));
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30000;
  const startedAt = now();
  const base: childProcess.SpawnOptions = {
    env: usageEnv(dir, explicit, process.env, options.env),
    cwd: os.homedir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  const run = (command: string, extra: childProcess.SpawnOptions = {}): Promise<Attempt> =>
    attempt(spawn, command, { ...base, ...extra }, platform, Math.max(0, startedAt + timeoutMs - now()), options);
  let a = await run('claude');
  // npm installs a claude.cmd shim, which spawn without a shell can neither find nor start; the command line is a fixed literal
  if (a.kind === 'enoent' && platform === 'win32' && onPath('claude.cmd')) a = await run('claude.cmd', { shell: true });
  if (a.kind === 'enoent') return { ok: false, reason: 'cliMissing' };
  if (!a.result.ok) return a.result;
  const own = ownCache(readInfo(dir, explicit));
  if (!own) return { ok: false, reason: 'noUsage' };
  // The CLI answers from its old cache without an error when the fetch fails (e.g. offline)
  return own.checkedAt >= startedAt - REFRESH_TOLERANCE_MS ? { ok: true } : { ok: false, reason: 'notRefreshed' };
}

// The JSON result of the print-mode run; its text is never returned except as a short error detail
function outcome(stdout: string): ClaudeQueryResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'failed', detail: truncate(stdout.trim()) || undefined };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'failed' };
  if (data.is_error === true || data.subtype !== 'success') {
    return { ok: false, reason: 'failed', detail: typeof data.result === 'string' && data.result.trim() ? truncate(data.result.trim()) : undefined };
  }
  return { ok: true };
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
    const stdout = child.stdout;

    const finish = (a: Attempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      out += chunk;
      if (out.length > MAX_OUTPUT) finish({ kind: 'done', result: { ok: false, reason: 'failed', detail: 'output too long' } });
    };
    const onError = (e: NodeJS.ErrnoException): void => {
      finish(e.code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'done', result: { ok: false, reason: 'failed', detail: truncate(e.message) } });
    };
    // 'exit' can arrive before the last stdout chunk; 'close' would wait for every stdio stream, so read what is left first
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const done = (): void => {
        if (code !== 0 && !out.trim()) finish({ kind: 'done', result: { ok: false, reason: 'failed', detail: String(code ?? signal) } });
        else finish({ kind: 'done', result: outcome(out) });
      };
      if (stdout && !stdout.readableEnded) stdout.once('end', done);
      else done();
    };
    const timer = setTimeout(() => finish({ kind: 'done', result: { ok: false, reason: 'timeout' } }), timeoutMs);

    stdout?.setEncoding('utf8');
    stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}
