import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NAME_RE, caseVariantOf, findSameDir, realPathInside, samePath, sameRealPath } from '../paths';
import { lstatOrUndefined } from '../claudeShare';
import { accountTerminalShell, bundledPathAssignment, hasControlChars, shQuote, windowsAccountEnv, windowsTerminalEnvSetting } from '../terminalShell';
import { type AccountsPanel, type PanelSource, viewInfo } from '../accountsPanel';
import { labelFor, sameName, type LabelStore, EXTERNAL_NAME } from '../labels';
import type { RecommendExclusions } from '../recommend';
import type { AccountView, ApiCardInput, ApiServiceView, FromWebview, RestartInfo } from '../protocol';
import {
  CODEX_DEFAULT_NAME,
  type CodexAccount,
  codexAccountDir,
  codexDefaultDir,
  codexLoggedIn,
  readCodexAccountInfo,
  deleteCodexDir,
  ensureCodexDir,
} from './codexPaths';
import { codexAccountBusy, codexBusyText, copyCodexIndependent, ensureCodexLinks, isSharedCodexAccount, makeCodexIndependent, migrateCodexToShared } from './codexShare';
import { describeShareReport } from '../shareReport';
import {
  STATE_FILE,
  effectiveDir,
  disableWindows,
  enableWindows,
  installRcBlocks,
  isEnabled,
  preCheck,
  rcBlock,
  rcStatus,
  readSelectedDir,
  removeLinuxState,
  removeRcBlockFrom,
  removeRcBlocks,
  removeWindowsState,
  selfCheck,
  watchedStateFiles,
  writeSelection,
} from './codexState';
import { isWindows, tildify, errText } from '../platform';
import { askCopyFallback } from '../linkPolicy';
import { type ServerKind, canAutoRestart, detectServerKind, executeRestart, planRestart } from './codexServer';
import type { CodexAccountStore } from './codexStore';
import { codexRunsInWsl, warnCodexRunsInWsl } from './codexSettings';
import { runTool, type TerminalCheck, type ToolDeps } from '../tools';
import { joinSentences, t } from '../i18n';
import type { CodexUsageHistory } from './codexUsageHistory';
import {
  API_SERVICES, DEEPSEEK_MODELS, PROVIDER_FILES, ProviderConfigError, SERVICE_INFO, checkBaseUrl, createProviderConfig,
  editProviderConfig, preserveProviderConfig, providerLabel, readProviderEditState, readProviderInfo, readProviderKey,
  validateProviderConfig, type ApiService, type ProviderErrorCode,
} from './codexProvider';
import { fetchModels, ModelListError } from './providerModels';
import type { ModelCache } from './modelCache';
// Codex commands, panel message handling and the Codex panel data source. Command ids and restart behavior:
// codex-design.md section 8 and docs/features.md. QuickPick items, messages and terminal names use labelFor; logic
// uses account name and dir. Panel account messages resolve their directory through panel.resolve.

export interface CodexDeps {
  store: CodexAccountStore;
  panel: AccountsPanel;
  // The Codex LabelStore (codex.labels)
  labels: LabelStore;
  // Accounts excluded from recommendations (codex.recommendExcluded); cleared with the account. Tests may leave it out
  exclusions?: RecommendExclusions;
  // Passed to runTool for Codex page tool messages
  tools: ToolDeps;
  // The Codex extension's bundled CLI (findBundledCodex), the account terminals' fallback when `codex` is not on PATH
  bundledCodex?: () => string | undefined;
  // Model lists of the API card services (codex.modelCache); a list a form loads for a preset is stored there
  modelCache?: ModelCache;
  // Receives this module's "account terminal open" check, so the toolbar's Re-link can treat such an account as busy
  provideTerminalCheck?: (check: TerminalCheck) => void;
}

/**
 * Linux: the command line of a Codex account terminal: `env CODEX_HOME='<dir>'` for a named account, `env -u CODEX_HOME`
 * for the default one (the rc block re-exports CODEX_HOME), plus bundledPathAssignment when the Codex extension bundles
 * a CLI.
 */
export function linuxCodexCommand(dir: string | undefined, bundled: string | undefined): string {
  const home = dir === undefined ? '-u CODEX_HOME' : `CODEX_HOME=${shQuote(dir)}`;
  return `env ${home}${bundled ? ` ${bundledPathAssignment(bundled)}` : ''} codex`;
}


// Editor display names (not localized); a Record so that a new kind cannot be left out
const EDITOR_NAMES: Record<ServerKind, string> = {
  antigravity: 'Antigravity',
  vscodium: 'VSCodium',
  vscode: 'VS Code',
  unknown: '', // unused: the unknown kind never names an editor
};
const editorName = (kind: ServerKind): string => EDITOR_NAMES[kind];

/** Pure localized guidance selector (hint, the "restart required" warning and the switch confirmation): native Windows
 *  local window → quit and relaunch the editor; other local → restart the editor; non-WSL remote → remote guidance;
 *  WSL → per editor kind. Callers pass vscode.env.remoteName; uses the editor connection context, not the kernel, so
 *  WSLg desktop windows get local guidance. windows is a test seam. */
