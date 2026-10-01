// Manual usage refreshes do not query an account again within a short cooldown after its last query, since the usage
// endpoints behind the official CLIs are rate limited per account. One instance per product; in memory only. No vscode
// import.
import { samePath } from './paths';

export const USAGE_COOLDOWN_MS = 60_000;

/** Last query start per directory (samePath). The host marks every query of a product (scheduled, manual, refresh-all)
 *  and checks remaining() only before a manual refresh. */
export class UsageCooldown {
  private readonly last: Array<{ dir: string; at: number }> = [];

  constructor(private readonly now: () => number = Date.now, private readonly ms: number = USAGE_COOLDOWN_MS) {}

  /** Records that a query of dir starts now (scheduled, manual or refresh-all). */
  mark(dir: string): void {
    const entry = this.last.find((e) => samePath(e.dir, dir));
    if (entry) entry.at = this.now();
    else this.last.push({ dir, at: this.now() });
  }

  /**
   * Milliseconds left before dir may be queried manually again; 0 when it may. `elsewhere` is a check time from
   * another source (Claude's usage cache, refreshed by any window or terminal); a time in the future is ignored.
   */
  remaining(dir: string, elsewhere?: number): number {
    const now = this.now();
    const times = [this.last.find((e) => samePath(e.dir, dir))?.at, elsewhere].filter((t): t is number => t !== undefined && t <= now);
    if (!times.length) return 0;
    return Math.max(0, this.ms - (now - Math.max(...times)));
  }
}
