// Read-only link check of linked (shared) accounts, shared by the Re-link tool and the background check: turns the
// check-mode reports of ensureClaudeLinks / ensureCodexLinks (and the .claude.json keys mirrorClaudeJson would change)
// into problems that a repair fixes or cannot fix and notes about entries kept on purpose, formats them for one
// notification, and remembers what was announced.
// Design: docs/design.md 6.7 ("Link check"). Imports vscode only for the Memento type.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Memento } from 'vscode';
import type { ShareReport } from './claudeShare';
import { t } from './i18n';
import { knownFileLinks } from './platform';

/** One linked account's check: the check-mode report and the mirror's would-be changes, or the error the check threw. */
export interface AccountCheck {
  dir: string;
  label: string;
  vendor?: 'claude' | 'codex';
  def?: string;   // the vendor's default dir (the link targets), to tell plugin cache files and folders apart
  report?: ShareReport;
  mirror?: string[];
  error?: string;
}

// Kinds in display order: what a repair changes, what blocks it, and notes on entries the account keeps as they are
// (a link elsewhere or its own file may be on purpose, and PlanSwap cannot tell), which are not problems
const FIXABLE_KINDS = ['missing', 'defaultMissing', 'replaced', 'stale', 'mirror'] as const;
const UNFIXABLE_KINDS = ['busy', 'error'] as const;
const NOTE_KINDS = ['elsewhere', 'conflict'] as const;
export type ProblemKind = (typeof FIXABLE_KINDS)[number] | (typeof UNFIXABLE_KINDS)[number] | (typeof NOTE_KINDS)[number];

export interface Problem { kind: ProblemKind; entries: string[] }

/**
 * Problems of one account, in display order (empty kinds left out):
 * - missing: entries the repair links (linked except merged) or gives the stripped settings.json copy (stripped
 *   except unlinked);
 * - defaultMissing: default entries the repair creates empty (created);
 * - replaced: history files merged back before relinking (merged);
 * - stale: links the repair removes (unlinked);
 * - mirror: '.claude.json' when the mirror would change keys;
 * - busy: repairs skipped while the account is in use;
 * - error: the check's error message;
 * - elsewhere / conflict (notes, isNote): conflicts that are links resolving elsewhere / real entries (never changed).
 * Known states, left out: refusals, Windows entries without file-link privilege, failed junctions, and a top-level
 * file under plugins/ whose default is a file (Claude Code's plugin caches: it rewrites them by rename, which replaces
 * the link, so each account keeps its own and a new link would not last; needs c.def). Claude's dated plugin install
 * backups are also known states after retention cleanup, even when their default target no longer exists.
 */
export function accountProblems(c: AccountCheck): Problem[] {
  if (c.error !== undefined) return [{ kind: 'error', entries: [c.error] }];
  const r = c.report;
  const merged = new Set(r?.merged ?? []);
  const unlinked = new Set(r?.unlinked ?? []);
  const elsewhere = new Set(r?.elsewhere ?? []);
  // These are retention-managed recovery copies, not plugin content. Their names remain recognizable after cleanup.
  const retiredBackup = (entry: string): boolean => c.vendor === 'claude'
    && /^plugins\/installed_plugins\.(?:set-aside\.[^/]+\.json|unreadable\.[^/]+\.kept)$/.test(entry);
  const cache = (entry: string): boolean => {
    if (c.def === undefined || !/^plugins\/[^/]+$/.test(entry)) return false;
    try {
      return fs.statSync(path.join(c.def, entry)).isFile();
    } catch {
      return false;
    }
  };
  const kept = (entries: string[]): string[] => entries.filter((n) => !cache(n));
  const lists: Record<ProblemKind, string[]> = {
    missing: kept([...(r?.linked ?? []).filter((n) => !merged.has(n)), ...(r?.stripped ?? []).filter((n) => !unlinked.has(n))]),
    defaultMissing: r?.created ?? [],
    replaced: r?.merged ?? [],
    stale: (r?.unlinked ?? []).filter((n) => !retiredBackup(n)),
    mirror: c.mirror?.length ? ['.claude.json'] : [],
    busy: (r?.busy ?? []).filter((n) => !retiredBackup(n)),
    error: [],
    elsewhere: kept(r?.elsewhere ?? []),
    conflict: kept((r?.conflicts ?? []).filter((n) => !elsewhere.has(n))),
  };
  return [...FIXABLE_KINDS, ...UNFIXABLE_KINDS, ...NOTE_KINDS].filter((k) => lists[k].length).map((kind) => ({ kind, entries: lists[kind] }));
}

export function isFixable(kind: ProblemKind): boolean {
  return (FIXABLE_KINDS as readonly string[]).includes(kind);
}

/** A note on an entry kept as it is (a link elsewhere, the account's own entry), not a problem. */
export function isNote(kind: ProblemKind): boolean {
  return (NOTE_KINDS as readonly string[]).includes(kind);
}

/** One localized line per account with problems or notes ('<label>: <part>; <part>'); problems: whether any is not a
 *  note; fixable: whether a repair would change anything. */