export function manualRestartMessages(kind: ServerKind, remoteName: string | undefined, windows: boolean = isWindows()): { hint: string; required: string; switchConfirm: string } {
  if (remoteName === undefined && windows) {
    const hint = t('codex.manualRestartHintWin');
    return {
      hint,
      required: t('codex.manualRestartRequiredWin', { hint }),
      switchConfirm: t('codex.switchConfirmManualWin', { hint }),
    };
  }
  if (remoteName === undefined) {
    const hint = t('codex.manualRestartHintLocal');
    return {
      hint,
      required: t('codex.manualRestartRequiredLocal', { hint }),
      switchConfirm: t('codex.switchConfirmManualLocal', { hint }),
    };
  }
  if (remoteName !== 'wsl') {
    const hint = t('codex.manualRestartHintRemote');
    return {
      hint,
      required: t('codex.manualRestartRequiredRemote', { hint }),
      switchConfirm: t('codex.switchConfirmManualRemote', { hint }),
    };
  }
  const hint = kind === 'vscode' ? t('codex.manualRestartHintVscode')
    : kind === 'unknown' ? t('codex.manualRestartHintUnknown')
      : t('codex.manualRestartHint', { editor: editorName(kind) });
  return {
    hint,
    required: t('codex.manualRestartRequired', { hint }),
    switchConfirm: t('codex.switchConfirmManual', { hint }),
  };
}

/** Automatic restart is restricted to the existing supported WSL servers: auto only for a WSL remote with
 *  canAutoRestart(kind); local and other remotes never. userEnv: true on native Windows. kind: the caller's
 *  detectServerKind() result, so one flow detects the kind once. */
export function restartInfo(kind: ServerKind = detectServerKind()): RestartInfo {
  const remoteName = vscode.env.remoteName;
  const context = remoteName === undefined ? 'local' : remoteName === 'wsl' ? 'wsl' : 'remote';
  const info: RestartInfo = { context, auto: context === 'wsl' && canAutoRestart(kind) };
  return isWindows() ? { ...info, userEnv: true } : info;
}

// Returns false when automatic restart is unsupported or validation failed and the manual alternative was shown
function restart(kind: ServerKind): boolean {
  const messages = manualRestartMessages(kind, vscode.env.remoteName);
  if (vscode.env.remoteName !== 'wsl' || !canAutoRestart(kind)) {
    void vscode.window.showWarningMessage(messages.required);
    return false;
  }
  let plan;
  try {
    plan = planRestart();
  } catch (err) {
    void vscode.window.showWarningMessage(t('codex.restartPlanFailed', { error: errText(err), hint: messages.hint }));
    return false;
  }
  try {
    executeRestart(plan);
  } catch (err) {
    void vscode.window.showWarningMessage(t('codex.restartFailed', { error: errText(err), hint: messages.hint }));
    return false;
  }
  return true;
}

/** Restart a supported WSL server with modal confirmation; otherwise show instructions: available from the Command Palette */
export async function restartServerInteractive(): Promise<void> {
  const kind = detectServerKind();
  const info = restartInfo(kind);
  if (!info.auto) {
    void vscode.window.showWarningMessage(manualRestartMessages(kind, vscode.env.remoteName).required);
    return;
  }
  const continueLabel = t('common.continue');
  const confirm = t('codex.restartConfirm', { editor: editorName(kind) });
  const ok = await vscode.window.showWarningMessage(confirm, { modal: true }, continueLabel);
  if (ok !== continueLabel) return;
  restart(kind);
}

function providerErrorText(code: ProviderErrorCode): string {
  return t(`codex.provider.error.${code}`);
}

// Only safe provider status enters the view. Provider homes never need a subscription credential read.
function codexRowInfo(dir: string): Pick<AccountView, 'email' | 'plan' | 'loggedIn' | 'provider' | 'providerService' | 'providerModel' | 'providerBaseUrl' | 'providerHost' | 'providerHasKey' | 'providerConfigured' | 'providerError'> {
  const provider = readProviderInfo(dir);
  if (!provider) return viewInfo(readCodexAccountInfo(dir));
  return {
    loggedIn: provider.configured,
    plan: providerLabel(provider.provider),
    provider: providerLabel(provider.provider),
    providerService: provider.provider,
    providerModel: provider.model,
    providerBaseUrl: provider.baseUrl,
    providerHost: provider.host,
    providerHasKey: provider.hasKey,
    providerConfigured: provider.configured,
    providerError: provider.error ? providerErrorText(provider.error) : undefined,
  };
}

/**
 * Data source of the Codex panel tab.
 * - accounts(): store.all() rows with subscription info or secret-free provider status; current and selected rows by findSameDir (alternate
 *   spellings match), isSelected independent of isCurrent; shared only for named rows; when effectiveDir() matches no
 *   row, an extra current 'external' row. Usage history only for signed-in non-API-key rows, and none while
 *   codexRunsInWsl().
 * - enabled(): isEnabled(); errors count as not enabled.
 * - pendingDir(): when the selected dir (default when unset) differs from effectiveDir(), the account's display name,
 *   or the path for an unregistered dir; display text only.
 * - watchTargets(): auth.json and provider files of each row's dir plus this editor's state files (watchedStateFiles).
 */
