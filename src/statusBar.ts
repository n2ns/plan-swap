// The PlanSwap status bar item and its HTML tooltip. Imports vscode.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { claudeJsonPath, findSameDir, readAccountInfo, samePath } from './paths';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import { EXTERNAL_NAME, labelFor, type LabelStore } from './labels';
import { getLocale, LOCALE_INFO, t, type MessageKey } from './i18n';
import type { CodexAccountStore } from './codex/codexStore';
import { codexDefaultDir, readCodexAccountInfo } from './codex/codexPaths';
import { effectiveDir, isEnabled, readSelectedDir } from './codex/codexState';
import { codexRunsInWsl } from './codex/codexCommands';
import type { CodexUsageState } from './codex/codexUsageMonitor';
import type { CodexUsage, UsageFailure, UsageWindow } from './codex/codexUsage';
import { USAGE_HISTORY_MAX_AGE_MS } from './codex/codexUsageHistory';
import { readClaudeUsage, type ClaudeUsage, type ClaudeUsageFailure, type ClaudeUsageWindow } from './claudeUsage';
import type { ClaudeUsageState } from './claudeUsageMonitor';

// Refresh commands; only the two single-account ones are trusted command links in the tooltip (buildTooltip)
export const REFRESH_USAGE_COMMAND = 'planswap.codex.refreshUsage';
export const CLAUDE_REFRESH_USAGE_COMMAND = 'planswap.claude.refreshUsage';
export const CLAUDE_REFRESH_ALL_USAGE_COMMAND = 'planswap.claude.refreshAllUsage';
export const CODEX_REFRESH_ALL_USAGE_COMMAND = 'planswap.codex.refreshAllUsage';

const CLAUDE_USAGE_FAILURE_MESSAGES: Record<ClaudeUsageFailure, MessageKey> = {
  cliMissing: 'status.claudeUsageCliMissing',
  timeout: 'status.claudeUsageTimeout',
  notRefreshed: 'status.claudeUsageNotRefreshed',
  noUsage: 'status.claudeUsageNone',
  failed: 'status.usageFailed',
};
const CODEX_USAGE_FAILURE_MESSAGES: Partial<Record<UsageFailure, MessageKey>> = {
  notLoggedIn: 'status.codexUsageNotLoggedIn',
  authExpired: 'status.codexUsageAuthExpired',
  cliMissing: 'status.codexUsageCliMissing',
  timeout: 'status.codexUsageTimeout',
};

// 300 → 5h, 10080 → 7d; anything that is not a whole hour stays in minutes
function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) return t('status.days', { n: minutes / 1440 });
  if (minutes % 60 === 0) return t('status.hours', { n: minutes / 60 });
  return t('status.minutes', { n: minutes });
}

