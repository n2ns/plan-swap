// Localized one-line summary of a share / migration report (shared by Claude and Codex); no vscode import
import { t } from './i18n';

export interface ShareReportLike {
  conflicts: string[];
  refused: string[];
  moved?: number;
  duplicates?: number;
  keptBoth?: string[];
  backups?: string[];
  busy?: string[];
  noPrivilege?: string[];
}

/** Empty string when there is nothing worth telling (newly linked or created entries are not reported) */
export function describeShareReport(r: ShareReportLike): string {
  const list = (items: string[]): string => items.join(t('common.nameSep'));
  const parts: string[] = [];
  if (r.moved) parts.push(t('share.r.moved', { count: r.moved }));
  if (r.duplicates) parts.push(t('share.r.duplicates', { count: r.duplicates }));
  if (r.keptBoth?.length) parts.push(t('share.r.keptBoth', { list: list(r.keptBoth) }));
  if (r.backups?.length) parts.push(t('share.r.backups', { list: list(r.backups) }));
  if (r.conflicts.length) parts.push(t('share.r.conflicts', { list: list(r.conflicts) }));
  if (r.refused.length) parts.push(t('share.r.refused', { list: list(r.refused) }));
  if (r.noPrivilege?.length) parts.push(t('share.r.needsDevMode', { list: list(r.noPrivilege) }));
  if (r.busy?.length) parts.push(t('share.r.busy', { list: list(r.busy) }));
  return parts.join(t('common.listSep'));
}
