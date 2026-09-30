// Keeps the usage limits of this window's effective Codex account for the status bar tooltip. One query at a time;
// the caller decides when to ask (focus, a manual refresh, an auth.json change). No vscode import.
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
  // A result older than this is refreshed by refreshIfStale; failures count from the attempt, so they are not retried in a loop
  staleMs?: number;
  // Cheap fingerprint of <dir>/auth.json (never its content); changes include sign-in, sign-out and token refreshes.
  authStamp?: (dir: string) => string;
  // In-memory comparison only; never included in state or persistence callbacks.
  authIdentity?: (dir: string) => string | undefined;
  onAccepted?: (dir: string, result: UsageResult, stamp: string) => Promise<void> | void;
}

interface AuthSnapshot { dir: string; stamp: string; identity?: string }

function sameAuth(a: AuthSnapshot, b: AuthSnapshot): boolean {
  if (!samePath(a.dir, b.dir)) return false;
  if (a.identity !== undefined || b.identity !== undefined) return a.identity !== undefined && a.identity === b.identity;
  return a.stamp === b.stamp;
}

export const USAGE_STALE_MS = 15 * 60_000;

/** mtime and size of auth.json, or 'missing'; only stat is used, the file is never opened. */
export function authFileStamp(dir: string): string {
  try {
    const st = fs.statSync(path.join(dir, 'auth.json'));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
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
  private readonly staleMs: number;
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
    this.staleMs = options.staleMs ?? USAGE_STALE_MS;
    this.authStamp = options.authStamp ?? authFileStamp;
    this.authIdentity = options.authIdentity ?? ((dir) => readCodexAccountInfo(dir).identity);
    this.onAccepted = options.onAccepted;
  }

  current(): CodexUsageState {
    return this.state;
  }

  /** Queries now; a call while a query runs joins it instead of starting a second codex process. */
  refresh(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
      this.queryAuth = undefined;
    });
    return this.running;
  }

  /** Queries after a discarded response, when nothing was tried yet, or after the stale interval. */
  refreshIfStale(): Promise<void> {
    if (!this.needsRefresh && this.lastAttempt !== undefined && this.now() - this.lastAttempt < this.staleMs) return this.running ?? Promise.resolve();
    return this.refresh();
  }

  /**
   * Queries when auth.json changed since the last accepted response: a sign-in, a re-login after an expired sign-in, or a
   * sign-out. Other account-info events (tab switches, other accounts' files) start nothing.
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
