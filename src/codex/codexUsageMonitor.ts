// Keeps the usage limits of this window's effective Codex account for the status bar tooltip. One query at a time;
// the caller decides when to ask (focus, a manual refresh, an auth.json change). No vscode import.
// Attribution: before and after each query the monitor compares the in-memory identity and auth stamp of the
// directory. A changed stamp is accepted only for the same known identity (a token refresh); otherwise the response is
// discarded and stays eligible for the next auth-change or stale check. A known identity change permits one
// sequential follow-up query per refresh chain. onAccepted receives the verified stamp for persistence, and identity is
// checked again after it settles before the result is published. Identity keys never enter the callback, the live
// state or persistent history; the state lives in memory only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { samePath } from '../paths';
import { readCodexAccountInfo } from './codexPaths';
import { readCodexUsage, type UsageResult } from './codexUsage';

export interface CodexUsageState {
  // A query is running (a previous result stays visible only for the same known identity)
  checking: boolean;
  result?: UsageResult;
}

export interface UsageMonitorOptions {
  read?: (dir: string) => Promise<UsageResult>;
  now?: () => number;
  // Default USAGE_STALE_MS. A result older than this is refreshed by refreshIfStale; failures count from the attempt, so they are not retried in a loop.
  // A function is read on every check, so a changed setting applies at once
  staleMs?: number | (() => number);
  // Default authFileStamp. Cheap fingerprint of <dir>/auth.json (never its content); changes include sign-in, sign-out and token refreshes.
  authStamp?: (dir: string) => string;
  // Default readCodexAccountInfo(dir).identity. In-memory comparison only; never included in state or persistence callbacks.
  authIdentity?: (dir: string) => string | undefined;
  // Persists an accepted result with its verified stamp (CodexUsageHistory.record); a failure here is ignored
  onAccepted?: (dir: string, result: UsageResult, stamp: string) => Promise<void> | void;
}

interface AuthSnapshot { dir: string; stamp: string; identity?: string }

function sameAuth(a: AuthSnapshot, b: AuthSnapshot): boolean {
  if (!samePath(a.dir, b.dir)) return false;
  if (a.identity !== undefined || b.identity !== undefined) return a.identity !== undefined && a.identity === b.identity;
  return a.stamp === b.stamp;
}

export const USAGE_STALE_MS = 15 * 60_000;

