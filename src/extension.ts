import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccountStore } from './accounts';
import { claudeCredentialOverrides, oneDriveHome, pathVarsWithSpaces } from './environmentWarnings';
import { AccountsPanel, VIEW_ID, claudePanelSource, type PanelSource } from './accountsPanel';
import { LabelStore, labelFor } from './labels';
import { FileMemento, STATE_JSON, type StateMemento } from './fileState';
import { RecommendDismissals, RecommendExclusions } from './recommend';
import { usageColorsChanged } from './usageSettings';
import { setClaudeSettingEnv } from './paths';
import { ensureCodexLinks, isSharedCodexAccount } from './codex/codexShare';
import { StatusBar } from './statusBar';
import { registerCommands } from './commands';
import { affectsSetting, settingEnvNames } from './claudeSettings';
import { findBundledClaude } from './claudeUsage';
import { CodexAccountStore } from './codex/codexStore';
import { codexPanelSource, registerCodexCommands } from './codex/codexCommands';
import { checkSharedInBackground, registerToolCommands, runTool, type TerminalCheck, type ToolDeps } from './tools';
import { LinkCheckNotices } from './linkCheck';
import { registerDiagnosticsCommand } from './diagnosticsCommand';
import type { PanelMode } from './protocol';
import { setLocale, t } from './i18n';
import { isSupportedPlatform } from './platform';
import { migrateLegacyLanguage, resolveLocale, watchLocale } from './i18nVscode';
import { migrateLegacyCodex, upgradeRcBlocks } from './codex/codexState';
import { CodexUsageHistory } from './codex/codexUsageHistory';
import { ModelCache } from './codex/modelCache';
import { ClaudeModelCache } from './claudeModelCache';
import { findBundledCodex } from './codex/codexUsage';
import { codexDefaultDir } from './codex/codexPaths';
import { preserveProviderConfig } from './codex/codexProvider';
import { IdentityWarnings, claudeIdentity, codexIdentity, type IdentitySource } from './identityWarnings';
import { createUsageOrchestration } from './usageOrchestration';

// Official extensions whose bundled binaries answer usage queries (and start account terminals) when the CLI is not on PATH
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CODEX_EXTENSION_ID = 'openai.chatgpt';
// Background link checks of linked accounts run at most this often per window (on activation and on regaining focus)
const LINK_CHECK_MIN_MS = 10 * 60_000;

/**
 * Activation order matters: the UI locale is resolved first so every later string is localized; an unsupported
 * platform (not linux / win32 / darwin) only warns once and returns. Then the FileMemento state (with its one-time globalState
 * import), the Claude store, migrateLegacyCodex and upgradeRcBlocks each in their own try/catch (an error only
 * warns), and the Codex store. A
 * Codex initialization failure is logged and degrades the Codex page to an empty, disabled source: Claude is not
 * affected, Codex 'tool' messages still run, and every other Codex panel action and planswap.codex.* command shows the
 * error. The usage limits of both products (queues, monitors, background checks, notices, timers, refresh commands)
 * are one object from usageOrchestration.ts, wired to the panel, the status bar, the account-info watcher and the
 * settings here. Everything created here is disposed through ctx.subscriptions.
 */
