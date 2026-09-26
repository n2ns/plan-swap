import * as fs from 'node:fs';
import type { Memento } from 'vscode';
import type { Account } from './paths';
import { DEFAULT_NAME, defaultDir, samePath, scanAccountDirs } from './paths';
import { labelFor, sameName, type LabelStore } from './labels';

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

  named(): Account[] {
    return this.load()
      .filter((a) => a.name !== DEFAULT_NAME)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  all(): Account[] {
    return [{ name: DEFAULT_NAME, dir: defaultDir() }, ...this.named()];
  }

  find(name: string): Account | undefined {
    return this.all().find((a) => a.name === name);
  }

  findByDir(dir: string): Account | undefined {
    return this.all().find((a) => samePath(a.dir, dir));
  }

  private ignored(): string[] {
    return this.state.get<string[]>(IGNORED_KEY, []);
  }

  async add(account: Account): Promise<void> {
    await this.state.update(IGNORED_KEY, this.ignored().filter((d) => !samePath(d, account.dir)));
    await this.save([...this.load().filter((a) => !sameName(a.name, account.name)), account]);
  }

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
   * Prunes named entries whose directory no longer exists (their alias is cleared through labels; they are not
   * added to ignoredDirs), then registers scanned directories that are not ignored, not already registered by
   * directory, and whose name does not match (case-insensitively) a remaining account's name or display name.
   * Saves only when something changed
   */
  async syncWithDisk(labels?: LabelStore): Promise<void> {
    const stored = this.load();
    const pruned = stored.filter((a) => a.name !== DEFAULT_NAME && !fs.existsSync(a.dir));
    for (const a of pruned) await labels?.remove(a.name);
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
    if (pruned.length || missing.length) await this.save([...list, ...missing]);
  }
}
