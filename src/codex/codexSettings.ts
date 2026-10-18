// The Codex extension's own setting that decides where its CLI runs; read on every call. Kept apart from codexCommands
// so the status bar and the panel can ask without importing the command registrar.
import * as vscode from 'vscode';
import { isWindows } from '../platform';
import { t } from '../i18n';

/** The Codex extension setting that moves its CLI into WSL; the Settings UI is opened at it (openCodexWslSetting) */
export const RUNS_IN_WSL_SETTING = 'chatgpt.runCodexInWindowsSubsystemForLinux';

/**
 * Native Windows only: the Codex extension can run its CLI inside WSL (chatgpt.runCodexInWindowsSubsystemForLinux).
 * That Codex reads the WSL-side ~/.codex and never sees the Windows user variable, so switching here would not reach
 * it; accounts are then managed from a WSL window instead.
 */
export function codexRunsInWsl(windows: boolean = isWindows()): boolean {
  return windows && vscode.workspace.getConfiguration('chatgpt').get<boolean>('runCodexInWindowsSubsystemForLinux', false) === true;
}

/** Opens the Settings UI at RUNS_IN_WSL_SETTING; whether to turn it off stays the user's decision (PlanSwap never
 *  changes another extension's settings) */
export async function openCodexWslSetting(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', RUNS_IN_WSL_SETTING);
}

/** The refusal shown by the Codex actions while codexRunsInWsl(): a warning with an **Open Setting** button that
 *  leads to the setting */
export function warnCodexRunsInWsl(): void {
  const open = t('codex.win.openSetting');
  void Promise.resolve(vscode.window.showWarningMessage(t('codex.win.runsInWsl'), open)).then((picked) => {
    if (picked === open) return openCodexWslSetting();
  });
}
