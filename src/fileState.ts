// File-backed Memento at ~/.config/planswap/state.json, so the account lists, ignore lists and aliases follow the
// WSL distribution (a workspace extension's globalState is stored on the Windows client and shared by every distro).
// Depends only on vscode's Memento type
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Memento } from 'vscode';
import { renameReplacing, stripBom } from './platform';

export const STATE_JSON = () => path.join(os.homedir(), '.config', 'planswap', 'state.json');

// Keys copied once from globalState by importOnce (the panel tab stays in globalState)
export const STATE_KEYS = ['accounts', 'ignoredDirs', 'claude.labels', 'codex.accounts', 'codex.ignoredDirs', 'codex.labels'] as const;

type State = Record<string, unknown>;

export class FileMemento implements Memento {
  constructor(private readonly file: string = STATE_JSON()) {}

  /** Tolerates a missing, half-written or non-object file (treated as empty) */
  private read(): State {
    try {
      // A byte order mark (the file edited in Notepad or Windows PowerShell 5.1) would otherwise read as empty, and the
      // next update would drop every account
      const parsed: unknown = JSON.parse(stripBom(fs.readFileSync(this.file, 'utf8')));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as State) : {};
    } catch {
      return {};
    }
  }

  keys(): readonly string[] {
    return Object.keys(this.read());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const state = this.read();
    return Object.hasOwn(state, key) ? (state[key] as T) : defaultValue;
  }

  /** undefined deletes the key; the file (0600, directory 0700) is rewritten atomically */
  async update(key: string, value: unknown): Promise<void> {
    const entries = Object.entries(this.read()).filter(([k]) => k !== key);
    if (value !== undefined) entries.push([key, value]);
    this.write(Object.fromEntries(entries));
  }

  /** True when the state file exists (used to decide whether a one-time import from globalState is needed) */
  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /**
   * One-time import: when the state file does not exist, copies STATE_KEYS that are set in `source` and creates the
   * file (even when nothing was set, so the import never runs again). Entries pointing at directories of another
   * distribution are pruned afterwards by the stores' syncWithDisk
   */
  async importOnce(source: Memento): Promise<void> {
    if (this.exists()) return;
    const state: State = {};
    for (const key of STATE_KEYS) {
      const value = source.get<unknown>(key);
      if (value !== undefined) state[key] = value;
    }
    this.write(state);
  }

  private write(state: State): void {
    const dirName = path.dirname(this.file);
    fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
    const tmp = path.join(dirName, `.state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      renameReplacing(tmp, this.file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }
}
