// Shell of the account terminals PlanSwap opens on Windows
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
 * Windows PowerShell; any other default profile (PowerShell, cmd, Git Bash) is kept. undefined = the default profile.
 */
export function accountTerminalShell(): string | undefined {
  if (!isWindows()) return undefined;
  const cfg = vscode.workspace.getConfiguration('terminal.integrated');
  const name = cfg.get<string>('defaultProfile.windows');
  return name && isWslProfile(name, cfg.get<TerminalProfiles>('profiles.windows')) ? 'powershell.exe' : undefined;
}
