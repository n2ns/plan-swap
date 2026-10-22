// File-backed Memento at ~/.config/planswap/state.json, so the account lists, ignore lists and aliases follow the
// WSL distribution (a workspace extension's globalState is stored on the Windows client and shared by every distro).
// Besides STATE_KEYS the file holds warnings.dismissed (extension.ts), codex.usageHistory (codexUsageHistory.ts),
// usage.lowNotified (usageNotices.ts) and links.announced / links.fileLinks (linkCheck.ts).
// Every update is a read-modify-write under a cross-process lock (the directory <file>.lock, see withLock), so two
// extension hosts of the same distribution (VS Code and VSCodium side by side) cannot lose each other's writes; a new
// value that depends on the key's current one is computed under that lock (updateWith).
// Depends only on vscode's Memento type
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Memento } from 'vscode';
import { t } from './i18n';
import { isWindows, pidAlive, renameReplacing, stripBom } from './platform';

export const STATE_JSON = () => path.join(os.homedir(), '.config', 'planswap', 'state.json');

// Keys copied once from globalState by importOnce (the panel tab stays in globalState)
const STATE_KEYS = ['accounts', 'ignoredDirs', 'claude.labels', 'codex.accounts', 'codex.ignoredDirs', 'codex.labels'] as const;

type State = Record<string, unknown>;

/** How long an update waits for another process to release the lock before it fails. */
export const LOCK_WAIT_MS = 5000;
/** A lock without a readable owner that is older than this was left behind (a crash between mkdir and the owner note). */
export const LOCK_STALE_MS = 10_000;

/** The Memento the state stores write through (FileMemento; an in-memory stand-in in tests) */
export interface StateMemento extends Memento {
  /** Sets key to fn(its current value), read and written under one lock; see FileMemento.updateWith */
  updateWith<T>(key: string, fn: (current: T | undefined) => T | undefined): Thenable<void>;
}

export class FileMemento implements StateMemento {
  /** lockWaitMs: how long update waits for the lock (tests shorten it). */
  constructor(private readonly file: string = STATE_JSON(), private readonly lockWaitMs: number = LOCK_WAIT_MS) {}

  /** The lock directory next to the file. mkdir is atomic on every file system, so whoever creates it owns the
   *  read-modify-write; it holds an `owner` file with the pid. */
  get lockDir(): string {
    return `${this.file}.lock`;
  }

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
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('state.notObject'));
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

  /** undefined deletes the key; under the lock, re-reads the file, then rewrites the whole object atomically (pretty
   *  JSON; temp file 0600 + rename, directory 0700). Rejects without writing when the file exists but cannot be read
   *  or is not a JSON object, or when the lock is not released within lockWaitMs */
  async update(key: string, value: unknown): Promise<void> {
    await this.withLock(() => this.writeKey(this.readOrThrow(), key, value));
  }

  /** A read-modify-write of one key: under the lock, fn gets the key's value in the freshly read file and returns the
   *  new one (undefined deletes the key), so a write of the same key by another window while this one waited for
   *  the lock is not lost. fn runs synchronously under the lock (get of other keys reads the file as it stands);
   *  returning the current value itself writes nothing. Rejects like update */
  async updateWith<T>(key: string, fn: (current: T | undefined) => T | undefined): Promise<void> {
    await this.withLock(() => {
      const state = this.readOrThrow();
      const current = Object.hasOwn(state, key) ? (state[key] as T) : undefined;
      const value = fn(current);
      if (value !== current) this.writeKey(state, key, value);
    });
  }

  private writeKey(state: State, key: string, value: unknown): void {
    const entries = Object.entries(state).filter(([k]) => k !== key);
    if (value !== undefined) entries.push([key, value]);
    this.write(Object.fromEntries(entries));
  }

  /**
   * Runs fn while holding <file>.lock. Acquire: mkdir, retried with a short backoff until lockWaitMs passed; a lock
   * whose owner process is gone, or that has no owner note and is older than LOCK_STALE_MS, is taken over (renamed
   * away first, so only one waiter takes it) and mkdir retried after a zero-delay yield, within the same deadline.
   * Release: the directory is removed, also when fn throws.
   */
  private async withLock<T>(fn: () => T): Promise<T> {
    const lockDir = this.lockDir;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockWaitMs;
    let delay = 5;
    for (;;) {
      // Windows refuses mkdir with EPERM while the lock directory another process just removed is still pending
      // deletion: retried like a held lock, and rethrown only if it lasts until the deadline
      let pending: NodeJS.ErrnoException | undefined;
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (isWindows() && code === 'EPERM') pending = e as NodeJS.ErrnoException;
        else if (code !== 'EEXIST') throw e;
      }
      const tookOver = !pending && this.takeOverStaleLock(lockDir);
      if (Date.now() >= deadline) throw pending ?? new Error(t('state.lockBusy', { dir: lockDir }));
      // After a takeover mkdir is retried at once, still yielding, so a takeover that keeps failing cannot spin
      await new Promise((resolve) => setTimeout(resolve, tookOver ? 0 : delay));
      if (!tookOver) delay = Math.min(delay * 2, 100);
    }
    try {
      // Written whole: a waiter must never read a half-written (empty) note and mistake it for a dead owner
      const note = path.join(lockDir, 'owner.tmp');
      fs.writeFileSync(note, String(process.pid));
      fs.renameSync(note, path.join(lockDir, 'owner'));
    } catch {
      // The lock holds without the note; a waiter then relies on its age
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  /** Removes a lock left behind by a process that is gone (owner pid not alive, or this process's own pid) or, without a readable owner note,
   *  one older than LOCK_STALE_MS. Returns true when the caller should try mkdir again at once. The directory is
   *  renamed before it is removed: only one of several waiters succeeds, the others see it gone and retry. */
  private takeOverStaleLock(lockDir: string): boolean {
    let owner: number | undefined;
    try {
      const text = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8').trim();
      if (/^[1-9][0-9]*$/.test(text)) owner = Number(text);
    } catch {
      // No note (yet): decided by age below
    }
    let stale: boolean;
    if (owner !== undefined) {
      // This process never waits for a lock it holds (holding is synchronous): its own pid is a leftover
      stale = owner === process.pid || !pidAlive(owner);
    } else {
      try {
        stale = Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
      } catch {
        return true; // released meanwhile
      }
    }
    if (!stale) return false;
    const away = `${lockDir}.stale.${process.pid}.${Date.now()}`;
    try {
      fs.renameSync(lockDir, away);
    } catch {
      return true; // another waiter took it, or it was released
    }
    fs.rmSync(away, { recursive: true, force: true });
    return true;
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
    await this.withLock(() => {
      if (this.exists()) return;
      const state: State = {};
      for (const key of STATE_KEYS) {
        const value = source.get<unknown>(key);
        if (value !== undefined) state[key] = value;
      }
      this.write(state);
    });
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
