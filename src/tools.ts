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
import { openCodexWslSetting } from './codex/codexSettings';
import { claudeJsonPath, defaultDir, sameRealPath, syncMcpServers } from './paths';
import { ensureClaudeLinks, isSharedClaudeAccount } from './claudeShare';
import { syncClaudeAccount } from './claudeSync';
import type { LinkOptions, ShareReport } from './shareLinks';
import { askCopyFallback } from './linkPolicy';
import { describeShareReport, type ShareReportLike } from './shareReport';
import { accountProblems, announcementKeys, describeLinkCheck, isFixable, type AccountCheck, type LinkCheckNotices } from './linkCheck';
import type { PanelMode, ToolId } from './protocol';
import { getLocale, joinSentences, LOCALE_INFO, t } from './i18n';
import { CLAUDE_REFRESH_ALL_USAGE_COMMAND, CLAUDE_REFRESH_USAGE_COMMAND, CODEX_REFRESH_ALL_USAGE_COMMAND, REFRESH_USAGE_COMMAND } from './statusBar';
import { isWindows, errText } from './platform';
import { accountTerminalShell } from './terminalShell';

export interface ShareOps {
  isShared(dir: string): boolean;
  // Re-links the account and mirrors what the vendor mirrors; returns the report of the linking step
  refresh(dir: string, options?: LinkOptions): ShareReportLike;
  // Read-only actionable repairs (Claude skips absent optional targets) and what the account lacks of the default
  // .claude.json (Claude only); writes nothing
  check(dir: string, options?: LinkOptions): { report: ShareReport; mirror?: string[]; mirrorQuiet?: string[] };
  // The vendor's default dir, where the links point
  defaultDir(): string;
}

export interface ToolDeps {
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
 * Syncs a shared account with the default account in both directions (syncClaudeAccount, full; inUse: the account is
 * the one in use, see SyncOptions). An account that is not shared (e.g. an existing folder that could not be linked)
 * only gets the default MCP servers added, so its own servers are never replaced and the default account is not changed.
 */
export function syncClaudeInto(fromJson: string, dir: string, inUse = false): void {
  if (isSharedClaudeAccount(dir)) syncClaudeAccount(fromJson, dir, 'full', { inUse });
  else syncMcpServers(fromJson, dir);
}


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
 * - openCodexWslSetting: the Settings UI at chatgpt.runCodexInWindowsSubsystemForLinux (the runs-in-WSL banner's button).
 * - reloadWindow / restartExtHost: the editor commands, without confirmation.
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
    case 'openCodexWslSetting':
      await openCodexWslSetting();
      return;
    case 'reloadWindow':
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    case 'restartExtHost':
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
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
    syncClaudeInto(claudeJsonPath(def, isExplicitConfigDir(def)), dir, sameRealPath(dir, currentDir()));
    return report;
  },
  check(dir, options) {
    const report = ensureClaudeLinks(dir, '/proc', { ...options, check: true });
    const def = defaultDir();
    // Only shared accounts are checked, which syncClaudeInto syncs with syncClaudeAccount. The current account is
    // checked too: what the default account gained meanwhile is missing in the account in use
    const { changed, quiet } = syncClaudeAccount(claudeJsonPath(def, isExplicitConfigDir(def)), dir, 'check', { inUse: sameRealPath(dir, currentDir()) });
    return { report, mirror: changed, mirrorQuiet: quiet };
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
// keys: what the background check announces (announcementKeys; Windows file links count as unknown before a probe),
// computed without the quiet sync groups (prompt keys only, or refreshed sign-ins the account already has), so Re-link
// records what the background check announces. background: those groups are also left out of the checks; a switch
// syncs them, and their lack only makes Claude Code ask once more or use an older token it can refresh itself
function checkShared(accounts: SharedAccounts, deps: ToolDeps, background = false): { checks: AccountCheck[]; keys: string[] } {
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
  const quiet = checks.map((c) => (c.mirror ? { ...c, mirror: c.mirror.filter((key) => !c.mirrorQuiet?.includes(key)) } : c));
  return { checks: background ? quiet : checks, keys: announcementKeys(quiet, isWindows() && fileLinks === undefined) };
}

// The check's notification: the problems and notes per account, with Repair when a repair would change something
async function offerRepair(mode: PanelMode, deps: ToolDeps, accounts: SharedAccounts, checks: AccountCheck[]): Promise<void> {
  const { lines, fixable } = describeLinkCheck(checks);
  const message = joinSentences(t(fixable ? (mode === 'claude' ? 'linkCheck.claudeFound' : 'linkCheck.found') : 'linkCheck.foundNoFix', { vendor: accounts.vendor }), ...lines);
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
        syncClaudeAccount(claudeJsonPath(def, isExplicitConfigDir(def)), check.dir, 'pull', { groups: scope.mirror, inUse: sameRealPath(check.dir, currentDir()) });
      }
      const notes = describeShareReport(report);
      if (notes) issues.push(t('sync.item', { name: accounts.nameOf(check.dir), notes }));
    } catch (err) {
      issues.push(t('sync.item', { name: accounts.nameOf(check.dir), notes: errText(err) }));
    }
  }
  const done = t(issues.length ? 'linkCheck.claudeAttempted' : 'linkCheck.claudeRepaired', { count });
  if (issues.length) void vscode.window.showWarningMessage(joinSentences(done, t('sync.issues', { list: issues.join(t('common.listSep')) })));
  else void vscode.window.showInformationMessage(done);
}

