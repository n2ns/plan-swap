// Keeps the usage limits of this window's effective Codex account for the status bar tooltip. One query at a time;
// the caller decides when to ask (focus, a manual refresh, an auth.json change). No vscode import.
// Attribution: before and after each query the monitor compares the in-memory identity and auth stamp of the
// directory. A changed stamp is accepted only for the same known identity (a token refresh); otherwise the response is
// discarded and stays eligible for the next auth-change or stale check. A known identity change permits one
// sequential follow-up query per refresh chain. onAccepted receives the verified stamp for persistence, and identity is
// checked again after it settles before the result is published. Identity keys never enter the callback, the live
// state or persistent history; the state lives in memory only. A token refresh of the known identity outside a query
// (Codex itself, another window) moves the accepted stamp without a query, and a shared observation younger than
// staleMs (cachedUsage) stands in for a scheduled query, so several windows share one schedule. adoptCached shows the
// shared observation without any query at all, so the status bar shows it even with automatic checks off.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { samePath } from '../paths';
import { readCodexAccountInfo } from './codexPaths';
import { readCodexUsage, type CodexUsage, type UsageResult } from './codexUsage';

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
  // The shared observation of dir, accepted by any window under the current auth.json stamp (CodexUsageHistory.get);
  // one younger than staleMs makes a scheduled query unnecessary. Default: none
  cachedUsage?: (dir: string) => CodexUsage | undefined;
}

interface AuthSnapshot { dir: string; stamp: string; identity?: string }

// An observation dated further in the future than this (clock moved back) does not count as fresh
const FUTURE_TOLERANCE_MS = 2 * 60_000;

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
  private readonly cachedUsage: (dir: string) => CodexUsage | undefined;

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
    this.cachedUsage = options.cachedUsage ?? (() => undefined);
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

  /**
   * Queries after a discarded response, when nothing was tried yet, or when the last attempt (failures included) is
   * older than staleMs; otherwise joins a running query or does nothing. A shared observation younger than staleMs
   * (cachedUsage; one dated more than 2 minutes in the future does not count) also starts nothing and becomes the live
   * result when it is newer than the shown one, so a window opened after another's query shows its values at once.
   */
  refreshIfStale(): Promise<void> {
    if (this.running) return this.running;
    if (this.needsRefresh) return this.refresh();
    const now = this.now();
    const staleMs = this.staleMs();
    if (this.lastAttempt !== undefined && now - this.lastAttempt < staleMs) return Promise.resolve();
    const shared = this.cachedUsage(this.dirOf());
    if (shared && shared.checkedAt <= now + FUTURE_TOLERANCE_MS && now - shared.checkedAt < staleMs) {
      this.adoptCached();
      return Promise.resolve();
    }
    return this.refresh();
  }

  /**
   * Shows the shared observation of dirOf() (cachedUsage: accepted by any window under the current auth.json stamp)
   * without querying, when it is newer than the shown result; one dated more than 2 minutes in the future does not
   * count, and nothing happens while a query runs. The accepted auth snapshot moves to the current one, so a later
   * auth change is detected against it. Returns whether it was adopted. Called at start-up, on every check tick and
   * after account-info changes, whatever the automatic-check setting, so the status bar shows what another window
   * or an earlier session observed, as the sidebar row does.
   */
  adoptCached(): boolean {
    if (this.running) return false;
    const shared = this.cachedUsage(this.dirOf());
    if (!shared || shared.checkedAt > this.now() + FUTURE_TOLERANCE_MS) return false;
    const shown = this.state.result;
    if (shown?.ok && shown.usage.checkedAt >= shared.checkedAt) return false;
    this.accepted = this.snapshot();
    this.set({ checking: false, result: { ok: true, usage: shared } });
    return true;
  }

  /**
   * Queries when auth.json changed since the last accepted response: a sign-in, a re-login after an expired sign-in, or a
   * sign-out. A changed stamp for the same known identity while a successful result is shown is a token refresh (by
   * Codex itself or another window's query): the result stays, the accepted stamp moves to the new one (onAccepted
   * re-stamps the persisted observation) and the check follows refreshIfStale, so a rotation does not start a query in
   * every window. Other account-info events (tab switches, other accounts' files) start nothing. While a query runs it is
   * joined, and a changed sign-in marks its response for discarding (a shown result is dropped while checking).
   */
  async refreshIfAuthChanged(): Promise<void> {
    if (this.running) {
      if (this.queryAuth && !sameAuth(this.queryAuth, this.snapshot())) {
        this.needsRefresh = true;
        if (this.state.result) this.set({ checking: true });
      }
      return this.running;
    }
    if (this.needsRefresh) return this.refresh();
    if (!this.accepted) return;
    const current = this.snapshot();
    if (current.stamp === this.accepted.stamp) return;
    const result = this.state.result;
    if (result?.ok && sameAuth(this.accepted, current)) {
      this.accepted = current;
      try { await this.onAccepted?.(current.dir, result, current.stamp); } catch { /* a history failure does not hide live usage */ }
      return this.refreshIfStale();
    }
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
