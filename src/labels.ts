// Account display name (alias) storage and validation, keyed by account name; depends only on vscode's Memento type
import type { Memento } from 'vscode';
import { t, translationsOf } from './i18n';

// Internal sentinel name of the "external directory" row; never displayed (see labelFor). '<' cannot pass NAME_RE.
export const EXTERNAL_NAME = '<external>';
// Name of the default account on both sides (paths.DEFAULT_NAME / codexPaths.CODEX_DEFAULT_NAME); it cannot be renamed
const DEFAULT_NAME = 'default';
const MAX_LABEL_LENGTH = 32;
// Length in grapheme clusters (an emoji sequence or a letter with combining marks counts once); UTF-16 code units
// when the host Node lacks Intl.Segmenter
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
function lengthOf(s: string): number {
  return segmenter ? [...segmenter.segment(s)].length : s.length;
}

// Stored under state[key]: account name → alias; no entry means no alias
type Labels = Record<string, string>;

export class LabelStore {
  constructor(
    private readonly state: Memento,
    private readonly key: 'claude.labels' | 'codex.labels',
  ) {}

  /** Returns undefined when not set */
  get(name: string): string | undefined {
    // Own properties only, so names like `constructor` / `toString` never resolve to Object.prototype members
    const labels = this.read();
    const value = Object.hasOwn(labels, name) ? labels[name] : undefined;
    return typeof value === 'string' && value ? value : undefined;
  }

  /** undefined, empty or equal to name → remove the entry (entering the account's own name clears the alias) */
  async set(name: string, label: string | undefined): Promise<void> {
    // Rebuilt with Object.fromEntries (define semantics) so a `__proto__` name is stored as a normal own key
    const entries = Object.entries(this.read()).filter(([k]) => k !== name);
    if (label && label !== name) entries.push([name, label]);
    await this.state.update(this.key, Object.fromEntries(entries));
  }

  /** Called when an account is deleted */
  async remove(name: string): Promise<void> {
    await this.set(name, undefined);
  }

  /**
   * Returns an error message, or undefined when valid.
   * Trimmed non-empty; ≤32 grapheme clusters; no line breaks; not the external sentinel or any of its localized names;
   * not equal (case-insensitively) to the name or label of another account of the same vendor (excluding itself).
   * Checked in that order on the trimmed value: label.empty, label.tooLong, label.newline, name.reserved, label.dupName,
   * name.dupLabel. `existing` holds the accounts of the same vendor only (the same alias is allowed across vendors);
   * `name` excludes the account itself by exact name.
   */
  validate(label: string, name: string, existing: Array<{ name: string; label: string }>): string | undefined {
    const value = label.trim();
    if (!value) return t('label.empty');
    if (lengthOf(value) > MAX_LABEL_LENGTH) return t('label.tooLong', { max: MAX_LABEL_LENGTH });
    if (/[\r\n]/.test(value)) return t('label.newline');
    if (value === EXTERNAL_NAME || translationsOf('account.external').includes(value)) return t('name.reserved', { name: value });
    const others = existing.filter((a) => a.name !== name);
    if (others.some((a) => sameName(a.name, value))) return t('label.dupName');
    if (others.some((a) => sameName(a.label, value))) return t('name.dupLabel');
    return undefined;
  }

  private read(): Labels {
    return this.state.get<Labels>(this.key) ?? {};
  }
}

/**
 * Account names and aliases are compared case-insensitively when checking for duplicates (`Work` and `work` clash).
 * The rule applies to new names and aliases only: accounts registered before it that differ only in case are left
 * as they are, neither renamed nor pruned.
 */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Display name: the alias if set, otherwise the name; the external row gets its localized name; default is always shown as is (a stored alias is ignored) */
export function labelFor(name: string, labels: LabelStore): string {
  if (name === EXTERNAL_NAME) return t('account.external');
  if (name === DEFAULT_NAME) return name;
  return labels.get(name) ?? name;
}
