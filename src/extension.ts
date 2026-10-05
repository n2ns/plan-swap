import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccountStore } from './accounts';
import { claudeCredentialOverrides, oneDriveHome, pathVarsWithSpaces } from './environmentWarnings';
import { AccountsPanel, VIEW_ID, claudePanelSource, type PanelSource } from './accountsPanel';
import { LabelStore, labelFor } from './labels';
import { FileMemento } from './fileState';
import { RecommendExclusions } from './recommend';
import { readAccountInfo, samePath, setClaudeSettingEnv } from './paths';
import { ensureCodexLinks, isSharedCodexAccount } from './codex/codexShare';
import { CLAUDE_REFRESH_ALL_USAGE_COMMAND, CLAUDE_REFRESH_USAGE_COMMAND, CODEX_REFRESH_ALL_USAGE_COMMAND, REFRESH_USAGE_COMMAND, StatusBar, claudeUsageFailureText, codexUsageFailureText } from './statusBar';
import { registerCommands } from './commands';
import { affectsSetting, currentDir, isExplicitConfigDir, settingEnv, settingEnvNames } from './claudeSettings';
import { findBundledClaude, oneAtATime, queryClaudeUsage, queryEach, readClaudeUsage, readUsageFetchedAt, type ClaudeQueryResult } from './claudeUsage';
import { ClaudeUsageMonitor } from './claudeUsageMonitor';
import { CodexAccountStore } from './codex/codexStore';
import { codexPanelSource, codexRunsInWsl, registerCodexCommands, restartServerInteractive } from './codex/codexCommands';
import { registerToolCommands, runTool, type TerminalCheck, type ToolDeps } from './tools';
import { registerDiagnosticsCommand } from './diagnosticsCommand';
import type { PanelMode } from './protocol';
import { setLocale, t } from './i18n';
import { isSupportedPlatform } from './platform';
import { migrateLegacyLanguage, resolveLocale, watchLocale } from './i18nVscode';
import { effectiveDir, migrateLegacyCodex } from './codex/codexState';
import { CodexUsageMonitor, queryCodexAccount } from './codex/codexUsageMonitor';
import { CodexUsageHistory } from './codex/codexUsageHistory';
import { findBundledCodex, readCodexUsageWithFallback, type UsageResult } from './codex/codexUsage';
import { readCodexAccountInfo } from './codex/codexPaths';
import { IdentityWarnings, claudeIdentity, codexIdentity, type IdentitySource } from './identityWarnings';
import { UsageCooldown } from './usageCooldown';
import { OtherAccountChecks } from './usageOthers';

// Official extensions whose bundled binaries answer usage queries when the CLI is not on PATH
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CODEX_EXTENSION_ID = 'openai.chatgpt';
// Re-render interval for usage values that expire, independent of the checks
const USAGE_TICK_MS = 60_000;
// planswap.usageCheckIntervalSeconds: how often automatic checks look for an account whose refresh interval has passed
const USAGE_CHECK_SECONDS = { min: 30, max: 600, default: 120 };
// The first automatic check waits until the window has finished starting up
const USAGE_FIRST_CHECK_MS = 20_000;
// planswap.<product>.usageAutoRefresh / usageRefreshMinutes; the interval is clamped to the range the manifest declares
// Claude's usage endpoint is rate limited per account (shared with the user's own sessions), so its floor is higher
const USAGE_MINUTES_MIN: Record<PanelMode, number> = { claude: 10, codex: 5 };
const USAGE_MINUTES_MAX = 1440;
const USAGE_MINUTES_DEFAULT = 15;

/** planswap.usageCheckIntervalSeconds in ms, clamped to the range the manifest declares. */
function usageCheckMs(): number {
  const seconds = vscode.workspace.getConfiguration('planswap').get<number>('usageCheckIntervalSeconds', USAGE_CHECK_SECONDS.default);
  const valid = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : USAGE_CHECK_SECONDS.default;
  return Math.min(USAGE_CHECK_SECONDS.max, Math.max(USAGE_CHECK_SECONDS.min, valid)) * 1000;
}

/** planswap.usageAutoRefreshCurrentOnly: automatic checks query only the current Claude / effective Codex account. */
function usageCurrentOnly(): boolean {
  return vscode.workspace.getConfiguration('planswap').get<boolean>('usageAutoRefreshCurrentOnly', false) === true;
}

