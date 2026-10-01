// Warns when two registered accounts of one vendor are signed in to the same user in the same workspace/organization:
// switching between them gives nothing. Each distinct situation is warned once per window session.
import * as vscode from 'vscode';
import { readAccountInfo } from './paths';
import { isExplicitConfigDir } from './claudeSettings';
import { readCodexAccountInfo } from './codex/codexPaths';
import { identityGroupsKey, sameIdentityGroups } from './identity';
import { t } from './i18n';

export type Vendor = 'Claude' | 'Codex';

/** One vendor's accounts for the duplicate sign-in check. */
export interface IdentitySource {
  vendor: Vendor;
  // Registered accounts (default and named); dir for comparison, label (labelFor) for the message
  accounts(): Array<{ dir: string; label: string }>;
  identityOf(dir: string): string | undefined;
}

export const claudeIdentity = (dir: string): string | undefined => readAccountInfo(dir, isExplicitConfigDir(dir)).identity;
export const codexIdentity = (dir: string): string | undefined => readCodexAccountInfo(dir).identity;

/** In-memory duplicate sign-in warnings; identity values never leave the process. */
export class IdentityWarnings {
  // Groups already warned about, per vendor (keys built from dirs only); a resolved group is forgotten, so a recurrence is warned again
  private readonly warned = new Map<Vendor, Set<string>>();

  // warn defaults to a non-modal warning message
  constructor(
    private readonly sources: IdentitySource[],
    private readonly warn: (message: string) => void = (message) => void vscode.window.showWarningMessage(message),
  ) {}

  /**
   * Per source, groups the accounts by identity (sameIdentityGroups) and warns identity.duplicate (labels joined with
   * common.nameSep) for each group whose key (identityGroupsKey, dirs only) was not present at the previous check;
   * the remembered set is then replaced by the current groups. A source that throws is skipped. The host calls it at
   * activation and on every account-info change.
   */
  check(): void {
    for (const source of this.sources) {
      let groups: Array<Array<{ dir: string; label: string; identity?: string }>>;
      try {
        groups = sameIdentityGroups(source.accounts().map((a) => ({ ...a, identity: source.identityOf(a.dir) })));
      } catch {
        // Account info is best effort; a failed read never blocks anything
        continue;
      }
      const before = this.warned.get(source.vendor) ?? new Set<string>();
      const now = new Set<string>();
      for (const group of groups) {
        const key = identityGroupsKey([group]);
        now.add(key);
        if (!before.has(key)) {
          this.warn(t('identity.duplicate', { vendor: source.vendor, labels: group.map((a) => a.label).join(t('common.nameSep')) }));
        }
      }
      this.warned.set(source.vendor, now);
    }
  }
}