// Background check, Claude: adds to every shared account, the account in use included, the default account's
// user-level MCP servers it lacks (syncClaudeAccount fill: add only, a server the account removed since the last sync
// is not re-added, the default account is never written) and names them in one information notice. A failing account
// is only logged; its check then lists the servers for Repair. A failing base write after the servers were added is only
// logged too; the notice still names them
function fillClaudeMcpServers(accounts: SharedAccounts): void {
  const def = defaultDir();
  const from = claudeJsonPath(def, isExplicitConfigDir(def));
  const filled: Array<{ name: string; servers: string }> = [];
  for (const dir of accounts.dirs) {
    try {
      const { added = [], baseError } = syncClaudeAccount(from, dir, 'fill');
      if (added.length) filled.push({ name: accounts.nameOf(dir), servers: added.join(t('common.nameSep')) });
      if (baseError !== undefined) console.warn(`[planswap] recording the added default MCP servers failed: ${baseError}`);
    } catch (err) {
      console.warn(`[planswap] adding the default MCP servers failed: ${errText(err)}`);
    }
  }
  if (filled.length === 1) void vscode.window.showInformationMessage(t('linkCheck.mcpFilled', filled[0]));
  else if (filled.length) {
    const list = filled.map((f) => t('linkCheck.mcpFilledItem', f)).join(t('common.nameSep'));
    void vscode.window.showInformationMessage(t('linkCheck.mcpFilledMany', { list }));
  }
}

/**
 * Background link check of one vendor (the host calls it in the focused window). Claude first adds the default
 * account's user-level MCP servers that shared accounts lack (fillClaudeMcpServers, with its own information notice).
 * Then every shared account is checked read only and the Re-link notification (all problems) is shown when
 * LinkCheckNotices.take says its announcement keys (repairable problems only, announcementKeys) are due. Nothing else
 * is repaired without the user's Repair; nothing happens when the vendor is not initialized or deps.linkNotices is
 * missing.
 */
export async function checkSharedInBackground(mode: PanelMode, deps: ToolDeps): Promise<void> {
  const accounts = sharedAccounts(mode, deps);
  const notices = deps.linkNotices;
  if (!accounts || !notices) return;
  if (mode === 'claude') fillClaudeMcpServers(accounts);
  const { checks, keys } = checkShared(accounts, deps, true);
  if (await notices.take(mode, keys)) await offerRepair(mode, deps, accounts, checks);
}

// Re-link: checks every shared account of the vendor read only; without problems it reports "all fine" (followed by the
// notes on entries kept as they are, if any), otherwise one notification lists every problem and note per account and offers
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
    void vscode.window.showInformationMessage(joinSentences(t('linkCheck.ok', params), ...lines));
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
  if (issues.length) void vscode.window.showWarningMessage(joinSentences(done, t('sync.issues', { list: issues.join(t('common.listSep')) })));
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
