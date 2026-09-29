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
  readAccountInfo,
  samePath,
  sameRealPath,
} from './paths';
import {
  claudeAccountBusy,
  copyClaudeIndependent,
  ensureClaudeLinks,
  isSharedClaudeAccount,
  lstatOrUndefined,
  makeClaudeIndependent,
  migrateClaudeToShared,
  mirrorClaudeJson,
} from './claudeShare';
import { describeShareReport } from './shareReport';
import { currentDir, isExplicitConfigDir, setConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import type { AccountsPanel } from './accountsPanel';
import type { StatusBar } from './statusBar';
import { labelFor, sameName, type LabelStore, EXTERNAL_NAME } from './labels';
import type { FromWebview } from './protocol';
import type { CodexAccountStore } from './codex/codexStore';
import { runTool, type ToolDeps } from './tools';
import { t } from './i18n';
import { isWindows } from './platform';

export interface Deps {
  store: AccountStore;
  panel: AccountsPanel;
  statusBar: StatusBar;
  labels: LabelStore;
  // Codex-side store; the refresh command applies to both tabs
  codex?: { store: CodexAccountStore; labels: LabelStore };
  tools: ToolDeps;
  // Root of the process tree for the busy checks; tests pass a fake, product code leaves the default /proc
  procRoot?: string;
}

export function registerCommands(deps: Deps): vscode.Disposable[] {
  const { store, panel, statusBar, labels, codex, tools } = deps;
  const procRoot = deps.procRoot ?? '/proc';
  const MODE = 'claude';
  // Terminals created by this extension -> their account
  const terminals = new Map<vscode.Terminal, Account>();

  const refreshUi = (): void => {
    panel.refresh();
    statusBar.update();
  };
  const isCurrent = (a: Account): boolean => samePath(a.dir, currentDir());
  // Display name: the alias if set, otherwise the name
  const labelOf = (a: Account): string => labelFor(a.name, labels);
  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  async function pickAccount(accounts: Account[], placeHolder: string): Promise<Account | undefined> {
    if (accounts.length === 0) {
      void vscode.window.showInformationMessage(t('common.noAccounts'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((account) => ({
        label: labelOf(account),
        description: readAccountInfo(account.dir, isExplicitConfigDir(account.dir)).email ?? t('common.notLoggedIn'),
        detail: account.dir,
        account,
      })),
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
    // Linking or copying failures only warn and do not block
    try {
      if (shared) {
        const report = ensureClaudeLinks(account.dir);
        mirrorClaudeJson(defaultJson(), account.dir);
        const notes = describeShareReport(report);
        if (notes) void vscode.window.showWarningMessage(t('share.addNotes', { name, notes }));
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
      const notes = describeShareReport(ensureClaudeLinks(account.dir, procRoot));
      mirrorClaudeJson(defaultJson(), account.dir);
      return notes || undefined;
    } catch (err) {
      return errText(err);
    }
  }

  // Converts an independent account to a shared one after a modal confirmation
  async function shareAccount(account: Account): Promise<void> {
    if (account.name === DEFAULT_NAME || isSharedClaudeAccount(account.dir)) return;
    if (isCurrent(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('share.confirmButton');
    const picked = await vscode.window.showWarningMessage(t('share.confirm', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    if (claudeAccountBusy(account.dir, procRoot)) {
      void vscode.window.showWarningMessage(t('share.busy', { name: labelOf(account) }));
      return;
    }
    try {
      const report = migrateClaudeToShared(account.dir, account.name, procRoot, labelOf(account));
      mirrorClaudeJson(defaultJson(), account.dir);
      void vscode.window.showInformationMessage(t('share.done', { label: labelOf(account), summary: describeShareReport(report) || t('share.nothingElse') }));
    } catch (err) {
      void vscode.window.showErrorMessage(t('share.failed', { label: labelOf(account), error: errText(err) }));
    }
    refreshUi();
  }

  // Converts a shared account back to an independent one after a modal confirmation; history stays in the default dir
  async function unshareAccount(account: Account): Promise<void> {
    if (account.name === DEFAULT_NAME || !isSharedClaudeAccount(account.dir)) return;
    if (isCurrent(account)) {
      void vscode.window.showWarningMessage(t('unshare.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('unshare.confirmButton');
    const picked = await vscode.window.showWarningMessage(t('unshare.confirm', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    if (claudeAccountBusy(account.dir, procRoot)) {
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
    // The current account cannot be deleted; switch to another account first
    if (isCurrent(account)) {
      void vscode.window.showWarningMessage(t('claude.removeCurrent', { label: labelOf(account) }));
      return;
    }
    // A running Claude process of this account would keep writing into the directory offered for deletion
    if (claudeAccountBusy(account.dir, procRoot)) {
      void vscode.window.showWarningMessage(t('share.busy', { name: labelOf(account) }));
      return;
    }
    if (!confirmed) {
      const deleteLabel = t('common.delete');
      const ok = await vscode.window.showWarningMessage(t('claude.removeConfirm', { label: labelOf(account) }), { modal: true }, deleteLabel);
      if (ok !== deleteLabel) return;
    }

    // Capture the display name before its alias is cleared, so the prompt below still shows it
    const label = labelOf(account);
    const shared = isSharedClaudeAccount(account.dir);
    await store.remove(account.name);
    await labels.remove(account.name);
    refreshUi();

    const detail = t(shared ? 'claude.removeDirDetailShared' : 'claude.removeDirDetail');
    const deleteDirLabel = t('common.deleteDir');
    const delDir = await vscode.window.showWarningMessage(
      t('account.removeDirPrompt', { label, dir: account.dir }),
      { modal: true, detail },
      deleteDirLabel,
    );
    if (delDir !== deleteDirLabel) return;
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
    const terminal = vscode.window.createTerminal({
      name: `Claude (${labelOf(account)})`,
      env: isDefault ? undefined : { CLAUDE_CONFIG_DIR: account.dir },
    });
    terminals.set(terminal, account);
    // The terminal environment carries CLAUDE_CONFIG_DIR; Windows shells have no `env` command
    terminal.sendText(isDefault || isWindows() ? 'claude' : `env CLAUDE_CONFIG_DIR=${shQuote(account.dir)} claude`);
    terminal.show();
  }

  // Panel messages
  panel.setHandler(MODE, async (msg: FromWebview) => {
    switch (msg.type) {
      case 'switch': {
        const a = panel.resolve(MODE, msg.dir);
        if (!a || isCurrent(a)) return;
        // Panel entries (switch button, double-click, Enter) confirm first; the Command Palette pick is already explicit
        const switchLabel = t('claude.switchButton');
        const ok = await vscode.window.showInformationMessage(t('claude.switchConfirm', { label: labelOf(a) }), { modal: true }, switchLabel);
        if (ok === switchLabel) await switchTo(a);
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
      case 'add':
        panel.post({ type: 'addResult', mode: MODE, error: await addAccount(msg.name.trim(), msg.shared !== false) });
        return;
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
      case 'rename':
        panel.post({ type: 'renameResult', mode: MODE, dir: msg.dir, error: await rename(msg.dir, msg.label) });
        return;
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

  // Command Palette entries
  const allWithExternal = (): Account[] =>
    store.findByDir(currentDir()) ? store.all() : [...store.all(), { name: EXTERNAL_NAME, dir: currentDir() }];

  return [
    vscode.commands.registerCommand('planswap.switchAccount', async () => {
      const a = await pickAccount(store.all().filter((x) => !isCurrent(x)), t('claude.pick.switch'));
      if (a) await switchTo(a);
    }),
    vscode.commands.registerCommand('planswap.addAccount', () => panel.focusAdd(MODE)),
    vscode.commands.registerCommand('planswap.removeAccount', async () => {
      const a = await pickAccount(store.named().filter((x) => !isCurrent(x)), t('claude.pick.remove'));
      if (a) await removeAccount(a, false);
    }),
    vscode.commands.registerCommand('planswap.openTerminal', async () => {
      const a = await pickAccount(allWithExternal(), t('claude.pick.terminal'));
      if (a) openTerminal(a);
    }),
    vscode.commands.registerCommand('planswap.refresh', async () => {
      await store.syncWithDisk(labels);
      if (codex) await codex.store.syncWithDisk(codex.labels);
      refreshUi();
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      const account = terminals.get(terminal);
      if (!account) return;
      terminals.delete(terminal);
      refreshUi();
      // Same sign-in state as the panel rows; never for the default or external-directory row
      if (
        account.name !== DEFAULT_NAME &&
        account.name !== EXTERNAL_NAME &&
        !readAccountInfo(account.dir, isExplicitConfigDir(account.dir)).loggedIn
      ) {
        void vscode.window.showWarningMessage(
          t('claude.loginNotLanded', { dir: account.dir }),
        );
      }
    }),
  ];
}

// Name check for a new Claude account; only Claude accounts are compared, case-insensitively
export function validateName(name: string, store: AccountStore, labels: LabelStore): string | undefined {
  if (!name) return t('name.empty');
  if (!NAME_RE.test(name)) return t('name.invalid');
  if (sameName(name, DEFAULT_NAME)) return t('name.reserved', { name: DEFAULT_NAME });
  if (store.all().some((a) => sameName(a.name, name))) return t('name.exists');
  if (store.all().some((a) => sameName(labelFor(a.name, labels), name))) return t('name.dupLabel');
  if (sameRealPath(accountDir(name), defaultDir())) return t('name.sameAsDefaultDir');
  // scanAccountDirs skips symlinks, so a linked directory must not be registered by adding its name either
  if (lstatOrUndefined(accountDir(name))?.isSymbolicLink()) return t('name.dirIsSymlink');
  return undefined;
}

// Wrap in single quotes; inner ' becomes '\''
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
