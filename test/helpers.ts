// Shared test helpers: create a temporary HOME, assert the real HOME is not used, clean up
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Memento } from 'vscode';
import { CLAUDE_OVERRIDE_VARS } from '../src/environmentWarnings';
import { setLocale } from '../src/i18n';

// Record the real home directory at module load (before any `before` hook) for later assertions
const REAL_HOME = os.homedir();

export const onWindows = process.platform === 'win32';

// scripts/test-guard.cjs (loaded first in every test bundle by scripts/run-tests.mjs) refuses reg / powershell / pwsh /
// setx on every platform, so the Windows code paths cannot touch the real user-level CODEX_HOME. Fail loudly when a
// bundle was built without it.
assert.ok((childProcess as unknown as { __planswapTestGuard?: boolean }).__planswapTestGuard,
  'the process guard (scripts/test-guard.cjs) is not loaded; run the tests through npm test');

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
/**
 * Sharing logic (link, migrate, copy, unshare) on real links. Runs on Windows too when file symbolic links can be
 * created (Developer Mode, an elevated shell, or the elevated GitHub Windows runner); directory fixtures become
 * junctions or directory symlinks there. Linux-only details inside use LINUX_ONLY per test.
 */
export const SHARING = { skip: onWindows && !fileSymlinksAllowed() && 'sharing tests need file symbolic links (Windows Developer Mode)' };
/** Creates entries whose names differ only in case, which a Windows file system folds together. */
export const CASE_SENSITIVE_FS = { skip: onWindows && 'the Windows file system is case-insensitive' };

/** Asserts POSIX permission bits; Windows has none to check (mode() reads 666 / 444 there). */
export function assertMode(f: string, expected: string, message?: string): void {
  if (!onWindows) assert.equal(mode(f), expected, message);
}
/**
 * Variables PlanSwap reads from the extension host environment that a developer's shell may have set, cleared for the
 * duration of a temporary HOME: the account directories, CLAUDE_CODE_CUSTOM_OAUTH_URL (switches the info file name),
 * the Claude credential overrides and federation pair (environment warnings) and the OneDrive roots (OneDrive warning).
 */
const CLEARED_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  ...CLAUDE_OVERRIDE_VARS, 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
  'OneDrive', 'OneDriveCommercial', 'OneDriveConsumer',
] as const;
// Saved and restored, but left as they are (SHELL is set by the rc-file tests themselves)
const ENV_KEYS = ['HOME', 'USERPROFILE', 'SHELL', ...CLEARED_ENV_KEYS] as const;

export interface TempHome { home: string; restore(): void }

/**
 * Creates a mktemp directory and points process.env.HOME and USERPROFILE (read by os.homedir() on Windows) at it; also
 * clears CLEARED_ENV_KEYS (CLAUDE_CONFIG_DIR / CODEX_HOME among them) so that defaultDir / codexDefaultDir / effectiveDir
 * all resolve inside the temporary directory and nothing from the developer's shell changes the results.
 * restore() deletes the directory and restores every saved variable to its previous value (or absence).
 */
export function makeTempHome(prefix: string): TempHome {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  // The prefix avoids selfCheck's own planswap-codex-*, otherwise parallel tests would disturb its leftover check
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `planswap-test-${prefix}-`));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const k of CLEARED_ENV_KEYS) delete process.env[k];
  assertTempHome(home);
  return {
    home,
    restore() {
      for (const [k, v] of saved) restoreEnv(k, v);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Sets process.env[name] back to a saved value, or removes it when it was absent */
export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Runs fn with the given variables set (undefined removes one) and restores their previous values afterwards, also
 * when fn throws or its promise rejects.
 */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) restoreEnv(k, v);
  const restore = (): void => { for (const [k, v] of saved) restoreEnv(k, v); };
  return settle(fn, restore);
}

/** Runs fn in the given locale and switches back to English afterwards, also when fn throws or its promise rejects */
export function inLocale<T>(locale: Parameters<typeof setLocale>[0], fn: () => T): T {
  setLocale(locale);
  return settle(fn, () => setLocale('en'));
}

// Calls fn, then cleanup: right away for a synchronous result or throw, after settling for a promise
function settle<T>(fn: () => T, cleanup: () => void): T {
  let result: T;
  try {
    result = fn();
  } catch (e) {
    cleanup();
    throw e;
  }
  if (result instanceof Promise) return result.finally(cleanup) as T;
  cleanup();
  return result;
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