// HTML text for content that is not ours (account labels, emails, plans, model names): line breaks become a space, and
// HTML, markdown and theme-icon metacharacters become numeric character references, so the text can never become a
// tag, link, icon or formatting (the tooltip is an HTML table, inside which markdown is not parsed anyway).
export function escapeHtml(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[&<>"'$\\`*_{}[\]()#+!|~]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A codicon in the HTML tooltip; the sanitizer keeps only `codicon codicon-<name>` classes. */
const icon = (name: string): string => `<span class="codicon codicon-${name}"></span>`;

/** Remaining percentage of a window, rounded down and clamped to 0..100. */
export function remainingOf(w: { usedPercent: number }): number {
  return Math.max(0, Math.min(100, Math.floor(100 - w.usedPercent)));
}

const BAR_CELLS = 10;

/**
 * Fixed-width progress bar of the remaining share: always 10 cells of █/░ (one Unicode block, so both glyphs share a
 * width); a non-empty window always shows at least one filled cell.
 */
export function usageBar(remaining: number): string {
  const clamped = Math.max(0, Math.min(100, remaining));
  const filled = clamped <= 0 ? 0 : Math.max(1, Math.round(clamped / 100 * BAR_CELLS));
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
}

/**
 * The window the status bar text states: among the general (not model-specific) windows the one with the shortest
 * duration (normally the 5-hour window); without durations, the first general window.
 */
export function shortWindow<W extends { usedPercent: number; windowMinutes?: number; scope?: string }>(windows: readonly W[]): W | undefined {
  const general = windows.filter((w) => !w.scope);
  let best: W | undefined;
  for (const w of general) {
    if (w.windowMinutes !== undefined && (best === undefined || w.windowMinutes < best.windowMinutes!)) best = w;
  }
  return best ?? general[0];
}

export interface StatusBarSettings {
  enabled: boolean;
  claude: boolean;
  codex: boolean;
  warningThreshold: number;
  errorThreshold: number;
  alignment: 'left' | 'right';
}

// A threshold setting clamped to 0..100 like the manifest range; anything that is not a number takes the default
function threshold(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
}

/** The planswap.statusBar.* settings, read on every update; unknown enum values take the defaults. */
export function statusBarSettings(): StatusBarSettings {
  const config = vscode.workspace.getConfiguration('planswap');
  const products = config.get<string>('statusBar.products', 'both');
  return {
    enabled: config.get<boolean>('statusBar.enabled', true) !== false,
    claude: products !== 'codex',
    codex: products !== 'claude',
    warningThreshold: threshold(config.get<number>('statusBar.warningThreshold'), 30),
    errorThreshold: threshold(config.get<number>('statusBar.errorThreshold'), 10),
    alignment: config.get<string>('statusBar.alignment', 'right') === 'left' ? 'left' : 'right',
  };
}

/**
 * The only two background colors a status bar item may use; thresholds are on the lowest remaining percentage:
 * <= errorThreshold error (it wins over warning), <= warningThreshold warning, otherwise (or undefined) none.
 */
export function backgroundIdFor(
  lowest: number | undefined,
  thresholds: Pick<StatusBarSettings, 'warningThreshold' | 'errorThreshold'> = { warningThreshold: 30, errorThreshold: 10 },
): 'statusBarItem.errorBackground' | 'statusBarItem.warningBackground' | undefined {
  if (lowest === undefined) return undefined;
  return lowest <= thresholds.errorThreshold ? 'statusBarItem.errorBackground'
    : lowest <= thresholds.warningThreshold ? 'statusBarItem.warningBackground' : undefined;
}

type DurationFormatConstructor = new (locale: string, options: { style: string }) => { format(duration: Record<string, number>): string };

/**
 * Time until a reset (unix seconds) as a short duration in the UI language with the two largest units, a zero unit
 * left out: "2d 5h" / "2天5小时", "5h 20m", "45m"; rounded up to the minute, never below one minute. Uses
 * Intl.DurationFormat with the locale's LOCALE_INFO durationStyle when available, else Intl.NumberFormat units. The
 * sidebar's src/webview/main.ts keeps a copy (the Webview cannot import host code); keep both in step.
 */
export function relativeReset(epochSeconds: number, now: number = Date.now()): string {
  const total = Math.max(1, Math.ceil((epochSeconds * 1000 - now) / 60000));
  const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60), minutes = total % 60;
  const parts = Object.entries(days ? { days, hours } : hours ? { hours, minutes } : { minutes }).filter(([, n]) => n > 0);
  const { intl: locale, durationStyle, durationUnitSeparator } = LOCALE_INFO[getLocale()];
  const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatConstructor }).DurationFormat;
  if (DurationFormat) return new DurationFormat(locale, { style: durationStyle }).format(Object.fromEntries(parts));
  // Without DurationFormat (Node 22): unit numbers in the same widths, joined as DurationFormat writes them
  const unit = { days: 'day', hours: 'hour', minutes: 'minute' } as Record<string, string>;
  return parts.map(([k, n]) => new Intl.NumberFormat(locale, { style: 'unit', unit: unit[k], unitDisplay: durationStyle }).format(n))
    .join(durationUnitSeparator);
}

/** Status bar text ("Claude 97% · Codex 82%"): product names with the remaining percentage of their short window when known. */
export function statusText(parts: ReadonlyArray<{ product: string; remaining?: number }>): string {
  return parts.map((p) => p.remaining === undefined ? p.product : t('status.textUsage', { product: p.product, percent: p.remaining })).join(' · ');
}

/** Screen reader label of the status bar item ("PlanSwap: Claude 97% left, Codex"). */
export function statusAccessibilityLabel(parts: ReadonlyArray<{ product: string; remaining?: number }>): string {
  const items = parts.map((p) => p.remaining === undefined ? p.product : `${p.product} ${t('status.remainingShort', { percent: p.remaining })}`);
  return `PlanSwap: ${items.join(', ')}`;
}

