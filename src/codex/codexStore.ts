import * as fs from 'node:fs';
import type { Memento } from 'vscode';
import { samePath } from '../paths';
import { labelFor, sameName, type LabelStore } from '../labels';
import type { CodexAccount } from './codexPaths';
import { CODEX_DEFAULT_NAME, codexDefaultDir, scanCodexDirs } from './codexPaths';

const STATE_KEY = 'codex.accounts';
// Accounts deleted but whose directories were kept; skipped by the auto scan
const IGNORED_KEY = 'codex.ignoredDirs';

export class CodexAccountStore {
  constructor(private readonly state: Memento) {}

  private load(): CodexAccount[] {
    return this.state.get<CodexAccount[]>(STATE_KEY, []);
  }

  private save(list: CodexAccount[]): Thenable<void> {
    return this.state.update(STATE_KEY, list);
  }

  named(): CodexAccount[] {
    return this.load()
      .filter((a) => a.name !== CODEX_DEFAULT_NAME)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  all(): CodexAccount[] {
    return [{ name: CODEX_DEFAULT_NAME, dir: codexDefaultDir() }, ...this.named()];
  }

  find(name: string): CodexAccount | undefined {
    return this.all().find((a) => a.name === name);
  }

  findByDir(dir: string): CodexAccount | undefined {
    return this.all().find((a) => samePath(a.dir, dir));
  }

  private ignored(): string[] {
    return this.state.get<string[]>(IGNORED_KEY, []);
  }

  async add(account: CodexAccount): Promise<void> {
    await this.state.update(IGNORED_KEY, this.ignored().filter((d) => !samePath(d, account.dir)));
    await this.save([...this.load().filter((a) => a.name !== account.name), account]);
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

  // Prunes named entries whose directory no longer exists (alias cleared, not added to the ignore list), then
  // registers scanned directories; a scanned name equal (case-insensitively) to a remaining account's name or,
  // with labels, display name is skipped until that alias changes
  async syncWithDisk(labels?: LabelStore): Promise<void> {
    const stored = this.load();
    const list = stored.filter((a) => fs.existsSync(a.dir));
    for (const a of stored) if (!list.includes(a)) await labels?.remove(a.name);
    const ignored = this.ignored();
    const taken = [CODEX_DEFAULT_NAME, ...list.map((a) => a.name)];
    if (labels) taken.push(...list.map((a) => labelFor(a.name, labels)));
    const missing: CodexAccount[] = [];
    for (const s of scanCodexDirs()) {
      if (ignored.some((d) => samePath(d, s.dir)) || list.some((a) => samePath(a.dir, s.dir))) continue;
      if (taken.some((n) => sameName(n, s.name))) continue;
      // Also reserves the name against another scanned directory differing only in case
      taken.push(s.name);
      missing.push(s);
    }
    const pruned = stored.filter((a) => !list.includes(a));
    if (!missing.length && !pruned.length) return;
    // Another window may have added, removed or ignored accounts while the disk was scanned (and the aliases cleared):
    // apply only the deltas to the list as it is now, so its changes are kept
    const current = this.load().filter((a) => !pruned.some((p) => p.name === a.name && samePath(p.dir, a.dir)));
    const ignoredNow = this.ignored();
    const added = missing.filter((s) => !ignoredNow.some((d) => samePath(d, s.dir))
      && !current.some((a) => samePath(a.dir, s.dir) || sameName(a.name, s.name)));
    await this.save([...current, ...added]);
  }
}
