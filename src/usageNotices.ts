// Low usage-limit notices: once per general limit window and reset period, when this window's current Claude or
// effective Codex account has at most planswap.notifications.threshold percent of that window left. A used-up window
// (0% left, or Codex's limit reached) is left to Claude Code and Codex, which say so themselves. Announced windows are
// kept in the state file under usage.lowNotified as { product, dir, windowMinutes, resetsAt } (no email, identity or
// credentials), so other editor windows and a restart do not repeat a notice. Imports vscode only for the Memento type.
import type { Memento } from 'vscode';
import { samePath } from './paths';

export type NoticeProduct = 'claude' | 'codex';
export interface NoticeWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number /* unix seconds */; scope?: string }
interface Entry { product: NoticeProduct; dir: string; windowMinutes: number; resetsAt: number }

const KEY = 'usage.lowNotified';
// Later checks may report a slightly moved reset time; an entry keeps counting this long after its reset
const RESET_GRACE_MS = 10 * 60_000;

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Entry;
  return (e.product === 'claude' || e.product === 'codex') && typeof e.dir === 'string'
    && Number.isFinite(e.windowMinutes) && Number.isFinite(e.resetsAt);
}

export class LowUsageNotices {
  constructor(private readonly state: Memento, private readonly now: () => number = Date.now) {}

  /**
   * Of the general windows (no scope) of the account in dir that have a duration and a reset time and at most threshold
   * percent left (rounded down as the status bar shows it) but more than 0, those not announced in their reset period
   * are recorded as announced; the one with the least left is returned with that percentage. Nothing with limitReached,
   * and nothing when the record cannot be saved, so a broken state file does not repeat a notice on every check.
   * Entries past their reset are pruned on the way.
   */
  async take<W extends NoticeWindow>(
    product: NoticeProduct, dir: string, windows: readonly W[], threshold: number, limitReached = false,
  ): Promise<{ window: W; remaining: number } | undefined> {
    if (limitReached) return undefined;
    const now = this.now();
    const raw = this.state.get<unknown>(KEY);
    const entries = (Array.isArray(raw) ? raw.filter(validEntry) : []).filter((e) => e.resetsAt * 1000 + RESET_GRACE_MS > now);
    // Until its reset, an entry covers its window whatever reset time a later check reports
    const announced = (w: W): boolean => entries.some((e) => e.product === product && samePath(e.dir, dir) && e.windowMinutes === w.windowMinutes);
    const remainingOf = (w: W): number => Math.max(0, Math.min(100, Math.floor(100 - w.usedPercent)));
    const due = windows.filter((w) => !w.scope && w.windowMinutes !== undefined && w.resetsAt !== undefined
      && w.resetsAt * 1000 > now && remainingOf(w) > 0 && remainingOf(w) <= threshold && !announced(w));
    if (!due.length) return undefined;
    const added = due.map((w): Entry => ({ product, dir, windowMinutes: w.windowMinutes!, resetsAt: w.resetsAt! }));
    try {
      await this.state.update(KEY, [...entries, ...added]);
    } catch {
      return undefined;
    }
    const lowest = due.reduce((a, b) => remainingOf(b) < remainingOf(a) ? b : a);
    return { window: lowest, remaining: remainingOf(lowest) };
  }
}
