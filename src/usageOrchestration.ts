// The usage-limit orchestration of one window, for both products: the query queues and cooldowns, the monitors of
// the current Claude / effective Codex account, the background checks of the other accounts, the subscription probes,
// the low-usage notices, the manual refresh commands and the timers. extension.ts creates one per activation
// (createUsageOrchestration) and wires it to the panel, the status bar and the settings; the settings readers of the
// planswap.usage* / notifications.* keys live here too. The product differences stay visible in the two halves of
// createUsageOrchestration; what they share (refresh-all, cooldowns, the other-account checks) comes from the usage*
// modules.
import * as vscode from 'vscode';
import type { AccountStore } from './accounts';
import { currentDir, isExplicitConfigDir, settingEnv } from './claudeSettings';
import { oneAtATime, queryClaudeUsage, readClaudeUsage, readUsageFetchedAt, type ClaudeQueryResult } from './claudeUsage';
import { ClaudeUsageMonitor, ClaudeUsageQueries } from './claudeUsageMonitor';
import { ClaudeSubscriptionChecks, queryClaudeSubscription } from './claudeSubscription';
import { hasClaudeProviderMarker } from './claudeProvider';
import type { CodexAccountStore } from './codex/codexStore';
import { codexRunsInWsl, warnCodexRunsInWsl } from './codex/codexSettings';
import { effectiveDir } from './codex/codexState';
import { CodexUsageMonitor, queryCodexAccount } from './codex/codexUsageMonitor';
import type { CodexUsageHistory } from './codex/codexUsageHistory';
import { readCodexUsageWithFallback, type UsageResult } from './codex/codexUsage';
import { readCodexAccountInfo } from './codex/codexPaths';
import { preserveProviderConfig } from './codex/codexProvider';
import type { StateMemento } from './fileState';
import { t } from './i18n';
import { claudeIdentity } from './identityWarnings';
import { EXTERNAL_NAME, labelFor, type LabelStore } from './labels';
import { findSameDir, samePath } from './paths';
import type { PanelMode } from './protocol';
import {
  CLAUDE_REFRESH_ALL_USAGE_COMMAND, CLAUDE_REFRESH_USAGE_COMMAND, CODEX_REFRESH_ALL_USAGE_COMMAND, REFRESH_USAGE_COMMAND, type StatusBar,
  claudeUsageFailureText, codexUsageFailureText, formatDuration, liveCodexUsage, relativeReset,
} from './statusBar';
import { UsageCooldown } from './usageCooldown';
import { LowUsageNotices, type NoticeProduct, type NoticeWindow } from './usageNotices';
import { OtherAccountChecks } from './usageOthers';
import { cooldownSeconds, createRefreshAll } from './usageRefreshAll';

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
export function usageCheckMs(): number {
  const seconds = vscode.workspace.getConfiguration('planswap').get<number>('usageCheckIntervalSeconds', USAGE_CHECK_SECONDS.default);
  const valid = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : USAGE_CHECK_SECONDS.default;
  return Math.min(USAGE_CHECK_SECONDS.max, Math.max(USAGE_CHECK_SECONDS.min, valid)) * 1000;
}

/** planswap.usageAutoRefreshCurrentOnly: automatic checks query only the current Claude / effective Codex account. */
export function usageCurrentOnly(): boolean {
  return vscode.workspace.getConfiguration('planswap').get<boolean>('usageAutoRefreshCurrentOnly', false) === true;
}