export function codexPanelSource(store: CodexAccountStore, labels: LabelStore, history?: CodexUsageHistory, exclusions?: RecommendExclusions, modelCache?: ModelCache): PanelSource {
  const accounts = (): AccountView[] => {
    const cur = effectiveDir();
    const selected = readSelectedDir() ?? codexDefaultDir();
    const all = store.all();
    const curIdx = findSameDir(all.map((a) => a.dir), cur);
    const selIdx = findSameDir(all.map((a) => a.dir), selected);
    const rows: AccountView[] = all.map((a, i) => ({
      kind: a.name === CODEX_DEFAULT_NAME ? 'default' : 'named',
      name: a.name,
      label: labelFor(a.name, labels),
      dir: a.dir,
      dirLabel: tildify(a.dir),
      ...codexRowInfo(a.dir),
      isCurrent: i === curIdx,
      isSelected: i === selIdx,
      shared: a.name === CODEX_DEFAULT_NAME ? undefined : isSharedCodexAccount(a.dir),
      recommendExcluded: exclusions?.has(a.name) || undefined,
    }));
    if (!rows.some((r) => r.isCurrent)) {
      rows.push({
        kind: 'external',
        name: EXTERNAL_NAME,
        label: labelFor(EXTERNAL_NAME, labels),
        dir: cur,
        dirLabel: tildify(cur),
        ...codexRowInfo(cur),
        isCurrent: true,
        isSelected: findSameDir([cur], selected) === 0,
      });
    }
    if (!codexRunsInWsl()) {
      for (const row of rows) {
        if (!row.provider && row.loggedIn && row.plan !== 'API key') {
          row.usage = history?.get(row.dir);
          row.usageEligible = true;
        }
      }
    }
    return rows;
  };
  return {
    accounts,
    apiServices: (): ApiServiceView[] => API_SERVICES.map((id) => ({
      id, name: id === 'custom' ? '' : SERVICE_INFO[id].name, baseUrl: SERVICE_INFO[id].baseUrl, keyRequired: SERVICE_INFO[id].keyRequired,
      models: id === 'deepseek' ? [...DEEPSEEK_MODELS] : modelCache?.get(id),
    })),
    identityOf: (dir) => preserveProviderConfig(dir) ? undefined : readCodexAccountInfo(dir).identity,
    runsInWsl: () => codexRunsInWsl(),
    // Treat errors such as unreadable rc files as not enabled so panel rendering is not interrupted; a broken block
    // (start marker without end marker) counts as not enabled so the Enable button leads to preCheck's repair guidance
    enabled: () => {
      try {
        return isEnabled();
      } catch {
        return false;
      }
    },
    pendingDir: () => {
      const selected = readSelectedDir() ?? codexDefaultDir();
      if (findSameDir([selected], effectiveDir()) === 0) return undefined;
      const all = store.all();
      const account = all[findSameDir(all.map((a) => a.dir), selected)];
      return account ? labelFor(account.name, labels) : selected;
    },
    // Same directories as accounts() (registered ones plus the external effective dir) without decoding any auth.json
    watchTargets: () => {
      const cur = effectiveDir();
      const dirs = store.all().map((a) => a.dir);
      if (!dirs.some((d) => samePath(d, cur))) dirs.push(cur);
      return [...dirs.flatMap((d) => ['auth.json', ...PROVIDER_FILES].map((file) => path.join(d, file))), ...watchedStateFiles()];
    },
    restart: () => restartInfo(),
  };
}

/**
 * Registers the Codex commands and the panel's 'codex' message handler.
 * - enable / switch / terminal: refused with codex.win.runsInWsl while codexRunsInWsl(); switching also requires isEnabled().
 * - switch: concurrent requests are ignored; a target already effective only realigns the state file; otherwise a
 *   modal (codex.switchAndRestartButton for automatic WSL editors, codex.saveSelectionButton with manual instructions
 *   elsewhere), then re-checks the dir and its registration, re-links a shared target (problems only warn), writes the
 *   selection and restarts only supported WSL editors.
 * - add: validateName, create the dir; shared asks for the Windows copy fallback then ensureCodexLinks with the
 *   terminal-busy callback, independent runs copyCodexIndependent; link/copy failures only warn. Add and rename always
 *   post addResult / renameResult, also when they throw.
 * - API card add: a new directory only; the sidebar form sends the service, endpoint (custom), key and the model chosen
 *   from the loaded list; the host validates them again, refusing a missing required key or an unusable endpoint before
 *   any directory exists, and writes provider files before sharing or registration. No key enters panel state.
 *   providerModels answers with DeepSeek's catalog models or fetchModels of the endpoint (the typed key, else the saved
 *   key of the card being edited). saveProvider (model, endpoint for non-DeepSeek cards, key; empty keeps it) uses a
 *   fresh revision. Creation/edit never selects or restarts. Switch/terminal/conversion validate provider files;
 *   provider terminals never start subscription sign-in.
 * - recommendExclude: registered rows only (the external row is ignored); sets or clears the recommendation mark and
 *   refreshes the panel. The mark is cleared with the account (remove, or a pruned directory on sync).
 * - reorder: the rows that resolve to registered accounts, in the order sent, become the stored order (store.setOrder);
 *   the external row and unknown directories are skipped; then the panel is refreshed.
 * - share / unshare: effective or selected accounts (alternate spellings included) are refused before the modal and
 *   re-checked after it, then the host busy guard (codexAccountBusy or, on Windows, an open account terminal). Share
 *   re-checks registration, effective/selected and busy state after the copy fallback too, then passes the copy-fallback
 *   and terminal-busy options to migrateCodexToShared (busy checked again at its start; both
 *   apply to its final link repair).
 * - remove: one blocked() guard for effective, selected and busy, before the flow and after every modal, including
 *   right before deleteCodexDir; a successful deletion calls store.unignore.
 * - terminal: a non-default Linux account whose dir has a C0 or DEL control character is refused; the bundled CLI's
 *   folder is appended to the terminal's PATH (windowsAccountEnv / linuxCodexCommand); a sign-in terminal
 *   shows the account login tip. Tool messages go through runTool('codex', …).
 */
