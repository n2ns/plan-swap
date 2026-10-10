// Shared usage colors and percentage validation. Settings are read on each update; no migration or writes.
import * as vscode from 'vscode';

export const USAGE_WARNING_SETTING = 'usageWarningThreshold';
export const USAGE_ERROR_SETTING = 'usageErrorThreshold';

/** Clamp a finite percentage to 0..100; invalid values use the supplied default. */
export function threshold(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
}

/** Remaining percentages for warning and error colors in both the sidebar and status bar. */
export function usageThresholds(): { warning: number; error: number } {
  const config = vscode.workspace.getConfiguration('planswap');
  return { warning: threshold(config.get(USAGE_WARNING_SETTING), 30), error: threshold(config.get(USAGE_ERROR_SETTING), 10) };
}

export function usageColorsChanged(event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>): boolean {
  return event.affectsConfiguration(`planswap.${USAGE_WARNING_SETTING}`) || event.affectsConfiguration(`planswap.${USAGE_ERROR_SETTING}`);
}
