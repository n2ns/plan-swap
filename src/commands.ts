import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  DEFAULT_NAME,
  NAME_RE,
  type Account,
  accountDir,
  claudeJsonPath,
  defaultDir,
  deleteAccountDir,
  ensureAccountDir,
  findSameDir,
  readAccountInfo,
  realPathInside,
  samePath,
  sameRealPath,
  caseVariantOf,
} from './paths';
import {
  claudeAccountBusy,
  copyClaudeIndependent,
  ensureClaudeLinks,
  isSharedClaudeAccount,
  lstatOrUndefined,
  makeClaudeIndependent,
  migrateClaudeToShared,
} from './claudeShare';
import { describeShareReport } from './shareReport';
import { currentDir, isExplicitConfigDir, setConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import type { AccountsPanel } from './accountsPanel';
import type { StatusBar } from './statusBar';
import { labelFor, sameName, type LabelStore, EXTERNAL_NAME } from './labels';
import type { RecommendExclusions } from './recommend';
import type { FromWebview } from './protocol';
import type { CodexAccountStore } from './codex/codexStore';
import { mirrorClaudeJsonInto, runTool, type TerminalCheck, type ToolDeps } from './tools';
import { t } from './i18n';
import { isWindows } from './platform';
import { askCopyFallback } from './linkPolicy';
import { accountTerminalShell } from './terminalShell';

// planswap.claude.confirmSwitch: whether a switch from the panel asks a modal first (default on)
export const CONFIRM_SWITCH_SETTING = 'claude.confirmSwitch';

export interface Deps {
  store: AccountStore;
  panel: AccountsPanel;
  statusBar: StatusBar;
  // Aliases of Claude accounts (claude.labels)
  labels: LabelStore;
  // Accounts excluded from recommendations (claude.recommendExcluded); cleared with the account. Tests may leave it out
  exclusions?: RecommendExclusions;
  // Codex-side store; the refresh command applies to both tabs
  codex?: { store: CodexAccountStore; labels: LabelStore; exclusions?: RecommendExclusions };
  // Panel 'tool' messages of the Claude page go to runTool('claude', tool, tools)
  tools: ToolDeps;
  // Root of the process tree for the busy checks; tests pass a fake, product code leaves the default /proc
  procRoot?: string;
  // Receives this module's "account terminal open" check, so the toolbar's Re-link can treat such an account as busy
  provideTerminalCheck?: (check: TerminalCheck) => void;
}

/**
 * Claude account commands and the Claude page's panel handler. The host is authoritative: every panel `dir` is
 * re-resolved with panel.resolve and every new name checked with validateName; frontend checks are only hints.
 * QuickPick items, messages and terminal names use the display name (labelFor); logic uses name / dir.
 *
 * - Switch: the panel asks a modal first unless planswap.claude.confirmSwitch is off (the Command Palette pick is the
 *   confirmation); a missing non-default folder is an error; a shared account is re-linked and mirrored first (problems
 *   only warn); then setConfigDir, the reload banner (plus a notification while the panel is hidden). A failed settings
 *   write is reported.
 * - Add: always answers addResult, also when the flow throws. Linking or copying failures only warn and the account is
 *   still registered. A shared add creates the folder, then asks askCopyFallback (Windows) before anything is linked.
 * - Share / unshare: named, non-current accounts only, after a modal; current-account and busy state are re-checked
 *   after the modal. Share asks askCopyFallback after those re-checks and checks registration, current and busy state
 *   again after its fallback modal. Add and share pass the answer plus the
 *   terminal-busy callback (linkBusy) to ensureClaudeLinks / migrateClaudeToShared; switching re-links with linkBusy only.
 * - Remove: the current account (any spelling, sameRealPath) and a busy one are refused before the first confirmation,
 *   after the Command Palette confirmation and again after the delete-directory confirmation. The alias is cleared with
 *   the account; the directory is deleted only through deleteAccountDir, after which it is no longer ignored.
 * - Rename: named rows only; always answers renameResult.
 * - recommendExclude: registered rows only (the external row is ignored); sets or clears the recommendation mark and
 *   refreshes the panel. The mark is cleared with the account (remove, or a pruned directory on sync).
 * - Terminals: on Linux a non-default folder with a control character is refused; closing a PlanSwap terminal refreshes
 *   the UI and warns when a still-registered named account is still signed out.
 * - planswap.refresh re-syncs both stores with the disk and refreshes the panel and status bar.
 */
export function registerCommands(deps: Deps): vscode.Disposable[] {
  const { store, panel, statusBar, labels, exclusions, codex, tools } = deps;
  const procRoot = deps.procRoot ?? '/proc';
  const MODE = 'claude';
  // Terminals created by this extension -> their account
  const terminals = new Map<vscode.Terminal, Account>();

  const refreshUi = (): void => {
    panel.refresh();
    statusBar.update();
  };
  const isCurrent = (a: Account): boolean => samePath(a.dir, currentDir());
  // Guards before removing or converting also treat another spelling of the current directory (8.3 name, '\?\',
  // a link or alias) as current
  const inUse = (a: Account): boolean => isCurrent(a) || sameRealPath(a.dir, currentDir());
  // Display name: the alias if set, otherwise the name
  const labelOf = (a: Account): string => labelFor(a.name, labels);
  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  // Windows cannot attribute a running Claude process to an account (see windowsSessionsBusy), so an open terminal of
  // the account also counts; on Linux the /proc check covers terminals
  const terminalOpen: TerminalCheck = (dir) => isWindows() && [...terminals.values()].some((x) => samePath(x.dir, dir));
  deps.provideTerminalCheck?.(terminalOpen);
  const busy = (a: Account): boolean => claudeAccountBusy(a.dir, procRoot) || terminalOpen(a.dir);
  // Passed to the linking steps, which OR it with their own process check
  const linkBusy = (a: Account): (() => boolean) => () => terminalOpen(a.dir);

  async function pickAccount(accounts: Account[], placeHolder: string): Promise<Account | undefined> {
    if (accounts.length === 0) {
      void vscode.window.showInformationMessage(t('common.noAccounts'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((account) => {
        const info = readAccountInfo(account.dir, isExplicitConfigDir(account.dir));
        return {
          label: labelOf(account),
          description: info.email ?? t(info.loggedIn ? 'common.loggedIn' : 'common.notLoggedIn'),
          detail: account.dir,
          account,
        };
      }),
      { placeHolder },
    );
    return picked?.account;
  }

  // Rename: only named rows (the default and external rows cannot be renamed); label equal to name clears the alias
  async function rename(dir: string, label: string): Promise<string | undefined> {
    const account = panel.resolve(MODE, dir);
    if (!account || account.kind !== 'named') return undefined;
    const existing = store.all().map((a) => ({ name: a.name, label: labelOf(a) }));
    const error = labels.validate(label, account.name, existing);
    if (error) return error;
    const value = label.trim();
    await labels.set(account.name, value === account.name ? undefined : value);
    refreshUi();
    return undefined;
  }

  async function switchTo(account: Account): Promise<boolean> {
    if (isCurrent(account)) return true;
    if (account.name !== DEFAULT_NAME && !fs.existsSync(account.dir)) {
      void vscode.window.showErrorMessage(t('account.dirMissing', { dir: account.dir }));
      return false;
    }
    // A shared account is re-linked and mirrored first; a problem only warns, the switch still happens
    if (account.name !== DEFAULT_NAME && isSharedClaudeAccount(account.dir)) {
      const warning = refreshShared(account);
      if (warning) void vscode.window.showWarningMessage(t('share.refreshWarning', { label: labelOf(account), notes: warning }));
    }
    try {
      await setConfigDir(account.name === DEFAULT_NAME ? undefined : account.dir);
    } catch (err) {
      void vscode.window.showErrorMessage(
        t('claude.switchFailed', { error: errText(err) }),
      );
      return false;
    }
    // The reload prompt is the banner at the top of the panel; fall back to a notification when the panel is hidden
    panel.setSwitchedTo(labelOf(account));
    statusBar.update();
    // Do not await the notification so the caller is not blocked by it
    if (!panel.visible) {
      void vscode.window
        .showInformationMessage(t('claude.switched', { label: labelOf(account) }), t('common.reloadWindow'))
        .then((choice) => (choice ? reloadWindow() : undefined));
    }
    return true;
  }

  async function reloadWindow(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  // Info file of the default account: the source of mirrored MCP servers and project settings
  const defaultJson = (): string => claudeJsonPath(defaultDir(), isExplicitConfigDir(defaultDir()));

  // shared: link everything but the login to the default account; otherwise copy its configuration once
  async function addAccount(name: string, shared: boolean): Promise<string | undefined> {
    const error = validateName(name, store, labels);
    if (error) return error;
    const account: Account = { name, dir: accountDir(name) };
    try {
      ensureAccountDir(account.dir);
    } catch (err) {
      return t('account.createDirFailed', { error: errText(err) });
    }
    // Windows without file-link privilege: ask before anything is linked or copied
    const linkOptions = shared ? await askCopyFallback(account.dir, 'Claude') : {};
    // Linking or copying failures only warn and do not block
    try {
      if (shared) {
        // The folder may already exist (kept from an earlier removal, its terminal possibly still open)
        const report = ensureClaudeLinks(account.dir, '/proc', { ...linkOptions, busy: linkBusy(account) });
        // An existing folder that could not be linked stays independent: it only gains the default MCP servers
        mirrorClaudeJsonInto(defaultJson(), account.dir);
        const notes = describeShareReport(report);
        if (notes) void vscode.window.showWarningMessage(t(isSharedClaudeAccount(account.dir) ? 'share.addNotes' : 'share.addNotLinked', { name, notes }));
      } else {
        copyClaudeIndependent(defaultJson(), account.dir);
      }
    } catch (err) {
      void vscode.window.showWarningMessage(t(shared ? 'share.addLinkFailed' : 'share.addCopyFailed', { name, error: errText(err) }));
    }
    await store.add(account);
    refreshUi();
    return undefined;
  }

  // Re-links a shared account and mirrors the default account's info file; returns a warning text or undefined
  function refreshShared(account: Account): string | undefined {
    try {
      const notes = describeShareReport(ensureClaudeLinks(account.dir, procRoot, { busy: linkBusy(account) }));
      mirrorClaudeJsonInto(defaultJson(), account.dir);
      return notes || undefined;
    } catch (err) {
      return errText(err);
    }
  }

  // Converts an independent account to a shared one after a modal confirmation
  async function shareAccount(account: Account): Promise<void> {
    if (account.name === DEFAULT_NAME || isSharedClaudeAccount(account.dir)) return;
    if (inUse(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('share.confirmButton');
    const picked = await vscode.window.showWarningMessage(t('share.confirm', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    // Re-checked after the modal: another window may have switched to the account meanwhile
    if (inUse(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    if (busy(account)) {
      void vscode.window.showWarningMessage(t('share.busy', { name: labelOf(account) }));
      return;
    }
    const linkOptions = await askCopyFallback(account.dir, 'Claude');
    // The Windows fallback can show another modal; every account guard must hold after it too.
    const registered = store.find(account.name);
    if (!registered || !samePath(registered.dir, account.dir)) {
      refreshUi();
      return;
    }
    if (inUse(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    if (busy(account)) {
      void vscode.window.showWarningMessage(t('share.busy', { name: labelOf(account) }));
      return;
    }
    try {
      const report = migrateClaudeToShared(account.dir, account.name, procRoot, labelOf(account), { ...linkOptions, busy: linkBusy(account) });
      mirrorClaudeJsonInto(defaultJson(), account.dir);
      void vscode.window.showInformationMessage(t(isSharedClaudeAccount(account.dir) ? 'share.done' : 'share.incomplete', { label: labelOf(account), summary: describeShareReport(report) || t('share.nothingElse') }));
    } catch (err) {
      void vscode.window.showErrorMessage(t('share.failed', { label: labelOf(account), error: errText(err) }));
    }
    refreshUi();
  }

  // Converts a shared account back to an independent one after a modal confirmation; history stays in the default dir
  async function unshareAccount(account: Account): Promise<void> {
    if (account.name === DEFAULT_NAME || !isSharedClaudeAccount(account.dir)) return;
    if (inUse(account)) {
      void vscode.window.showWarningMessage(t('unshare.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('unshare.confirmButton');
    const picked = await vscode.window.showWarningMessage(t('unshare.confirm', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    if (inUse(account)) {
      void vscode.window.showWarningMessage(t('unshare.current', { label: labelOf(account) }));
      return;
    }
    if (busy(account)) {
      void vscode.window.showWarningMessage(t('share.busy', { name: labelOf(account) }));
      return;
    }
    try {
      const r = makeClaudeIndependent(defaultJson(), account.dir);
      void vscode.window.showInformationMessage(
        t('unshare.done', { label: labelOf(account), removed: r.removed.length, copied: r.copied.join(', ') || t('unshare.nothingCopied') }),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(t('unshare.failed', { label: labelOf(account), error: errText(err) }));
    }
    refreshUi();
  }

  // confirmed: the panel already did an inline confirmation; Command Palette entries need a modal confirmation
  async function removeAccount(account: Account, confirmed: boolean): Promise<void> {
    if (account.name === DEFAULT_NAME || !store.find(account.name)) return;
    // Capture the display name before its alias is cleared, so the prompts below still show it
    const label = labelOf(account);
    // Re-checked after every modal: another window may have switched to the account, or a terminal was opened meanwhile
    const blocked = (): boolean => {
      // The current account cannot be deleted; switch to another account first
      if (inUse(account)) {
        void vscode.window.showWarningMessage(t('claude.removeCurrent', { label }));
        return true;
      }
      // A running Claude process of this account would keep writing into the directory offered for deletion
      if (busy(account)) {
        void vscode.window.showWarningMessage(t('share.busy', { name: label }));
        return true;
      }
      return false;
    };
    if (blocked()) return;
    if (!confirmed) {
      const deleteLabel = t('common.delete');
      const ok = await vscode.window.showWarningMessage(t('claude.removeConfirm', { label }), { modal: true }, deleteLabel);
      if (ok !== deleteLabel || blocked()) return;
    }

    const shared = isSharedClaudeAccount(account.dir);
    await store.remove(account.name);
    await labels.remove(account.name);
    await exclusions?.remove(account.name);
    refreshUi();

    const detail = t(shared ? 'claude.removeDirDetailShared' : 'claude.removeDirDetail');
    const deleteDirLabel = t('common.deleteDir');
    const delDir = await vscode.window.showWarningMessage(
      t('account.removeDirPrompt', { label, dir: account.dir }),
      { modal: true, detail },
      deleteDirLabel,
    );
    if (delDir !== deleteDirLabel || blocked()) return;
    try {
      await deleteAccountDir(account.dir);
      // The directory is gone; stop ignoring it so a recreated directory is auto-discovered again
      await store.unignore(account.dir);
    } catch (err) {
      void vscode.window.showErrorMessage(t('account.deleteDirFailed', { error: errText(err) }));
    }
  }

  function openTerminal(account: Account): void {
    const isDefault = account.name === DEFAULT_NAME;
    // Linux types the folder into the shell; a control character (a newline) would end the command line early
    if (!isDefault && !isWindows() && hasControlChars(account.dir)) {
      void vscode.window.showErrorMessage(t('terminal.badDir', { dir: JSON.stringify(account.dir) }));
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `Claude (${labelOf(account)})`,
      shellPath: accountTerminalShell(),
      env: isDefault ? undefined : { CLAUDE_CONFIG_DIR: account.dir },
    });
    terminals.set(terminal, account);
    // The terminal environment carries CLAUDE_CONFIG_DIR; Windows shells have no `env` command
    terminal.sendText(isDefault || isWindows() ? 'claude' : `env CLAUDE_CONFIG_DIR=${shQuote(account.dir)} claude`);
    terminal.show();
    if (!readAccountInfo(account.dir, isExplicitConfigDir(account.dir)).loggedIn) {
      void vscode.window.showInformationMessage(t('account.loginTip', { vendor: 'Claude' }));
    }
  }

  // Panel messages
  panel.setHandler(MODE, async (msg: FromWebview) => {
    switch (msg.type) {
      case 'switch': {
        const a = panel.resolve(MODE, msg.dir);
        if (!a || isCurrent(a)) return;
        // Panel entries (switch button, double-click, Enter) confirm first unless planswap.claude.confirmSwitch is off;
        // the Command Palette pick is already explicit
        if (vscode.workspace.getConfiguration('planswap').get<boolean>(CONFIRM_SWITCH_SETTING, true) !== false) {
          const switchLabel = t('claude.switchButton');
          const ok = await vscode.window.showInformationMessage(t('claude.switchConfirm', { label: labelOf(a) }), { modal: true }, switchLabel);
          if (ok !== switchLabel) return;
        }
        await switchTo(a);
        return;
      }
      case 'terminal': {
        const a = panel.resolve(MODE, msg.dir);
        if (a) openTerminal(a);
        return;
      }
      case 'remove': {
        const a = panel.resolve(MODE, msg.dir);
        if (a?.kind === 'named') await removeAccount(a, true);
        return;
      }
      case 'add': {
        // Any failure still answers, so the panel never keeps waiting for the result
        let error: string | undefined;
        try {
          error = await addAccount(msg.name.trim(), msg.shared !== false);
        } catch (err) {
          error = errText(err);
        }
        panel.post({ type: 'addResult', mode: MODE, error });
        return;
      }
      case 'share': {
        const a = panel.resolve(MODE, msg.dir);
        if (a?.kind === 'named') await shareAccount(a);
        return;
      }
      case 'unshare': {
        const a = panel.resolve(MODE, msg.dir);
        if (a?.kind === 'named') await unshareAccount(a);
        return;
      }
      case 'rename': {
        let error: string | undefined;
        try {
          error = await rename(msg.dir, msg.label);
        } catch (err) {
          error = errText(err);
        }
        panel.post({ type: 'renameResult', mode: MODE, dir: msg.dir, error });
        return;
      }
      case 'recommendExclude': {
        const a = panel.resolve(MODE, msg.dir);
        if (!a || a.kind === 'external') return;
        await exclusions?.set(a.name, msg.excluded !== false);
        panel.refresh();
        return;
      }
      case 'reload':
        await reloadWindow();
        return;
      case 'dismissBanner':
        panel.setSwitchedTo(undefined);
        return;
      case 'tool':
        await runTool(MODE, msg.tool, tools);
        return;
    }
  });

  // Command Palette entries. The current row is matched like the panel does (findSameDir), so another spelling of the
  // current directory neither adds an external entry nor offers a switch to the current account
  const currentIndex = (all: Account[]): number => findSameDir(all.map((a) => a.dir), currentDir());
  const allWithExternal = (): Account[] => {
    const all = store.all();
    return currentIndex(all) >= 0 ? all : [...all, { name: EXTERNAL_NAME, dir: currentDir() }];
  };

  return [
    vscode.commands.registerCommand('planswap.switchAccount', async () => {
      const all = store.all();
      const cur = currentIndex(all);
      const a = await pickAccount(all.filter((_, i) => i !== cur), t('claude.pick.switch'));
      if (a) await switchTo(a);
    }),
    vscode.commands.registerCommand('planswap.addAccount', () => panel.focusAdd(MODE)),
    vscode.commands.registerCommand('planswap.shareAccount', async () => {
      const a = await pickAccount(store.named().filter((x) => !isSharedClaudeAccount(x.dir) && !inUse(x)), t('claude.pick.share'));
      if (a) await shareAccount(a);
    }),
    vscode.commands.registerCommand('planswap.removeAccount', async () => {
      const a = await pickAccount(store.named().filter((x) => !inUse(x)), t('claude.pick.remove'));
      if (a) await removeAccount(a, false);
    }),
    vscode.commands.registerCommand('planswap.openTerminal', async () => {
      const a = await pickAccount(allWithExternal(), t('claude.pick.terminal'));
      if (a) openTerminal(a);
    }),
    vscode.commands.registerCommand('planswap.refresh', async () => {
      await store.syncWithDisk(labels, exclusions);
      if (codex) await codex.store.syncWithDisk(codex.labels, codex.exclusions);
      refreshUi();
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const account = terminals.get(terminal);
      if (!account) return;
      terminals.delete(terminal);
      refreshUi();
      // Same sign-in state as the panel rows; never for the default or external-directory row, nor for an account
      // removed (or whose folder was deleted) while its terminal was open
      if (
        account.name !== DEFAULT_NAME &&
        account.name !== EXTERNAL_NAME &&
        store.find(account.name) &&
        fs.existsSync(account.dir) &&
        !readAccountInfo(account.dir, isExplicitConfigDir(account.dir)).loggedIn
      ) {
        void vscode.window.showWarningMessage(
          t(isWindows() ? 'claude.win.loginNotLanded' : 'claude.loginNotLanded', { dir: account.dir }),
        );
      }
    }),
  ];
}

/**
 * Name check for a new Claude account; only Claude accounts are compared, case-insensitively (sameName). Refuses an
 * empty name, one not matching NAME_RE, the reserved `default`, the name or display name of any registered account,
 * a folder that is (sameRealPath) or contains the default directory, a Windows folder differing only in case, and an
 * existing folder that is a symbolic link. Returns the localized reason, or undefined when valid.
 */
export function validateName(name: string, store: AccountStore, labels: LabelStore): string | undefined {
  if (!name) return t('name.empty');
  if (!NAME_RE.test(name)) return t('name.invalid');
  if (sameName(name, DEFAULT_NAME)) return t('name.reserved', { name: DEFAULT_NAME });
  if (store.all().some((a) => sameName(a.name, name))) return t('name.exists');
  if (store.all().some((a) => sameName(labelFor(a.name, labels), name))) return t('name.dupLabel');
  const dir = accountDir(name);
  const def = defaultDir();
  if (sameRealPath(dir, def)) return t('name.sameAsDefaultDir');
  if (realPathInside(dir, def)) return t('account.containsDefaultDir', { dir, default: def });
  // Windows: a kept folder that differs only in case is the same folder (its old sign-in would be reused)
  const variant = caseVariantOf(accountDir(name));
  if (variant) return t('name.dirCaseDiffers', { dir: variant });
  // scanAccountDirs skips symlinks, so a linked directory must not be registered by adding its name either
  if (lstatOrUndefined(accountDir(name))?.isSymbolicLink()) return t('name.dirIsSymlink');
  return undefined;
}

// Wrap in single quotes; inner ' becomes '\''
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Whether a path holds a control character, which must never be typed into a terminal (a newline runs the line). */
export function hasControlChars(s: string): boolean {
  return /[\x00-\x1f\x7f]/.test(s);
}
