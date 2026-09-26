import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import { effectiveDir } from './codex/codexState';
import { claudeJsonPath, defaultDir } from './paths';
import { ensureClaudeLinks, isSharedClaudeAccount, mirrorClaudeJson } from './claudeShare';
import { describeShareReport, type ShareReportLike } from './shareReport';
import type { PanelMode, ToolId } from './protocol';
import { t } from './i18n';

export interface ShareOps {
  isShared(dir: string): boolean;
  // Re-links the account and mirrors what the vendor mirrors; returns the report of the linking step
  refresh(dir: string): ShareReportLike;
}

export interface ToolDeps {
  // "Restart WSL server" provided by codexCommands (with modal confirmation and planRestart checks); undefined when Codex is not initialized
  codexRestart?: () => Promise<void>;
  // Panel entry: push version info to the sidebar (the editor's quick input position is not under extension control, so no QuickPick)
  postVersions?: (items: Array<{ label: string; value: string }>) => void;
  // Directories of each vendor's registered named accounts (for "sync shared"); undefined when not initialized
  claudeDirs?: () => string[];
  codexDirs?: () => string[];
  // Codex share operations; undefined when Codex is not initialized
  codexShareOps?: ShareOps;
  // Display name (labelFor) of a registered account dir, for user-visible text
  labelOf?: (mode: PanelMode, dir: string) => string;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Tool entry shared by the panel toolbar and the Command Palette */
export async function runTool(mode: PanelMode, tool: ToolId, deps: ToolDeps): Promise<void> {
  switch (tool) {
    case 'openHelp':
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/n2ns/planswap#readme'));
      return;
    case 'openStar':
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/n2ns/planswap'));
      return;
    case 'openGlobalMd':
      await openGlobalMd(mode);
      return;
    case 'openSettings':
      await vscode.commands.executeCommand('workbench.action.openSettings', mode === 'claude' ? 'claudeCode.' : 'chatgpt.');
      return;
    case 'reloadWindow':
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    case 'restartExtHost':
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      return;
    case 'restartServer':
      if (!deps.codexRestart) {
        void vscode.window.showWarningMessage(t('tools.codexNotInit'));
        return;
      }
      await deps.codexRestart();
      return;
    case 'cliVersions':
      if (deps.postVersions) deps.postVersions(await collectVersions());
      else await showCliVersions();
      return;
    case 'sync':
      syncShared(mode, deps);
      return;
    case 'updateCli': {
      const vendor = mode === 'claude' ? 'Claude' : 'Codex';
      const terminal = vscode.window.createTerminal({ name: t('tools.updateCli', { vendor }) });
      terminal.sendText(mode === 'claude' ? 'claude update' : 'env -u CODEX_HOME codex update');
      terminal.show();
      return;
    }
  }
}

const claudeShareOps: ShareOps = {
  isShared: isSharedClaudeAccount,
  refresh(dir) {
    const report = ensureClaudeLinks(dir);
    const def = defaultDir();
    mirrorClaudeJson(claudeJsonPath(def, isExplicitConfigDir(def)), dir);
    return report;
  },
};

// Re-links every shared account of the vendor to the default account and reports in one notification; independent accounts are untouched
function syncShared(mode: PanelMode, deps: ToolDeps): void {
  const vendor = mode === 'claude' ? 'Claude' : 'Codex';
  const dirs = mode === 'claude' ? deps.claudeDirs : deps.codexDirs;
  const ops = mode === 'claude' ? claudeShareOps : deps.codexShareOps;
  if (!dirs || !ops) {
    void vscode.window.showWarningMessage(t('tools.syncNotInit', { vendor }));
    return;
  }
  const prefix = mode === 'claude' ? '.claude-' : '.codex-';
  const nameOf = (dir: string): string => {
    if (deps.labelOf) return deps.labelOf(mode, dir);
    const base = path.basename(dir);
    return base.startsWith(prefix) ? base.slice(prefix.length) : base;
  };
  const shared = dirs().filter((d) => ops.isShared(d));
  if (shared.length === 0) {
    void vscode.window.showInformationMessage(t('sync.none', { vendor }));
    return;
  }
  const issues: string[] = [];
  for (const dir of shared) {
    try {
      const notes = describeShareReport(ops.refresh(dir));
      if (notes) issues.push(t('sync.item', { name: nameOf(dir), notes }));
    } catch (err) {
      issues.push(t('sync.item', { name: nameOf(dir), notes: errText(err) }));
    }
  }
  const done = t(issues.length ? 'sync.attempted' : 'sync.done', { count: shared.length, vendor });
  if (issues.length) void vscode.window.showWarningMessage(`${done} ${t('sync.issues', { list: issues.join(t('common.listSep')) })}`);
  else void vscode.window.showInformationMessage(done);
}

// claude → <current Claude effective dir>/CLAUDE.md; codex → <current Codex effective dir>/AGENTS.md
async function openGlobalMd(mode: PanelMode): Promise<void> {
  const file = mode === 'claude' ? path.join(currentDir(), 'CLAUDE.md') : path.join(effectiveDir(), 'AGENTS.md');
  if (!fs.existsSync(file)) {
    // A dangling symlink (e.g. to a deleted default rules file): create its target so the link works again
    const target = danglingLinkTarget(file) ?? file;
    const createLabel = t('tools.create');
    const ok = await vscode.window.showInformationMessage(t('tools.fileMissingCreate', { file: target }), { modal: true }, createLabel);
    if (ok !== createLabel) return;
    try {
      fs.writeFileSync(target, '', { mode: 0o600, flag: 'wx' });
    } catch (err) {
      void vscode.window.showErrorMessage(t('tools.createFailed', { error: errText(err) }));
      return;
    }
  }
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  } catch (err) {
    void vscode.window.showErrorMessage(t('tools.openFailed', { error: errText(err) }));
  }
}

