// Shared test helpers: create a temporary HOME, assert the real HOME is not used, clean up
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mock } from 'node:test';
import type { Memento } from 'vscode';

// Record the real home directory at module load (before any `before` hook) for later assertions
const REAL_HOME = os.homedir();

export const onWindows = process.platform === 'win32';

// On a Windows test machine the Windows code paths would read and write the real user-level CODEX_HOME through reg and
// powershell.exe (codexWindows' default runner). Refuse both for the whole test process; tests inject their own runners.
if (onWindows) {
  const realExecFileSync = childProcess.execFileSync;
  mock.method(childProcess, 'execFileSync', ((file: string, ...rest: unknown[]) => {
    if (/^(reg|powershell)(\.exe)?$/i.test(path.basename(file))) throw new Error(`tests must not run ${file} against the real user environment`);
    return (realExecFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof childProcess.execFileSync);
}

// Whether this process may create a file symbolic link: always off Windows; on Windows only with Developer Mode or elevation
function fileSymlinksAllowed(): boolean {
  if (!onWindows) return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planswap-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Test/describe options. Directory link fixtures pass the 'junction' type to fs.symlinkSync (ignored off Windows, no
 * privilege needed on Windows), so only the categories below are skipped, and only on Windows.
 */
/** Linux/WSL behavior: rc files and bash, /proc, the WSL server, fifos, chmod-based permissions and the Linux link semantics of sharing. */
export const LINUX_ONLY = { skip: onWindows && 'Linux/WSL behavior' };
/** Creates file symbolic links, which Windows refuses without Developer Mode or elevation. */
export const FILE_SYMLINKS = { skip: !fileSymlinksAllowed() && 'file symbolic links need Windows Developer Mode' };
/** Creates entries whose names differ only in case, which a Windows file system folds together. */
export const CASE_SENSITIVE_FS = { skip: onWindows && 'the Windows file system is case-insensitive' };

/** Asserts POSIX permission bits; Windows has none to check (mode() reads 666 / 444 there). */
export function assertMode(f: string, expected: string, message?: string): void {
  if (!onWindows) assert.equal(mode(f), expected, message);
}
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'SHELL'] as const;

export interface TempHome { home: string; restore(): void }

/**
 * Creates a mktemp directory and points process.env.HOME and USERPROFILE (read by os.homedir() on Windows) at it; also clears CLAUDE_CONFIG_DIR / CODEX_HOME
 * so that defaultDir / codexDefaultDir / effectiveDir all resolve inside the temporary directory.
 * restore() deletes the directory and restores the environment variables.
 */
export function makeTempHome(prefix: string): TempHome {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // The prefix avoids selfCheck's own planswap-codex-*, otherwise parallel tests would disturb its leftover check
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `planswap-test-${prefix}-`));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  assertTempHome(home);
  return {
    home,
    restore() {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Asserts that the current os.homedir() is a temporary directory, not the real home directory */
export function assertTempHome(expected?: string): void {
  const home = os.homedir();
  assert.notEqual(path.resolve(home), path.resolve(REAL_HOME), `HOME is still the real home directory: ${home}`);
  assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir())), `HOME is not under the temporary directory: ${home}`);
  if (expected !== undefined) assert.equal(home, expected);
}

export const read = (f: string): string => fs.readFileSync(f, 'utf8');
export const mode = (f: string): string => (fs.statSync(f).mode & 0o777).toString(8);

/** Sorted list of every entry below dir as 'relative path|kind|content' (links by target, never followed) */
export function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const child of fs.readdirSync(d).sort()) {
      const p = path.join(d, child);
      const r = path.join(rel, child);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push(`${r}|link|${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) {
        out.push(`${r}|dir|`);
        walk(p, r);
      } else out.push(`${r}|file|${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir, '');
  return out;
}

/** In-memory Memento stub */
export class MemoryMemento implements Memento {
  readonly data = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.data.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}
