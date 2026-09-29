// Asks once (modal, centered) whether config files may be copied when Windows refuses file links. Imports vscode.
import * as vscode from 'vscode';
import { fileLinksAvailable, isWindows } from './platform';
import type { LinkOptions } from './claudeShare';
import { t } from './i18n';

// Files shown in the dialog (the ones COPYABLE_ON_NO_LINK would copy for each vendor)
const FILES = { Claude: 'settings.json, CLAUDE.md', Codex: 'config.toml, AGENTS.md, hooks.json' } as const;

/**
 * Off Windows, or when file links work, returns {} without asking. Otherwise shows a modal explaining that Windows
 * cannot link files and offers a one-time copy of the small config files; dismissing the dialog means "do not copy".
 * dir: an existing directory on the same volume as the accounts, where the probe link is tried.
 */
export async function askCopyFallback(dir: string, vendor: 'Claude' | 'Codex'): Promise<LinkOptions> {
  if (!isWindows() || fileLinksAvailable(dir)) return {};
  const copy = t('share.noFileLinks.copy');
  const picked = await vscode.window.showWarningMessage(t('share.noFileLinks.prompt', { files: FILES[vendor] }), { modal: true }, copy, t('share.noFileLinks.skip'));
  return { copyConfig: picked === copy };
}