/** Automatic usage checks of one product: on/off and the interval in ms. Manual refreshes do not depend on them. */
function usageSchedule(product: PanelMode): { auto: boolean; staleMs: number } {
  const config = vscode.workspace.getConfiguration('planswap');
  const minutes = config.get<number>(`${product}.usageRefreshMinutes`, USAGE_MINUTES_DEFAULT);
  const valid = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : USAGE_MINUTES_DEFAULT;
  return {
    auto: config.get<boolean>(`${product}.usageAutoRefresh`, true) !== false,
    staleMs: Math.min(USAGE_MINUTES_MAX, Math.max(USAGE_MINUTES_MIN[product], valid)) * 60_000,
  };
}

// planswap.<product>.usageTimeoutSeconds, clamped to the range the manifest declares; the defaults are the query
// modules' own defaults
const USAGE_TIMEOUT_SECONDS: Record<PanelMode, { min: number; max: number; default: number }> = {
  claude: { min: 10, max: 120, default: 30 },
  codex: { min: 5, max: 120, default: 15 },
};

/** The time limit in ms of one usage query of a product (scheduled, manual or refresh-all), read for every query. */
export function usageTimeoutMs(product: PanelMode): number {
  const range = USAGE_TIMEOUT_SECONDS[product];
  const seconds = vscode.workspace.getConfiguration('planswap').get<number>(`${product}.usageTimeoutSeconds`, range.default);
  const valid = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : range.default;
  return Math.min(range.max, Math.max(range.min, valid)) * 1000;
}

interface CooldownSplit<T> { due: T[]; skipped: T[]; waitMs: number }

/** Refresh-all targets that may be queried now, and those still in the manual cooldown (with the shortest wait left). */
function splitCooldown<T extends { dir: string }>(targets: T[], remaining: (dir: string) => number): CooldownSplit<T> {
  const split: CooldownSplit<T> = { due: [], skipped: [], waitMs: Infinity };
  for (const target of targets) {
    const left = remaining(target.dir);
    if (left > 0) {
      split.skipped.push(target);
      split.waitMs = Math.min(split.waitMs, left);
    } else split.due.push(target);
  }
  return split;
}