/**
 * One usage window as an HTML table row: name, bar, remaining percentage (with a warning mark at 0%), relative reset
 * time. The name is the duration ("5h"), `#n` without one, or "{window} · {scope}" for a model-specific window; the
 * reset cell is empty without a reset time.
 */
export function windowRow(w: UsageWindow | ClaudeUsageWindow, index: number, now: number = Date.now()): string {
  const duration = w.windowMinutes ? formatDuration(w.windowMinutes) : `#${index + 1}`;
  const scope = 'scope' in w ? w.scope : undefined;
  const name = scope ? t('status.scopedWindow', { window: duration, scope }) : duration;
  const remaining = remainingOf(w);
  const exhausted = Number((100 - w.usedPercent).toFixed(2)) <= 0;
  const percent = exhausted ? `${remaining}% ${icon('warning')} ${escapeHtml(t('status.exhausted'))}` : `${remaining}%`;
  const reset = w.resetsAt !== undefined ? `${icon('clock')} ${escapeHtml(relativeReset(w.resetsAt, now))}` : '';
  return `<tr><td>${escapeHtml(name)}</td><td>${usageBar(remaining)}</td><td align="right">${percent}</td><td align="right">${reset}</td></tr>`;
}

/** A refresh icon link running one of PlanSwap's own refresh commands; the hover title is our own localized text. */
export function refreshLink(command: string): string {
  return `<a href="command:${command}" title="${escapeHtml(t('status.refreshUsage'))}">${icon('refresh')}</a>`;
}

/**
 * All products as one HTML table (MarkdownString.supportHtml), so the bars, percentages and reset times of every product
 * share the same columns. A product starts with a header row whose email (bold) spans the name, bar and percentage
 * columns (colspan, which markdown tables lack), so it cannot widen the name column; the plan and the refresh link sit in
 * the right-aligned last column. Then one row per usage window and one full-width row per status line. Kept on one line:
 * a blank line would end the HTML block. Text from outside is escaped here or before.
 */
export interface TableBlock { identity: string; plan?: string; refresh?: string; rows: readonly string[]; notes: readonly string[] }
export function usageTable(blocks: readonly TableBlock[]): string {
  if (!blocks.length) return '';
  const rows = blocks.flatMap((block) => {
    const tail = [block.plan ? escapeHtml(block.plan) : '', block.refresh ?? ''].filter(Boolean).join(' ');
    return [
      `<tr><td colspan="3"><strong>${escapeHtml(block.identity)}</strong></td><td align="right">${tail}</td></tr>`,
      ...block.rows,
      ...block.notes.map((note) => `<tr><td colspan="4">${note}</td></tr>`),
    ];
  });
  return `<table>${rows.join('')}</table>`;
}

const italic = (text: string): string => `<em>${escapeHtml(text)}</em>`;

/** Shortest windows first; windows without a duration keep their order after the others. */
function byDuration<W extends { windowMinutes?: number }>(windows: readonly W[]): W[] {
  return windows.map((w, i) => ({ w, i })).sort((x, y) => (x.w.windowMinutes ?? Infinity) - (y.w.windowMinutes ?? Infinity) || x.i - y.i).map(({ w }) => w);
}

/** What a product block shows below its first line: window table rows and short italic status lines (already markdown). */
export interface UsageParts { rows: string[]; notes: string[] }

/**
 * The Codex observation as far as it may still be shown: undefined when older than 24 hours or dated more than two
 * minutes ahead; windows past their reset dropped.
 */
export function liveCodexUsage(usage: CodexUsage, now: number = Date.now()): CodexUsage | undefined {
  const age = now - usage.checkedAt;
  if (age >= USAGE_HISTORY_MAX_AGE_MS || age < -2 * 60_000) return undefined;
  return { ...usage, windows: usage.windows.filter((w) => w.resetsAt === undefined || w.resetsAt * 1000 > now) };
}

/** Windows of the effective Codex account that may be shown, or undefined (no state, a failure, a stale observation). */
function codexWindows(state: CodexUsageState | undefined, now: number): UsageWindow[] | undefined {
  const r = state?.result;
  return r?.ok ? liveCodexUsage(r.usage, now)?.windows : undefined;
}

