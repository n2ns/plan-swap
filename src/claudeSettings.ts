import * as path from 'node:path';
import * as vscode from 'vscode';
import { defaultDir, samePath } from './paths';
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

function getConfiguredConfigDir(): string | undefined {
  const byName = new Map<string, string>();
  for (const e of readEntries()) {
    if (!isEnvName(e.name) || e.value === undefined || e.value === null) continue;
    const v = String(e.value);
    // The official extension skips empty-string entries; a later non-empty entry overrides earlier ones
    if (v) byName.set(e.name, v);
  }
  // Several spellings (Windows only): Node passes the child the one that sorts first, i.e. the upper-case one
  const name = [...byName.keys()].sort()[0];
  return name === undefined ? undefined : path.resolve(byName.get(name)!);
}

export function currentDir(): string {
  return getConfiguredConfigDir() ?? defaultDir();
}

/** Whether the setting sets CLAUDE_CONFIG_DIR (non-empty) to dir; then Claude Code reads <dir>/.claude.json even for ~/.claude */
export function isExplicitConfigDir(dir: string): boolean {
  const configured = getConfiguredConfigDir();
  return configured !== undefined && samePath(configured, dir);
}

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

export function affectsSetting(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`${SECTION}.${KEY}`);
}
