// Automatic usage checks of the registered accounts other than the current Claude / effective Codex one (whose own
// checks belong to the usage monitors). One instance per product; in memory only. No vscode import.

export interface OtherAccountChecksOptions {
  // Whether the run may go on (window focused, automatic checks on, no manual refresh waiting or running); asked before
  // every account
  allowed: () => boolean;
  // Read before every account, so a changed setting applies at once
  staleMs: () => number;
  // When dir was last checked by any window or trigger (Claude's usage cache, the Codex usage history); undefined
  // when unknown
  checkedAt: (dir: string) => number | undefined;
  // Queries dir; the caller serializes it with the product's other queries. Resolving to false means it was not run
  // (a manual refresh came first): no attempt is counted and the run stops. 'skipped' means it became fresh during
  // the queue wait: no attempt is counted, but the following accounts are still checked
  query: (dir: string) => Promise<boolean | 'skipped' | void>;
  now?: () => number;
}

// A check time further in the future than this (clock moved back) does not count
const FUTURE_TOLERANCE_MS = 2 * 60_000;

export class OtherAccountChecks {
  private readonly attempts = new Map<string, number>();
  private running = false;
  private readonly now: () => number;

  constructor(private readonly options: OtherAccountChecksOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Queries the given directories one after another, each only when both its last check (checkedAt) and this
   * instance's last attempt for it, failed ones included, are older than staleMs, so a failure is not retried in a
   * loop. Stops before the next account once allowed() is false, and when a query reports that it was not run. A call
   * while a run is going on does nothing. A rejected query counts as an attempt and the run goes on.
   */
  async run(dirs: readonly string[]): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const dir of dirs) {
        if (!this.options.allowed()) return;
        const now = this.now();
        const checked = this.options.checkedAt(dir);
        const last = Math.max(checked !== undefined && checked <= now + FUTURE_TOLERANCE_MS ? checked : 0, this.attempts.get(dir) ?? 0);
        if (now - last < this.options.staleMs()) continue;
        const previous = this.attempts.get(dir);
        this.attempts.set(dir, now);
        let ran: boolean | 'skipped' | void = true;
        try {
          ran = await this.options.query(dir);
        } catch { /* counted as an attempt; the next account is still checked */ }
        if (ran === false || ran === 'skipped') {
          if (previous === undefined) this.attempts.delete(dir);
          else this.attempts.set(dir, previous);
          if (ran === false) return;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
