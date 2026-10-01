// claudeCode.environmentVariables: the CLAUDE_CONFIG_DIR entry is the only record of the current Claude account; the
// other entries are what the Claude extension passes to Claude Code. Imports vscode.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultDir, samePath, sameRealPath } from './paths';
import { isWindows } from './platform';

const SECTION = 'claudeCode';
const KEY = 'environmentVariables';
const ENV_NAME = 'CLAUDE_CONFIG_DIR';

type EnvEntry = { name: string; value: unknown };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Normalize to an entry array (also accepts the object form {K: v}); returns a new array, never mutates get()'s result
function readEntries(): EnvEntry[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY);
  if (Array.isArray(raw)) {
    return raw.filter((e): e is EnvEntry => isPlainObject(e) && typeof e.name === 'string')
      .map((e) => ({ name: e.name, value: e.value }));
  }
  if (isPlainObject(raw)) return Object.entries(raw).map(([name, value]) => ({ name, value }));
  return [];
}

// Windows variable names are case-insensitive, so a hand-written 'claude_config_dir' entry also sets it there
function isEnvName(name: string): boolean {
  return isWindows() ? name.toUpperCase() === ENV_NAME : name === ENV_NAME;
}

// A value the official extension accepts as the directory: an absolute path string; on Windows with a drive letter
// or as a UNC path (a rooted '\x' has no drive and is ignored there)
function acceptedDir(value: unknown): string | undefined {
  const p = isWindows() ? path.win32 : path;
  if (typeof value !== 'string' || !p.isAbsolute(value)) return undefined;
  if (isWindows() && !/^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/])/.test(value)) return undefined;
  return p.resolve(value);
}

// As the official extension (2.1.284) picks it: the last entry of any accepted spelling whose value is accepted;
// empty, relative and non-string values are skipped
function getConfiguredConfigDir(): string | undefined {
  let found: string | undefined;
  for (const e of readEntries()) {
    if (!isEnvName(e.name)) continue;
    found = acceptedDir(e.value) ?? found;
  }
  return found;
}

/** Names the setting passes to Claude Code: set (non-empty value) and cleared (empty value; the official extension then
 *  passes '' instead of the inherited value). The last entry of a name decides, as it does for the extension */
export function settingEnvNames(): { set: string[]; cleared: string[] } {
  const last = new Map<string, boolean>();
  for (const e of readEntries()) last.set(e.name, e.value !== undefined && e.value !== null && String(e.value) !== '');
  return { set: [...last].filter(([, v]) => v).map(([n]) => n), cleared: [...last].filter(([, v]) => !v).map(([n]) => n) };
}

/**
 * The variables the setting passes to Claude Code besides CLAUDE_CONFIG_DIR, last entry winning; an empty value is
 * passed as '' (overriding the inherited value), as the Claude extension does. Applied to the claude processes PlanSwap
 * starts so they see what the Claude extension's processes see.
 */
export function settingEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const e of readEntries()) {
    if (!isEnvName(e.name)) env[e.name] = e.value === undefined || e.value === null ? '' : String(e.value);
  }
  return env;
}

/** The current Claude account directory: the setting's CLAUDE_CONFIG_DIR as the extension picks it (array or object
 *  form), else defaultDir(). */
export function currentDir(): string {
  return getConfiguredConfigDir() ?? defaultDir();
}

/** Whether the setting's accepted CLAUDE_CONFIG_DIR (an absolute path, see acceptedDir) is dir; then Claude Code reads
 *  <dir>/.claude.json even for ~/.claude. Another spelling of the configured folder (8.3 name, '\\?\' prefix, a link
 *  to it) counts as the same folder. Passed as `explicit` to claudeJsonPath / readAccountInfo by every caller */
export function isExplicitConfigDir(dir: string): boolean {
  const configured = getConfiguredConfigDir();
  return configured !== undefined && (samePath(configured, dir) || sameRealPath(configured, dir));
}

/**
 * Writes a new entry array (never mutating get()'s result) to the global (user / remote Machine) setting: every
 * CLAUDE_CONFIG_DIR entry (any accepted spelling) is removed, the others kept, and {name, value: path.resolve(dir)} is
 * appended unless dir is undefined or the default dir (samePath). The object form is written back as an array.
 * Errors of the update are rethrown as is.
 */
export async function setConfigDir(dir: string | undefined): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const raw = config.get<unknown>(KEY);
  // Other entries are kept as-is (shallow-copied, not filtered, values unchanged); the object form is converted to {name, value} per official semantics
  const next: unknown[] = Array.isArray(raw)
    ? raw.filter((e) => !(isPlainObject(e) && typeof e.name === 'string' && isEnvName(e.name))).map((e) => (isPlainObject(e) ? { ...e } : e))
    : isPlainObject(raw)
      ? Object.entries(raw).filter(([name]) => !isEnvName(name)).map(([name, value]) => ({ name, value: String(value) }))
      : [];
  if (dir !== undefined && !samePath(dir, defaultDir())) next.push({ name: ENV_NAME, value: path.resolve(dir) });
  await config.update(KEY, next, vscode.ConfigurationTarget.Global);
}

// Whether a configuration change touches claudeCode.environmentVariables
export function affectsSetting(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`${SECTION}.${KEY}`);
}
