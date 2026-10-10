// Tools of the sidebar: the footer toolbar shared by both tabs (versions, user guide, reload window, restart extension
// host, star) and each page's "Tools" section (global rules file, settings, Re-link, Update CLI), plus their Command
// Palette entries. One host implementation serves both entry points; openGlobalMd, openSettings, sync, updateCli and
// the usage refresh tools depend on the mode, the others ignore it. All texts come from t().
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import { effectiveDir } from './codex/codexState';
import { claudeJsonPath, defaultDir, syncMcpServers } from './paths';
import { ensureClaudeLinks, isSharedClaudeAccount, mirrorClaudeJson, type LinkOptions, type ShareReport } from './claudeShare';
import { askCopyFallback } from './linkPolicy';
import { describeShareReport, type ShareReportLike } from './shareReport';
import { accountProblems, announcementKeys, describeLinkCheck, isFixable, type AccountCheck, type LinkCheckNotices } from './linkCheck';
import type { PanelMode, ToolId } from './protocol';
import { getLocale, LOCALE_INFO, t } from './i18n';
import { CLAUDE_REFRESH_ALL_USAGE_COMMAND, CLAUDE_REFRESH_USAGE_COMMAND, CODEX_REFRESH_ALL_USAGE_COMMAND, REFRESH_USAGE_COMMAND } from './statusBar';
import { isWindows } from './platform';
import { accountTerminalShell } from './terminalShell';

export interface ShareOps {
  isShared(dir: string): boolean;
  // Re-links the account and mirrors what the vendor mirrors; returns the report of the linking step
  refresh(dir: string, options?: LinkOptions): ShareReportLike;
  // Read-only actionable repairs (Claude skips absent optional targets) and what the account lacks of the default
  // .claude.json (Claude only); writes nothing
  check(dir: string, options?: LinkOptions): { report: ShareReport; mirror?: string[] };
  // The vendor's default dir, where the links point
  defaultDir(): string;
}

