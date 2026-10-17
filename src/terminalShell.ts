// Shell of the account terminals PlanSwap opens on Windows (Claude / Codex account terminals, update-CLI terminal)
// and the environment of the account terminals
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isWindows } from './platform';

export type TerminalProfiles = Record<string, { path?: string | string[] } | null | undefined>;

/** Whether a Windows terminal profile starts WSL: a detected distribution ("Ubuntu (WSL)"), or a profile whose path is
 *  wsl.exe or the System32 bash.exe launcher (Git Bash's bash.exe is not). */
export function isWslProfile(name: string, profiles: TerminalProfiles = {}): boolean {
  if (/\(WSL\)\s*$/i.test(name)) return true;
  const p = profiles[name]?.path;
  const paths = p === undefined ? [] : Array.isArray(p) ? p : [p];
  return paths.some((x) => /(^|[\\/])wsl\.exe$/i.test(x) || /[\\/](system32|sysnative)[\\/]bash\.exe$/i.test(x));
}

/**
 * Windows: the shell for PlanSwap's account terminals. Their account travels in the terminal environment, which a WSL
 * shell does not receive (it would also run the Linux CLI with the Linux home), so a WSL default profile is replaced by
 * Windows PowerShell; any other default profile (PowerShell, cmd, Git Bash) is kept. undefined = the default profile
 * (always undefined off Windows). Reads terminal.integrated.defaultProfile.windows / profiles.windows.
 */
export function accountTerminalShell(): string | undefined {
  if (!isWindows()) return undefined;
  const cfg = vscode.workspace.getConfiguration('terminal.integrated');
  const name = cfg.get<string>('defaultProfile.windows');
  return name && isWslProfile(name, cfg.get<TerminalProfiles>('profiles.windows')) ? 'powershell.exe' : undefined;
}

/**
 * Windows: the environment of an account terminal: vars (the account variable; null removes it) and, when the official
 * extension bundles a CLI (findBundledClaude / findBundledCodex), that binary's folder appended to PATH, so the command
 * falls back to it only when no installed CLI comes earlier (PowerShell, cmd and Git Bash all search PATH in order).
 * The PATH this terminal would otherwise get is the host's, or the PATH entry of setting
 * (terminal.integrated.env.windows) with its ${env:NAME} references resolved from the host; this env replaces it, so
 * that entry is kept. Names compare case-insensitively and the host's spelling (`Path`) is kept. undefined when there
 * is nothing to set.
 */
export function windowsAccountEnv(
  vars: Record<string, string | null>, bundled: string | undefined,
  setting: Record<string, string | null | undefined> = {}, env: NodeJS.ProcessEnv = process.env,
): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = { ...vars };
  if (bundled) {
    const keyOf = (o: object): string | undefined => Object.keys(o).find((k) => k.toUpperCase() === 'PATH');
    const hostValue = (name: string): string => {
      const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
      return (key && env[key]) || '';
    };
    const settingKey = keyOf(setting);
    const base = settingKey === undefined
      ? hostValue('PATH')
      : (setting[settingKey] ?? '').replace(/\$\{env:([^}]+)\}/g, (_, name: string) => hostValue(name));
    const folder = path.win32.dirname(bundled);
    out[keyOf(env) ?? 'Path'] = base ? `${base};${folder}` : folder;
  }
  return Object.keys(out).length ? out : undefined;
}

/** terminal.integrated.env.windows, the base of windowsAccountEnv's PATH. */
export function windowsTerminalEnvSetting(): Record<string, string | null | undefined> | undefined {
  return vscode.workspace.getConfiguration('terminal.integrated').get('env.windows');
}

// Wrap in single quotes; inner ' becomes '\''
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Whether a path holds a control character, which must never be typed into a terminal (a newline runs the line). */
export function hasControlChars(s: string): boolean {
  return /[\x00-\x1f\x7f]/.test(s);
}

/**
 * Linux: the `env` assignment that appends the folder of an official extension's bundled CLI to PATH in an account
 * terminal's command line, so the command falls back to it only when no installed CLI comes earlier. It is expanded by
 * the shell after its rc and profile files ran, so a login profile that resets PATH cannot drop it (bash, zsh and
 * fish 3 all join "$PATH" with colons).
 */
export function bundledPathAssignment(bundled: string): string {
  return `PATH="$PATH":${shQuote(path.posix.dirname(bundled))}`;
}
