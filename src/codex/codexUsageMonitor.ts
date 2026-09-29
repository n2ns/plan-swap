// Keeps the usage limits of this window's effective Codex account for the status bar tooltip. One query at a time;
// the caller decides when to ask (focus, a manual refresh, an auth.json change). No vscode import.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCodexUsage, type UsageResult } from './codexUsage';

export interface CodexUsageState {
  // A query is running (the previous result, if any, stays visible meanwhile)
  checking: boolean;
  result?: UsageResult;
}

export interface UsageMonitorOptions {
  read?: (dir: string) => Promise<UsageResult>;
  now?: () => number;
  // A result older than this is refreshed by refreshIfStale; failures count from the attempt, so they are not retried in a loop
  staleMs?: number;
  // Cheap fingerprint of <dir>/auth.json (never its content); a different value means a sign-in, sign-out or re-login
  authStamp?: (dir: string) => string;
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
  // auth.json as it was when the last query ended (so a token refresh Codex does during our own query is not a "change")
  private stampAfterQuery: string | undefined;
  private readonly read: (dir: string) => Promise<UsageResult>;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly authStamp: (dir: string) => string;

  constructor(
    private readonly dirOf: () => string,
    private readonly onChange: (state: CodexUsageState) => void,
    options: UsageMonitorOptions = {},
  ) {
    this.read = options.read ?? ((dir) => readCodexUsage(dir));
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? USAGE_STALE_MS;
    this.authStamp = options.authStamp ?? authFileStamp;
  }

  current(): CodexUsageState {
    return this.state;
  }

  /** Queries now; a call while a query runs joins it instead of starting a second codex process. */
  refresh(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Queries only when nothing was tried yet or the last attempt is older than the stale interval. */
  refreshIfStale(): Promise<void> {
    if (this.lastAttempt !== undefined && this.now() - this.lastAttempt < this.staleMs) return this.running ?? Promise.resolve();
    return this.refresh();
  }

  /**
   * Queries when auth.json changed since the last query ended: a sign-in, a re-login after an expired sign-in, or a
   * sign-out. Other account-info events (tab switches, other accounts' files) start nothing.
   */
  refreshIfAuthChanged(): Promise<void> {
    if (this.running) return this.running;
    if (this.stampAfterQuery === undefined || this.authStamp(this.dirOf()) === this.stampAfterQuery) return Promise.resolve();
    return this.refresh();
  }

  private async run(): Promise<void> {
    const dir = this.dirOf();
    this.lastAttempt = this.now();
    this.set({ checking: true, result: this.state.result });
    let result: UsageResult;
    try {
      result = await this.read(dir);
    } catch (e) {
      result = { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
    this.stampAfterQuery = this.authStamp(dir);
    this.set({ checking: false, result });
  }

  private set(state: CodexUsageState): void {
    this.state = state;
    this.onChange(state);
  }
}
