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
  configDirFromEnv,
} from './paths';
import {
  claudeAccountBusy,
  copyClaudeIndependent,
  ensureClaudeLinks,
  isSharedClaudeAccount,
  lstatOrUndefined,
  makeClaudeIndependent,
  migrateClaudeToShared,
  syncClaudeAccount,
} from './claudeShare';
import { describeShareReport } from './shareReport';
import { currentDir, isExplicitConfigDir, setConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import { claudeCardLabel, claudeProviderErrorText, type AccountsPanel } from './accountsPanel';
import {
  CLAUDE_API_SERVICES, CLAUDE_SERVICE_INFO, ProviderConfigError, claudeModelsUrl, createClaudeProviderConfig, editClaudeProviderConfig,
  hasClaudeProviderMarker, readClaudeProviderEditState, readClaudeProviderInfo, readClaudeProviderKey, validateClaudeProviderConfig,
  type ClaudeApiService,
} from './claudeProvider';
import type { ClaudeModelCache } from './claudeModelCache';
import { checkBaseUrl } from './codex/codexProvider';
import { fetchModels, ModelListError } from './codex/providerModels';
import type { StatusBar } from './statusBar';
import { labelFor, sameName, type LabelStore, EXTERNAL_NAME } from './labels';
import type { RecommendExclusions } from './recommend';
import type { ApiCardInput, FromWebview } from './protocol';
import type { CodexAccountStore } from './codex/codexStore';
import { syncClaudeInto, runTool, type TerminalCheck, type ToolDeps } from './tools';
import { joinSentences, t } from './i18n';
import { isWindows, lacksProcfs, errText } from './platform';
import { askCopyFallback } from './linkPolicy';
import { parseAccountUri } from './accountUri';
import { accountTerminalShell, bundledPathAssignment, hasControlChars, shQuote, windowsAccountEnv, windowsTerminalEnvSetting } from './terminalShell';

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
  checkSubscription?: (dir: string) => Promise<void>;
  // Codex-side store; the refresh command applies to both tabs
  codex?: { store: CodexAccountStore; labels: LabelStore; exclusions?: RecommendExclusions };
  // Panel 'tool' messages of the Claude page go to runTool('claude', tool, tools)
  tools: ToolDeps;
  // Root of the process tree for the busy checks; tests pass a fake, product code leaves the default /proc
  procRoot?: string;
  // The Claude extension's bundled CLI (findBundledClaude), the account terminals' fallback when `claude` is not on PATH
  bundledClaude?: () => string | undefined;
  // Receives this module's "account terminal open" check, so the toolbar's Re-link can treat such an account as busy
  provideTerminalCheck?: (check: TerminalCheck) => void;
  // Model lists of the Claude API card services (claude.modelCache); a list a form loads for a preset is stored there
  modelCache?: ClaudeModelCache;
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
 * - URI: validates the request and receiving host, resolves a registered name (case-insensitive, never an alias),
 *   and checks that its directory exists before switchTo, including the default/current account. No switch modal;
 *   reload=1 reloads only after switchTo succeeds. The URI registration is disposed with the commands.
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
 * - reorder: the rows that resolve to registered accounts, in the order sent, become the stored order (store.setOrder);
 *   the external row and unknown directories are skipped; then the panel is refreshed.
 * - Terminals: on Linux a folder with a control character is refused; the bundled CLI's folder is appended
 *   to the terminal's PATH (windowsAccountEnv / linuxClaudeCommand), so `claude` still starts without an installed CLI; closing a PlanSwap terminal refreshes
 *   the UI and warns when a still-registered named account is still signed out.
 * - planswap.refresh re-syncs both stores with the disk and refreshes the panel and status bar.
 * - API cards (hasClaudeProviderMarker): the add form sends the service, endpoint, key and model; the host checks them
 *   (a missing required key or an unusable endpoint is refused before any directory exists), creates a NEW folder,
 *   createClaudeProviderConfig, then links (keeping the two provider files) or copies like any account and registers
 *   it without switching; a failure after the folder was made deletes it through deleteAccountDir. providerModels
 *   answers DeepSeek's fixed list or fetchModels of claudeModelsUrl (the typed key, else the saved key of the card
 *   being edited, only for its own service and endpoint; a preset's list at its preset endpoint is cached).
 *   saveProvider edits a marked named row with a fresh revision. Switching (panel, Command Palette, URI) and
 *   share/unshare refuse a card failing validateClaudeProviderConfig; switching to a card is the ordinary
 *   CLAUDE_CONFIG_DIR write (Claude Code applies the card's settings.json env). Cards get no subscription check,
 *   sign-in tip, "still signed out" warning or recommendation mark; their terminal starts claude with
 *   CLAUDE_CONFIG_DIR as usual.
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
  // Windows and macOS cannot attribute a running Claude process to an account (see windowsSessionsBusy), so an open
  // terminal of the account also counts; on Linux the /proc check covers terminals
  const terminalOpen: TerminalCheck = (dir) => lacksProcfs() && [...terminals.values()].some((x) => samePath(x.dir, dir));
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
        const card = account.name === DEFAULT_NAME ? undefined : readClaudeProviderInfo(account.dir);
        const info = card ? undefined : readAccountInfo(account.dir, isExplicitConfigDir(account.dir));
        return {
          label: labelOf(account),
          description: card ? claudeCardLabel(card.provider) : info!.email ?? t(info!.loggedIn ? 'common.loggedIn' : 'common.notLoggedIn'),
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
    if (!providerReady(account)) return false;
    // A shared current account syncs with the default account first (as the account in use), so the incoming account
    // gets what it changed. A failure cancels the switch, so nothing is left half synced behind the user's back
    const outgoing = currentDir();
    try {
      if (isSharedClaudeAccount(outgoing)) syncClaudeAccount(defaultJson(), outgoing, 'full', { inUse: true });
    } catch (err) {
      const all = store.all();
      const i = findSameDir(all.map((a) => a.dir), outgoing);
      const label = i >= 0 ? labelOf(all[i]) : labelFor(EXTERNAL_NAME, labels);
      void vscode.window.showErrorMessage(t('share.writeBackFailed', { label, error: errText(err) }));
      return false;
    }
    // A shared account is re-linked and synced first. A linking problem only warns and the switch still happens; a
    // failed sync cancels it, since the account would otherwise start without what the default account gained
    if (account.name !== DEFAULT_NAME && isSharedClaudeAccount(account.dir)) {
      const warning = relinkShared(account);
      if (warning) void vscode.window.showWarningMessage(t('share.refreshWarning', { label: labelOf(account), notes: warning }));
      try {
        syncClaudeInto(defaultJson(), account.dir);
      } catch (err) {
        void vscode.window.showErrorMessage(t('share.mirrorFailed', { label: labelOf(account), error: errText(err) }));
        return false;
      }
    }
    // The re-link above may have run into the card's files: checked again right before the switch
    if (!providerReady(account)) return false;
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

  // A named account that is a Claude API card (the default account never is one)
  const isCard = (account: Account): boolean => account.name !== DEFAULT_NAME && hasClaudeProviderMarker(account.dir);

  // A card must pass local validation before it is switched to or converted; shows why not
  function providerReady(account: Account): boolean {
    if (!isCard(account)) return true;
    try {
      validateClaudeProviderConfig(account.dir);
      return true;
    } catch (err) {
      const reason = claudeProviderErrorText(err instanceof ProviderConfigError ? err.code : 'file');
      void vscode.window.showErrorMessage(t('codex.provider.unavailable', { reason }));
      return false;
    }
  }

  const isService = (value: string): value is ClaudeApiService => (CLAUDE_API_SERVICES as readonly string[]).includes(value);
  const badText = (value: string): boolean => /\s|[\x00-\x1f\x7f]/u.test(value);

  // The model list for a form: DeepSeek's fixed list, otherwise GET <claudeModelsUrl>/models with the key typed in the
  // form, or the saved key of the card being edited (dir) when none was typed. Errors name only the status or the cause
  async function listProviderModels(msg: { service: string; baseUrl?: string; key: string; dir?: string }): Promise<{ models?: string[]; error?: string }> {
    if (!isService(msg.service)) return { error: claudeProviderErrorText('format') };
    const info = CLAUDE_SERVICE_INFO[msg.service];
    if (info.models) return { models: [...info.models] };
    let baseUrl: string;
    let key = msg.key.trim();
    try {
      baseUrl = checkBaseUrl(msg.baseUrl?.trim() || info.baseUrl);
      if (!key && msg.dir) {
        // A saved key goes only to its own card's service and endpoint; another one needs the key typed again
        const card = panel.resolve(MODE, msg.dir);
        if (card?.kind === 'named' && hasClaudeProviderMarker(card.dir)) {
          const saved = readClaudeProviderEditState(card.dir);
          if (saved.service !== msg.service || saved.baseUrl !== baseUrl) return { error: t('codex.provider.newEndpointNeedsKey') };
          key = readClaudeProviderKey(card.dir);
        }
      }
    } catch (err) {
      return { error: claudeProviderErrorText(err instanceof ProviderConfigError ? err.code : 'file') };
    }
    if (badText(key)) return { error: claudeProviderErrorText('key') };
    try {
      const models = await fetchModels(claudeModelsUrl(msg.service, baseUrl), key, undefined, { anthropic: true });
      // A preset's list at its own endpoint is the service's list: keep it for the next form
      if (msg.service !== 'custom' && baseUrl === info.baseUrl) {
        void deps.modelCache?.set(msg.service, models).then(() => panel.refresh()).catch(() => undefined);
      }
      return { models };
    } catch (err) {
      const e = err instanceof ModelListError ? err : new ModelListError('network');
      return { error: e.code === 'http' ? t('codex.provider.modelsHttp', { status: e.status ?? 0 }) : t(e.code === 'format' ? 'codex.provider.modelsFormat' : 'codex.provider.modelsNetwork') };
    }
  }

  // The edit form's values; key '' keeps the saved key, an empty endpoint keeps the saved one. Errors carry no config text
  async function saveProvider(account: Account, msg: { model: string; baseUrl?: string; key: string }): Promise<string | undefined> {
    try {
      const before = readClaudeProviderEditState(account.dir);
      const registered = store.find(account.name);
      if (!registered || !samePath(registered.dir, account.dir)) return claudeProviderErrorText('changed');
      const baseUrl = msg.baseUrl?.trim() || undefined;
      // Moving the saved key to another endpoint needs it typed again, as for the model list
      if (!msg.key.trim() && before.hasKey && baseUrl !== undefined && baseUrl !== before.baseUrl) return t('codex.provider.newEndpointNeedsKey');
      editClaudeProviderConfig(account.dir, { model: msg.model.trim(), key: msg.key.trim(), baseUrl }, before.revision);
      return undefined;
    } catch (err) {
      return joinSentences(t('codex.provider.editFailed'), claudeProviderErrorText(err instanceof ProviderConfigError ? err.code : 'write'));
    } finally {
      refreshUi();
    }
  }

  // An API card: the form's fields are checked before anything is created, and the card always gets a NEW folder (an
  // existing one is never adopted). A failure after the folder was made deletes it again (deleteAccountDir only)
  async function addProviderAccount(name: string, shared: boolean, input: ApiCardInput): Promise<string | undefined> {
    const account: Account = { name, dir: accountDir(name) };
    if (!isService(input.service)) return claudeProviderErrorText('format');
    const service = input.service;
    const model = input.model.trim();
    const key = input.key.trim();
    const baseUrl = input.baseUrl?.trim() || undefined;
    if (!model || badText(model)) return claudeProviderErrorText('model');
    if (CLAUDE_SERVICE_INFO[service].keyRequired && !key) return t('codex.provider.keyRequired');
    if (badText(key)) return claudeProviderErrorText('key');
    if (service === 'custom' || baseUrl !== undefined) {
      try { checkBaseUrl(baseUrl ?? CLAUDE_SERVICE_INFO[service].baseUrl); } catch { return claudeProviderErrorText('url'); }
    }
    const error = validateName(name, store, labels);
    if (error) return error;
    if (lstatOrUndefined(account.dir)) return t('codex.provider.dirExists', { dir: account.dir });
    let created = false;
    try {
      fs.mkdirSync(account.dir, { mode: 0o700 });
      created = true;
      createClaudeProviderConfig(account.dir, service, { model, key, baseUrl });
      if (shared) {
        const options = await askCopyFallback(account.dir, 'Claude');
        validateClaudeProviderConfig(account.dir);
        const report = ensureClaudeLinks(account.dir, procRoot, { ...options, busy: linkBusy(account) });
        if (!isSharedClaudeAccount(account.dir)) throw new Error('not linked');
        syncClaudeInto(defaultJson(), account.dir);
        const notes = describeShareReport(report);
        if (notes) void vscode.window.showWarningMessage(t('share.addNotes', { name, notes }));
      } else {
        copyClaudeIndependent(defaultJson(), account.dir);
      }
      validateClaudeProviderConfig(account.dir);
      await store.add(account);
    } catch (err) {
      if (created) {
        try { await deleteAccountDir(account.dir); } catch { /* left for the user; the message names the folder */ }
      }
      // Never an arbitrary exception text: the form's fields must not come back to the Webview
      const reason = err instanceof ProviderConfigError ? claudeProviderErrorText(err.code) : t('codex.provider.error.write');
      return joinSentences(t('codex.provider.createFailed', { dir: account.dir }), reason);
    }
    refreshUi();
    return undefined;
  }

  // shared: link everything but the login to the default account; otherwise copy its configuration once
  async function addAccount(name: string, shared: boolean, provider?: ApiCardInput): Promise<string | undefined> {
    const error = validateName(name, store, labels);
    if (error) return error;
    if (provider) return addProviderAccount(name, shared, provider);
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
        // An existing folder that could not be linked stays independent: it only gains the default MCP servers. A
        // shared one syncs both ways, so what it changed on its own (e.g. as the current external account, which is
        // the account in use) is kept
        syncClaudeInto(defaultJson(), account.dir, sameRealPath(account.dir, currentDir()));
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

  // Re-links a shared account; returns a warning text or undefined
  function relinkShared(account: Account): string | undefined {
    try {
      const notes = describeShareReport(ensureClaudeLinks(account.dir, procRoot, { busy: linkBusy(account) }));
      return notes || undefined;
    } catch (err) {
      return errText(err);
    }
  }

  // Converts an independent account to a shared one after a modal confirmation
  async function shareAccount(account: Account): Promise<void> {
    if (account.name === DEFAULT_NAME || isSharedClaudeAccount(account.dir)) return;
    if (!providerReady(account)) return;
    if (inUse(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('share.confirmButton');
    const picked = await vscode.window.showWarningMessage(t(isCard(account) ? 'claude.provider.shareConfirm' : 'share.confirm', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
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
      if (!providerReady(account)) return;
      const report = migrateClaudeToShared(account.dir, account.name, procRoot, labelOf(account), { ...linkOptions, busy: linkBusy(account) });
      syncClaudeInto(defaultJson(), account.dir);
      void vscode.window.showInformationMessage(t(isSharedClaudeAccount(account.dir) ? 'share.done' : 'share.incomplete', { label: labelOf(account), summary: describeShareReport(report) || t('share.nothingElse') }));
    } catch (err) {
      void vscode.window.showErrorMessage(t('share.failed', { label: labelOf(account), error: errText(err) }));
    }
    refreshUi();
  }

  // Converts a shared account back to an independent one after a modal confirmation; history stays in the default dir
  async function unshareAccount(account: Account): Promise<void> {
    if (account.name === DEFAULT_NAME || !isSharedClaudeAccount(account.dir)) return;
    if (!providerReady(account)) return;
    if (inUse(account)) {
      void vscode.window.showWarningMessage(t('unshare.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('unshare.confirmButton');
    const picked = await vscode.window.showWarningMessage(t(isCard(account) ? 'claude.provider.unshareConfirm' : 'unshare.confirm', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
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
      if (!providerReady(account)) return;
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
    const dir = isDefault ? undefined : account.dir;
    // Linux: the default account gets the host's CLAUDE_CONFIG_DIR (or none), so an rc export cannot redirect its sign-in
    const linuxDir = isDefault ? configDirFromEnv() : account.dir;
    // Linux types the folder into the shell; a control character (a newline) would end the command line early
    if (!isWindows() && linuxDir !== undefined && hasControlChars(linuxDir)) {
      void vscode.window.showErrorMessage(t('terminal.badDir', { dir: JSON.stringify(linuxDir) }));
      return;
    }
    const bundled = deps.bundledClaude?.();
    const terminal = vscode.window.createTerminal({
      name: `Claude (${labelOf(account)})`,
      shellPath: accountTerminalShell(),
      env: isWindows()
        ? windowsAccountEnv(dir === undefined ? {} : { CLAUDE_CONFIG_DIR: dir }, bundled, windowsTerminalEnvSetting())
        : dir === undefined ? undefined : { CLAUDE_CONFIG_DIR: dir },
    });
    terminals.set(terminal, account);
    // Windows shells have no `env` command: the terminal environment carries CLAUDE_CONFIG_DIR and PATH there
    terminal.sendText(isWindows() ? 'claude' : linuxClaudeCommand(linuxDir, bundled));
    terminal.show();
    // An API card has no sign-in: its Claude Code uses the card's settings.json
    if (!isCard(account) && !readAccountInfo(account.dir, isExplicitConfigDir(account.dir)).loggedIn) {
      void vscode.window.showInformationMessage(t('account.loginTip', { vendor: 'Claude' }));
    }
  }

  // Panel messages
  panel.setHandler(MODE, async (msg: FromWebview) => {
    switch (msg.type) {
      case 'switch': {
        const a = panel.resolve(MODE, msg.dir);
        if (!a || isCurrent(a) || !providerReady(a)) return;
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
      case 'subscriptionCheck': {
        const a = panel.resolve(MODE, msg.dir);
        // An API card has no subscription to check
        if (a && !hasClaudeProviderMarker(a.dir)) await deps.checkSubscription?.(a.dir);
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
          error = await addAccount(msg.name.trim(), msg.shared !== false, msg.provider);
        } catch (err) {
          error = msg.provider ? t('codex.provider.createFailed', { dir: accountDir(msg.name.trim()) }) : errText(err);
        }
        panel.post({ type: 'addResult', mode: MODE, error });
        return;
      }
      case 'providerModels': {
        const result = await listProviderModels(msg);
        panel.post({ type: 'providerModelsResult', mode: MODE, request: msg.request, ...result });
        return;
      }
      case 'saveProvider': {
        const a = panel.resolve(MODE, msg.dir);
        const error = a?.kind === 'named' && hasClaudeProviderMarker(a.dir) ? await saveProvider(a, msg) : claudeProviderErrorText('unmanaged');
        panel.post({ type: 'saveProviderResult', mode: MODE, dir: msg.dir, error });
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
        if (!a || a.kind === 'external' || hasClaudeProviderMarker(a.dir)) return;
        await exclusions?.set(a.name, msg.excluded !== false);
        panel.refresh();
        return;
      }
      case 'reorder': {
        const names = msg.dirs.map((dir) => panel.resolve(MODE, dir)).filter((a) => a && a.kind !== 'external').map((a) => a!.name);
        await store.setOrder(names);
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
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        try {
          const request = parseAccountUri(uri, {
            uriScheme: vscode.env.uriScheme,
            platform: process.platform,
            remoteName: vscode.env.remoteName,
            distro: process.env.WSL_DISTRO_NAME,
          });
          const account = store.all().find((a) => sameName(a.name, request.account));
          if (!account) throw new Error(t('uri.unknownAccount', { name: request.account }));
          let isDirectory = false;
          try {
            isDirectory = fs.statSync(account.dir).isDirectory();
          } catch {
            // A missing or inaccessible directory must never change the selected account, even for default.
          }
          if (!isDirectory) throw new Error(t('uri.directory', { dir: account.dir }));
          if (await switchTo(account) && request.reload) await reloadWindow();
        } catch (err) {
          void vscode.window.showErrorMessage(errText(err));
        }
      },
    }),
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
        !hasClaudeProviderMarker(account.dir) &&
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

/**
 * Linux: the command line of a Claude account terminal: `env CLAUDE_CONFIG_DIR='<dir>'`, or `env -u CLAUDE_CONFIG_DIR`
 * without a folder (the default account when the host has none), so an export in rc files cannot redirect the account;
 * plus bundledPathAssignment when the Claude extension bundles a CLI.
 */
export function linuxClaudeCommand(dir: string | undefined, bundled: string | undefined): string {
  const home = dir === undefined ? '-u CLAUDE_CONFIG_DIR' : `CLAUDE_CONFIG_DIR=${shQuote(dir)}`;
  return `env ${home}${bundled ? ` ${bundledPathAssignment(bundled)}` : ''} claude`;
}
