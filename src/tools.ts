import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import { effectiveDir } from './codex/codexState';
import { claudeJsonPath, defaultDir, syncMcpServers } from './paths';
import { ensureClaudeLinks, isSharedClaudeAccount, mirrorClaudeJson, type LinkOptions } from './claudeShare';
import { askCopyFallback } from './linkPolicy';
import { describeShareReport, type ShareReportLike } from './shareReport';
import type { PanelMode, ToolId } from './protocol';
import { t } from './i18n';
import { CLAUDE_REFRESH_ALL_USAGE_COMMAND, CLAUDE_REFRESH_USAGE_COMMAND, CODEX_REFRESH_ALL_USAGE_COMMAND, REFRESH_USAGE_COMMAND } from './statusBar';
import { isWindows } from './platform';
import { accountTerminalShell } from './terminalShell';

export interface ShareOps {
  isShared(dir: string): boolean;
  // Re-links the account and mirrors what the vendor mirrors; returns the report of the linking step
  refresh(dir: string, options?: LinkOptions): ShareReportLike;
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
  // Extra busy check passed to the linking steps (Windows: PlanSwap has a terminal of the account open)
  accountBusy?: (mode: PanelMode, dir: string) => boolean;
}

/** Whether PlanSwap has an account terminal open for dir (only meaningful on Windows; false elsewhere). */
export type TerminalCheck = (dir: string) => boolean;

/**
 * Mirrors the default account's info file into a shared account. An account that is not shared (e.g. an existing
 * folder that could not be linked) only gets the default MCP servers added, so its own servers are never replaced.
 */
export function mirrorClaudeJsonInto(fromJson: string, dir: string): void {
  if (isSharedClaudeAccount(dir)) mirrorClaudeJson(fromJson, dir);
  else syncMcpServers(fromJson, dir);
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
    // Panel buttons next to "Add": the product's own refresh command, so the Command Palette and the panel share one path
    case 'refreshUsage':
      await vscode.commands.executeCommand(mode === 'claude' ? CLAUDE_REFRESH_USAGE_COMMAND : REFRESH_USAGE_COMMAND);
      return;
    case 'refreshAllUsage':
      await vscode.commands.executeCommand(mode === 'claude' ? CLAUDE_REFRESH_ALL_USAGE_COMMAND : CODEX_REFRESH_ALL_USAGE_COMMAND);
      return;
    case 'cliVersions':
      if (deps.postVersions) deps.postVersions(await collectVersions());
      else await showCliVersions();
      return;
    case 'sync':
      await syncShared(mode, deps);
      return;
    case 'updateCli': {
      const vendor = mode === 'claude' ? 'Claude' : 'Codex';
      const terminal = vscode.window.createTerminal({
        name: t('tools.updateCli', { vendor }),
        shellPath: accountTerminalShell(),
        env: isWindows() && mode === 'codex' ? { CODEX_HOME: null } : undefined,
      });
      terminal.sendText(mode === 'claude' ? 'claude update' : isWindows() ? 'codex update' : 'env -u CODEX_HOME codex update');
      terminal.show();
      return;
    }
  }
}

const claudeShareOps: ShareOps = {
  isShared: isSharedClaudeAccount,
  refresh(dir, options) {
    const report = ensureClaudeLinks(dir, '/proc', options);
    const def = defaultDir();
    mirrorClaudeJsonInto(claudeJsonPath(def, isExplicitConfigDir(def)), dir);
    return report;
  },
};

// Re-links every shared account of the vendor to the default account and reports in one notification; independent accounts are untouched
async function syncShared(mode: PanelMode, deps: ToolDeps): Promise<void> {
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
  // One question for the whole run (Windows without file-link privilege only)
  const options = await askCopyFallback(shared[0], mode === 'claude' ? 'Claude' : 'Codex');
  const issues: string[] = [];
  for (const dir of shared) {
    try {
      const accountBusy = deps.accountBusy;
      const notes = describeShareReport(ops.refresh(dir, accountBusy ? { ...options, busy: () => accountBusy(mode, dir) } : options));
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

// Windows: whether `where` finds the command on PATH (any PATHEXT extension: .exe, or npm's .cmd shim). Through a
// shell a missing command is only an exit code 1, not ENOENT; `where` exits 1 exactly when nothing matches
function whereFinds(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('where.exe', [cmd], { timeout: 8000, windowsHide: true }, (err) => {
      resolve(!err || (err as { code?: unknown }).code !== 1);
    });
  });
}

// Runs `<cmd> --version` read-only; shows "not found" when not installed, otherwise an error summary
async function cliVersion(cmd: string): Promise<string> {
  if (isWindows() && !(await whereFinds(cmd))) return t('tools.ver.notFound');
  return new Promise((resolve) => {
    // Windows: npm installs .cmd shims that only a shell resolves; the command line is a fixed literal, passed as one
    // string (arguments next to shell: true are deprecated)
    const run = (callback: (err: Error | null, stdout: string) => void): void => {
      if (isWindows()) execFile(`${cmd} --version`, [], { timeout: 8000, shell: true, windowsHide: true }, callback);
      else execFile(cmd, ['--version'], { timeout: 8000, windowsHide: true }, callback);
    };
    run((err, stdout) => {
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

export async function collectVersions(): Promise<Array<{ label: string; value: string }>> {
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
    vscode.commands.registerCommand('planswap.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:n2ns.planswap')),
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
