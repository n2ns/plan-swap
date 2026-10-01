// Refreshes the usage cache of this window's current Claude account for the status bar tooltip and the panel. The
// values themselves are always read from the account's own info file; the monitor only keeps whether a refresh runs and
// how the last one failed. One query at a time; the caller decides when to ask. No vscode import.
import { samePath } from './paths';
import type { ClaudeQueryResult, ClaudeUsageFailure } from './claudeUsage';

export interface ClaudeUsageState {
  checking: boolean;
  // The last failed refresh, only for the directory it was run for
  failure?: { dir: string; reason: ClaudeUsageFailure; detail?: string };
}

export interface ClaudeUsageMonitorOptions {
  query: (dir: string) => Promise<ClaudeQueryResult>;
  // Whether the account can have usage limits (a subscription sign-in); others are never queried. Default: always
  eligible?: (dir: string) => boolean;
  now?: () => number;
  staleMs?: number;
}

export const CLAUDE_USAGE_STALE_MS = 15 * 60_000;

export class ClaudeUsageMonitor {
  private state: ClaudeUsageState = { checking: false };
  private running: Promise<void> | undefined;
  private last: { dir: string; at: number } | undefined;
  private readonly query: ClaudeUsageMonitorOptions['query'];
  private readonly eligible: (dir: string) => boolean;
  private readonly now: () => number;
  private readonly staleMs: number;

  constructor(
    private readonly dirOf: () => string,
    private readonly onChange: (state: ClaudeUsageState) => void,
    options: ClaudeUsageMonitorOptions,
  ) {
    this.query = options.query;
    this.eligible = options.eligible ?? (() => true);
    this.now = options.now ?? Date.now;
    this.staleMs = options.staleMs ?? CLAUDE_USAGE_STALE_MS;
  }

  current(): ClaudeUsageState {
    return this.state;
  }

  /** Queries now; a call while a query runs joins it instead of starting a second claude process. */
  refresh(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Queries when the current account changed or its last attempt, failed ones included, is older than staleMs. An
   * account that is not eligible is skipped without counting as an attempt, so its sign-in is checked at once.
   */
  refreshIfStale(): Promise<void> {
    const dir = this.dirOf();
    if (this.running || !this.eligible(dir) || (this.last && samePath(this.last.dir, dir) && this.now() - this.last.at < this.staleMs)) {
      return this.running ?? Promise.resolve();
    }
    return this.refresh();
  }

  private async run(): Promise<void> {
    // One follow-up when the current account changed during the query
    for (let attempt = 0; attempt < 2; attempt++) {
      const dir = this.dirOf();
      if (!this.eligible(dir)) {
        if (this.state.checking || this.state.failure) this.set({ checking: false });
        return;
      }
      this.last = { dir, at: this.now() };
      this.set({ checking: true, failure: this.state.failure });
      let result: ClaudeQueryResult;
      try {
        result = await this.query(dir);
      } catch (e) {
        result = { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
      }
      this.set({ checking: false, failure: result.ok ? undefined : { dir, reason: result.reason, detail: result.detail } });
      if (samePath(dir, this.dirOf())) return;
    }
  }

  private set(state: ClaudeUsageState): void {
    this.state = state;
    this.onChange(state);
  }
}
