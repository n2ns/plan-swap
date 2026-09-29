// Native Windows persistence of the selected CODEX_HOME: the per-user environment variable (HKCU\Environment). Windows
// has no rc files; the editor picks the variable up only when it is started afresh (Explorer receives the change
// broadcast; running editors and their terminals keep the old environment). No vscode import.
import { execFileSync } from 'node:child_process';

export const ENV_NAME = 'CODEX_HOME';
/** Scratch variable of the enable self-check, so the check never changes CODEX_HOME itself. */
export const SELF_CHECK_NAME = 'PLANSWAP_SELF_CHECK';

/** Runs a command and returns stdout; injectable for tests. */
export type Runner = (file: string, args: string[], env?: Record<string, string>) => string;

const defaultRunner: Runner = (file, args, env) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, ...env } });

/** Decodes the base64 UTF-8 output of getUserEnv's script; undefined when empty. */
export function decodeEnvOutput(out: string): string | undefined {
  const b64 = out.trim();
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined;
}

/**
 * A user-level environment variable, or undefined when unset or empty (a REG_EXPAND_SZ value comes back expanded with
 * this process's environment; PlanSwap itself only writes REG_SZ). Read through .NET and
 * printed as base64 of its UTF-8 bytes: without a console (the extension host) `reg query` prints the ANSI code page,
 * which garbles non-ASCII paths such as a Chinese user name.
 */
export function getUserEnv(name: string, run: Runner = defaultRunner): string | undefined {
  const script =
    "$v = [Environment]::GetEnvironmentVariable($env:PLANSWAP_ENV_NAME, 'User'); " +
    'if ($v) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) }';
  try {
    return decodeEnvOutput(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { PLANSWAP_ENV_NAME: name }));
  } catch {
    return undefined;
  }
}

/**
 * Sets (or with undefined removes) a user-level environment variable. Uses .NET so the change is broadcast to
 * Explorer; name and value travel in the child's environment, never inside the command line, so no quoting is involved.
 */
export function setUserEnv(name: string, value: string | undefined, run: Runner = defaultRunner): void {
  const script = "[Environment]::SetEnvironmentVariable($env:PLANSWAP_ENV_NAME, $env:PLANSWAP_ENV_VALUE, 'User')";
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { PLANSWAP_ENV_NAME: name, PLANSWAP_ENV_VALUE: value ?? '' });
}

/** The user-level CODEX_HOME, or undefined when unset. */
export function getUserCodexHome(run: Runner = defaultRunner): string | undefined {
  return getUserEnv(ENV_NAME, run);
}

/** Sets (or with undefined removes) the user-level CODEX_HOME. */
export function setUserCodexHome(value: string | undefined, run: Runner = defaultRunner): void {
  setUserEnv(ENV_NAME, value, run);
}