/**
 * Table rows and status lines for the effective Codex account's usage limits; empty when there is nothing to say (signed
 * out). Rows: the live windows sorted by duration. Notes (italic): limit reached, a failure other than notLoggedIn,
 * then "checking" while a query runs.
 */
export function codexUsageParts(state: CodexUsageState | undefined, now: number = Date.now()): UsageParts {
  const parts: UsageParts = { rows: [], notes: [] };
  if (!state) return parts;
  const r = state.result;
  if (r?.ok) {
    const usage = liveCodexUsage(r.usage, now);
    if (usage) {
      parts.rows.push(...byDuration(usage.windows).map((w, i) => windowRow(w, i, now)));
      if (usage.limitReached) parts.notes.push(`<em>${icon('warning')} ${escapeHtml(t('status.usageReached'))}</em>`);
    }
  } else if (r && r.reason !== 'notLoggedIn') {
    parts.notes.push(italic(t('status.usageFailedShort')));
  }
  if (state.checking) parts.notes.push(italic(t('status.usageChecking')));
  return parts;
}

/**
 * Table rows and status lines for the current Claude account: the general windows sorted by duration (model-specific
 * ones are never shown here), then the refresh state of that directory: "checking", else a failure recorded for `dir`
 * (a failure of another directory is not shown).
 */
export function claudeUsageParts(
  usage: ClaudeUsage | undefined, state: ClaudeUsageState | undefined, dir: string, now: number = Date.now(),
): UsageParts {
  const parts: UsageParts = { rows: [], notes: [] };
  if (usage) {
    parts.rows.push(...byDuration(usage.windows.filter((w) => !w.scope)).map((w, i) => windowRow(w, i, now)));
  }
  if (state?.checking) parts.notes.push(italic(t('status.usageChecking')));
  else if (state?.failure && samePath(state.failure.dir, dir)) parts.notes.push(italic(t('status.usageFailedShort')));
  return parts;
}

/**
 * The localized plain text of a failed Claude usage query, used by the refresh-all warning; hasUsage: whether older
 * values are still shown. `failed` without detail gives the unknown-error text.
 */
export function claudeUsageFailureText(failure: { reason: ClaudeUsageFailure; detail?: string }, hasUsage: boolean): string {
  // Without values to show (too old, or all reset), "could not be refreshed" must not point at shown values
  return failure.reason === 'failed' && !failure.detail ? t('status.usageUnknownError', { detail: '' })
    : failure.reason === 'notRefreshed' && !hasUsage ? t('status.claudeUsageRefreshFailed')
      : t(CLAUDE_USAGE_FAILURE_MESSAGES[failure.reason], { detail: failure.detail ?? '' });
}

/**
 * Localized plain text of one failed Codex query, used by the refresh-all warning: notLoggedIn / authExpired / cliMissing /
 * timeout have their own text; other reasons give the generic failure with the detail (or the reason), and `failed`
 * without detail the unknown-error text.
 */
export function codexUsageFailureText(failure: { reason: UsageFailure; detail?: string }): string {
  const key = CODEX_USAGE_FAILURE_MESSAGES[failure.reason];
  if (key) return t(key);
  // A response discarded because the sign-in changed while the query ran
  if (failure.reason === 'failed' && failure.detail === 'discarded') return t('status.codexUsageDiscarded');
  return failure.detail || failure.reason !== 'failed' ? t('status.usageFailed', { detail: failure.detail ?? failure.reason })
    : t('status.usageUnknownError', { detail: '' });
}

interface Block {
  // First line: the email, or its fallback
  identity: string;
  // Shown at the right end of the first line; absent for no plan (and for the Codex API key mode, where identity says it)
  plan?: string;
  // Refresh command linked after the plan; absent when the product shows no usage
  refresh?: string;
  usage: UsageParts;
}

interface Product { product: string; remaining?: number }
interface Candidate { remaining: number; product: string; window: string }

// The lowest remaining percentage among the general windows (model-specific ones never count)
function candidatesOf(product: string, windows: ReadonlyArray<UsageWindow | ClaudeUsageWindow>): Candidate[] {
  return windows.flatMap((w, index) => ('scope' in w && w.scope) ? [] : [{
    remaining: remainingOf(w), product, window: w.windowMinutes ? formatDuration(w.windowMinutes) : `#${index + 1}`,
  }]);
}

