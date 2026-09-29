import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccountStore } from './accounts';
import { claudeCredentialOverrides, oneDriveHome } from './environmentWarnings';
import { AccountsPanel, VIEW_ID, claudePanelSource, type PanelSource } from './accountsPanel';
import { LabelStore, labelFor } from './labels';
import { FileMemento } from './fileState';
import { ensureCodexLinks, isSharedCodexAccount } from './codex/codexShare';
import { REFRESH_USAGE_COMMAND, StatusBar } from './statusBar';
import { registerCommands } from './commands';
import { affectsSetting, settingEnvNames } from './claudeSettings';
import { CodexAccountStore } from './codex/codexStore';
import { codexPanelSource, codexRunsInWsl, registerCodexCommands, restartServerInteractive } from './codex/codexCommands';
import { registerToolCommands, runTool, type ToolDeps } from './tools';
import { setLocale, t } from './i18n';
import { isSupportedPlatform } from './platform';
import { migrateLegacyLanguage, resolveLocale, watchLocale } from './i18nVscode';
import { effectiveDir, migrateLegacyCodex } from './codex/codexState';
import { CodexUsageMonitor } from './codex/codexUsageMonitor';
import { findBundledCodex, readCodexUsageWithFallback } from './codex/codexUsage';
import { readCodexAccountInfo } from './codex/codexPaths';
import { IdentityWarnings, claudeIdentity, codexIdentity, type IdentitySource } from './identityWarnings';