/** Automatic usage checks of one product: on/off and the interval in ms. Manual refreshes do not depend on them. */
export function usageSchedule(product: PanelMode): { auto: boolean; staleMs: number } {
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

/** planswap.notifications.enabled / threshold: low usage-limit notices on or off, and the remaining percentage at or
 *  below which they appear, clamped to the range the manifest declares (1–99, default 20). */
export function noticeSettings(): { enabled: boolean; threshold: number } {
  const config = vscode.workspace.getConfiguration('planswap');
  const value = config.get<number>('notifications.threshold', 20);
  const valid = typeof value === 'number' && Number.isFinite(value) ? value : 20;
  return { enabled: config.get<boolean>('notifications.enabled', true) !== false, threshold: Math.min(99, Math.max(1, valid)) };
}

export interface UsageDeps {
  /** The extension version, sent as the Codex app-server client version */
  version: string;
  /** PlanSwap's state file (LowUsageNotices) */
  state: StateMemento;
  store: AccountStore;
  claudeLabels: LabelStore;
  /** Absent when Codex initialization failed: nothing of Codex is queried then */
  codex?: { store: CodexAccountStore; labels: LabelStore };
  usageHistory: CodexUsageHistory;
  statusBar: StatusBar;
  /** Re-renders the sidebar; the panel exists only after the orchestration (it needs subscriptionState), so this is
   *  called only from queries, timers and commands, never while the orchestration is created */
  refreshPanel(): void;
  /** The official extensions' bundled CLIs, the fallbacks when `claude` / `codex` are not on PATH */
  bundledClaude(): string | undefined;
  bundledCodex(): string | undefined;
}

export interface UsageOrchestration extends vscode.Disposable {
  /** Whether the Claude account's subscription access was confirmed unavailable (the panel row and the status bar) */
  subscriptionState(dir: string): ReturnType<ClaudeSubscriptionChecks['state']>;
  /** The scheduled check of both products: the current / effective account when due, then the other registered
   *  accounts (also on regaining focus and after a usage setting change) */
  checkUsage(): void;
  /** Low usage-limit notices of the current / effective account, from what is cached */
  checkLowUsage(): void;
  /** After an account-info change: a sign-in of the current Claude account is checked at once, a changed Codex
   *  sign-in re-queried (or its stale result dropped), the low-usage notices re-checked */
  onAccountInfoChanged(): void;
  /** The usage-related settings: automatic checks and intervals (check now), notices (announce now), the check timer */
  onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void;
  /** The manual subscription re-check of a Claude account (an API card is ignored); a confirmed availability is
   *  followed by a usage query */
  checkSubscription(dir: string): Promise<void>;
  /** A stored observation of the effective Codex account is shown from the start */
  adoptCached(): void;
  /** The manual refresh commands: current / effective account and all accounts, per product */
  commands(): vscode.Disposable[];
}

/**
 * Creates the usage orchestration of this window. Only the focused window queries, so several open windows do not all
 * start the CLIs; every claude process of the window runs after the previous one (usage reads, subscription probes and
 * manual rechecks share one queue), and so does every codex process. Each query of an account starts its manual
 * cooldown. Nothing is started for signed-out accounts, API cards or a Claude account whose subscription access was
 * confirmed unavailable (automatic checks only; a manual refresh still queries it), and nothing of Codex while it runs
 * inside WSL on Windows. Timers: the first check 20 s after activation, then every planswap.usageCheckIntervalSeconds,
 * and a re-render every minute for values that expire. dispose() aborts the running claude process and stops the timers.
 */
export function createUsageOrchestration(deps: UsageDeps): UsageOrchestration {
  const { version, state, store, claudeLabels, codex, usageHistory, statusBar } = deps;
  const refreshPanel = (): void => deps.refreshPanel();

  // --- Codex: the effective account's usage for the status bar tooltip --------------------------------------------
  // API-key accounts have no ChatGPT usage limits (and the tooltip hides them): nothing is started for them
  const readCodex = async (dir: string, signal?: AbortSignal): Promise<UsageResult> => preserveProviderConfig(dir) || readCodexAccountInfo(dir).plan === 'API key'
    ? { ok: false, reason: 'notLoggedIn' }
    : readCodexUsageWithFallback(dir, deps.bundledCodex, { clientVersion: version, signal, timeoutMs: usageTimeoutMs('codex') });
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
      if (!s.checking) {
        refreshPanel();
        checkLowUsage();
      }
    }, {
      read: (dir) => codexQuery(dir),
      staleMs: () => usageSchedule('codex').staleMs,
      onAccepted: (dir, result, stamp) => usageHistory.record(dir, result, stamp),
      cachedUsage: (dir) => preserveProviderConfig(dir) ? undefined : usageHistory.get(dir),
    })
    : undefined;
  if (usage) statusBar.setCodexUsage(usage.current());

  // --- Claude: the current account's usage, refreshed by claude into the account's info file -----------------------
  // Signed-out and non-subscription accounts start nothing, and neither do API cards (claudeIdentity is undefined for
  // them, which every Claude usage and subscription path below checks)
  const claudeCooldown = new UsageCooldown();
  // Claude Code's usage cache tells when any window or terminal last fetched the account's usage
  const claudeCooldownLeft = (dir: string): number => claudeCooldown.remaining(dir, readUsageFetchedAt(dir, isExplicitConfigDir(dir)));
  // Usage reads and subscription probes share one process queue, including manual rechecks.
  const claudeProcessQueue = oneAtATime();
  const claudeAbort = new AbortController();
  const claudeOptions = (signal?: AbortSignal) => ({
    env: settingEnv(), signal: signal ? AbortSignal.any([signal, claudeAbort.signal]) : claudeAbort.signal,
    timeoutMs: usageTimeoutMs('claude'), fallback: deps.bundledClaude,
  });
  const subscription = new ClaudeSubscriptionChecks(
    (dir, explicit, signal) => queryClaudeSubscription(dir, explicit, claudeOptions(signal)),
    () => { refreshPanel(); statusBar.update(); },
  );
  const subscriptionState = (dir: string) => subscription.state(dir, isExplicitConfigDir(dir));
  statusBar.setClaudeSubscriptionUnavailable((dir) => subscriptionState(dir).unavailable);
  const runClaudeQuery = (dir: string, signal?: AbortSignal) => claudeProcessQueue(async () => {
    claudeCooldown.mark(dir);
    const explicit = isExplicitConfigDir(dir);
    const result = await queryClaudeUsage(dir, explicit, claudeOptions(signal));
    if (result.ok) subscription.acceptAvailable(dir, explicit);
    else if (result.reason === 'noUsage' && !signal?.aborted && !claudeAbort.signal.aborted) {
      await subscription.check(dir, explicit, false, signal);
    }
    return result;
  });
  const claudeQueries = new ClaudeUsageQueries(runClaudeQuery, {
    cachedAt: (dir) => readUsageFetchedAt(dir, isExplicitConfigDir(dir)),
    staleMs: () => usageSchedule('claude').staleMs,
  });
  const claudeQuery = (dir: string, signal?: AbortSignal) => claudeQueries.query(dir, signal);

  // --- Low usage-limit notices (usageNotices.ts) -------------------------------------------------------------------
  // Checked after every usage result, account-info change and automatic check tick. Only the focused window announces,
  // so the windows reacting to the same file change do not all show the notice
  const lowUsage = new LowUsageNotices(state);
  const announceLowUsage = async (
    product: NoticeProduct, dir: string, windows: readonly NoticeWindow[], limitReached: boolean, threshold: number,
    accounts: ReadonlyArray<{ name: string; dir: string }>, labels: LabelStore,
  ): Promise<void> => {
    const low = await lowUsage.take(product, dir, windows, threshold, limitReached);
    if (!low) return;
    const account = accounts[findSameDir(accounts.map((a) => a.dir), dir)];
    const open = t('usage.lowOpen');
    const picked = await vscode.window.showWarningMessage(t('usage.low', {
      product: product === 'claude' ? 'Claude' : 'Codex',
      label: labelFor(account ? account.name : EXTERNAL_NAME, labels),
      percent: low.remaining,
      window: formatDuration(low.window.windowMinutes!),
      reset: relativeReset(low.window.resetsAt!),
    }), open);
    if (picked === open) void vscode.commands.executeCommand('workbench.view.extension.planswap');
  };
  const checkLowUsage = (): void => {
    const settings = noticeSettings();
    if (!settings.enabled || !vscode.window.state.focused) return;
    const dir = currentDir();
    const explicit = isExplicitConfigDir(dir);
    const claudeWindows = claudeIdentity(dir) !== undefined && !subscriptionState(dir).unavailable ? readClaudeUsage(dir, explicit)?.windows : undefined;
    if (claudeWindows) void announceLowUsage('claude', dir, claudeWindows, false, settings.threshold, store.all(), claudeLabels);
    const result = usage?.current().result;
    const codexUsage = codex && result?.ok && !codexRunsInWsl() && !preserveProviderConfig(effectiveDir()) ? liveCodexUsage(result.usage) : undefined;
    if (codex && codexUsage) void announceLowUsage('codex', effectiveDir(), codexUsage.windows, codexUsage.limitReached, settings.threshold, codex.store.all(), codex.labels);
  };
  const claudeUsage = new ClaudeUsageMonitor(currentDir, (s) => {
    statusBar.setClaudeUsage(s);
    if (!s.checking) {
      refreshPanel();
      checkLowUsage();
    }
  }, {
    query: (dir) => claudeQuery(dir),
    queryIfStale: (dir) => claudeQueries.queryIfStale(dir, () => claudeIdentity(dir) !== undefined && !subscriptionState(dir).unavailable),
    // A confirmed unavailable account stops automatic checks only (claudeAutoRefresh); a manual refresh still queries it
    eligible: (dir) => claudeIdentity(dir) !== undefined,
    cachedAt: (dir) => readUsageFetchedAt(dir, isExplicitConfigDir(dir)),
    staleMs: () => usageSchedule('claude').staleMs,
  });
  statusBar.setClaudeUsage(claudeUsage.current());
  // Automatic check of the current account, none once its subscription access was confirmed unavailable
  const claudeAutoRefresh = (): void => {
    if (!subscriptionState(currentDir()).unavailable) void claudeUsage.refreshIfStale();
  };

  // --- Refresh all (usageRefreshAll.ts) ----------------------------------------------------------------------------
  // Manual only: every registered signed-in Claude account, one claude process at a time, so rows can be compared
  // before switching. The result for the current account is handed to the monitor, which owns its tooltip state.
  // A second call while one runs is ignored; the unregistered external directory is not a target; accounts still in
  // the manual cooldown are skipped (and counted in the final message); cancelling aborts the running claude process
  const refreshAllClaude = createRefreshAll<ClaudeQueryResult>({
    keys: { none: 'claude.usageAllNone', progress: 'claude.usageAllProgress', cancelled: 'claude.usageAllCancelled', done: 'claude.usageAllDone', failed: 'claude.usageAllFailed' },
    eligible: () => store.all()
      .filter((a) => claudeIdentity(a.dir) !== undefined)
      .map((a) => ({ dir: a.dir, label: labelFor(a.name, claudeLabels) })),
    cooldownLeft: claudeCooldownLeft,
    query: async (dir, signal) => {
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
      // Cancelling also ends the claude process that is running now
      const result = await claudeQuery(dir, signal);
      if (!signal.aborted) claudeUsage.record(dir, result);
      return result;
    },
    failureText: (dir, result) => claudeUsageFailureText(result, readClaudeUsage(dir, isExplicitConfigDir(dir)) !== undefined),
    afterRun: () => { refreshPanel(); statusBar.update(); },
  });
  // Manual only: every registered signed-in ChatGPT Codex account, one codex process at a time. The effective account
  // goes through the monitor, which owns its tooltip state; the others are recorded as observations when their sign-in
  // did not change while the query ran. Same re-entrancy, cooldown and cancellation rules as the Claude run (createRefreshAll);
  // refused with a warning when Codex runs inside WSL
  const refreshAllCodex = createRefreshAll<UsageResult>({
    keys: { none: 'codex.usageAllNone', progress: 'codex.usageAllProgress', cancelled: 'codex.usageAllCancelled', done: 'codex.usageAllDone', failed: 'codex.usageAllFailed' },
    eligible: () => (codex?.store.all() ?? [])
      .filter((a) => {
        if (preserveProviderConfig(a.dir)) return false;
        const info = readCodexAccountInfo(a.dir);
        return info.loggedIn && info.plan !== 'API key';
      })
      .map((a) => ({ dir: a.dir, label: labelFor(a.name, codex!.labels) })),
    cooldownLeft: (dir) => codexCooldown.remaining(dir),
    query: async (dir, signal) => {
      if (!samePath(dir, effectiveDir())) {
        // Cancelling also ends the codex process of an account other than the effective one
        const result = await queryCodexAccount(dir, (d) => codexQuery(d, signal), (d, r, stamp) => usageHistory.record(d, r, stamp));
        // The history is not watched: show this account's row now instead of after the whole run
        refreshPanel();
        return result;
      }
      // A refresh from its own button that ran after this run started is not repeated; a running one is joined
      if (usage!.current().checking || codexCooldown.remaining(dir) === 0) await usage!.refresh();
      // No result: the monitor discarded the response because the sign-in changed while it ran
      return usage!.current().result ?? { ok: false, reason: 'failed', detail: 'discarded' };
    },
    failureText: (_dir, result) => codexUsageFailureText(result),
    afterRun: () => { refreshPanel(); statusBar.update(); },
  });
  const refreshAllCodexUsage = async (): Promise<void> => {
    if (!codex || !usage) return;
    if (codexRunsInWsl()) {
      warnCodexRunsInWsl();
      return;
    }
    await refreshAllCodex.run();
  };
  // Manual single-account refreshes waiting or running, per product (refresh-all has its own flag)
  const manualRefreshes: Record<PanelMode, number> = { claude: 0, codex: 0 };
  const manualRefresh = async (product: PanelMode, refresh: () => Promise<void>): Promise<void> => {
    manualRefreshes[product]++;
    try { await refresh(); } finally { manualRefreshes[product]--; }
  };

  // --- The other registered accounts (usageOthers.ts) --------------------------------------------------------------
  // Automatic checks of the registered accounts other than the current (Claude) / effective (Codex) one, which the
  // monitors check (OtherAccountChecks decides which are due). Manual refreshes come first: a run stops while one is
  // waiting or running, and a background query re-checks that when its turn in the product's queue comes, so it never
  // runs before or twice with a button's. Every query of an account, manual and failed ones included, counts as a check,
  // so after a button the background leaves that account alone for the refresh interval. Not with
  // planswap.usageAutoRefreshCurrentOnly; a run also stops when the window loses focus or automatic checks are turned off
  const othersAllowed = (product: PanelMode, refreshingAllOf: () => boolean) => (): boolean =>
    vscode.window.state.focused && usageSchedule(product).auto && !usageCurrentOnly() && !refreshingAllOf() && manualRefreshes[product] === 0;
  const claudeOthersAllowed = othersAllowed('claude', refreshAllClaude.running);
  const codexOthersAllowed = othersAllowed('codex', refreshAllCodex.running);
  const latest = (...times: Array<number | undefined>): number | undefined => {
    const known = times.filter((at): at is number => at !== undefined);
    return known.length ? Math.max(...known) : undefined;
  };
  const otherClaudeChecks = new OtherAccountChecks({
    allowed: claudeOthersAllowed,
    staleMs: () => usageSchedule('claude').staleMs,
    checkedAt: (dir) => latest(readUsageFetchedAt(dir, isExplicitConfigDir(dir)), claudeCooldown.lastQueried(dir)),
    query: async (dir) => {
      const result = await claudeQueries.queryIfStale(dir, () => claudeOthersAllowed() && claudeIdentity(dir) !== undefined && !subscriptionState(dir).unavailable);
      if (!result) return claudeOthersAllowed() ? 'skipped' : false;
      // The account may have become the current one meanwhile: the monitor then takes the result as its attempt
      claudeUsage.record(dir, result);
      return true;
    },
  });
  const otherCodexChecks = new OtherAccountChecks({
    allowed: codexOthersAllowed,
    staleMs: () => usageSchedule('codex').staleMs,
    checkedAt: (dir) => preserveProviderConfig(dir) ? undefined : latest(usageHistory.get(dir)?.checkedAt, codexCooldown.lastQueried(dir)),
    query: (dir) => codexQueue(async () => {
      if (!codexOthersAllowed()) return false;
      if (preserveProviderConfig(dir)) return 'skipped' as const;
      await queryCodexAccount(dir, (d) => runCodexQuery(d), (d, r, stamp) => usageHistory.record(d, r, stamp));
      // The history is not watched: show this account's row now
      refreshPanel();
      return true;
    }),
  });
  const otherClaudeDirs = (): string[] => store.all().map((a) => a.dir)
    .filter((dir) => !samePath(dir, currentDir()) && claudeIdentity(dir) !== undefined && !subscriptionState(dir).unavailable);
  const otherCodexDirs = (): string[] => (codex?.store.all() ?? []).map((a) => a.dir).filter((dir) => {
    if (samePath(dir, effectiveDir()) || preserveProviderConfig(dir)) return false;
    const info = readCodexAccountInfo(dir);
    return info.loggedIn && info.plan !== 'API key';
  });

  // --- The scheduled check and the timers --------------------------------------------------------------------------
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
    checkLowUsage();
    if (usageSchedule('claude').auto) {
      claudeAutoRefresh();
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
  // Re-render expiry even when no query is due, including accounts other than the effective one.
  const historyTick = setInterval(refreshPanel, USAGE_TICK_MS);

  const cooldownNotice = (left: number): boolean => {
    if (left <= 0) return false;
    void vscode.window.showInformationMessage(t('usage.cooldown', { seconds: cooldownSeconds(left) }));
    return true;
  };

  return {
    subscriptionState,
    checkUsage,
    checkLowUsage,
    adoptCached: () => usage?.adoptCached(),
    onAccountInfoChanged: () => {
      // A sign-in of the current Claude account is checked at once; a recent check is not repeated
      if (usageStarted && vscode.window.state.focused && usageSchedule('claude').auto) claudeAutoRefresh();
      // With automatic checks off nothing is queried, but a result of a previous sign-in is not shown for a new one,
      // and a stored observation under the current sign-in is shown
      if (usage && !codexRunsInWsl()) {
        if (usageSchedule('codex').auto) void usage.refreshIfAuthChanged();
        else {
          usage.clearIfAuthChanged();
          usage.adoptCached();
        }
      }
      checkLowUsage();
    },
    onConfigurationChanged: (e) => {
      // Automatic usage checks turned on or a shorter interval: check now when due
      if (['claude', 'codex'].some((p) => e.affectsConfiguration(`planswap.${p}.usageAutoRefresh`) || e.affectsConfiguration(`planswap.${p}.usageRefreshMinutes`))
        || e.affectsConfiguration('planswap.usageAutoRefreshCurrentOnly')) checkUsage();
      // Notices turned on or a higher threshold: announce a window that is already low
      if (e.affectsConfiguration('planswap.notifications')) checkLowUsage();
      // A new check interval replaces the timer at once
      if (e.affectsConfiguration('planswap.usageCheckIntervalSeconds')) {
        clearInterval(usageTick);
        usageTick = setInterval(checkUsage, usageCheckMs());
      }
    },
    checkSubscription: async (dir) => {
      // An API card has no subscription
      if (hasClaudeProviderMarker(dir)) return;
      await manualRefresh('claude', () => claudeProcessQueue(async () => {
        const explicit = isExplicitConfigDir(dir);
        const result = await subscription.check(dir, explicit, true, claudeAbort.signal);
        if (result === 'available' && !claudeAbort.signal.aborted) {
          claudeCooldown.mark(dir);
          const usageResult = await queryClaudeUsage(dir, explicit, claudeOptions());
          claudeUsage.record(dir, usageResult);
          refreshPanel();
        }
      }));
    },
    commands: () => [
      vscode.commands.registerCommand(CLAUDE_REFRESH_USAGE_COMMAND, async () => {
        // A running query is joined; otherwise an account queried less than a minute ago is not asked again
        if (cooldownNotice(claudeUsage.current().checking ? 0 : claudeCooldownLeft(currentDir()))) return;
        await manualRefresh('claude', () => claudeUsage.refresh());
      }),
      vscode.commands.registerCommand(CLAUDE_REFRESH_ALL_USAGE_COMMAND, () => refreshAllClaude.run()),
      ...(usage
        ? [vscode.commands.registerCommand(REFRESH_USAGE_COMMAND, async () => {
          if (preserveProviderConfig(effectiveDir())) return;
          if (codexRunsInWsl()) {
            warnCodexRunsInWsl();
            return;
          }
          if (cooldownNotice(usage.current().checking ? 0 : codexCooldown.remaining(effectiveDir()))) return;
          await manualRefresh('codex', () => usage.refresh());
        }), vscode.commands.registerCommand(CODEX_REFRESH_ALL_USAGE_COMMAND, () => refreshAllCodexUsage())]
        : []),
    ],
    dispose: () => {
      claudeAbort.abort();
      clearTimeout(firstUsageCheck);
      clearInterval(usageTick);
      clearInterval(historyTick);
    },
  };
}