export function describeLinkCheck(checks: readonly AccountCheck[]): { lines: string[]; problems: boolean; fixable: boolean } {
  const lines: string[] = [];
  let fixable = false;
  let any = false;
  for (const c of checks) {
    const problems = accountProblems(c);
    if (!problems.length) continue;
    fixable ||= problems.some((p) => isFixable(p.kind));
    any ||= problems.some((p) => !isNote(p.kind));
    const parts = problems.map((p) => (p.kind === 'error'
      ? t('linkCheck.error', { error: p.entries[0] })
      : t(c.vendor === 'claude' && p.kind === 'defaultMissing' ? 'linkCheck.claudeDefaultMissing' : `linkCheck.${p.kind}`, {
        list: (c.vendor === 'claude' && p.kind === 'mirror' ? (c.mirror ?? []).map((key) => `.claude.json (${key})`) : p.entries).join(t('common.nameSep')),
      })));
    lines.push(t('sync.item', { name: c.label, notes: parts.join(t('common.listSep')) }));
  }
  return { lines, problems: any, fixable };
}

/**
 * The problems that are announced without being asked for (the background check), as keys 'dir NUL kind NUL entry'
 * (no labels; only '.claude.json' for the mirror, so routine changes of the mirrored keys do not count): repairable
 * problems only, since a link elsewhere, the account's own entry, a busy account or a failed check cannot be helped by
 * Repair and would come back every day. Also left out with fileLinksUnknown (Windows before any file-link probe): a
 * missing link whose default target is not a folder, which may need Developer Mode. Empty → nothing to announce.
 */
export function announcementKeys(checks: readonly AccountCheck[], fileLinksUnknown = false): string[] {
  const keys: string[] = [];
  for (const c of checks) {
    const isDir = (entry: string): boolean => {
      try {
        return c.def !== undefined && fs.statSync(path.join(c.def, entry)).isDirectory();
      } catch {
        return false;
      }
    };
    const quiet = (kind: ProblemKind, entry: string): boolean => kind === 'missing' && fileLinksUnknown && !isDir(entry);
    for (const p of accountProblems(c)) {
      if (!isFixable(p.kind)) continue;
      for (const entry of p.entries) if (!quiet(p.kind, entry)) keys.push(`${c.dir}\0${p.kind}\0${entry}`);
    }
  }
  return keys.sort();
}

type Vendor = 'claude' | 'codex';
interface Announced { fp: string; at: number }

const KEY = 'links.announced';
const FILE_LINKS_KEY = 'links.fileLinks';
/** An unchanged set of problems is announced again after this long. */
export const REANNOUNCE_MS = 24 * 60 * 60_000;

/**
 * Announced link problems per vendor, kept in the state file under links.announced as { fp, at } (a hash of
 * announcementKeys and the time), so other editor windows and a reload do not repeat a notification. Also keeps the last
 * known Windows file-link probe result under links.fileLinks for the read-only check, which cannot probe.
 */
export class LinkCheckNotices {
  constructor(private readonly state: Memento, private readonly now: () => number = Date.now) {}

  private entries(): Partial<Record<Vendor, Announced>> {
    const raw = this.state.get<unknown>(KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<Record<Vendor, Announced>> : {};
  }

  /**
   * Background check: true when the problems are to be announced now, that is non-empty and either different from the
   * last announced ones or announced at least REANNOUNCE_MS ago; the announcement is then recorded. No problems forget
   * the record, so a recurrence is announced. false when the record cannot be saved, so a broken state file does not
   * repeat the notification on every check.
   */
  async take(vendor: Vendor, keys: readonly string[]): Promise<boolean> {
    const last = this.entries()[vendor];
    if (!keys.length && !last) return false;
    if (keys.length && last?.fp === fingerprint(keys) && this.now() - last.at < REANNOUNCE_MS) return false;
    return (await this.save(vendor, keys)) && keys.length > 0;
  }

  /** Re-link: records the problems it shows (or forgets them when there are none) without asking whether they are due. */
  async remember(vendor: Vendor, keys: readonly string[]): Promise<void> {
    await this.save(vendor, keys);
  }

  /** Whether Windows file links work as far as known: this process's last probe, else the stored one. */
  fileLinks(): boolean | undefined {
    const stored = this.state.get<unknown>(FILE_LINKS_KEY);
    return knownFileLinks() ?? (typeof stored === 'boolean' ? stored : undefined);
  }

  private async save(vendor: Vendor, keys: readonly string[]): Promise<boolean> {
    const entries = this.entries();
    if (keys.length) entries[vendor] = { fp: fingerprint(keys), at: this.now() };
    else delete entries[vendor];
    try {
      await this.state.update(KEY, Object.keys(entries).length ? entries : undefined);
      const probe = knownFileLinks();
      if (probe !== undefined && this.state.get<unknown>(FILE_LINKS_KEY) !== probe) await this.state.update(FILE_LINKS_KEY, probe);
      return true;
    } catch {
      return false;
    }
  }
}

function fingerprint(keys: readonly string[]): string {
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 32);
}
