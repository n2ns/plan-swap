// Last observed usage per directory, stored under codex.usageHistory as entries { dir, stamp, usage } (dir compared with
// samePath). Only quota numbers, collection time and the auth.json stat stamp are persisted: no email, identity key or
// credentials. Age, stamp and reset checks happen on read; expired entries are pruned when a result is recorded.
// Imports vscode only for the Memento type.
import type { Memento } from 'vscode';
import { samePath } from '../paths';
import { authFileStamp } from './codexUsageMonitor';
import type { CodexUsage, UsageResult } from './codexUsage';

const KEY = 'codex.usageHistory';
export const USAGE_HISTORY_MAX_AGE_MS = 24 * 60 * 60_000;
interface Entry { dir: string; stamp: string; usage: CodexUsage }

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Entry;
  return typeof e.dir === 'string' && typeof e.stamp === 'string'
    && !!e.usage && Number.isFinite(e.usage.checkedAt) && typeof e.usage.limitReached === 'boolean'
    && Array.isArray(e.usage.windows) && e.usage.windows.every((w) => w && Number.isFinite(w.usedPercent)
      && w.usedPercent >= 0 && w.usedPercent <= 100
      && (w.windowMinutes === undefined || (Number.isFinite(w.windowMinutes) && w.windowMinutes > 0))
      && (w.resetsAt === undefined || Number.isFinite(w.resetsAt)));
}

export class CodexUsageHistory {
  constructor(
    private readonly state: Memento,
    private readonly now: () => number = Date.now,
    private readonly stamp: (dir: string) => string = authFileStamp,
  ) {}

  private entries(): Entry[] {
    const raw = this.state.get<unknown>(KEY);
    return Array.isArray(raw) ? raw.filter(validEntry) : [];
  }

  private recent(e: Entry): boolean {
    const age = this.now() - e.usage.checkedAt;
    return age >= 0 && age < USAGE_HISTORY_MAX_AGE_MS;
  }

  /** The observation for dir when it is younger than USAGE_HISTORY_MAX_AGE_MS and its stamp still equals the current
   *  auth.json stamp (never for 'missing'); windows past their reset time are omitted, and none left → undefined.
   *  Missing data never means zero usage. */
  get(dir: string): CodexUsage | undefined {
    const e = this.entries().find((entry) => samePath(entry.dir, dir));
    if (!e || !this.recent(e) || e.stamp === 'missing' || e.stamp !== this.stamp(dir)) return undefined;
    const windows = e.usage.windows.filter((w) => w.resetsAt === undefined || w.resetsAt * 1000 > this.now())
      .map(({ usedPercent, windowMinutes, resetsAt }) => ({ usedPercent, windowMinutes, resetsAt }));
    if (!windows.length) return undefined;
    return { windows, checkedAt: e.usage.checkedAt, limitReached: e.usage.limitReached };
  }

  /** Capture only completed queries. Ignored when acceptedStamp no longer matches auth.json. Success replaces this
   *  directory's entry under acceptedStamp; notLoggedIn / authExpired clear it; any other failure (temporary) leaves
   *  the last observation intact. */
  async record(dir: string, result: UsageResult, acceptedStamp: string): Promise<void> {
    if (acceptedStamp !== this.stamp(dir)) return;
    if (!result.ok && result.reason !== 'notLoggedIn' && result.reason !== 'authExpired') return;
    const entries = this.entries().filter((e) => !samePath(e.dir, dir) && this.recent(e));
    const stamp = acceptedStamp;
    if (result.ok && stamp !== 'missing') {
      const { windows, checkedAt, limitReached } = result.usage;
      entries.push({ dir, stamp, usage: {
        windows: windows.map(({ usedPercent, windowMinutes, resetsAt }) => ({ usedPercent, windowMinutes, resetsAt })),
        checkedAt, limitReached,
      } });
    }
    if (JSON.stringify(entries) !== JSON.stringify(this.entries())) await this.state.update(KEY, entries);
  }
}
