// Asks once (modal, centered) whether config files may be copied when Windows refuses file links. Imports vscode.
import * as vscode from 'vscode';
import { fileLinksAvailable, isWindows } from './platform';
import type { LinkOptions } from './claudeShare';
import { t } from './i18n';

// Files shown in the dialog (the ones COPYABLE_ON_NO_LINK would copy for each vendor)
const FILES = { Claude: 'settings.json, CLAUDE.md', Codex: 'config.toml, AGENTS.md, hooks.json' } as const;

/** The "For developers" page of Windows Settings (Developer Mode), the same URI on Windows 10 and 11. */
export const DEVELOPER_SETTINGS_URI = 'ms-settings:developers';

/** Opens Windows Settings > For developers; when the editor cannot, says where to find it. */
export async function openDeveloperSettings(): Promise<void> {
  let opened = false;
  try {
    opened = await vscode.env.openExternal(vscode.Uri.parse(DEVELOPER_SETTINGS_URI));
  } catch {
    // reported below
  }
  if (!opened) void vscode.window.showWarningMessage(t('share.noFileLinks.openFailed'));
}

/**
 * Off Windows, or when file links work, returns {} without asking. Otherwise shows a modal explaining that Windows
 * cannot link files and offers a one-time copy of the small config files, or to open the Developer Mode settings
 * (then nothing is copied: once Developer Mode is on, Re-link links the files). Dismissing means "do not copy".
 * dir: an existing directory on the same volume as the accounts, where the probe link is tried.
 */
export async function askCopyFallback(dir: string, vendor: 'Claude' | 'Codex'): Promise<LinkOptions> {
  if (!isWindows() || fileLinksAvailable(dir)) return {};
  const copy = t('share.noFileLinks.copy');
  const settings = t('share.noFileLinks.openSettings');
  const picked = await vscode.window.showWarningMessage(
    t('share.noFileLinks.prompt', { files: FILES[vendor] }), { modal: true }, copy, settings, t('share.noFileLinks.skip'),
  );
  if (picked === settings) await openDeveloperSettings();
  return { copyConfig: picked === copy };
}