// Target path of file when it is a symlink to a file of the same name (relative targets resolved against the link's
// real directory, as the kernel does); undefined otherwise, so nothing but a rules file is ever created
function danglingLinkTarget(file: string): string | undefined {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return undefined;
    const target = path.resolve(fs.realpathSync(path.dirname(file)), fs.readlinkSync(file));
    return path.basename(target) === path.basename(file) ? target : undefined;
  } catch {
    return undefined;
  }
}

// Runs `<cmd> --version` read-only without a shell; shows "not found" when not installed, otherwise an error summary
function cliVersion(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return resolve(t('tools.ver.notFound'));
        if (e.killed) return resolve(t('tools.ver.timeout'));
        return resolve(t('tools.ver.failed', { error: errText(err).split('\n')[0] }));
      }
      const line = stdout.trim().split('\n')[0]?.trim();
      resolve(line || t('tools.ver.noOutput'));
    });
  });
}

function extVersion(id: string): string {
  const version = vscode.extensions.getExtension(id)?.packageJSON?.version;
  return typeof version === 'string' ? version : t('tools.ver.notFound');
}

async function collectVersions(): Promise<Array<{ label: string; value: string }>> {
  const [claudeCli, codexCli] = await Promise.all([cliVersion('claude'), cliVersion('codex')]);
  return [
    { label: 'Claude Code CLI', value: claudeCli },
    { label: t('tools.ver.claudeExt'), value: extVersion('anthropic.claude-code') },
    { label: 'Codex CLI', value: codexCli },
    { label: t('tools.ver.codexExt'), value: extVersion('openai.chatgpt') },
  ];
}

async function showCliVersions(): Promise<void> {
  const items: vscode.QuickPickItem[] = (await collectVersions()).map((v) => ({ label: v.label, description: v.value }));
  // Display only; picking an item does nothing
  await vscode.window.showQuickPick(items, { canPickMany: false, placeHolder: t('tools.ver.placeholder') });
}

/** Command Palette entries; restarting the WSL server reuses planswap.codex.restartServer and is not registered here */
export function registerToolCommands(deps: ToolDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('planswap.tools.openClaudeMd', () => runTool('claude', 'openGlobalMd', deps)),
    vscode.commands.registerCommand('planswap.tools.openAgentsMd', () => runTool('codex', 'openGlobalMd', deps)),
    vscode.commands.registerCommand('planswap.tools.openSettings', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Claude Code', mode: 'claude' as const },
          { label: 'Codex', mode: 'codex' as const },
        ],
        { placeHolder: t('tools.pick.settings') },
      );
      if (picked) await runTool(picked.mode, 'openSettings', deps);
    }),
    vscode.commands.registerCommand('planswap.tools.reloadWindow', () => runTool('claude', 'reloadWindow', deps)),
    vscode.commands.registerCommand('planswap.tools.restartExtHost', () => runTool('claude', 'restartExtHost', deps)),
    vscode.commands.registerCommand('planswap.tools.cliVersions', () => runTool('claude', 'cliVersions', { ...deps, postVersions: undefined })),
    vscode.commands.registerCommand('planswap.tools.sync', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Claude Code', mode: 'claude' as const },
          { label: 'Codex', mode: 'codex' as const },
        ],
        { placeHolder: t('tools.pick.sync') },
      );
      if (picked) await runTool(picked.mode, 'sync', deps);
    }),
  ];
}