export function registerCodexCommands(deps: CodexDeps): vscode.Disposable[] {
  const { store, panel, labels, exclusions, tools } = deps;
  const MODE = 'codex';
  // Terminals created by this extension -> their account
  const terminals = new Map<vscode.Terminal, CodexAccount>();

  // Display name: the alias if set, otherwise the name
  const labelOf = (a: CodexAccount): string => labelFor(a.name, labels);
  const isEffective = (a: CodexAccount): boolean => samePath(a.dir, effectiveDir());
  const isSelected = (a: CodexAccount): boolean => samePath(a.dir, readSelectedDir() ?? codexDefaultDir());
  // Guards before removing or converting also treat another spelling of those directories (8.3 name, '\?\', a link or
  // alias) as in use
  const effectiveAlias = (a: CodexAccount): boolean => isEffective(a) || sameRealPath(a.dir, effectiveDir());
  const selectedAlias = (a: CodexAccount): boolean => isSelected(a) || sameRealPath(a.dir, readSelectedDir() ?? codexDefaultDir());
  // Windows cannot attribute a running codex.exe to an account (see codexAccountBusy), so an open terminal of the
  // account also counts; on Linux the /proc check covers terminals
  const terminalOpen: TerminalCheck = (dir) => isWindows() && [...terminals.values()].some((x) => samePath(x.dir, dir));
  deps.provideTerminalCheck?.(terminalOpen);
  const busy = (a: CodexAccount): boolean => codexAccountBusy(a.dir) || terminalOpen(a.dir);
  // Passed to the linking steps, which OR it with their own process check
  const linkBusy = (a: CodexAccount): (() => boolean) => () => terminalOpen(a.dir);
  // A switch is in progress (e.g. its modal is open); further requests such as a double click are ignored
  let switching = false;

  async function pickAccount(accounts: CodexAccount[], placeHolder: string): Promise<CodexAccount | undefined> {
    if (accounts.length === 0) {
      void vscode.window.showInformationMessage(t('common.noAccounts'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((account) => ({
        label: labelOf(account),
        description: preserveProviderConfig(account.dir) ? providerLabel(readProviderInfo(account.dir)?.provider ?? 'custom')
          : codexLoggedIn(account.dir) ? t('common.loggedIn') : t('common.notLoggedIn'),
        detail: account.dir,
        account,
      })),
      { placeHolder },
    );
    return picked?.account;
  }

  async function enable(): Promise<void> {
    if (codexRunsInWsl()) {
      warnCodexRunsInWsl();
      return;
    }
    let check: ReturnType<typeof preCheck>;
    try {
      check = preCheck();
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.enableFailed', { error: errText(err) }));
      return;
    }
    if (!check.ok) {
      void vscode.window.showErrorMessage(t('codex.enableFailedReasons', { reasons: check.reasons.join('\n') }));
      return;
    }
    const writeLabel = t('codex.enableButton');
    if (isWindows()) {
      const okWin = await vscode.window.showWarningMessage(t('codex.win.enableConfirm'), { modal: true, detail: t('codex.win.enableDetail') }, writeLabel);
      if (okWin !== writeLabel) return;
      // Re-enabling over an existing state file keeps it: a failed self-check only rolls back what this run created
      let existed = true;
      try {
        existed = fs.existsSync(STATE_FILE());
        enableWindows();
        const result = selfCheck();
        if (!result.ok) {
          if (!existed) removeWindowsState();
          void vscode.window.showErrorMessage(t('codex.win.selfCheckFailed', { detail: result.detail }));
        }
      } catch (err) {
        void vscode.window.showErrorMessage(t('codex.enableFailed', { error: errText(err) }));
      }
      panel.refresh();
      return;
    }
    const ok = await vscode.window.showWarningMessage(t('codex.enableConfirm'), { modal: true, detail: rcBlock() }, writeLabel);
    if (ok !== writeLabel) return;
    // Snapshot before writing: rollback only removes blocks from files newly written this time, never the user's existing blocks
    let newlyWritten: string[];
    try {
      newlyWritten = rcStatus().filter((s) => !s.hasBlock).map((s) => s.file);
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.enableFailed', { error: errText(err) }));
      return;
    }
    const rollback = (): string[] => {
      const failed: string[] = [];
      for (const file of newlyWritten) {
        try {
          removeRcBlockFrom(file);
        } catch (e) {
          failed.push(errText(e));
        }
      }
      return failed;
    };
    try {
      installRcBlocks();
    } catch (err) {
      const failed = rollback();
      void vscode.window.showErrorMessage(
        t('codex.writeRcFailed', { error: errText(err) }) +
          (failed.length ? t('codex.rollbackFailedSuffix', { errors: failed.join('\n') }) : ''),
      );
      panel.refresh();
      return;
    }
    const result = selfCheck();
    if (!result.ok) {
      const failed = rollback();
      void vscode.window.showErrorMessage(
        failed.length
          ? t('codex.selfCheckFailedRollbackFailed', { detail: result.detail, errors: failed.join('\n') })
          : t('codex.selfCheckFailed', { detail: result.detail }),
      );
    }
    panel.refresh();
  }

  async function disable(): Promise<void> {
    const disableLabel = t('codex.disableButton');
    const ok = await vscode.window.showWarningMessage(t(isWindows() ? 'codex.win.disableConfirm' : 'codex.disableConfirm'), { modal: true }, disableLabel);
    if (ok !== disableLabel) return;
    try {
      if (isWindows()) {
        disableWindows();
      } else {
        removeRcBlocks();
        removeLinuxState();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.disableFailed', { error: errText(err) }));
    }
    panel.refresh();
  }

  async function switchTo(account: CodexAccount): Promise<void> {
    if (switching) return;
    if (codexRunsInWsl()) {
      warnCodexRunsInWsl();
      return;
    }
    // Switching is only allowed once PlanSwap manages CODEX_HOME (an unreadable rc file counts as not enabled)
    let enabled = false;
    try {
      enabled = isEnabled();
    } catch {
      enabled = false;
    }
    if (!enabled) {
      void vscode.window.showWarningMessage(t('codex.notEnabled'));
      return;
    }
    switching = true;
    try {
      await doSwitch(account);
    } finally {
      switching = false;
    }
  }

  async function doSwitch(account: CodexAccount): Promise<void> {
    if (!providerReady(account.dir)) return;
    if (isEffective(account) && isSelected(account)) {
      void vscode.window.showInformationMessage(t('account.alreadyCurrent', { label: labelOf(account) }));
      return;
    }
    if (!fs.existsSync(account.dir)) {
      void vscode.window.showErrorMessage(t('account.dirMissing', { dir: account.dir }));
      return;
    }
    // Already effective in this window (e.g. another window selected a different account): only the state file
    // is brought back in line; no confirmation and no restart
    if (isEffective(account)) {
      try {
        writeSelection(account.name === CODEX_DEFAULT_NAME ? undefined : account.dir);
      } catch (err) {
        void vscode.window.showErrorMessage(t('codex.writeStateFailed', { error: errText(err) }));
        return;
      }
      panel.refresh();
      return;
    }
    const kind = detectServerKind();
    const info = restartInfo(kind);
    const auto = info.auto;
    const confirmText = !auto
      ? manualRestartMessages(kind, vscode.env.remoteName).switchConfirm
      : t('codex.switchConfirm', { editor: editorName(kind) });
    const switchLabel = t(auto ? 'codex.switchAndRestartButton' : 'codex.saveSelectionButton');
    const ok = await vscode.window.showWarningMessage(confirmText, { modal: true }, switchLabel);
    if (ok !== switchLabel) return;
    // Another window may have removed the account while the confirmation was open.
    if (!fs.existsSync(account.dir)) {
      void vscode.window.showErrorMessage(t('account.dirMissing', { dir: account.dir }));
      panel.refresh();
      return;
    }
    const registered = store.find(account.name);
    if (!registered || !samePath(registered.dir, account.dir)) {
      panel.refresh();
      return;
    }
    if (!providerReady(account.dir)) return;
    // A shared account is re-linked first; a problem only warns, the switch still happens
    if (account.name !== CODEX_DEFAULT_NAME && isSharedCodexAccount(account.dir)) {
      try {
        const notes = describeShareReport(ensureCodexLinks(account.dir, { busy: linkBusy(account) }));
        if (notes) void vscode.window.showWarningMessage(t('share.refreshWarning', { label: labelOf(account), notes }));
      } catch (err) {
        void vscode.window.showWarningMessage(t('share.refreshWarning', { label: labelOf(account), notes: errText(err) }));
      }
    }
    if (!providerReady(account.dir)) return;
    try {
      writeSelection(account.name === CODEX_DEFAULT_NAME ? undefined : account.dir);
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.writeStateFailed', { error: errText(err) }));
      return;
    }
    panel.refresh();
    // Manual kinds already showed the instructions in the confirmation
    if (auto) restart(kind);
  }

  function providerReady(dir: string): boolean {
    if (!preserveProviderConfig(dir)) return true;
    try {
      validateProviderConfig(dir);
      return true;
    } catch (err) {
      const reason = providerErrorText(err instanceof ProviderConfigError ? err.code : 'file');
      void vscode.window.showErrorMessage(t('codex.provider.unavailable', { reason }));
      return false;
    }
  }

  const isService = (value: string): value is ApiService => (API_SERVICES as readonly string[]).includes(value);

  // The model list for a form: DeepSeek's listed models (bound to its catalog), otherwise GET <endpoint>/models with the
  // key typed in the form, or the saved key of the card being edited (dir) when none was typed
  async function listProviderModels(msg: { service: string; baseUrl?: string; key: string; dir?: string }): Promise<{ models?: string[]; error?: string }> {
    if (!isService(msg.service)) return { error: providerErrorText('format') };
    if (msg.service === 'deepseek') return { models: [...DEEPSEEK_MODELS] };
    let baseUrl: string;
    let key = msg.key.trim();
    try {
      baseUrl = checkBaseUrl(msg.baseUrl?.trim() || SERVICE_INFO[msg.service].baseUrl);
      if (!key && msg.dir) {
        // A saved key goes only to its own card's service and endpoint; another one needs the key typed again
        const card = panel.resolve(MODE, msg.dir);
        if (card?.kind === 'named' && preserveProviderConfig(card.dir)) {
          const saved = readProviderEditState(card.dir);
          if (saved.service !== msg.service || saved.baseUrl !== baseUrl) return { error: t('codex.provider.newEndpointNeedsKey') };
          key = readProviderKey(card.dir);
        }
      }
    } catch (err) {
      return { error: providerErrorText(err instanceof ProviderConfigError ? err.code : 'file') };
    }
    if (/\s|[\x00-\x1f\x7f]/u.test(key)) return { error: providerErrorText('key') };
    try {
      const models = await fetchModels(baseUrl, key);
      // A preset's list at its own endpoint is the service's list: keep it for the next form
      if (msg.service !== 'custom' && baseUrl === SERVICE_INFO[msg.service].baseUrl) {
        void deps.modelCache?.set(msg.service, models).then(() => panel.refresh()).catch(() => undefined);
      }
      return { models };
    } catch (err) {
      const e = err instanceof ModelListError ? err : new ModelListError('network');
      return { error: e.code === 'http' ? t('codex.provider.modelsHttp', { status: e.status ?? 0 }) : t(e.code === 'format' ? 'codex.provider.modelsFormat' : 'codex.provider.modelsNetwork') };
    }
  }

  // The edit form's values; key '' keeps the saved key. Errors carry no config text
  async function saveProvider(account: CodexAccount, msg: { model: string; baseUrl?: string; key: string }): Promise<string | undefined> {
    try {
      const before = readProviderEditState(account.dir);
      const registered = store.find(account.name);
      if (!registered || !samePath(registered.dir, account.dir)) return providerErrorText('changed');
      // Moving the saved key to another endpoint needs it typed again, as for the model list
      if (before.service !== 'deepseek' && !msg.key.trim() && before.hasKey && msg.baseUrl !== undefined && msg.baseUrl.trim() !== before.baseUrl) {
        return t('codex.provider.newEndpointNeedsKey');
      }
      editProviderConfig(account.dir, { model: msg.model.trim(), key: msg.key.trim(), baseUrl: before.service === 'deepseek' ? undefined : msg.baseUrl?.trim() }, before.revision);
      return undefined;
    } catch (err) {
      return joinSentences(t('codex.provider.editFailed'), providerErrorText(err instanceof ProviderConfigError ? err.code : 'write'));
    } finally {
      panel.refresh();
    }
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
    panel.refresh();
    return undefined;
  }

  // shared: link everything but the login to the default account; otherwise copy its configuration once
  async function addAccount(name: string, shared: boolean, provider?: ApiCardInput): Promise<string | undefined> {
    const error = validateName(name, store, labels);
    if (error) return error;
    if (provider) return addProviderAccount(name, shared, provider);
    const account: CodexAccount = { name, dir: codexAccountDir(name) };
    try {
      ensureCodexDir(account.dir);
    } catch (err) {
      return t('account.createDirFailed', { error: errText(err) });
    }
    const linkOptions = shared ? await askCopyFallback(account.dir, 'Codex') : {};
    // Linking or copying failures only warn and do not block
    try {
      if (shared) {
        // The folder may already exist (kept from an earlier removal, its terminal possibly still open)
        const notes = describeShareReport(ensureCodexLinks(account.dir, { ...linkOptions, busy: linkBusy(account) }));
        if (notes) void vscode.window.showWarningMessage(t(isSharedCodexAccount(account.dir) ? 'share.addNotes' : 'share.addNotLinked', { name, notes }));
      } else {
        const result = copyCodexIndependent(account.dir);
        // "Source missing" / "target exists" are normal and not reported; only blocked or unreadable files are
        const normal = [t('codex.seed.srcMissing'), t('codex.seed.dstExists')];
        const notable = result.skipped.filter((s) => !normal.includes(s.reason));
        if (notable.length) {
          void vscode.window.showInformationMessage(
            t('codex.seedSkipped', {
              name,
              list: notable.map((s) => t('codex.seedSkippedItem', { file: s.file, reason: s.reason })).join('\n'),
            }),
          );
        }
      }
    } catch (err) {
      void vscode.window.showWarningMessage(t(shared ? 'share.addLinkFailed' : 'share.addCopyFailed', { name, error: errText(err) }));
    }
    await store.add(account);
    panel.refresh();
    return undefined;
  }

  async function addProviderAccount(name: string, shared: boolean, input: ApiCardInput): Promise<string | undefined> {
    const account: CodexAccount = { name, dir: codexAccountDir(name) };
    if (lstatOrUndefined(account.dir)) return t('codex.provider.dirExists', { dir: account.dir });
    if (!isService(input.service)) return providerErrorText('format');
    const target = { service: input.service, baseUrl: input.service === 'custom' ? input.baseUrl?.trim() : undefined };
    const model = input.model.trim();
    const key = input.key;
    if (!model) return providerErrorText('model');
    if (SERVICE_INFO[target.service].keyRequired && !key.trim()) return t('codex.provider.keyRequired');
    if (/\s|[\x00-\x1f\x7f]/u.test(key.trim())) return providerErrorText('key');
    // Fails before any directory is made, so a rejected form leaves nothing behind
    if (target.service === 'custom') {
      try { checkBaseUrl(target.baseUrl); } catch { return providerErrorText('url'); }
    }
    const error = validateName(name, store, labels);
    if (error) return error;
    if (lstatOrUndefined(account.dir)) return t('codex.provider.dirExists', { dir: account.dir });
    try {
      // Unlike ordinary account registration, a provider card never adopts an existing directory.
      fs.mkdirSync(account.dir, { mode: 0o700 });
      const seeded = createProviderConfig(account.dir, target.service, { model, key: key.trim(), baseUrl: target.baseUrl }, codexDefaultDir());
      if (shared) {
        const options = await askCopyFallback(account.dir, 'Codex');
        validateProviderConfig(account.dir);
        const report = ensureCodexLinks(account.dir, { ...options, busy: linkBusy(account) });
        if (!isSharedCodexAccount(account.dir)) {
          return t('codex.provider.createFailed', { dir: account.dir });
        }
        const notes = describeShareReport(report);
        if (notes) void vscode.window.showWarningMessage(t('share.addNotes', { name, notes }));
      } else {
        copyCodexIndependent(account.dir);
      }
      validateProviderConfig(account.dir);
      await store.add(account);
      if (seeded.skipped.length) {
        void vscode.window.showInformationMessage(t('codex.provider.seedSkipped', { list: seeded.skipped.join(', ') }));
      }
      panel.refresh();
      return undefined;
    } catch (err) {
      // Provider write failures never serialize config input or an arbitrary exception into the Webview.
      const reason = err instanceof ProviderConfigError ? providerErrorText(err.code) : t('codex.provider.error.write');
      return joinSentences(t('codex.provider.createFailed', { dir: account.dir }), reason);
    }
  }

  // Converts an independent account to a shared one after a modal confirmation
  async function shareAccount(account: CodexAccount): Promise<void> {
    if (account.name === CODEX_DEFAULT_NAME || isSharedCodexAccount(account.dir)) return;
    if (!providerReady(account.dir)) return;
    if (effectiveAlias(account) || selectedAlias(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('share.confirmButton');
    const picked = await vscode.window.showWarningMessage(t(preserveProviderConfig(account.dir) ? 'codex.provider.shareConfirm'
      : isWindows() ? 'share.confirmCodexWindows' : 'share.confirmCodex', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    // Re-checked after the modal: another window may have selected the account meanwhile
    if (effectiveAlias(account) || selectedAlias(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    if (busy(account)) {
      void vscode.window.showWarningMessage(codexBusyText(account.dir, labelOf(account)));
      return;
    }
    const linkOptions = await askCopyFallback(account.dir, 'Codex');
    // The Windows fallback can show another modal; every account guard must hold after it too.
    const registered = store.find(account.name);
    if (!registered || !samePath(registered.dir, account.dir)) {
      panel.refresh();
      return;
    }
    if (effectiveAlias(account) || selectedAlias(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    if (busy(account)) {
      void vscode.window.showWarningMessage(codexBusyText(account.dir, labelOf(account)));
      return;
    }
    try {
      if (!providerReady(account.dir)) return;
      const report = migrateCodexToShared(account.dir, account.name, '/proc', { ...linkOptions, busy: linkBusy(account) });
      void vscode.window.showInformationMessage(t(isSharedCodexAccount(account.dir) ? 'share.done' : 'share.incomplete', { label: labelOf(account), summary: describeShareReport(report) || t('share.nothingElse') }));
    } catch (err) {
      void vscode.window.showErrorMessage(t('share.failed', { label: labelOf(account), error: errText(err) }));
    }
    panel.refresh();
  }

  // Converts a shared account back to an independent one after a modal confirmation; sessions stay in ~/.codex
  async function unshareAccount(account: CodexAccount): Promise<void> {
    if (account.name === CODEX_DEFAULT_NAME || !isSharedCodexAccount(account.dir)) return;
    if (!providerReady(account.dir)) return;
    if (effectiveAlias(account) || selectedAlias(account)) {
      void vscode.window.showWarningMessage(t('unshare.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('unshare.confirmButton');
    const picked = await vscode.window.showWarningMessage(t(preserveProviderConfig(account.dir) ? 'codex.provider.unshareConfirm'
      : isWindows() ? 'unshare.confirmCodexWindows' : 'unshare.confirmCodex', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    if (effectiveAlias(account) || selectedAlias(account)) {
      void vscode.window.showWarningMessage(t('unshare.current', { label: labelOf(account) }));
      return;
    }
    if (busy(account)) {
      void vscode.window.showWarningMessage(codexBusyText(account.dir, labelOf(account)));
      return;
    }
    try {
      if (!providerReady(account.dir)) return;
      const r = makeCodexIndependent(account.dir, account.name);
      const done = t('unshare.done', { label: labelOf(account), removed: r.removed.length, copied: r.copied.join(', ') || t('unshare.nothingCopied') });
      const skipped = r.skipped.length ? t('unshare.skipped', { list: r.skipped.map((s) => `${s.file} (${s.reason})`).join(', ') }) : '';
      void vscode.window.showInformationMessage(joinSentences(...[done, skipped].filter(Boolean)));
    } catch (err) {
      void vscode.window.showErrorMessage(t('unshare.failed', { label: labelOf(account), error: errText(err) }));
    }
    panel.refresh();
  }

  // confirmed: the panel already did an inline confirmation; Command Palette entries need a modal confirmation
  async function removeAccount(account: CodexAccount, confirmed: boolean): Promise<void> {
    if (account.name === CODEX_DEFAULT_NAME || !store.find(account.name)) return;
    // Capture the alias before labels.remove clears it, so the prompts below still show it
    const label = labelOf(account);
    // Re-checked after every modal: another window may have selected the account, or a Codex process (daemon or,
    // on Windows, the account's terminal) started meanwhile
    const blocked = (): boolean => {
      if (effectiveAlias(account)) {
        void vscode.window.showWarningMessage(t('codex.removeEffective', { label }));
        return true;
      }
      if (selectedAlias(account)) {
        void vscode.window.showWarningMessage(t('codex.removeSelected', { label }));
        return true;
      }
      if (busy(account)) {
        void vscode.window.showWarningMessage(codexBusyText(account.dir, label));
        return true;
      }
      return false;
    };
    if (blocked()) return;
    if (!confirmed) {
      const deleteLabel = t('common.delete');
      const ok = await vscode.window.showWarningMessage(t('codex.removeConfirm', { label }), { modal: true }, deleteLabel);
      if (ok !== deleteLabel || blocked()) return;
    }

    const shared = isSharedCodexAccount(account.dir);
    await store.remove(account.name);
    await labels.remove(account.name);
    await exclusions?.remove(account.name);
    panel.refresh();

    const detail = t(shared ? 'share.removeDirDetail' : 'codex.removeDirDetail');
    const deleteDirLabel = t('common.deleteDir');
    const delDir = await vscode.window.showWarningMessage(
      t('account.removeDirPrompt', { label, dir: account.dir }),
      { modal: true, detail },
      deleteDirLabel,
    );
    if (delDir !== deleteDirLabel || blocked()) return;
    try {
      await deleteCodexDir(account.dir);
      await store.unignore(account.dir);
    } catch (err) {
      void vscode.window.showErrorMessage(t('account.deleteDirFailed', { error: errText(err) }));
    }
  }

  function openTerminal(account: CodexAccount, login: boolean): void {
    // A Windows terminal would sign in to the Windows-side directory, which the WSL-side Codex never reads
    if (codexRunsInWsl()) {
      warnCodexRunsInWsl();
      return;
    }
    if (!providerReady(account.dir)) return;
    if (preserveProviderConfig(account.dir)) login = false;
    const isDefault = account.name === CODEX_DEFAULT_NAME;
    // Linux types the folder into the shell (the env prefix is needed: the rc block re-exports CODEX_HOME); a control
    // character (a newline) would end the command line early
    if (!isDefault && !isWindows() && hasControlChars(account.dir)) {
      void vscode.window.showErrorMessage(t('terminal.badDir', { dir: JSON.stringify(account.dir) }));
      return;
    }
    const bundled = deps.bundledCodex?.();
    // Windows shells have no `env` command: the terminal environment carries the variable instead (null removes it)
    const terminal = vscode.window.createTerminal({
      name: `Codex (${labelOf(account)})`,
      shellPath: accountTerminalShell(),
      env: isWindows() ? windowsAccountEnv({ CODEX_HOME: isDefault ? null : account.dir }, bundled, windowsTerminalEnvSetting()) : undefined,
    });
    terminals.set(terminal, account);
    const cmd = isWindows() ? 'codex' : linuxCodexCommand(isDefault ? undefined : account.dir, bundled);
    terminal.sendText(login ? `${cmd} login` : cmd);
    terminal.show();
    if (login) void vscode.window.showInformationMessage(t('account.loginTip', { vendor: 'Codex' }));
  }

  // Panel messages
  panel.setHandler(MODE, async (msg: FromWebview) => {
    switch (msg.type) {
      case 'enable':
        await enable();
        return;
      case 'switch': {
        const a = panel.resolve(MODE, msg.dir);
        // Only registered rows: the external directory must never become the selection (or the Windows user variable)
        if (a && a.kind !== 'external') await switchTo(a);
        return;
      }
      case 'terminal': {
        const a = panel.resolve(MODE, msg.dir);
        if (a) openTerminal(a, !preserveProviderConfig(a.dir) && !codexLoggedIn(a.dir));
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
          error = msg.provider ? t('codex.provider.createFailed', { dir: codexAccountDir(msg.name.trim()) }) : errText(err);
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
        const error = a?.kind === 'named' && preserveProviderConfig(a.dir) ? await saveProvider(a, msg) : providerErrorText('unmanaged');
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
        if (!a || a.kind === 'external' || preserveProviderConfig(a.dir)) return;
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
      case 'dismissBanner':
        return;
      case 'tool':
        await runTool(MODE, msg.tool, tools);
        return;
    }
  });

  // Command Palette entries. Rows are matched like the panel does (findSameDir), so another spelling of the effective
  // directory neither adds an external entry nor offers a switch to the account already effective and selected
  const indexOf = (all: CodexAccount[], dir: string): number => findSameDir(all.map((a) => a.dir), dir);
  const allWithExternal = (): CodexAccount[] => {
    const all = store.all();
    return indexOf(all, effectiveDir()) >= 0 ? all : [...all, { name: EXTERNAL_NAME, dir: effectiveDir() }];
  };

  return [
    vscode.commands.registerCommand('planswap.codex.enable', enable),
    vscode.commands.registerCommand('planswap.codex.disable', disable),
    vscode.commands.registerCommand('planswap.codex.switchAccount', async () => {
      const all = store.all();
      const eff = indexOf(all, effectiveDir());
      const sel = indexOf(all, readSelectedDir() ?? codexDefaultDir());
      const a = await pickAccount(all.filter((_, i) => !(i === eff && i === sel)), t('codex.pick.switch'));
      if (a) await switchTo(a);
    }),
    vscode.commands.registerCommand('planswap.codex.addAccount', () => panel.focusAdd(MODE)),
    vscode.commands.registerCommand('planswap.codex.shareAccount', async () => {
      const a = await pickAccount(store.named().filter((x) => !isSharedCodexAccount(x.dir) && !effectiveAlias(x) && !selectedAlias(x)), t('codex.pick.share'));
      if (a) await shareAccount(a);
    }),
    vscode.commands.registerCommand('planswap.codex.removeAccount', async () => {
      const a = await pickAccount(store.named().filter((x) => !effectiveAlias(x) && !selectedAlias(x)), t('codex.pick.remove'));
      if (a) await removeAccount(a, false);
    }),
    vscode.commands.registerCommand('planswap.codex.openTerminal', async () => {
      if (codexRunsInWsl()) {
        warnCodexRunsInWsl();
        return;
      }
      const a = await pickAccount(allWithExternal(), t('codex.pick.terminal'));
      if (a) openTerminal(a, !preserveProviderConfig(a.dir) && !codexLoggedIn(a.dir));
    }),
    vscode.commands.registerCommand('planswap.codex.restartServer', () => restartServerInteractive()),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (!terminals.delete(terminal)) return;
      panel.refresh();
    }),
  ];
}

// Name check for a new Codex account; only Codex accounts are compared (the same name as on the Claude side is allowed).
// Refuses: empty, not NAME_RE, the reserved name, an existing name or display label (case-insensitive), a dir equal to
// or containing ~/.codex after resolving links, a Windows case variant of an existing folder, and a dir that is a link
// or junction
export function validateName(name: string, store: CodexAccountStore, labels: LabelStore): string | undefined {
  if (!name) return t('name.empty');
  if (!NAME_RE.test(name)) return t('name.invalid');
  if (sameName(name, CODEX_DEFAULT_NAME)) return t('name.reserved', { name: CODEX_DEFAULT_NAME });
  if (store.all().some((a) => sameName(a.name, name))) return t('name.exists');
  if (store.all().some((a) => sameName(labelFor(a.name, labels), name))) return t('name.dupLabel');
  const dir = codexAccountDir(name);
  const def = codexDefaultDir();
  if (sameRealPath(dir, def)) return t('name.sameAsDefaultDir');
  if (realPathInside(dir, def)) return t('account.containsDefaultDir', { dir, default: def });
  // Windows: a kept folder that differs only in case is the same folder (its old sign-in would be reused)
  const variant = caseVariantOf(dir);
  if (variant) return t('name.dirCaseDiffers', { dir: variant });
  // scanCodexDirs skips links, so a linked directory must not be registered by adding its name either (sharing would
  // write links into the folder it points at)
  if (lstatOrUndefined(dir)?.isSymbolicLink()) return t('name.dirIsSymlink');
  return undefined;
}