/** Seconds shown for a cooldown wait, rounded up so "try again in N s" is never too early. */
const cooldownSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/**
 * Activation order matters: the UI locale is resolved first so every later string is localized; an unsupported
 * platform (not linux / win32) only warns once and returns. Then the FileMemento state (with its one-time globalState
 * import), the Claude store, migrateLegacyCodex in its own try/catch (an error only warns), and the Codex store. A
 * Codex initialization failure is logged and degrades the Codex page to an empty, disabled source: Claude is not
 * affected, Codex 'tool' messages still run, and every other Codex panel action and planswap.codex.* command shows the
 * error. Everything created here is disposed through ctx.subscriptions.
 */
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
  // The account info file name depends on what the Claude Code setting passes (custom OAuth URL)
  setClaudeSettingEnv(settingEnvNames());
  const state = new FileMemento();
  await state.importOnce(ctx.globalState);
  const store = new AccountStore(state);
  const claudeLabels = new LabelStore(state, 'claude.labels');
  const claudeExclusions = new RecommendExclusions(state, 'claude.recommendExcluded');
  await store.syncWithDisk(claudeLabels, claudeExclusions);
  const codexLabels = new LabelStore(state, 'codex.labels');
  const codexExclusions = new RecommendExclusions(state, 'codex.recommendExcluded');
  const usageHistory = new CodexUsageHistory(state);

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
  try {
    const codexStore = new CodexAccountStore(state);
    await codexStore.syncWithDisk(codexLabels, codexExclusions);
    codexSource = codexPanelSource(codexStore, codexLabels, usageHistory, codexExclusions);
    codex = { store: codexStore, labels: codexLabels, exclusions: codexExclusions };
  } catch (err) {
    codexInitError = err instanceof Error ? err.message : String(err);
    console.error('[planswap] Codex initialization failed:', err);
  }

  const statusBar = new StatusBar(store, claudeLabels, codex);

  // Usage limits of this window's effective Codex account for the status bar tooltip. Only the focused window
  // queries, so several open windows do not all start codex; nothing runs when Codex runs inside WSL (Windows)
  const version = String(ctx.extension.packageJSON.version ?? '0');
  // API-key accounts have no ChatGPT usage limits (and the tooltip hides them): nothing is started for them
  const readCodex = async (dir: string, signal?: AbortSignal): Promise<UsageResult> => readCodexAccountInfo(dir).plan === 'API key'
    ? { ok: false, reason: 'notLoggedIn' }
    : readCodexUsageWithFallback(dir, () => {
      const ext = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
      return ext && findBundledCodex(ext.extensionPath);
    }, { clientVersion: version, signal, timeoutMs: usageTimeoutMs('codex') });
  // Every query of an account (scheduled, manual, refresh-all) starts its manual-refresh cooldown
  const codexCooldown = new UsageCooldown();
  // Every codex usage process of this window (effective account, other accounts, refresh-all) runs after the previous one ended
  const codexQueue = oneAtATime();
  // One query, marking its cooldown when it starts; codexQuery runs it in the queue
  const runCodexQuery = (dir: string, signal?: AbortSignal): Promise<UsageResult> => {
    codexCooldown.mark(dir);
    return readCodex(dir, signal);
  };
  const codexQuery = (dir: string, signal?: AbortSignal): Promise<UsageResult> => codexQueue(() => runCodexQuery(dir, signal));
  const usage = codex
    ? new CodexUsageMonitor(effectiveDir, (s) => {
      statusBar.setCodexUsage(s);
      if (!s.checking) panel.refresh();
    }, {
      read: (dir) => codexQuery(dir),
      staleMs: () => usageSchedule('codex').staleMs,
      onAccepted: (dir, result, stamp) => usageHistory.record(dir, result, stamp),
      cachedUsage: (dir) => usageHistory.get(dir),
    })
    : undefined;
  if (usage) statusBar.setCodexUsage(usage.current());
  // Usage limits of this window's current Claude account: claude refreshes the cache in the account's info file, which
  // the status bar and the panel read. Signed-out and non-subscription accounts start nothing
  // Every claude usage process of this window (scheduled, manual, all accounts) runs after the previous one ended
  const claudeQueue = oneAtATime();
  const claudeCooldown = new UsageCooldown();
  // Claude Code's usage cache tells when any window or terminal last fetched the account's usage
  const claudeCooldownLeft = (dir: string): number => claudeCooldown.remaining(dir, readUsageFetchedAt(dir, isExplicitConfigDir(dir)));
  // One query, marking its cooldown when it starts; claudeQuery runs it in the queue
  const runClaudeQuery = (dir: string, signal?: AbortSignal) => {
    claudeCooldown.mark(dir);
    return queryClaudeUsage(dir, isExplicitConfigDir(dir), {
      env: settingEnv(), signal, timeoutMs: usageTimeoutMs('claude'),
      fallback: () => {
        const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
        return ext && findBundledClaude(ext.extensionPath);
      },
    });
  };
  const claudeQuery = (dir: string, signal?: AbortSignal) => claudeQueue(() => runClaudeQuery(dir, signal));
  const claudeUsage = new ClaudeUsageMonitor(currentDir, (s) => {
    statusBar.setClaudeUsage(s);
    if (!s.checking) panel.refresh();
  }, {
    query: (dir) => claudeQuery(dir),
    eligible: (dir) => readAccountInfo(dir, isExplicitConfigDir(dir)).identity !== undefined,
    cachedAt: (dir) => readUsageFetchedAt(dir, isExplicitConfigDir(dir)),
    staleMs: () => usageSchedule('claude').staleMs,
  });
  statusBar.setClaudeUsage(claudeUsage.current());
  // Manual only: every registered signed-in Claude account, one claude process at a time, so rows can be compared
  // before switching. The result for the current account is handed to the monitor, which owns its tooltip state.
  // A second call while one runs is ignored; the unregistered external directory is not a target; accounts still in
  // the manual cooldown are skipped (and counted in the final message); cancelling aborts the running claude process
  let refreshingAll = false;
  const refreshAllClaudeUsage = async (): Promise<void> => {
    if (refreshingAll) return;
    const eligible = store.all()
      .filter((a) => readAccountInfo(a.dir, isExplicitConfigDir(a.dir)).identity !== undefined)
      .map((a) => ({ dir: a.dir, label: labelFor(a.name, claudeLabels) }));
    if (!eligible.length) {
      void vscode.window.showInformationMessage(t('claude.usageAllNone'));
      return;
    }
    const { due: targets, skipped, waitMs } = splitCooldown(eligible, claudeCooldownLeft);
    if (!targets.length) {
      void vscode.window.showInformationMessage(t('usage.allCooldown', { seconds: cooldownSeconds(waitMs) }));
      return;
    }
    const skippedNote = skipped.length ? ` ${t('usage.allSkipped', { n: skipped.length })}` : '';
    refreshingAll = true;
    try {
      const abort = new AbortController();
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: true },
        (progress, token) => {
          // Cancelling also ends the claude process that is running now
          token.onCancellationRequested(() => abort.abort());
          return queryEach(targets, async (dir): Promise<ClaudeQueryResult> => {
            // The current account was refreshed from its own button after this run started (running now, or within the
            // cooldown): join it or take its result instead of querying it a second time
            if (samePath(dir, currentDir())) {
              const joined = claudeUsage.current().checking;
              if (joined) await claudeUsage.refresh();
              if (joined || claudeCooldownLeft(dir) > 0) {
                const failure = claudeUsage.current().failure;
                return failure && samePath(failure.dir, dir) ? { ok: false, reason: failure.reason, detail: failure.detail } : { ok: true };
              }
            }
            const result = await claudeQuery(dir, abort.signal);
            if (!abort.signal.aborted) claudeUsage.record(dir, result);
            return result;
          }, (target, index) => progress.report({
            message: t('claude.usageAllProgress', { label: target.label, done: index + 1, total: targets.length }),
            increment: index === 0 ? 0 : 100 / targets.length,
          }), () => abort.signal.aborted);
        },
      );
      panel.refresh();
      statusBar.update();
      // A query ended by the cancellation is neither a success nor a failure
      const done = results.filter((r) => r.result.ok || r.result.detail !== 'cancelled' || !abort.signal.aborted);
      const failed = done.filter((r) => !r.result.ok);
      if (abort.signal.aborted) {
        void vscode.window.showInformationMessage(t('claude.usageAllCancelled', { ok: done.length - failed.length, n: targets.length }) + skippedNote);
      } else if (!failed.length) {
        void vscode.window.showInformationMessage(t('claude.usageAllDone', { n: results.length }) + skippedNote);
      }
      if (!failed.length) return;
      // At most three accounts are named so the notification stays readable
      const named = failed.slice(0, 3).map(({ target, result }) => {
        const text = result.ok ? '' : claudeUsageFailureText(result, readClaudeUsage(target.dir, isExplicitConfigDir(target.dir)) !== undefined);
        return `${target.label} (${text})`;
      });
      if (failed.length > 3) named.push(t('claude.usageAllMore', { n: failed.length - 3 }));
      void vscode.window.showWarningMessage(t('claude.usageAllFailed', { ok: done.length - failed.length, n: done.length, failures: named.join('; ') }) + (abort.signal.aborted ? '' : skippedNote));
    } finally {
      refreshingAll = false;
    }
  };
  // Manual only: every registered signed-in ChatGPT Codex account, one codex process at a time. The effective account
  // goes through the monitor, which owns its tooltip state; the others are recorded as observations when their sign-in
  // did not change while the query ran. Same re-entrancy, cooldown and cancellation rules as the Claude run; refused
  // with a warning when Codex runs inside WSL
  let refreshingAllCodex = false;
  const refreshAllCodexUsage = async (): Promise<void> => {
    if (!codex || !usage || refreshingAllCodex) return;
    if (codexRunsInWsl()) {
      void vscode.window.showWarningMessage(t('codex.win.runsInWsl'));
      return;
    }
    const eligible = codex.store.all()
      .filter((a) => {
        const info = readCodexAccountInfo(a.dir);
        return info.loggedIn && info.plan !== 'API key';
      })
      .map((a) => ({ dir: a.dir, label: labelFor(a.name, codexLabels) }));
    if (!eligible.length) {
      void vscode.window.showInformationMessage(t('codex.usageAllNone'));
      return;
    }
    const { due: targets, skipped, waitMs } = splitCooldown(eligible, (dir) => codexCooldown.remaining(dir));
    if (!targets.length) {
      void vscode.window.showInformationMessage(t('usage.allCooldown', { seconds: cooldownSeconds(waitMs) }));
      return;
    }
    const skippedNote = skipped.length ? ` ${t('usage.allSkipped', { n: skipped.length })}` : '';
    refreshingAllCodex = true;
    try {
      const abort = new AbortController();
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: true },
        (progress, token) => {
          // Cancelling also ends the codex process of an account other than the effective one
          token.onCancellationRequested(() => abort.abort());
          return queryEach(targets, async (dir): Promise<UsageResult> => {
            if (!samePath(dir, effectiveDir())) {
              const result = await queryCodexAccount(dir, (d) => codexQuery(d, abort.signal), (d, r, stamp) => usageHistory.record(d, r, stamp));
              // The history is not watched: show this account's row now instead of after the whole run
              panel.refresh();
              return result;
            }
            // A refresh from its own button that ran after this run started is not repeated; a running one is joined
            if (usage.current().checking || codexCooldown.remaining(dir) === 0) await usage.refresh();
            // No result: the monitor discarded the response because the sign-in changed while it ran
            return usage.current().result ?? { ok: false, reason: 'failed', detail: 'discarded' };
          }, (target, index) => progress.report({
            message: t('codex.usageAllProgress', { label: target.label, done: index + 1, total: targets.length }),
            increment: index === 0 ? 0 : 100 / targets.length,
          }), () => abort.signal.aborted);
        },
      );
      panel.refresh();
      statusBar.update();
      // A query ended by the cancellation is neither a success nor a failure
      const done = results.filter((r) => r.result.ok || r.result.detail !== 'cancelled' || !abort.signal.aborted);
      const failed = done.filter((r) => !r.result.ok);
      if (abort.signal.aborted) {
        void vscode.window.showInformationMessage(t('codex.usageAllCancelled', { ok: done.length - failed.length, n: targets.length }) + skippedNote);
      } else if (!failed.length) {
        void vscode.window.showInformationMessage(t('codex.usageAllDone', { n: results.length }) + skippedNote);
      }
      if (!failed.length) return;
      // At most three accounts are named so the notification stays readable
      const named = failed.slice(0, 3).map(({ target, result }) => `${target.label} (${result.ok ? '' : codexUsageFailureText(result)})`);
      if (failed.length > 3) named.push(t('claude.usageAllMore', { n: failed.length - 3 }));
      void vscode.window.showWarningMessage(t('codex.usageAllFailed', { ok: done.length - failed.length, n: done.length, failures: named.join('; ') }) + (abort.signal.aborted ? '' : skippedNote));
    } finally {
      refreshingAllCodex = false;
    }
  };
  // Manual single-account refreshes waiting or running, per product (refresh-all has its own flag)
  const manualRefreshes: Record<PanelMode, number> = { claude: 0, codex: 0 };
  const manualRefresh = async (product: PanelMode, refresh: () => Promise<void>): Promise<void> => {
    manualRefreshes[product]++;
    try { await refresh(); } finally { manualRefreshes[product]--; }
  };
  // Automatic checks of the registered accounts other than the current (Claude) / effective (Codex) one, which the
  // monitors check (OtherAccountChecks decides which are due). Manual refreshes come first: a run stops while one is
  // waiting or running, and a background query re-checks that when its turn in the product's queue comes, so it never
  // runs before or twice with a button's. Every query of an account, manual and failed ones included, counts as a check,
  // so after a button the background leaves that account alone for the refresh interval. Not with
  // planswap.usageAutoRefreshCurrentOnly; a run also stops when the window loses focus or automatic checks are turned off
  const othersAllowed = (product: PanelMode, refreshingAllOf: () => boolean) => (): boolean =>
    vscode.window.state.focused && usageSchedule(product).auto && !usageCurrentOnly() && !refreshingAllOf() && manualRefreshes[product] === 0;
  const claudeOthersAllowed = othersAllowed('claude', () => refreshingAll);
  const codexOthersAllowed = othersAllowed('codex', () => refreshingAllCodex);
  const latest = (...times: Array<number | undefined>): number | undefined => {
    const known = times.filter((at): at is number => at !== undefined);
    return known.length ? Math.max(...known) : undefined;
  };
  const otherClaudeChecks = new OtherAccountChecks({
    allowed: claudeOthersAllowed,
    staleMs: () => usageSchedule('claude').staleMs,
    checkedAt: (dir) => latest(readUsageFetchedAt(dir, isExplicitConfigDir(dir)), claudeCooldown.lastQueried(dir)),
    query: (dir) => claudeQueue(async () => {
      if (!claudeOthersAllowed()) return false;
      // The account may have become the current one meanwhile: the monitor then takes the result as its attempt
      claudeUsage.record(dir, await runClaudeQuery(dir));
      return true;
    }),
  });
  const otherCodexChecks = new OtherAccountChecks({
    allowed: codexOthersAllowed,
    staleMs: () => usageSchedule('codex').staleMs,
    checkedAt: (dir) => latest(usageHistory.get(dir)?.checkedAt, codexCooldown.lastQueried(dir)),
    query: (dir) => codexQueue(async () => {
      if (!codexOthersAllowed()) return false;
      await queryCodexAccount(dir, (d) => runCodexQuery(d), (d, r, stamp) => usageHistory.record(d, r, stamp));
      // The history is not watched: show this account's row now
      panel.refresh();
      return true;
    }),
  });
  const otherClaudeDirs = (): string[] => store.all().map((a) => a.dir)
    .filter((dir) => !samePath(dir, currentDir()) && readAccountInfo(dir, isExplicitConfigDir(dir)).identity !== undefined);
  const otherCodexDirs = (): string[] => (codex?.store.all() ?? []).map((a) => a.dir).filter((dir) => {
    if (samePath(dir, effectiveDir())) return false;
    const info = readCodexAccountInfo(dir);
    return info.loggedIn && info.plan !== 'API key';
  });
  // Account-info changes re-check Claude usage only after the first scheduled check, not during start-up
  let usageStarted = false;
  // Automatic checks of both products: 20 s after activation, every planswap.usageCheckIntervalSeconds (default 120 s), on regaining focus, after a usage setting change
  // and after a claudeCode.environmentVariables change (a switched account is checked at once). Only the focused window
  // queries; each product needs its usageAutoRefresh, and Codex is skipped while it runs inside WSL. The monitors'
  // refreshIfStale decides whether a query of the current / effective account is actually due, OtherAccountChecks
  // whether one of another registered account is
  const checkUsage = (): void => {
    usageStarted = true;
    if (!vscode.window.state.focused) return;
    if (usageSchedule('claude').auto) {
      void claudeUsage.refreshIfStale();
      if (!usageCurrentOnly()) void otherClaudeChecks.run(otherClaudeDirs());
    }
    if (usage && !codexRunsInWsl()) {
      if (usageSchedule('codex').auto) {
        void usage.refreshIfStale();
        if (!usageCurrentOnly()) void otherCodexChecks.run(otherCodexDirs());
      } else usage.adoptCached();
    }
  };
  const firstUsageCheck = setTimeout(checkUsage, USAGE_FIRST_CHECK_MS);
  let usageTick = setInterval(checkUsage, usageCheckMs());

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
  void showEnvironmentWarnings(state);

  // "Account terminal open" checks of the two command modules (Windows busy signal), filled in when they register
  const terminalChecks: Partial<Record<PanelMode, TerminalCheck>> = {};
  // Toolbar dependencies: no restart entry when Codex is not initialized
  const tools: ToolDeps = {
    accountBusy: (mode, dir) => terminalChecks[mode]?.(dir) ?? false,
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

  const panel = new AccountsPanel(ctx.extensionUri, { claude: claudePanelSource(store, claudeLabels, claudeExclusions), codex: codexSource }, ctx.globalState);
  // A stored observation of the effective Codex account (another window, an earlier session) is shown from the start
  usage?.adoptCached();
  // Re-render expiry even when no query is due, including accounts other than the effective one.
  const historyTick = setInterval(() => panel.refresh(), USAGE_TICK_MS);
  // On init failure, Codex actions in the panel and Command Palette show a clear message instead of silently doing nothing
  if (codexInitError) {
    const notify = () => void vscode.window.showErrorMessage(t('ext.codexUnavailable', { error: codexInitError ?? '' }));
    // Toolbar messages are handled as usual (runTool reports "not initialized" for restartServer)
    panel.setHandler('codex', (msg) => (msg.type === 'tool' ? runTool('codex', msg.tool, tools) : notify()));
    for (const id of ['enable', 'disable', 'switchAccount', 'addAccount', 'shareAccount', 'removeAccount', 'openTerminal', 'restartServer', 'refreshUsage', 'refreshAllUsage']) {
      ctx.subscriptions.push(vscode.commands.registerCommand(`planswap.codex.${id}`, notify));
    }
  }

  ctx.subscriptions.push(
    panel,
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel),
    statusBar,
    ...registerCommands({ store, panel, statusBar, labels: claudeLabels, exclusions: claudeExclusions, codex, tools, provideTerminalCheck: (check) => { terminalChecks.claude = check; } }),
    ...(codex
      ? registerCodexCommands({ store: codex.store, panel, labels: codexLabels, exclusions: codexExclusions, tools, provideTerminalCheck: (check) => { terminalChecks.codex = check; } })
      : []),
    ...registerToolCommands(tools),
    registerDiagnosticsCommand({ store, codexStore: codex?.store, extensionVersion: version }),
    // Account info file changes only push panel state; keep the status bar email in sync here, re-check usage when the
    // effective account's auth.json changed (sign-in, re-login), and look for accounts signed in to the same identity
    panel.onDidChange(() => {
      statusBar.update();
      // A sign-in of the current Claude account is checked at once; a recent check is not repeated
      if (usageStarted && vscode.window.state.focused && usageSchedule('claude').auto) void claudeUsage.refreshIfStale();
      // With automatic checks off nothing is queried, but a result of a previous sign-in is not shown for a new one,
      // and a stored observation under the current sign-in is shown
      if (usage && !codexRunsInWsl()) {
        if (usageSchedule('codex').auto) void usage.refreshIfAuthChanged();
        else {
          usage.clearIfAuthChanged();
          usage.adoptCached();
        }
      }
      identityWarnings.check();
    }),
    { dispose: () => { clearTimeout(firstUsageCheck); clearInterval(usageTick); clearInterval(historyTick); } },
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) checkUsage();
    }),
    vscode.commands.registerCommand(CLAUDE_REFRESH_USAGE_COMMAND, async () => {
      // A running query is joined; otherwise an account queried less than a minute ago is not asked again
      const left = claudeUsage.current().checking ? 0 : claudeCooldownLeft(currentDir());
      if (left > 0) {
        void vscode.window.showInformationMessage(t('usage.cooldown', { seconds: cooldownSeconds(left) }));
        return;
      }
      await manualRefresh('claude', () => claudeUsage.refresh());
    }),
    vscode.commands.registerCommand(CLAUDE_REFRESH_ALL_USAGE_COMMAND, () => refreshAllClaudeUsage()),
    ...(usage
      ? [vscode.commands.registerCommand(REFRESH_USAGE_COMMAND, async () => {
        if (codexRunsInWsl()) {
          void vscode.window.showWarningMessage(t('codex.win.runsInWsl'));
          return;
        }
        const left = usage.current().checking ? 0 : codexCooldown.remaining(effectiveDir());
        if (left > 0) {
          void vscode.window.showInformationMessage(t('usage.cooldown', { seconds: cooldownSeconds(left) }));
          return;
        }
        await manualRefresh('codex', () => usage.refresh());
      }), vscode.commands.registerCommand(CODEX_REFRESH_ALL_USAGE_COMMAND, () => refreshAllCodexUsage())]
      : []),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // The Codex extension's run-in-WSL switch changes what the Codex section of the tooltip can say
      if (e.affectsConfiguration('chatgpt.runCodexInWindowsSubsystemForLinux')) { statusBar.update(); panel.refresh(); }
      // Sidebar display settings (email, 5-hour and 7-day limits, Claude's model-specific limits) and remaining/used display
      if (e.affectsConfiguration('planswap.sidebar') || e.affectsConfiguration('planswap.usageDisplay')) panel.refresh();
      // Automatic usage checks turned on or a shorter interval: check now when due
      if (['claude', 'codex'].some((p) => e.affectsConfiguration(`planswap.${p}.usageAutoRefresh`) || e.affectsConfiguration(`planswap.${p}.usageRefreshMinutes`))
        || e.affectsConfiguration('planswap.usageAutoRefreshCurrentOnly')) checkUsage();
      // A new check interval replaces the timer at once
      if (e.affectsConfiguration('planswap.usageCheckIntervalSeconds')) {
        clearInterval(usageTick);
        usageTick = setInterval(checkUsage, usageCheckMs());
      }
      if (!affectsSetting(e)) return;
      setClaudeSettingEnv(settingEnvNames());
      panel.refresh();
      statusBar.update();
      // A switched account is checked at once (when its last check is not recent)
      checkUsage();
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
  state: vscode.Memento,
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
      if (picked === never) await state.update(DISMISSED_KEY, [...new Set([...dismissed(), id])]);
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
