// Account recommendation: which registered account of a page to suggest when the current one runs low, and the
// per-account "excluded from recommendations" marks. Pure ranking over the rows the panel already shows (no new data,
// no vscode import); the Webview only renders the result.
import type { Memento } from 'vscode';
import type { AccountView } from './protocol';

type UsageWindow = NonNullable<AccountView['usage']>['windows'][number];

/**
 * Lowest remaining percentage of the general (non model-specific) windows of a usage observation, with at most two
 * decimals like the Webview; undefined without a general window. Model-specific windows never count: PlanSwap does
 * not know which model the user will use next.
 */
export function lowestRemaining(usage: AccountView['usage']): number | undefined {
  const general = (usage?.windows ?? []).filter((w: UsageWindow) => !w.scope);
  if (general.length === 0) return undefined;
  return Math.min(...general.map((w) => Number((100 - w.usedPercent).toFixed(2))));
}

/**
 * The directory of the account to recommend, or undefined. A recommendation is made only while the current row's
 * lowest general window is at or below warningThreshold (the sidebar's warning color); without a current observation
 * nothing is low, so nothing is recommended. Candidates are the registered rows (never the external directory) that
 * are not excluded, not already selected (Codex, pending restart) and have a general window observation with nothing
 * used up (lowest remaining > 0, no limitReached). The candidate with the highest lowest-remaining wins, a fresher
 * observation (checkedAt) breaking ties, and only when it is strictly better than the current account; so the current
 * account is never recommended.
 */
export function recommend(rows: readonly AccountView[], warningThreshold: number): string | undefined {
  const current = rows.find((r) => r.isCurrent);
  const currentLowest = lowestRemaining(current?.usage);
  if (currentLowest === undefined || currentLowest > warningThreshold) return undefined;
  let best: { dir: string; lowest: number; checkedAt: number } | undefined;
  for (const row of rows) {
    if (row.kind === 'external' || row.isCurrent || row.isSelected || row.recommendExcluded || row.usage?.limitReached) continue;
    const lowest = lowestRemaining(row.usage);
    if (lowest === undefined || lowest <= 0 || lowest <= currentLowest) continue;
    const checkedAt = row.usage!.checkedAt;
    if (!best || lowest > best.lowest || (lowest === best.lowest && checkedAt > best.checkedAt)) best = { dir: row.dir, lowest, checkedAt };
  }
  return best?.dir;
}

// Stored under state[key]: the names of the accounts excluded from recommendations
export class RecommendExclusions {
  constructor(
    private readonly state: Memento,
    private readonly key: 'claude.recommendExcluded' | 'codex.recommendExcluded',
  ) {}

  has(name: string): boolean {
    return this.read().includes(name);
  }

  /** Adds or removes the name; nothing is written when the mark is already as asked, and the entry is dropped from
   *  the state when the list becomes empty */
  async set(name: string, excluded: boolean): Promise<void> {
    const current = this.read();
    if (current.includes(name) === excluded) return;
    const names = current.filter((n) => n !== name);
    if (excluded) names.push(name);
    await this.state.update(this.key, names.length ? names : undefined);
  }

  /** Called when an account is deleted */
  async remove(name: string): Promise<void> {
    await this.set(name, false);
  }

  private read(): string[] {
    const value = this.state.get<unknown>(this.key);
    return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [];
  }
}
