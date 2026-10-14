// Subscription access checked through the official CLI only; tokens are never read and reports stay in memory.
// An access denial does not establish whether billing expired or an organization disabled access. No vscode import.
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeJsonPath } from './paths';
import { stripBom } from './platform';
import { usageEnv, type ClaudeQueryOptions, type ClaudeUsageChild, type ClaudeUsageSpawn } from './claudeUsage';
import { claudeCredentialOverrides } from './environmentWarnings';

export type ClaudeSubscriptionResult = 'available' | 'unavailable' | 'unknown';
export interface ClaudeSubscriptionState { unavailable: boolean; checking: boolean }
const ARGS = ['-p', 'Reply with OK.', '--output-format', 'json', '--verbose', '--no-session-persistence',
  '--system-prompt', 'Reply with OK.', '--disable-slash-commands', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--tools', '', '--strict-mcp-config', '--max-turns', '1'];
const MAX_OUTPUT = 1024 * 1024;
const COOLDOWN_MS = 60 * 60_000;
type Attempt = { kind: 'done'; result: ClaudeSubscriptionResult } | { kind: 'enoent' };
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function identity(dir: string, explicit: boolean): string | undefined {
  try {
    const data: unknown = JSON.parse(stripBom(fs.readFileSync(claudeJsonPath(dir, explicit), 'utf8')));
    if (!isPlainObject(data) || !isPlainObject(data.oauthAccount)) return undefined;
    const { accountUuid, organizationUuid } = data.oauthAccount;
    if (typeof accountUuid !== 'string' || !accountUuid || typeof organizationUuid !== 'string' || !organizationUuid) return undefined;
    return JSON.stringify([accountUuid, organizationUuid]);
  } catch { return undefined; }
}
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

/** A minimal model request, potentially consuming quota. Unknown errors never establish a subscription denial.
 * Identity must remain stable, and credential overrides prevent a query. Attempts share one timeout and cancellation.
 * User hooks, tools and configured MCP servers are disabled; no session transcript is retained. */
export async function queryClaudeSubscription(dir: string, explicit: boolean, options: ClaudeQueryOptions = {}): Promise<ClaudeSubscriptionResult> {
  const spawn: ClaudeUsageSpawn = options.spawn ?? ((c, a, o) => childProcess.spawn(c, a, o));
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const started = now();
  const before = identity(dir, explicit);
  const env = usageEnv(dir, explicit, process.env, options.env);
  let settings: unknown;
  try { settings = JSON.parse(stripBom(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown'; }
  const settingsEnv = isPlainObject(settings) && isPlainObject(settings.env) ? settings.env : {};
  const effectiveEnv = { ...env };
  for (const [key, value] of Object.entries(settingsEnv)) if (typeof value === 'string' && !effectiveEnv[key]) effectiveEnv[key] = value;
  if (!before || (isPlainObject(settings) && settings.apiKeyHelper)
    || claudeCredentialOverrides(effectiveEnv, { set: [] }, platform).length) return 'unknown';
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'planswap-subscription-'));
  try {
    const base: childProcess.SpawnOptions = { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    const run = (command: string, extra: childProcess.SpawnOptions = {}): Promise<Attempt> => {
      const remaining = started + (options.timeoutMs ?? 30000) - now();
      if (options.signal?.aborted || remaining <= 0) return Promise.resolve({ kind: 'done', result: 'unknown' });
      return attempt(spawn, command, { ...base, ...extra }, platform, remaining, options);
    };
    let a = await run('claude');
    if (a.kind === 'enoent' && platform === 'win32' && onPath('claude.cmd')) a = await run('claude.cmd', { shell: true });
    if (a.kind === 'enoent') {
      const bundled = options.fallback?.();
      if (bundled) a = await run(bundled);
    }
    return a.kind === 'done' && identity(dir, explicit) === before ? a.result : 'unknown';
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function outcome(stdout: string, code: number | null): ClaudeSubscriptionResult {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { return 'unknown'; }
  const messages = Array.isArray(data) ? data : [data];
  const terminal = messages.at(-1);
  if (!isPlainObject(terminal) || terminal.type !== 'result') return 'unknown';
  const preceding = messages.slice(0, -1);
  if (preceding.some((m) => !isPlainObject(m) || m.type === 'result')) return 'unknown';
  const assistants = preceding.filter((m) => isPlainObject(m) && m.type === 'assistant') as Record<string, unknown>[];
  if (code === 1 && terminal.is_error === true && assistants.some((m) => m.error === 'oauth_org_not_allowed')) return 'unavailable';
  if (code === 0 && terminal.is_error === false && terminal.subtype === 'success'
    && assistants.length && assistants.every((m) => !m.error)) return 'available';
  return 'unknown';
}

function attempt(
  spawn: ClaudeUsageSpawn, command: string, spawnOptions: childProcess.SpawnOptions,
  platform: NodeJS.Platform, timeoutMs: number, options: ClaudeQueryOptions,
): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    let child: ClaudeUsageChild;
    try {
      child = spawnOptions.shell ? spawn([command, ...ARGS.map((a) => `"${a.replace(/"/g, '\\"')}"`)].join(' '), [], spawnOptions) : spawn(command, ARGS, spawnOptions);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolve(err.code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'done', result: 'unknown' });
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
      if (outputBytes > MAX_OUTPUT) finish({ kind: 'done', result: 'unknown' });
      else out += chunk;
    };
    const onError = (e: NodeJS.ErrnoException): void => {
      finish(e.code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'done', result: 'unknown' });
    };
    // 'exit' can arrive before the last stdout chunk; 'close' would wait for every stdio stream, so read what is left first
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const done = (): void => {
        if (signal !== null) finish({ kind: 'done', result: 'unknown' });
        else finish({ kind: 'done', result: outcome(out, code) });
      };
      if (stdout && !stdout.readableEnded) stdout.once('end', done);
      else done();
    };
    const timer = setTimeout(() => finish({ kind: 'done', result: 'unknown' }), timeoutMs);
    const onAbort = (): void => finish({ kind: 'done', result: 'unknown' });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    stdout?.setEncoding('utf8');
    stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

interface Entry {
  identity: string;
  unavailable: boolean;
  lastAttempt?: number;
  running?: Promise<ClaudeSubscriptionResult>;
}

/** In-memory, identity-bound observations. Automatic probes stop after a confirmed denial; manual checks can restore
 * access. Transient failures retain a confirmed denial. The caller serializes these checks with usage queries. */
export class ClaudeSubscriptionChecks {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly query: (dir: string, explicit: boolean, signal?: AbortSignal) => Promise<ClaudeSubscriptionResult>,
    private readonly changed: () => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}
  private entry(dir: string, explicit: boolean): Entry | undefined {
    const key = path.resolve(claudeJsonPath(dir, explicit));
    const current = identity(dir, explicit);
    if (!current) { this.entries.delete(key); return undefined; }
    let entry = this.entries.get(key);
    if (!entry || entry.identity !== current) {
      entry = { identity: current, unavailable: false };
      this.entries.set(key, entry);
    }
    return entry;
  }
  state(dir: string, explicit: boolean): ClaudeSubscriptionState {
    const entry = this.entry(dir, explicit);
    return { unavailable: entry?.unavailable ?? false, checking: !!entry?.running };
  }
  check(dir: string, explicit: boolean, manual = false, signal?: AbortSignal): Promise<ClaudeSubscriptionResult> {
    const entry = this.entry(dir, explicit);
    if (!entry) return Promise.resolve('unknown');
    if (entry.running) return entry.running;
    if ((!manual && entry.unavailable) || (entry.lastAttempt !== undefined && this.now() - entry.lastAttempt < (manual ? 60_000 : COOLDOWN_MS))) {
      return Promise.resolve(entry.unavailable ? 'unavailable' : 'unknown');
    }
    entry.lastAttempt = this.now();
    entry.running = Promise.resolve().then(() => this.query(dir, explicit, signal)).catch((): ClaudeSubscriptionResult => 'unknown').then((result) => {
      if (this.entry(dir, explicit) !== entry) return 'unknown';
      if (result !== 'unknown') entry.unavailable = result === 'unavailable';
      return result;
    }).finally(() => { entry.running = undefined; this.changed(); });
    this.changed();
    return entry.running;
  }
  acceptAvailable(dir: string, explicit: boolean): void {
    const entry = this.entry(dir, explicit);
    if (entry) entry.unavailable = false;
  }
  clear(dir: string, explicit = false): void {
    this.entries.delete(path.resolve(claudeJsonPath(dir, explicit)));
  }
}
