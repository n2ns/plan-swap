// Subscription access checked through the official CLI only; tokens are never read and reports stay in memory.
// An access denial does not establish whether billing expired or an organization disabled access. No vscode import.
import type { SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeJsonPath, readAccountInfo } from './paths';
import { stripBom, isPlainObject } from './platform';
import { runClaudeCli, usageEnv, type ClaudeQueryOptions } from './claudeUsage';
import { claudeCredentialOverrides } from './environmentWarnings';

export type ClaudeSubscriptionResult = 'available' | 'unavailable' | 'unknown';
export interface ClaudeSubscriptionState { unavailable: boolean; checking: boolean }
const ARGS = ['-p', 'Reply with OK.', '--output-format', 'json', '--verbose', '--no-session-persistence',
  '--system-prompt', 'Reply with OK.', '--disable-slash-commands', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--tools', '', '--strict-mcp-config', '--max-turns', '1'];
const COOLDOWN_MS = 60 * 60_000;
// The in-memory identity comparison key of the sign-in (readAccountInfo; never displayed, logged or persisted)
const identity = (dir: string, explicit: boolean): string | undefined => readAccountInfo(dir, explicit).identity;

/** A minimal model request, potentially consuming quota. Unknown errors never establish a subscription denial.
 * Identity must remain stable, and credential overrides prevent a query. Attempts share one timeout and cancellation.
 * User hooks, tools and configured MCP servers are disabled; no session transcript is retained. */
export async function queryClaudeSubscription(dir: string, explicit: boolean, options: ClaudeQueryOptions = {}): Promise<ClaudeSubscriptionResult> {
  const platform = options.platform ?? process.platform;
  const started = (options.now ?? Date.now)();
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
    const base: SpawnOptions = { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    // Every failure of the run itself is unknown: only the CLI's own answer can establish access or its denial
    const a = await runClaudeCli<ClaudeSubscriptionResult>(ARGS, base, started, options, {
      failure: () => 'unknown',
      timeout: () => 'unknown',
      exit: (out, code, signal) => (signal !== null ? 'unknown' : outcome(out, code)),
    });
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
}
