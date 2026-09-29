// Native Windows persistence of the selected CODEX_HOME: the per-user environment variable (HKCU\Environment). Windows
// has no rc files; the editor picks the variable up only when it is started afresh (Explorer receives the change
// broadcast; running editors and their terminals keep the old environment). No vscode import.
import { execFileSync } from 'node:child_process';

export const ENV_NAME = 'CODEX_HOME';

/** Runs a command and returns stdout; injectable for tests. */
export type Runner = (file: string, args: string[], env?: Record<string, string>) => string;

const defaultRunner: Runner = (file, args, env) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, ...env } });

/** Parses `reg query HKCU\Environment /v CODEX_HOME` output; undefined when the value is absent or empty. */
export function parseRegQuery(out: string): string | undefined {
  const m = /^\s*CODEX_HOME\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(out);
  return m && m[1] ? m[1] : undefined;
}

/** The user-level CODEX_HOME, or undefined when unset. */
export function getUserCodexHome(run: Runner = defaultRunner): string | undefined {
  try {
    return parseRegQuery(run('reg', ['query', 'HKCU\\Environment', '/v', ENV_NAME]));
  } catch {
    // reg exits 1 when the value does not exist
    return undefined;
  }
}

/**
 * Sets (or with undefined removes) the user-level CODEX_HOME. Uses .NET so the change is broadcast to Explorer; the
 * value travels in the child's environment, never inside the command line, so no quoting is involved.
 */
export function setUserCodexHome(value: string | undefined, run: Runner = defaultRunner): void {
  const script = "[Environment]::SetEnvironmentVariable('CODEX_HOME', $env:PLANSWAP_CODEX_HOME, 'User')";
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { PLANSWAP_CODEX_HOME: value ?? '' });
}