// The Codex extension, whose bundled codex binary answers the usage query when the CLI is not on PATH
const CODEX_EXTENSION_ID = 'openai.chatgpt';
// While the window is focused, usage limits are re-checked once they are older than the stale interval
const USAGE_TICK_MS = 60_000;
const USAGE_FIRST_CHECK_MS = 5_000;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const startedAt = performance.now();
  console.info('[planswap] activation started');
  // Resolve the UI locale before anything renders (a language set under the pre-rename key is carried over once)
  await migrateLegacyLanguage(ctx.globalState);
  setLocale(resolveLocale());
  if (!isSupportedPlatform()) {
    void vscode.window.showWarningMessage(t('ext.linuxOnly'));
    return;
  }
  // Account lists, ignore lists and aliases live in ~/.config/planswap/state.json so they follow the WSL distribution (or the Windows user profile);
  // globalState is stored on the client and would be shared by every distro. Existing globalState data is imported once
  const state = new FileMemento();
  await state.importOnce(ctx.globalState);
  const store = new AccountStore(state);
  const claudeLabels = new LabelStore(state, 'claude.labels');
  await store.syncWithDisk(claudeLabels);
  const codexLabels = new LabelStore(state, 'codex.labels');

  // A Codex init failure is only logged and does not affect Claude: the Codex tab renders as "not enabled, no accounts"
  let codex: { store: CodexAccountStore; labels: LabelStore } | undefined;
  let codexSource: PanelSource = { accounts: () => [], enabled: () => false, pendingDir: () => undefined, watchTargets: () => [] };
  let codexInitError: string | undefined;
  // Setups written before the rename (ai-switcher) are migrated in place; on failure the Codex page shows the usual
  // pre-check reasons, and this warning says why
  try {
    migrateLegacyCodex();
  } catch (err) {
    void vscode.window.showWarningMessage(t('ext.codexLegacyFailed', { error: err instanceof Error ? err.message : String(err) }));
  }
  try {
    const codexStore = new CodexAccountStore(state);
    await codexStore.syncWithDisk(codexLabels);
    codexSource = codexPanelSource(codexStore, codexLabels);
    codex = { store: codexStore, labels: codexLabels };
  } catch (err) {
    codexInitError = err instanceof Error ? err.message : String(err);
    console.error('[planswap] Codex initialization failed:', err);
  }

  const statusBar = new StatusBar(store, claudeLabels, codex);

  // Usage limits of this window's effective Codex account for the status bar tooltip. Only the focused window
  // queries, so several open windows do not all start codex; nothing runs when Codex runs inside WSL (Windows)
  const version = String(ctx.extension.packageJSON.version ?? '0');
  const usage = codex
    ? new CodexUsageMonitor(effectiveDir, (s) => statusBar.setCodexUsage(s), {
      // API-key accounts have no ChatGPT usage limits (and the tooltip hides them): nothing is started for them
      read: async (dir) => readCodexAccountInfo(dir).plan === 'API key'
        ? { ok: false, reason: 'notLoggedIn' }
        : readCodexUsageWithFallback(dir, () => {
          const ext = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
          return ext && findBundledCodex(ext.extensionPath);
        }, { clientVersion: version }),
    })
    : undefined;
  if (usage) statusBar.setCodexUsage(usage.current());
  const checkUsage = (): void => {
    if (usage && vscode.window.state.focused && !codexRunsInWsl()) void usage.refreshIfStale();
  };
  const firstUsageCheck = setTimeout(checkUsage, USAGE_FIRST_CHECK_MS);
  const usageTick = setInterval(checkUsage, USAGE_TICK_MS);

  // Two registered accounts signed in to the same identity are pointed out once per situation
  const identitySources: IdentitySource[] = [
    { vendor: 'Claude', accounts: () => store.all().map((a) => ({ dir: a.dir, label: labelFor(a.name, claudeLabels) })), identityOf: claudeIdentity },
  ];
  if (codex) {
    const c = codex;
    identitySources.push({ vendor: 'Codex', accounts: () => c.store.all().map((a) => ({ dir: a.dir, label: labelFor(a.name, codexLabels) })), identityOf: codexIdentity });
  }
  const identityWarnings = new IdentityWarnings(identitySources);
  identityWarnings.check();
  showEnvironmentWarnings(state);

  // Toolbar dependencies: no restart entry when Codex is not initialized
  const tools: ToolDeps = {
    codexRestart: codex ? restartServerInteractive : undefined,
    postVersions: (items) => panel.post({ type: 'versions', items }),
    claudeDirs: () => store.named().map((a) => a.dir),
    codexDirs: codex ? () => codex.store.named().map((a) => a.dir) : undefined,
    codexShareOps: codex ? { isShared: isSharedCodexAccount, refresh: (dir, options) => ensureCodexLinks(dir, options) } : undefined,
    labelOf: (mode, dir) => {
      const account = mode === 'claude' ? store.findByDir(dir) : codex?.store.findByDir(dir);
      return account ? labelFor(account.name, mode === 'claude' ? claudeLabels : codexLabels) : path.basename(dir);
    },
  };

  const panel = new AccountsPanel(ctx.extensionUri, { claude: claudePanelSource(store, claudeLabels), codex: codexSource }, ctx.globalState);
  // On init failure, Codex actions in the panel and Command Palette show a clear message instead of silently doing nothing
  if (codexInitError) {
    const notify = () => void vscode.window.showErrorMessage(t('ext.codexUnavailable', { error: codexInitError ?? '' }));
    // Toolbar messages are handled as usual (runTool reports "not initialized" for restartServer)
    panel.setHandler('codex', (msg) => (msg.type === 'tool' ? runTool('codex', msg.tool, tools) : notify()));
    for (const id of ['enable', 'disable', 'switchAccount', 'addAccount', 'removeAccount', 'openTerminal', 'restartServer', 'refreshUsage']) {
      ctx.subscriptions.push(vscode.commands.registerCommand(`planswap.codex.${id}`, notify));
    }
  }

  ctx.subscriptions.push(
    panel,
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel),
    statusBar,
    ...registerCommands({ store, panel, statusBar, labels: claudeLabels, codex, tools }),
    ...(codex ? registerCodexCommands({ store: codex.store, panel, labels: codexLabels, tools }) : []),
    ...registerToolCommands(tools),
    // Account info file changes only push panel state; keep the status bar email in sync here, re-check usage when the
    // effective account's auth.json changed (sign-in, re-login), and look for accounts signed in to the same identity
    panel.onDidChange(() => {
      statusBar.update();
      if (usage && !codexRunsInWsl()) void usage.refreshIfAuthChanged();
      identityWarnings.check();
    }),
    { dispose: () => { clearTimeout(firstUsageCheck); clearInterval(usageTick); } },
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) checkUsage();
    }),
    ...(usage
      ? [vscode.commands.registerCommand(REFRESH_USAGE_COMMAND, async () => {
        if (codexRunsInWsl()) {
          void vscode.window.showWarningMessage(t('codex.win.runsInWsl'));
          return;
        }
        await usage.refresh();
      })]
      : []),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // The Codex extension's run-in-WSL switch changes what the Codex section of the tooltip can say
      if (e.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux')) statusBar.update();
      if (!affectsSetting(e)) return;
      panel.refresh();
      statusBar.update();
    }),
    // Language setting changes apply immediately: re-render the panel and status bar
    watchLocale(() => {
      panel.refresh();
      statusBar.update();
    }),
  );
  console.info(`[planswap] activation complete: ${(performance.now() - startedAt).toFixed(1)}ms`);
}

// state.json key: ids of environment warnings the user chose never to see again
const DISMISSED_KEY = 'warnings.dismissed';

// Conditions outside PlanSwap that defeat account separation or endanger the account folders, shown once per window
// until dismissed for good. An id carries the variable names, so a newly set variable is pointed out again
function showEnvironmentWarnings(state: FileMemento): void {
  const dismissed = (): string[] => state.get<string[]>(DISMISSED_KEY, []);
  const warn = (id: string, message: string): void => {
    if (dismissed().includes(id)) return;
    const never = t('common.dontShowAgain');
    void vscode.window.showWarningMessage(message, never).then(async (picked) => {
      if (picked === never) await state.update(DISMISSED_KEY, [...new Set([...dismissed(), id])]);
    });
  };
  const overrides = claudeCredentialOverrides(process.env, settingEnvNames());
  if (overrides.length) warn(`claudeEnv:${overrides.join(',')}`, t('warn.claudeEnvOverride', { names: overrides.join(', ') }));
  if (oneDriveHome(os.homedir(), process.env)) warn('oneDriveHome', t('warn.oneDriveHome', { home: os.homedir() }));
}

export function deactivate(): void {}
