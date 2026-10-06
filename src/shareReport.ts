// Localized one-line summary of a share / migration report (shared by Claude and Codex); no vscode import
import { t } from './i18n';

export interface ShareReportLike {
  conflicts: string[];
  refused: string[];
  refusedNotes?: Record<string, string>;
  moved?: number;
  duplicates?: number;
  keptBoth?: string[];
  backups?: string[];
  busy?: string[];
  noPrivilege?: string[];
  failed?: string[];
  copied?: string[];
}

/** One localized line: moved, duplicates, keptBoth, backups, conflicts, refused, copied, noPrivilege, failed, busy
 *  (share.r.*; a refused entry with a note gives its note instead), in that order, joined with common.listSep (names within a part with common.nameSep). Empty string when
 *  there is nothing worth telling (newly linked or created entries are not reported) */
export function describeShareReport(r: ShareReportLike): string {
  const list = (items: string[]): string => items.join(t('common.nameSep'));
  const parts: string[] = [];
  if (r.moved) parts.push(t('share.r.moved', { count: r.moved }));
  if (r.duplicates) parts.push(t('share.r.duplicates', { count: r.duplicates }));
  if (r.keptBoth?.length) parts.push(t('share.r.keptBoth', { list: list(r.keptBoth) }));
  if (r.backups?.length) parts.push(t('share.r.backups', { list: list(r.backups) }));
  if (r.conflicts.length) parts.push(t('share.r.conflicts', { list: list(r.conflicts) }));
  const plainRefused = r.refused.filter((name) => !r.refusedNotes?.[name]);
  if (plainRefused.length) parts.push(t('share.r.refused', { list: list(plainRefused) }));
  for (const name of r.refused) if (r.refusedNotes?.[name]) parts.push(r.refusedNotes[name]);
  if (r.copied?.length) parts.push(t('share.r.copiedNoLink', { list: list(r.copied) }));
  if (r.noPrivilege?.length) parts.push(t('share.r.needsDevMode', { list: list(r.noPrivilege) }));
  if (r.failed?.length) parts.push(t('share.r.junctionFailed', { list: list(r.failed) }));
  if (r.busy?.length) parts.push(t('share.r.busy', { list: list(r.busy) }));
  return parts.join(t('common.listSep'));
}
