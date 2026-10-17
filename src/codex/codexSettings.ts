// The Codex extension's own setting that decides where its CLI runs; read on every call. Kept apart from codexCommands
// so the status bar and the panel can ask without importing the command registrar.
import * as vscode from 'vscode';
import { isWindows } from '../platform';

/**
 * Native Windows only: the Codex extension can run its CLI inside WSL (chatgpt.runCodexInWindowsSubsystemForLinux).
 * That Codex reads the WSL-side ~/.codex and never sees the Windows user variable, so switching here would not reach
 * it; accounts are then managed from a WSL window instead.
 */
export function codexRunsInWsl(windows: boolean = isWindows()): boolean {
  return windows && vscode.workspace.getConfiguration('chatgpt').get<boolean>('runCodexInWindowsSubsystemForLinux', false) === true;
}