export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const startedAt = performance.now();
  console.info('[planswap] activation started');
  // Resolve the UI locale before anything renders (a language set under the pre-rename key is carried over once)
  await migrateLegacyLanguage(ctx.globalState);
  setLocale(resolveLocale());
  if (!isSupportedPlatform()) {
    void vscode.window.showWarningMessage(t('ext.unsupportedPlatform'));
    return;
  }
  // Account lists, ignore lists and aliases live in ~/.config/planswap/state.json so they follow the WSL distribution (or the Windows user profile);
  // globalState is stored on the client and would be shared by every distro. Existing globalState data is imported once
  // The account info file name depends on what the Claude Code setting passes (custom OAuth URL)
  setClaudeSettingEnv(settingEnvNames());
  const state = new FileMemento();
  // A state file that cannot be created (an unwritable ~/.config, a file in place of its folder) is reported below
  let importError: Error | undefined;
  try {
    await state.importOnce(ctx.globalState);
  } catch (err) {
    importError = err instanceof Error ? err : new Error(String(err));
  }
  const store = new AccountStore(state);
  const claudeLabels = new LabelStore(state, 'claude.labels');
  const claudeExclusions = new RecommendExclusions(state, 'claude.recommendExcluded');
  // An existing state file that cannot be read or is not a JSON object makes every write fail (FileMemento never
  // rewrites it from an empty state) and reads as empty: say which file and why at once, whether or not anything
  // needs writing, and activate with what can be read instead of failing activation
  const readError = state.readError();
  const stateError = readError ?? importError;
  if (readError) void vscode.window.showErrorMessage(t('ext.stateUnreadable', { file: STATE_JSON(), error: readError.message }));
  else if (importError) void vscode.window.showErrorMessage(t('ext.stateSaveFailed', { file: STATE_JSON(), error: importError.message }));
  try {
    await store.syncWithDisk(claudeLabels, claudeExclusions);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[planswap] Claude account sync failed:', err);
    // The rejected write of an unusable state file repeats the error already reported; anything else is shown
    if (error !== stateError?.message) void vscode.window.showErrorMessage(t('ext.syncFailed', { error }));
  }
  const codexLabels = new LabelStore(state, 'codex.labels');
  const codexExclusions = new RecommendExclusions(state, 'codex.recommendExcluded');
  const usageHistory = new CodexUsageHistory(state);
  const modelCache = new ModelCache(state);
  const claudeModelCache = new ClaudeModelCache(state);

  // A Codex init failure is only logged and does not affect Claude: the Codex tab renders as "not enabled, no accounts"
  let codex: { store: CodexAccountStore; labels: LabelStore; exclusions: RecommendExclusions } | undefined;
  let codexSource: PanelSource = { accounts: () => [], enabled: () => false, pendingDir: () => undefined, watchTargets: () => [] };
  let codexInitError: string | undefined;
  // Setups written before the rename (ai-switcher) are migrated in place; on failure the Codex page shows the usual
  // pre-check reasons, and this warning says why
  try {
    migrateLegacyCodex();
  } catch (err) {
    void vscode.window.showWarningMessage(t('ext.codexLegacyFailed', { error: err instanceof Error ? err.message : String(err) }));
  }
  // Marker blocks written by an earlier version are brought to the current content; a failure only warns
  try {
    upgradeRcBlocks();
  } catch (err) {
    void vscode.window.showWarningMessage(t('ext.codexRcUpgradeFailed', { error: err instanceof Error ? err.message : String(err) }));
  }
  try {
    const codexStore = new CodexAccountStore(state);
    try {
      await codexStore.syncWithDisk(codexLabels, codexExclusions);
    } catch (err) {
      // An unusable state file was reported above and only blocks registering: Codex works with what can be read.
      // Any other error fails Codex initialization, as it does with a usable state file
      const error = err instanceof Error ? err.message : String(err);
      if (!stateError || error !== stateError.message) throw err;
      console.error('[planswap] Codex account sync failed:', err);
    }
    codexSource = codexPanelSource(codexStore, codexLabels, usageHistory, codexExclusions, modelCache);
    codex = { store: codexStore, labels: codexLabels, exclusions: codexExclusions };
  } catch (err) {
    codexInitError = err instanceof Error ? err.message : String(err);
    console.error('[planswap] Codex initialization failed:', err);
  }

  const statusBar = new StatusBar(store, claudeLabels, codex);

  const version = String(ctx.extension.packageJSON.version ?? '0');
  // The official extensions' bundled binaries answer usage queries (and start account terminals) when the CLI is not on PATH
  const bundledCodex = (): string | undefined => {
    const ext = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
    return ext && findBundledCodex(ext.extensionPath);
  };
  const bundledClaude = (): string | undefined => {
    const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
    return ext && findBundledClaude(ext.extensionPath);
  };
  // Usage limits of both products (usageOrchestration.ts): the queues, monitors, background checks, notices, timers
  // and manual refresh commands of this window. The panel is created below; the orchestration reaches it only later
  const usageOrchestration = createUsageOrchestration({
    version, state, store, claudeLabels, codex, usageHistory, statusBar, bundledClaude, bundledCodex, refreshPanel: () => panel.refresh(),
  });

  // Two registered accounts signed in to the same identity are pointed out once per situation
  const identitySources: IdentitySource[] = [
    { vendor: 'Claude', accounts: () => store.all().map((a) => ({ dir: a.dir, label: labelFor(a.name, claudeLabels) })), identityOf: claudeIdentity },
  ];
  if (codex) {
    const c = codex;
    identitySources.push({ vendor: 'Codex', accounts: () => c.store.all().map((a) => ({ dir: a.dir, label: labelFor(a.name, codexLabels) })), identityOf: (dir) => preserveProviderConfig(dir) ? undefined : codexIdentity(dir) });
  }
  const identityWarnings = new IdentityWarnings(identitySources);
  identityWarnings.check();
  void showEnvironmentWarnings(state);

  // "Account terminal open" checks of the two command modules (Windows busy signal), filled in when they register
  const terminalChecks: Partial<Record<PanelMode, TerminalCheck>> = {};
  // Toolbar dependencies
  const tools: ToolDeps = {
    accountBusy: (mode, dir) => terminalChecks[mode]?.(dir) ?? false,
    postVersions: (items) => panel.post({ type: 'versions', items }),
    claudeDirs: () => store.named().map((a) => a.dir),
    codexDirs: codex ? () => codex.store.named().map((a) => a.dir) : undefined,
    codexShareOps: codex
      ? { isShared: isSharedCodexAccount, refresh: (dir, options) => ensureCodexLinks(dir, options), check: (dir, options) => ({ report: ensureCodexLinks(dir, { ...options, check: true }) }), defaultDir: codexDefaultDir }
      : undefined,
    labelOf: (mode, dir) => {
      const account = mode === 'claude' ? store.findByDir(dir) : codex?.store.findByDir(dir);
      return account ? labelFor(account.name, mode === 'claude' ? claudeLabels : codexLabels) : path.basename(dir);
    },
    linkNotices: new LinkCheckNotices(state),
  };
  // Link check of the linked accounts in the focused window, at most every LINK_CHECK_MIN_MS: on activation
  // and on regaining focus. Problems are announced once per change (or again after a day) across windows
  // (LinkCheckNotices); Claude's missing default MCP servers are added first (add only, checkSharedInBackground),
  // nothing else is repaired without the user's Repair
  let lastLinkCheck: number | undefined;
  const checkLinks = (): void => {
    if (!vscode.window.state.focused || (lastLinkCheck !== undefined && Date.now() - lastLinkCheck < LINK_CHECK_MIN_MS)) return;
    lastLinkCheck = Date.now();
    // Each vendor on its own: a notification left open must not hold back the other vendor's check
    for (const mode of codex ? ['claude', 'codex'] as const : ['claude'] as const) {
      checkSharedInBackground(mode, tools).catch((err: unknown) => console.warn(`[planswap] link check failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  };
  checkLinks();

  const panel = new AccountsPanel(ctx.extensionUri, { claude: claudePanelSource(store, claudeLabels, claudeExclusions, usageOrchestration.subscriptionState, claudeModelCache), codex: codexSource }, ctx.globalState,
    { claude: new RecommendDismissals(state, 'claude.recommendDismissed'), codex: new RecommendDismissals(state, 'codex.recommendDismissed') });
  // Model lists that need no key load in the background after activation, so the API card forms offer them at once
  void modelCache.refreshPublic().then((changed) => { if (changed) panel.refresh(); }).catch(() => undefined);
  void claudeModelCache.refreshPublic().then((changed) => { if (changed) panel.refresh(); }).catch(() => undefined);
  // A stored observation of the effective Codex account (another window, an earlier session) is shown from the start
  usageOrchestration.adoptCached();
  // On init failure, Codex actions in the panel and Command Palette show a clear message instead of silently doing nothing
  if (codexInitError) {
    const notify = () => void vscode.window.showErrorMessage(t('ext.codexUnavailable', { error: codexInitError ?? '' }));
    // Toolbar messages are handled as usual
    panel.setHandler('codex', (msg) => (msg.type === 'tool' ? runTool('codex', msg.tool, tools) : notify()));
    for (const id of ['enable', 'disable', 'switchAccount', 'addAccount', 'shareAccount', 'removeAccount', 'openTerminal', 'restartServer', 'refreshUsage', 'refreshAllUsage']) {
      ctx.subscriptions.push(vscode.commands.registerCommand(`planswap.codex.${id}`, notify));
    }
  }

  ctx.subscriptions.push(
    panel,
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel),
    statusBar,
    ...registerCommands({ store, panel, statusBar, labels: claudeLabels, exclusions: claudeExclusions, codex, tools, modelCache: claudeModelCache, checkSubscription: usageOrchestration.checkSubscription,
      bundledClaude, provideTerminalCheck: (check) => { terminalChecks.claude = check; } }),
    ...(codex
      ? registerCodexCommands({ store: codex.store, panel, labels: codexLabels, exclusions: codexExclusions, tools, bundledCodex, modelCache, provideTerminalCheck: (check) => { terminalChecks.codex = check; } })
      : []),
    ...registerToolCommands(tools),
    registerDiagnosticsCommand({ store, codexStore: codex?.store, extensionVersion: version }),
    // Account info file changes only push panel state; keep the status bar email in sync here, re-check usage when the
    // effective account's auth.json changed (sign-in, re-login), and look for accounts signed in to the same identity
    panel.onDidChange(() => {
      statusBar.update();
      identityWarnings.check();
      usageOrchestration.onAccountInfoChanged();
    }),
    usageOrchestration,
    vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused) return;
      usageOrchestration.checkUsage();
      checkLinks();
    }),
    ...usageOrchestration.commands(),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // The Codex extension's run-in-WSL switch changes what the Codex section of the tooltip can say
      if (e.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux')) { statusBar.update(); panel.refresh(); }
      // Sidebar display, recommendations, shared colors and remaining/used display
      if (e.affectsConfiguration('planswap.sidebar') || usageColorsChanged(e) || e.affectsConfiguration('planswap.usageDisplay')) panel.refresh();
      usageOrchestration.onConfigurationChanged(e);
      if (!affectsSetting(e)) return;
      setClaudeSettingEnv(settingEnvNames());
      panel.refresh();
      statusBar.update();
      // A switched account is checked at once (when its last check is not recent)
      usageOrchestration.checkUsage();
    }),
    // Language setting changes apply immediately: re-render the panel and status bar
    watchLocale(() => {
      panel.refresh();
      statusBar.update();
    }),
  );
  console.info(`[planswap] activation complete: ${(performance.now() - startedAt).toFixed(1)}ms`);
}

// state.json key: ids of environment warnings the user chose never to see again (`claudeEnv:<names>`,
// `pathSpaces:<names>`, `oneDriveHome`). The ids are persisted: changing their format makes dismissed warnings reappear.
const DISMISSED_KEY = 'warnings.dismissed';

/**
 * Conditions outside PlanSwap that defeat account separation or endanger the account folders, shown once per window
 * until dismissed for good. An id carries the variable names, so a newly set variable is pointed out again. The promise
 * settles once every shown warning was answered (tests await it; activation does not).
 */
export async function showEnvironmentWarnings(
  state: StateMemento,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  setting: { set: readonly string[]; cleared?: readonly string[] } = settingEnvNames(),
): Promise<void> {
  const dismissed = (): string[] => state.get<string[]>(DISMISSED_KEY, []);
  const shown: Array<Thenable<void>> = [];
  const warn = (id: string, message: string): void => {
    if (dismissed().includes(id)) return;
    const never = t('common.dontShowAgain');
    shown.push(vscode.window.showWarningMessage(message, never).then(async (picked) => {
      if (picked !== never) return;
      try {
        // Under the lock, so a warning another window dismissed meanwhile stays dismissed
        await state.updateWith(DISMISSED_KEY, () => [...new Set([...dismissed(), id])]);
      } catch (err) {
        // The state file cannot be saved: say so instead of ignoring the click
        void vscode.window.showErrorMessage(t('ext.stateSaveFailed', { file: STATE_JSON(), error: err instanceof Error ? err.message : String(err) }));
      }
    }));
  };
  const overrides = claudeCredentialOverrides(env, setting);
  if (overrides.length) warn(`claudeEnv:${overrides.join(',')}`, t('warn.claudeEnvOverride', { names: overrides.join(', ') }));
  if (oneDriveHome(home, env)) warn('oneDriveHome', t('warn.oneDriveHome', { home }));
  const spaced = pathVarsWithSpaces(env);
  if (spaced.length) warn(`pathSpaces:${spaced.join(',')}`, t('warn.pathSpaces', { names: spaced.join(', ') }));
  await Promise.all(shown);
}

// No deferred work: timers and watchers are disposed through ctx.subscriptions
export function deactivate(): void {}
