// Registered accounts of one vendor in the state file (FileMemento): a list of named accounts (the default is implicit)
// and the directories of removed accounts the auto scan must skip. Each vendor instantiates it with its own keys,
// default and scan (src/accounts.ts, src/codex/codexStore.ts), so the two vendors' data stay independent. Imports
// vscode only for the Memento type.
import * as fs from 'node:fs';
import type { Memento } from 'vscode';
import { samePath } from './paths';
import { labelFor, sameName, type LabelStore } from './labels';
import type { RecommendExclusions } from './recommend';

export interface StoredAccount { name: string; dir: string }

export interface AccountStoreConfig<T extends StoredAccount> {
  /** Memento key of the named accounts */
  stateKey: string;
  /** Memento key of the directories of removed accounts, skipped by the auto scan */
  ignoredKey: string;
  defaultName: string;
  defaultDir(): string;
  /** Unregistered account directories on disk */
  scan(): T[];
}

/**
 * The default account { defaultName, defaultDir() } is implicit and always first in all(); named() is sorted by name.
 * Directories are compared with samePath, names with sameName (case-insensitive) where a clash matters.
 */
export class AccountStoreBase<T extends StoredAccount> {
  constructor(private readonly state: Memento, private readonly config: AccountStoreConfig<T>) {}

  private load(): T[] {
    return this.state.get<T[]>(this.config.stateKey, []);
  }

  private save(list: T[]): Thenable<void> {
    return this.state.update(this.config.stateKey, list);
  }

  // Non-default accounts, sorted by name
  named(): T[] {
    return this.load()
      .filter((a) => a.name !== this.config.defaultName)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // The default account first, then named()
  all(): T[] {
    return [{ name: this.config.defaultName, dir: this.config.defaultDir() } as T, ...this.named()];
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
    await this.state.update(this.config.ignoredKey, this.ignored().filter((d) => !samePath(d, account.dir)));
    await this.save([...this.load().filter((a) => !sameName(a.name, account.name)), account]);
  }

  // Drops the entry and records its directory in the ignore list so the scan does not re-add it (the alias is the caller's)
  async remove(name: string): Promise<void> {
    const removed = this.load().find((a) => a.name === name);
    if (removed && !this.ignored().some((d) => samePath(d, removed.dir))) {
      await this.state.update(this.config.ignoredKey, [...this.ignored(), removed.dir]);
    }
    await this.save(this.load().filter((a) => a.name !== name));
  }

  // Called after the directory was deleted, so a recreated directory is auto-discovered again
  async unignore(dir: string): Promise<void> {
    await this.state.update(this.config.ignoredKey, this.ignored().filter((d) => !samePath(d, dir)));
  }

  /**
   * Prunes named entries whose directory no longer exists (their alias and recommendation mark are cleared through
   * labels / exclusions; they are not added to the ignore list), then registers scanned directories that are not
   * ignored, not already registered by directory, and whose name does not match (sameName, case-insensitive) the
   * default name, a remaining account's name or, with labels (callers pass the vendor's LabelStore), its display
   * name; such a directory is skipped until that alias changes. Saves only when something changed
   */
  async syncWithDisk(labels?: LabelStore, exclusions?: RecommendExclusions): Promise<void> {
    const stored = this.load();
    const pruned = stored.filter((a) => a.name !== this.config.defaultName && !fs.existsSync(a.dir));
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
    // Another window may have added, removed or ignored accounts while the disk was scanned (and the aliases cleared):
    // apply only the deltas to the list as it is now, so its changes are kept
    const current = this.load().filter((a) => !pruned.some((p) => p.name === a.name && samePath(p.dir, a.dir)));
    const ignoredNow = this.ignored();
    const added = missing.filter((s) => !ignoredNow.some((d) => samePath(d, s.dir))
      && !current.some((a) => samePath(a.dir, s.dir) || sameName(a.name, s.name)));
    await this.save([...current, ...added]);
  }
}