export interface ToolDeps {
  // "Restart WSL server" provided by codexCommands (with modal confirmation and planRestart checks for Antigravity /
  // VSCodium; manual-restart guidance only for other editors); undefined when Codex is not initialized
  codexRestart?: () => Promise<void>;
  // Panel entry: push version info to the sidebar (the editor's quick input position is not under extension control, so no QuickPick);
  // the Command Palette entry passes undefined and gets a read-only QuickPick instead
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
  // Announced link-check problems (state file), so windows and reloads do not repeat a notification
  linkNotices?: LinkCheckNotices;
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

// The user guide on GitHub in the UI language (LOCALE_INFO userGuide); English is the source and has no suffix
function userGuideUrl(): string {
  return `https://github.com/n2ns/plan-swap/blob/main/docs/${LOCALE_INFO[getLocale()].userGuide}`;
}

/**
 * Tool entry shared by the panel (toolbar, Tools section, usage refresh buttons) and the Command Palette.
 * - openHelp / openStar: open the user guide in the UI language / the repository page on GitHub; nothing else.
 * - openGlobalMd: <currentDir()>/CLAUDE.md or <effectiveDir()>/AGENTS.md; a missing file is created empty (0600,
 *   exclusive) after a modal confirmation; for a dangling same-name symlink its target is created instead.
 * - openSettings: the editor settings filtered to `claudeCode.` or `chatgpt.`.
 * - reloadWindow / restartExtHost: the editor commands, without confirmation.
 * - restartServer: deps.codexRestart, or a "not initialized" warning.
 * - refreshUsage / refreshAllUsage: the vendor's own refresh command, so both entry points share one path.
 * - cliVersions: collectVersions, pushed to the panel through deps.postVersions or shown in a QuickPick.
 * - sync: checks every shared account of the vendor read only and offers to repair them (syncShared).
 * - updateCli: a terminal running `claude update`, or `codex update` with CODEX_HOME removed from its environment
 *   (`env -u CODEX_HOME` on Linux); no pre-check and no state change. Available even when Codex is not initialized.
 */
export async function runTool(mode: PanelMode, tool: ToolId, deps: ToolDeps): Promise<void> {
  switch (tool) {
    case 'openHelp':
      await vscode.env.openExternal(vscode.Uri.parse(userGuideUrl()));
      return;
    case 'openStar':
      await vscode.env.openExternal(vscode.Uri.parse('https://github.com/n2ns/plan-swap'));
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
  check(dir, options) {
    const report = ensureClaudeLinks(dir, '/proc', { ...options, check: true });
    const def = defaultDir();
    // Only shared accounts are checked, which mirrorClaudeJsonInto mirrors with mirrorClaudeJson
    return { report, mirror: mirrorClaudeJson(claudeJsonPath(def, isExplicitConfigDir(def)), dir, undefined, true).changed };
  },
  defaultDir,
};

interface SharedAccounts {
  vendor: 'Claude' | 'Codex';
  ops: ShareOps;
  dirs: string[];          // the vendor's shared accounts
  nameOf: (dir: string) => string;
  busyOf: (dir: string) => (() => boolean) | undefined;
}

// The vendor's shared accounts and how to name and busy-check them; undefined when the vendor is not initialized
function sharedAccounts(mode: PanelMode, deps: ToolDeps): SharedAccounts | undefined {
  const dirs = mode === 'claude' ? deps.claudeDirs : deps.codexDirs;
  const ops = mode === 'claude' ? claudeShareOps : deps.codexShareOps;
  if (!dirs || !ops) return undefined;
  const prefix = mode === 'claude' ? '.claude-' : '.codex-';
  const nameOf = (dir: string): string => {
    if (deps.labelOf) return deps.labelOf(mode, dir);
    const base = path.basename(dir);
    return base.startsWith(prefix) ? base.slice(prefix.length) : base;
  };
  const accountBusy = deps.accountBusy;
  return {
    vendor: mode === 'claude' ? 'Claude' : 'Codex',
    ops,
    dirs: dirs().filter((d) => ops.isShared(d)),
    nameOf,
    busyOf: (dir) => (accountBusy ? () => accountBusy(mode, dir) : undefined),
  };
}

// Read-only check of every shared account; a failing account becomes an error entry and the next one continues.
// keys: what the background check announces (announcementKeys; Windows file links count as unknown before a probe)
function checkShared(accounts: SharedAccounts, deps: ToolDeps): { checks: AccountCheck[]; keys: string[] } {
  const fileLinks = deps.linkNotices?.fileLinks();
  const def = accounts.ops.defaultDir();
  const checks = accounts.dirs.map((dir): AccountCheck => {
    const label = accounts.nameOf(dir);
    try {
      return { dir, label, def, vendor: accounts.vendor === 'Claude' ? 'claude' : 'codex', ...accounts.ops.check(dir, { busy: accounts.busyOf(dir), fileLinks }) };
    } catch (err) {
      return { dir, label, error: errText(err) };
    }
  });
  return { checks, keys: announcementKeys(checks, isWindows() && fileLinks === undefined) };
}

// The check's notification: the problems and notes per account, with Repair when a repair would change something
async function offerRepair(mode: PanelMode, deps: ToolDeps, accounts: SharedAccounts, checks: AccountCheck[]): Promise<void> {
  const { lines, fixable } = describeLinkCheck(checks);
  const message = t(fixable ? (mode === 'claude' ? 'linkCheck.claudeFound' : 'linkCheck.found') : 'linkCheck.foundNoFix', { vendor: accounts.vendor, list: lines.join(t('common.listSep')) });
  const repair = t('linkCheck.repair');
  const picked = await (fixable ? vscode.window.showWarningMessage(message, repair) : vscode.window.showWarningMessage(message));
  if (picked === repair) {
    if (mode === 'claude') await repairClaudeChecks(deps, checks);
    else await repairShared(mode, deps);
  }
}

// Only entries offered as repairable authorize writes. Mirror groups are listed separately in the notification.
function claudeRepairScope(check: AccountCheck): { entries: string[]; mirror: string[] } {
  const problems = accountProblems(check);
  return {
    entries: [...new Set(problems.filter((p) => isFixable(p.kind) && p.kind !== 'mirror').flatMap((p) => p.entries))],
    mirror: problems.some((p) => p.kind === 'mirror') ? check.mirror ?? [] : [],
  };
}

// Claude Repair is bounded by the notification, even when the user leaves it open while accounts or files change.
// Normal add/switch initialization and Codex's refresh keep their existing behavior.
async function repairClaudeChecks(deps: ToolDeps, offered: AccountCheck[]): Promise<void> {
  const selected = offered.filter((c) => {
    const scope = claudeRepairScope(c);
    return scope.entries.length || scope.mirror.length;
  });
  if (!selected.length) return;
  const options = selected.some((c) => claudeRepairScope(c).entries.length)
    ? await askCopyFallback(selected[0].dir, 'Claude') : {};
  const accounts = sharedAccounts('claude', deps);
  if (!accounts) return;
  const issues: string[] = [];
  let count = 0;
  for (const check of selected) {
    if (!accounts.dirs.includes(check.dir)) continue;
    count++;
    try {
      const scope = claudeRepairScope(check);
      const report = ensureClaudeLinks(check.dir, '/proc', { ...options, busy: accounts.busyOf(check.dir), entries: scope.entries });
      if (scope.mirror.length) {
        const def = defaultDir();
        mirrorClaudeJson(claudeJsonPath(def, isExplicitConfigDir(def)), check.dir, undefined, false, scope.mirror);
      }
      const notes = describeShareReport(report);
      if (notes) issues.push(t('sync.item', { name: accounts.nameOf(check.dir), notes }));
    } catch (err) {
      issues.push(t('sync.item', { name: accounts.nameOf(check.dir), notes: errText(err) }));
    }
  }
  const done = t(issues.length ? 'linkCheck.claudeAttempted' : 'linkCheck.claudeRepaired', { count });
  if (issues.length) void vscode.window.showWarningMessage(`${done} ${t('sync.issues', { list: issues.join(t('common.listSep')) })}`);
  else void vscode.window.showInformationMessage(done);
}

/**
 * Background link check of one vendor (the host calls it in the focused window): checks every shared account read
 * only and shows the Re-link notification (all problems) when LinkCheckNotices.take says its announcement keys
 * (repairable problems only, announcementKeys) are due. Nothing is repaired without the user's Repair; nothing happens
 * when the vendor is not initialized or deps.linkNotices is missing.
 */
export async function checkSharedInBackground(mode: PanelMode, deps: ToolDeps): Promise<void> {
  const accounts = sharedAccounts(mode, deps);
  const notices = deps.linkNotices;
  if (!accounts || !notices) return;
  const { checks, keys } = checkShared(accounts, deps);
  if (await notices.take(mode, keys)) await offerRepair(mode, deps, accounts, checks);
}

// Re-link: checks every shared account of the vendor read only; without problems it reports "all fine" (with the notes
// on entries kept as they are, if any), otherwise one notification lists every problem and note per account and offers
// Repair (scoped for Claude; full refresh for Codex) when a repair would change something. Its
// announcement keys are recorded so the background check does not repeat them. Without the vendor's directory list or
// share ops (not initialized) only a warning is shown
async function syncShared(mode: PanelMode, deps: ToolDeps): Promise<void> {
  const accounts = sharedAccounts(mode, deps);
  if (!accounts) {
    void vscode.window.showWarningMessage(t('tools.syncNotInit', { vendor: mode === 'claude' ? 'Claude' : 'Codex' }));
    return;
  }
  if (accounts.dirs.length === 0) {
    void vscode.window.showInformationMessage(t('sync.none', { vendor: accounts.vendor }));
    return;
  }
  const { checks, keys } = checkShared(accounts, deps);
  await deps.linkNotices?.remember(mode, keys);
  const { lines, problems } = describeLinkCheck(checks);
  if (!problems) {
    const params = { count: accounts.dirs.length, vendor: accounts.vendor };
    void vscode.window.showInformationMessage(lines.length ? t('linkCheck.okNotes', { ...params, list: lines.join(t('common.listSep')) }) : t('linkCheck.ok', params));
    return;
  }
  await offerRepair(mode, deps, accounts, checks);
}

// Codex Repair: re-links every shared account to the default account and reports in one notification;
// independent accounts are untouched. A failing account is reported and the next one continues; with any issue the
// result is a warning that does not claim every account was re-linked
async function repairShared(mode: PanelMode, deps: ToolDeps): Promise<void> {
  const accounts = sharedAccounts(mode, deps);
  if (!accounts || accounts.dirs.length === 0) return;
  const { vendor, ops, dirs: shared } = accounts;
  // One question for the whole run (Windows without file-link privilege only)
  const options = await askCopyFallback(shared[0], vendor);
  const issues: string[] = [];
  for (const dir of shared) {
    try {
      const busy = accounts.busyOf(dir);
      const notes = describeShareReport(ops.refresh(dir, busy ? { ...options, busy } : options));
      if (notes) issues.push(t('sync.item', { name: accounts.nameOf(dir), notes }));
    } catch (err) {
      issues.push(t('sync.item', { name: accounts.nameOf(dir), notes: errText(err) }));
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

/**
 * Read-only `--version` of the claude and codex CLIs (in parallel, PATH inherited from the extension host, 8 s timeout)
 * and the versions of the Claude Code and Codex extensions. Not found, timed out, failed (first line of the error) and
 * no output each get their own text. No network access and no update check.
 */
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

/**
 * Command Palette entries; restarting the WSL server reuses planswap.codex.restartServer and is not registered here.
 * Vendor-specific tools without an obvious vendor (settings, Re-link) first ask Claude Code / Codex in a QuickPick;
 * planswap.openSettings opens PlanSwap's own settings.
 */
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
