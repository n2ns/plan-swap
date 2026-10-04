// Registered Claude accounts in the state file (FileMemento): key 'accounts' (named accounts only; the default is
// implicit) and 'ignoredDirs'. Imports vscode only for the Memento type.
import * as fs from 'node:fs';
import type { Memento } from 'vscode';
import type { Account } from './paths';
import { DEFAULT_NAME, defaultDir, samePath, scanAccountDirs } from './paths';
import { labelFor, sameName, type LabelStore } from './labels';
import type { RecommendExclusions } from './recommend';

const STATE_KEY = 'accounts';
// Accounts deleted but whose directories were kept; skipped by the auto scan
const IGNORED_KEY = 'ignoredDirs';

export class AccountStore {
  constructor(private readonly state: Memento) {}

  private load(): Account[] {
    return this.state.get<Account[]>(STATE_KEY, []);
  }

  private save(list: Account[]): Thenable<void> {
    return this.state.update(STATE_KEY, list);
  }

  // Non-default accounts, sorted by name
  named(): Account[] {
    return this.load()
      .filter((a) => a.name !== DEFAULT_NAME)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // The default account ({DEFAULT_NAME, defaultDir()}) first, then named()
  all(): Account[] {
    return [{ name: DEFAULT_NAME, dir: defaultDir() }, ...this.named()];
  }

  find(name: string): Account | undefined {
    return this.all().find((a) => a.name === name);
  }

  // samePath match in all()
  findByDir(dir: string): Account | undefined {
    return this.all().find((a) => samePath(a.dir, dir));
  }

  private ignored(): string[] {
    return this.state.get<string[]>(IGNORED_KEY, []);
  }

  // Replaces an entry with the same name (sameName, case-insensitive) and takes its directory off ignoredDirs
  async add(account: Account): Promise<void> {
    await this.state.update(IGNORED_KEY, this.ignored().filter((d) => !samePath(d, account.dir)));
    await this.save([...this.load().filter((a) => !sameName(a.name, account.name)), account]);
  }

  // Drops the entry and records its directory in ignoredDirs so the scan does not re-add it (the alias is the caller's)
  async remove(name: string): Promise<void> {
    const removed = this.load().find((a) => a.name === name);
    if (removed && !this.ignored().some((d) => samePath(d, removed.dir))) {
      await this.state.update(IGNORED_KEY, [...this.ignored(), removed.dir]);
    }
    await this.save(this.load().filter((a) => a.name !== name));
  }

  // Called after the directory was deleted, so a recreated directory is auto-discovered again
  async unignore(dir: string): Promise<void> {
    await this.state.update(IGNORED_KEY, this.ignored().filter((d) => !samePath(d, dir)));
  }

  /**
   * Prunes named entries whose directory no longer exists (their alias and recommendation mark are cleared through
   * labels / exclusions; they are not added to ignoredDirs), then registers scanned directories that are not ignored, not already registered by
   * directory, and whose name does not match (case-insensitively) a remaining account's name or display name.
   * Saves only when something changed
   */
  async syncWithDisk(labels?: LabelStore, exclusions?: RecommendExclusions): Promise<void> {
    const stored = this.load();
    const pruned = stored.filter((a) => a.name !== DEFAULT_NAME && !fs.existsSync(a.dir));
    for (const a of pruned) {
      await labels?.remove(a.name);
      await exclusions?.remove(a.name);
    }
    const list = stored.filter((a) => !pruned.includes(a));
    const ignored = this.ignored();
    const taken = [DEFAULT_NAME, ...list.map((a) => a.name), ...(labels ? list.map((a) => labelFor(a.name, labels)) : [])];
    const missing: Account[] = [];
    for (const s of scanAccountDirs()) {
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