/**
 * The PlanSwap status bar item; a click opens the PlanSwap view. The planswap.statusBar.* settings (statusBarSettings)
 * apply on every update, and a change of any of them updates at once: enabled off hides the item, products leaves a vendor out of the text, tooltip and background,
 * the thresholds pick the background, and an alignment change replaces the item (a status bar item's side is fixed).
 *
 * A selected vendor is shown when its effective configuration directory or a registered account directory exists (Claude also
 * when its resolved .claude.json exists); no network access or sign-in is needed, and with neither vendor the item is
 * hidden. Without a Codex store (initialization failed) only Claude is shown. Registered rows are matched with
 * findSameDir, so another spelling of a folder keeps its registered label. Codex identity comes from effectiveDir(),
 * never from the pending selection.
 *
 * Text: `$(dashboard)` + statusText; a product's percentage is the short window of the Claude cache (subscription
 * sign-in only; readClaudeUsage yields nothing for a cache attributed to another sign-in) or of the live Codex result
 * (signed in, not API key, not codexRunsInWsl()). The background follows the lowest remaining percentage over the
 * general windows of both products (never model-specific ones).
 *
 * Tooltip: one usageTable with one block per vendor. Identity is the email; without one, a Codex API key account shows
 * "API key" (and no plan), another signed-in account its label, a signed-out one "Not logged in". Codex notes in order:
 * the pending selection (only while switching is enabled and the selected and effective directories differ; an
 * unreadable switching configuration shows none), the run-in-WSL note (instead of usage), then codexUsageParts. A
 * vendor's refresh link appears only when it shows usage and its usage state is set.
 */