/** `${mtimeMs}:${size}` of <dir>/auth.json, or 'missing'; only stat is used, the file is never opened. */
export function authFileStamp(dir: string): string {
  try {
    const st = fs.statSync(path.join(dir, 'auth.json'));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * One query of an account that is not the effective one (refresh of all accounts). The result is handed to onAccepted,
 * with the verified stamp, only when auth.json and the identity did not change while it ran (as in the monitor);
 * otherwise it is discarded and returned as failed with detail 'discarded'. A thrown read becomes 'failed'; an
 * onAccepted failure is ignored.
 */
export async function queryCodexAccount(
  dir: string,
  read: (dir: string) => Promise<UsageResult>,
  onAccepted: (dir: string, result: UsageResult, stamp: string) => Promise<void> | void,
  options: Pick<UsageMonitorOptions, 'authStamp' | 'authIdentity'> = {},
): Promise<UsageResult> {
  const authStamp = options.authStamp ?? authFileStamp;
  const authIdentity = options.authIdentity ?? ((d: string) => readCodexAccountInfo(d).identity);
  const snapshot = (): AuthSnapshot => ({ dir, stamp: authStamp(dir), identity: authIdentity(dir) });
  const before = snapshot();
  let result: UsageResult;
  try {
    result = await read(dir);
  } catch (e) {
    result = { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
  const after = snapshot();
  if (!sameAuth(before, after)) return { ok: false, reason: 'failed', detail: 'discarded' };
  try { await onAccepted(dir, result, after.stamp); } catch { /* a history failure does not turn the query into an error */ }
  return result;
}

export class CodexUsageMonitor {
  private state: CodexUsageState = { checking: false };
  private running: Promise<void> | undefined;
  private lastAttempt: number | undefined;
  private accepted: AuthSnapshot | undefined;
  private queryAuth: AuthSnapshot | undefined;
  private needsRefresh = false;
  private readonly read: (dir: string) => Promise<UsageResult>;
  private readonly now: () => number;
  private readonly staleMs: () => number;
  private readonly authStamp: (dir: string) => string;
  private readonly authIdentity: (dir: string) => string | undefined;
  private readonly onAccepted: UsageMonitorOptions['onAccepted'];

  constructor(
    private readonly dirOf: () => string,
    private readonly onChange: (state: CodexUsageState) => void,
    options: UsageMonitorOptions = {},
  ) {
    this.read = options.read ?? ((dir) => readCodexUsage(dir));
    this.now = options.now ?? Date.now;
    const staleMs = options.staleMs ?? USAGE_STALE_MS;
    this.staleMs = typeof staleMs === 'number' ? () => staleMs : staleMs;
    this.authStamp = options.authStamp ?? authFileStamp;
    this.authIdentity = options.authIdentity ?? ((dir) => readCodexAccountInfo(dir).identity);
    this.onAccepted = options.onAccepted;
  }

  current(): CodexUsageState {
    return this.state;
  }

  /** Queries dirOf() now; a call while a query runs joins it instead of starting a second codex process. A thrown
   *  read becomes 'failed'. */
  refresh(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
      this.queryAuth = undefined;
    });
    return this.running;
  }

  /** Queries after a discarded response, when nothing was tried yet, or when the last attempt (failures included) is
   *  older than staleMs; otherwise joins a running query or does nothing. */
  refreshIfStale(): Promise<void> {
    if (!this.needsRefresh && this.lastAttempt !== undefined && this.now() - this.lastAttempt < this.staleMs()) return this.running ?? Promise.resolve();
    return this.refresh();
  }

  /**
   * Queries when auth.json changed since the last accepted response: a sign-in, a re-login after an expired sign-in, or a
   * sign-out. Other account-info events (tab switches, other accounts' files) start nothing. While a query runs it is
   * joined, and a changed sign-in marks its response for discarding (a shown result is dropped while checking).
   */
  refreshIfAuthChanged(): Promise<void> {
    if (this.running) {
      if (this.queryAuth && !sameAuth(this.queryAuth, this.snapshot())) {
        this.needsRefresh = true;
        if (this.state.result) this.set({ checking: true });
      }
      return this.running;
    }
    if (!this.needsRefresh && (!this.accepted || this.authStamp(this.dirOf()) === this.accepted.stamp)) return Promise.resolve();
    return this.refresh();
  }

  /**
   * Without querying (automatic checks off): drops the live result once auth.json no longer belongs to the sign-in it was
   * accepted for (another identity, a sign-out), so the tooltip never shows another account's limits. A token refresh
   * for the same identity keeps it; a running query discards a changed response itself. Such an auth change makes
   * the next refreshIfStale / refreshIfAuthChanged due at once.
   */
  clearIfAuthChanged(): void {
    if (this.running || !this.accepted || sameAuth(this.accepted, this.snapshot())) return;
    this.needsRefresh = true;
    if (this.state.result) this.set({ checking: false });
  }

  private snapshot(): AuthSnapshot {
    const dir = this.dirOf();
    return { dir, stamp: this.authStamp(dir), identity: this.authIdentity(dir) };
  }

  private async run(): Promise<void> {
    // One follow-up for a newly identified account; repeated changes wait for the next refresh trigger.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = this.snapshot();
      this.queryAuth = before;
      this.lastAttempt = this.now();
      const keep = this.accepted?.identity !== undefined && this.accepted.identity === before.identity
        && samePath(this.accepted.dir, before.dir);
      this.set({ checking: true, result: keep ? this.state.result : undefined });
      let result: UsageResult;
      try {
        result = await this.read(before.dir);
      } catch (e) {
        result = { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
      }
      const after = this.snapshot();
      if (sameAuth(before, after)) {
        // The callback gets the verified stamp, never a newly sampled stamp for an older response.
        try { await this.onAccepted?.(before.dir, result, after.stamp); } catch { /* history failure does not hide live usage */ }
        const current = this.snapshot();
        if (sameAuth(after, current)) {
          this.accepted = current;
          this.needsRefresh = false;
          this.set({ checking: false, result });
          return;
        }
      }
      this.needsRefresh = true;
      const current = this.snapshot();
      if (attempt === 0 && current.identity !== undefined && current.identity !== before.identity) continue;
      this.set({ checking: false });
      return;
    }
  }

  private set(state: CodexUsageState): void {
    this.state = state;
    this.onChange(state);
  }
}
