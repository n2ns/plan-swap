// Validation of a new account name, shared by the Claude and Codex command modules; no vscode import
import { NAME_RE, caseVariantOf, realPathInside, sameRealPath } from './paths';
import { lstatOrUndefined } from './shareLinks';
import { labelFor, sameName, type LabelStore } from './labels';
import { t } from './i18n';

/** What differs between the two vendors: the reserved default name, the directory a name maps to, the default
 *  directory, the registered accounts and the vendor's display names. */
export interface AccountNameRules {
  defaultName: string;
  accountDir(name: string): string;
  defaultDir(): string;
  accounts(): ReadonlyArray<{ name: string }>;
  labels: LabelStore;
}

/**
 * The localized reason a new account name is refused, or undefined when it may be used. Refuses: an empty name, one
 * not matching NAME_RE, the reserved default name, the name or display name of any registered account (sameName,
 * case-insensitive), a directory equal to or containing the default directory by real path, a kept folder differing
 * only in case (Windows: the same folder, so its old sign-in would be reused) and a directory that is a link (the
 * scans skip links, so one must not be registered by adding its name either: sharing would write links into the
 * folder it points at).
 */
export function validateAccountName(name: string, rules: AccountNameRules): string | undefined {
  if (!name) return t('name.empty');
  if (!NAME_RE.test(name)) return t('name.invalid');
  if (sameName(name, rules.defaultName)) return t('name.reserved', { name: rules.defaultName });
  const accounts = rules.accounts();
  if (accounts.some((a) => sameName(a.name, name))) return t('name.exists');
  if (accounts.some((a) => sameName(labelFor(a.name, rules.labels), name))) return t('name.dupLabel');
  const dir = rules.accountDir(name);
  const def = rules.defaultDir();
  if (sameRealPath(dir, def)) return t('name.sameAsDefaultDir');
  if (realPathInside(dir, def)) return t('account.containsDefaultDir', { dir, default: def });
  const variant = caseVariantOf(dir);
  if (variant) return t('name.dirCaseDiffers', { dir: variant });
  if (lstatOrUndefined(dir)?.isSymbolicLink()) return t('name.dirIsSymlink');
  return undefined;
}
