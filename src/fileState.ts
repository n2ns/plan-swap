// File-backed Memento at ~/.config/planswap/state.json, so the account lists, ignore lists and aliases follow the
// WSL distribution (a workspace extension's globalState is stored on the Windows client and shared by every distro).
// Besides STATE_KEYS the file holds warnings.dismissed (extension.ts), codex.usageHistory (codexUsageHistory.ts),
// usage.lowNotified (usageNotices.ts) and links.announced / links.fileLinks (linkCheck.ts).
// No cross-process lock: update re-reads the file, but two hosts writing at the same moment can still lose one write.
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

  /** A missing or empty file is an empty state; any other read error (permissions, a locked file, a directory at the
   *  path, I/O) and content that is not a JSON object (a syntax error left by a hand edit) is thrown, so an update never
   *  rewrites the file from an empty state. PlanSwap's own writes are atomic and never leave a half-written file */
  private readOrThrow(): State {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    // A byte order mark (the file edited in Notepad or Windows PowerShell 5.1) would otherwise fail to parse
    const body = stripBom(text);
    if (body.trim() === '') return {};
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return parsed as State;
  }

  /** Why the existing file cannot be used (read error or not a JSON object), or undefined; activation reports it */
  readError(): Error | undefined {
    try {
      this.readOrThrow();
      return undefined;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Reads never throw: an unreadable or invalid file reads as empty */
  private read(): State {
    try {
      return this.readOrThrow();
    } catch {
      return {};
    }
  }

  keys(): readonly string[] {
    return Object.keys(this.read());
  }

  // Reads the file on every call (never a cached state); own properties only (Object.hasOwn)
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const state = this.read();
    return Object.hasOwn(state, key) ? (state[key] as T) : defaultValue;
  }

  /** undefined deletes the key; re-reads the file, then rewrites the whole object atomically (pretty JSON; temp file
   *  0600 + rename, directory 0700). Rejects without writing when the file exists but cannot be read or is not a JSON
   *  object */
  async update(key: string, value: unknown): Promise<void> {
    const entries = Object.entries(this.readOrThrow()).filter(([k]) => k !== key);
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
    // Exclusive create: never write through a file or symlink that already sits at the random temp name
    const fd = fs.openSync(tmp, 'wx', 0o600);
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
