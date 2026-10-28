// Registered accounts of one vendor in the state file (FileMemento): a list of named accounts (the default is implicit),
// the directories of removed accounts the auto scan must skip and the order the user dragged the accounts into. Each
// vendor instantiates it with its own keys, default and scan (src/accounts.ts, src/codex/codexStore.ts), so the two
// vendors' data stay independent. Every write computes its value under the state file lock (updateWith), so a change
// another window made to the same key meanwhile is kept. Imports no vscode.
import * as fs from 'node:fs';
import type { StateMemento } from './fileState';
import { samePath } from './paths';
import { labelFor, sameName, type LabelStore } from './labels';
import type { RecommendExclusions } from './recommend';

export interface StoredAccount { name: string; dir: string }

export interface AccountStoreConfig<T extends StoredAccount> {
  /** Memento key of the named accounts */
  stateKey: string;
  /** Memento key of the directories of removed accounts, skipped by the auto scan */
  ignoredKey: string;
  /** Memento key of the order the user dragged the accounts into: the names (the default's included), first to last */
  orderKey: string;
  defaultName: string;
  defaultDir(): string;
  /** Unregistered account directories on disk */
  scan(): T[];
}

/**
 * The default account { defaultName, defaultDir() } is implicit and part of all(); named() is all() without it. Both
 * follow the stored order (orderKey, setOrder): accounts it names come first in that order, then the default, then the
 * rest by name, so without a stored order the default is first and the named accounts are sorted by name.
 * Directories are compared with samePath, names with sameName (case-insensitive) where a clash matters.
 */
export class AccountStoreBase<T extends StoredAccount> {
  constructor(private readonly state: StateMemento, private readonly config: AccountStoreConfig<T>) {}

  private load(): T[] {
    return this.state.get<T[]>(this.config.stateKey, []);
  }

  private order(): string[] {
    const value = this.state.get<unknown>(this.config.orderKey);
    return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [];
  }

  // Stored order first, then the default, then the rest by name
  private sorted(list: T[]): T[] {
    const order = this.order();
    const rank = (a: T): number => {
      const i = order.indexOf(a.name);
      return i >= 0 ? i : a.name === this.config.defaultName ? order.length : order.length + 1;
    };
    return [...list].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // Non-default accounts, in the stored order
  named(): T[] {
    return this.sorted(this.load().filter((a) => a.name !== this.config.defaultName));
  }

  // The default account and named(), in the stored order
  all(): T[] {
    return this.sorted([{ name: this.config.defaultName, dir: this.config.defaultDir() } as T, ...this.load().filter((a) => a.name !== this.config.defaultName)]);
  }

  /** Stores the order: the registered names among `names` (the default's included), first to last, without
   *  duplicates; names of unregistered accounts are dropped. An empty result deletes the entry */
  async setOrder(names: string[]): Promise<void> {
    await this.state.updateWith(this.config.orderKey, () => {
      const registered = new Set(this.all().map((a) => a.name));
      const order = [...new Set(names)].filter((n) => registered.has(n));
      return order.length ? order : undefined;
    });
  }

  // Drops names from the stored order; writes only when one of them was in it
  private async forgetOrder(names: string[]): Promise<void> {
    await this.state.updateWith<unknown>(this.config.orderKey, (current) => {
      const order = this.order();
      const kept = order.filter((n) => !names.includes(n));
      if (kept.length === order.length) return current;
      return kept.length ? kept : undefined;
    });
  }

  find(name: string): T | undefined {
    return this.all().find((a) => a.name === name);
  }

  // samePath match in all()
  findByDir(dir: string): T | undefined {
    return this.all().find((a) => samePath(a.dir, dir));
  }

  private ignored(): string[] {
    return this.state.get<string[]>(this.config.ignoredKey, []);
  }

  // Replaces an entry with the same name (sameName, case-insensitive) and takes its directory off the ignore list
  async add(account: T): Promise<void> {
    await this.state.updateWith(this.config.ignoredKey, () => this.ignored().filter((d) => !samePath(d, account.dir)));
    await this.state.updateWith(this.config.stateKey, () => [...this.load().filter((a) => !sameName(a.name, account.name)), account]);
  }

  // Drops the entry, its place in the stored order, and records its directory in the ignore list so the scan does not
  // re-add it (the alias is the caller's)
  async remove(name: string): Promise<void> {
    await this.state.updateWith<unknown>(this.config.ignoredKey, (current) => {
      const removed = this.load().find((a) => a.name === name);
      return removed && !this.ignored().some((d) => samePath(d, removed.dir)) ? [...this.ignored(), removed.dir] : current;
    });
    await this.state.updateWith(this.config.stateKey, () => this.load().filter((a) => a.name !== name));
    await this.forgetOrder([name]);
  }

  // Called after the directory was deleted, so a recreated directory is auto-discovered again
  async unignore(dir: string): Promise<void> {
    await this.state.updateWith(this.config.ignoredKey, () => this.ignored().filter((d) => !samePath(d, dir)));
  }

  /**
   * Prunes named entries whose directory no longer exists (directoryGone; their alias and recommendation mark are cleared through
   * labels / exclusions, their place in the stored order here; they are not added to the ignore list), then registers scanned directories that are not
   * ignored, not already registered by directory, and whose name does not match (sameName, case-insensitive) the
   * default name, a remaining account's name or, with labels (callers pass the vendor's LabelStore), its display
   * name; such a directory is skipped until that alias changes. Saves only when something changed
   */
  async syncWithDisk(labels?: LabelStore, exclusions?: RecommendExclusions): Promise<void> {
    const stored = this.load();
    const pruned = stored.filter((a) => a.name !== this.config.defaultName && directoryGone(a.dir));
    for (const a of pruned) {
      await labels?.remove(a.name);
      await exclusions?.remove(a.name);
    }
    const list = stored.filter((a) => !pruned.includes(a));
    const ignored = this.ignored();
    const taken = [this.config.defaultName, ...list.map((a) => a.name), ...(labels ? list.map((a) => labelFor(a.name, labels)) : [])];
    const missing: T[] = [];
    for (const s of this.config.scan()) {
      if (ignored.some((d) => samePath(d, s.dir)) || list.some((a) => samePath(a.dir, s.dir))) continue;
      if (taken.some((n) => sameName(n, s.name))) continue;
      // Also reserves the name against another scanned directory differing only in case
      taken.push(s.name);
      missing.push(s);
    }
    if (!pruned.length && !missing.length) return;
    // Another window may have added, removed or ignored accounts while the disk was scanned (and the aliases cleared)
    // or while this one waits for the lock: apply only the deltas to the list as it is under the lock, so its changes
    // are kept
    await this.state.updateWith(this.config.stateKey, () => {
      const current = this.load().filter((a) => !pruned.some((p) => p.name === a.name && samePath(p.dir, a.dir)));
      const ignoredNow = this.ignored();
      const added = missing.filter((s) => !ignoredNow.some((d) => samePath(d, s.dir))
        && !current.some((a) => samePath(a.dir, s.dir) || sameName(a.name, s.name)));
      return [...current, ...added];
    });
    await this.forgetOrder(pruned.map((a) => a.name));
  }
}

/** Whether an account directory is confirmed gone (ENOENT / ENOTDIR, links followed). Any other failure (no permission,
 *  an I/O error, a cycle) keeps the entry and its alias: the directory may be back after the cause is fixed. */
export function directoryGone(dir: string): boolean {
  try {
    fs.statSync(dir);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}