export class StatusBar implements vscode.Disposable {
  private alignment = statusBarSettings().alignment;
  private item = createItem(this.alignment);
  private readonly settingsListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('planswap.statusBar')) this.update();
  });
  private codexUsage: CodexUsageState | undefined;
  private claudeUsage: ClaudeUsageState | undefined;

  constructor(
    private readonly store: AccountStore,
    private readonly labels: LabelStore,
    private readonly codex?: { store: CodexAccountStore; labels: LabelStore },
  ) {
    this.update();
  }

  /** Usage limits of the effective Codex account, kept by CodexUsageMonitor; undefined hides the section. */
  setCodexUsage(state: CodexUsageState | undefined): void {
    this.codexUsage = state;
    this.update();
  }

  /** Refresh state of the current Claude account's usage, kept by ClaudeUsageMonitor; undefined hides its status lines. */
  setClaudeUsage(state: ClaudeUsageState | undefined): void {
    this.claudeUsage = state;
    this.update();
  }

  update(): void {
    const settings = statusBarSettings();
    if (settings.alignment !== this.alignment) {
      this.item.dispose();
      this.alignment = settings.alignment;
      this.item = createItem(this.alignment);
    }
    if (!settings.enabled) {
      this.item.hide();
      return;
    }
    const now = Date.now();
    const products: Product[] = [];
    const blocks: Block[] = [];
    const candidates: Candidate[] = [];
    const dir = currentDir();
    const explicit = isExplicitConfigDir(dir);
    const hasClaude = settings.claude && (fs.existsSync(dir) || fs.existsSync(claudeJsonPath(dir, explicit)) ||
      this.store.named().some((account) => fs.existsSync(account.dir)));
    if (hasClaude) {
      const account = sameDirAccount(this.store.all(), dir);
      const label = labelFor(account ? account.name : EXTERNAL_NAME, this.labels);
      const info = readAccountInfo(dir, explicit);
      // Usage limits exist only for a subscription sign-in (oauthAccount); signed-out accounts show none
      const showUsage = info.identity !== undefined;
      const usage = showUsage ? readClaudeUsage(dir, explicit) : undefined;
      const short = usage ? shortWindow(usage.windows) : undefined;
      products.push({ product: 'Claude', remaining: short ? remainingOf(short) : undefined });
      if (usage) candidates.push(...candidatesOf('Claude', usage.windows));
      blocks.push({
        identity: info.email ?? (info.loggedIn ? label : t('common.notLoggedIn')),
        plan: info.plan,
        refresh: showUsage && this.claudeUsage !== undefined ? CLAUDE_REFRESH_USAGE_COMMAND : undefined,
        usage: showUsage ? claudeUsageParts(usage, this.claudeUsage, dir, now) : { rows: [], notes: [] },
      });
    }
    const codexDir = effectiveDir();
    if (this.codex && settings.codex && (fs.existsSync(codexDir) || this.codex.store.all().some((account) => fs.existsSync(account.dir)))) {
      const all = this.codex.store.all();
      const account = sameDirAccount(all, codexDir);
      const label = labelFor(account ? account.name : EXTERNAL_NAME, this.codex.labels);
      const info = readCodexAccountInfo(codexDir);
      const apiKey = info.plan === 'API key';
      const usage: UsageParts = { rows: [], notes: [] };
      const selected = readSelectedDir() ?? codexDefaultDir();
      // A selection is only pending while PlanSwap manages CODEX_HOME (as on the panel, an unreadable rc file counts as
      // not enabled)
      if (codexSwitchingEnabled() && findSameDir([selected], codexDir) !== 0) {
        const pendingAccount = sameDirAccount(all, selected);
        const pending = pendingAccount ? labelFor(pendingAccount.name, this.codex.labels) : selected;
        usage.notes.push(italic(t('status.codexPending', { label: pending })));
      }
      // Codex run inside WSL by a Windows editor uses another home: its limits are not this account's
      const inWsl = codexRunsInWsl();
      const showUsage = !inWsl && !apiKey && info.loggedIn;
      if (inWsl) usage.notes.push(italic(t('status.codexRunsInWsl')));
      let remaining: number | undefined;
      if (showUsage) {
        const shown = codexUsageParts(this.codexUsage, now);
        usage.rows.push(...shown.rows);
        usage.notes.push(...shown.notes);
        const windows = codexWindows(this.codexUsage, now);
        const short = windows ? shortWindow(windows) : undefined;
        remaining = short ? remainingOf(short) : undefined;
        if (windows) candidates.push(...candidatesOf('Codex', windows));
      }
      products.push({ product: 'Codex', remaining });
      blocks.push({
        identity: apiKey ? 'API key' : info.email ?? (info.loggedIn ? label : t('common.notLoggedIn')),
        plan: apiKey ? undefined : info.plan,
        refresh: showUsage && this.codexUsage !== undefined ? REFRESH_USAGE_COMMAND : undefined,
        usage,
      });
    }
    // The color follows the window that runs out first, whichever it is; the text shows the short window only
    let lowest: Candidate | undefined;
    for (const c of candidates) if (!lowest || c.remaining < lowest.remaining) lowest = c;
    const background = backgroundIdFor(lowest?.remaining, settings);
    this.item.text = products.length ? `$(dashboard) ${statusText(products)}` : '';
    this.item.accessibilityInformation = products.length ? { label: statusAccessibilityLabel(products), role: 'button' } : undefined;
    this.item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
    this.item.tooltip = buildTooltip(blocks);
    if (products.length) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    this.settingsListener.dispose();
    this.item.dispose();
  }
}

// A new PlanSwap item on the given side; a click opens the PlanSwap view
function createItem(alignment: StatusBarSettings['alignment']): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right);
  item.command = 'workbench.view.extension.planswap';
  item.name = 'PlanSwap';
  return item;
}

// The registered account of dir, matched like the panel rows (another spelling of the folder counts as the same)
function sameDirAccount<T extends { dir: string }>(accounts: T[], dir: string): T | undefined {
  return accounts[findSameDir(accounts.map((a) => a.dir), dir)];
}

function codexSwitchingEnabled(): boolean {
  try {
    return isEnabled();
  } catch {
    return false;
  }
}

// Everything from outside (labels, emails, plans, model names) is escaped by escapeHtml when the block is assembled, so
// only our own markup (the table, emphasis, bars, codicons, the refresh links) can act as HTML. Only the two
// single-account refresh commands are trusted (isTrusted.enabledCommands).
function buildTooltip(blocks: Block[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.supportHtml = true;
  md.isTrusted = { enabledCommands: [CLAUDE_REFRESH_USAGE_COMMAND, REFRESH_USAGE_COMMAND] };
  md.appendMarkdown(usageTable(blocks.map((block) => ({
    identity: block.identity, plan: block.plan, refresh: block.refresh && refreshLink(block.refresh), rows: block.usage.rows, notes: block.usage.notes,
  }))));
  return md;
}
