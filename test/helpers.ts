// Shared test helpers: create a temporary HOME, assert the real HOME is not used, clean up
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Memento } from 'vscode';

// Record the real home directory at module load (before any `before` hook) for later assertions
const REAL_HOME = os.homedir();
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
