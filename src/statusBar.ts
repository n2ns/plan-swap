import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { claudeJsonPath, findSameDir, readAccountInfo, samePath } from './paths';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import { EXTERNAL_NAME, labelFor, type LabelStore } from './labels';
import { getLocale, t, type Locale, type MessageKey } from './i18n';
import type { CodexAccountStore } from './codex/codexStore';
import { codexDefaultDir, readCodexAccountInfo } from './codex/codexPaths';
import { effectiveDir, isEnabled, readSelectedDir } from './codex/codexState';
import { codexRunsInWsl } from './codex/codexCommands';
import type { CodexUsageState } from './codex/codexUsageMonitor';
import type { CodexUsage, UsageWindow } from './codex/codexUsage';
import { USAGE_HISTORY_MAX_AGE_MS } from './codex/codexUsageHistory';
import { readClaudeUsage, type ClaudeUsage, type ClaudeUsageFailure, type ClaudeUsageWindow } from './claudeUsage';
import type { ClaudeUsageState } from './claudeUsageMonitor';

export const REFRESH_USAGE_COMMAND = 'planswap.codex.refreshUsage';
export const CLAUDE_REFRESH_USAGE_COMMAND = 'planswap.claude.refreshUsage';
export const CLAUDE_REFRESH_ALL_USAGE_COMMAND = 'planswap.claude.refreshAllUsage';

const INTL_LOCALES: Record<Locale, string> = { en: 'en', 'zh-cn': 'zh-CN', es: 'es', ja: 'ja' };
const CLAUDE_USAGE_FAILURE_MESSAGES: Record<ClaudeUsageFailure, MessageKey> = {
  cliMissing: 'status.claudeUsageCliMissing',
  timeout: 'status.claudeUsageTimeout',
  notRefreshed: 'status.claudeUsageNotRefreshed',
  noUsage: 'status.claudeUsageNone',
  failed: 'status.usageFailed',
};

// 300 → 5h, 10080 → 7d; anything that is not a whole hour stays in minutes
function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) return t('status.days', { n: minutes / 1440 });
  if (minutes % 60 === 0) return t('status.hours', { n: minutes / 60 });
  return t('status.minutes', { n: minutes });
}

// Markdown for text that is not ours (account labels, emails, model names):
// every markdown and theme-icon metacharacter is escaped, so it can never become a link, icon or formatting.
export function escapeMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()#+\-.!|<>~&$]/g, '\\$&');
}

/** Remaining percentage of a window, rounded down. */
export function remainingOf(w: { usedPercent: number }): number {
  return Math.max(0, Math.min(100, Math.floor(100 - w.usedPercent)));
}

const BAR_CELLS = 10;

/** Fixed-width progress bar of the remaining share; a non-empty window always shows at least one filled cell. */
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

/** The only two background colors a status bar item may use; thresholds are on the lowest remaining percentage. */
export function backgroundIdFor(lowest: number | undefined): 'statusBarItem.errorBackground' | 'statusBarItem.warningBackground' | undefined {
  if (lowest === undefined) return undefined;
  return lowest <= 10 ? 'statusBarItem.errorBackground' : lowest <= 30 ? 'statusBarItem.warningBackground' : undefined;
}

type DurationFormatConstructor = new (locale: string, options: { style: string }) => { format(duration: Record<string, number>): string };

/**
 * Time until a reset (unix seconds) as a short duration in the UI language with the two largest units, a zero unit
 * left out: "2d 5h" / "2天5小时", "5h 20m", "45m"; rounded up to the minute, never below one minute. The sidebar's
 * src/webview/main.ts keeps a copy (the Webview cannot import host code); keep both in step.
 */
export function relativeReset(epochSeconds: number, now: number = Date.now()): string {
  const total = Math.max(1, Math.ceil((epochSeconds * 1000 - now) / 60000));
  const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60), minutes = total % 60;
  const parts = Object.entries(days ? { days, hours } : hours ? { hours, minutes } : { minutes }).filter(([, n]) => n > 0);
  const locale = INTL_LOCALES[getLocale()];
  // Japanese narrow units are Latin letters ("2d5h"); the short style gives "2 日 5 時間"
  const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatConstructor }).DurationFormat;
  if (DurationFormat) return new DurationFormat(locale, { style: locale === 'ja' ? 'short' : 'narrow' }).format(Object.fromEntries(parts));
  // Without DurationFormat (Node 22): unit numbers in the same widths, unspaced in Chinese, as DurationFormat writes them
  const unit = { days: 'day', hours: 'hour', minutes: 'minute' } as Record<string, string>;
  const display = locale === 'ja' ? 'short' : 'narrow';
  return parts.map(([k, n]) => new Intl.NumberFormat(locale, { style: 'unit', unit: unit[k], unitDisplay: display }).format(n))
    .join(locale.toLowerCase().startsWith('zh') ? '' : ' ');
}

/** Status bar text: product names with the remaining percentage of their short window when known. */
export function statusText(parts: ReadonlyArray<{ product: string; remaining?: number }>): string {
  return parts.map((p) => p.remaining === undefined ? p.product : t('status.textUsage', { product: p.product, percent: p.remaining })).join(' · ');
}

/** Screen reader label of the status bar item. */
export function statusAccessibilityLabel(parts: ReadonlyArray<{ product: string; remaining?: number }>): string {
  const items = parts.map((p) => p.remaining === undefined ? p.product : `${p.product} ${t('status.remainingShort', { percent: p.remaining })}`);
  return `PlanSwap: ${items.join(', ')}`;
}

/** One usage window as a table row: name, bar, remaining percentage (with a warning mark at 0%), relative reset time. */
export function windowRow(w: UsageWindow | ClaudeUsageWindow, index: number, now: number = Date.now()): string {
  const duration = w.windowMinutes ? formatDuration(w.windowMinutes) : `#${index + 1}`;
  const scope = 'scope' in w ? w.scope : undefined;
  const name = scope ? t('status.scopedWindow', { window: duration, scope }) : duration;
  const remaining = remainingOf(w);
  const exhausted = Number((100 - w.usedPercent).toFixed(2)) <= 0;
  const percent = exhausted ? `${remaining}% $(warning) ${escapeMarkdown(t('status.exhausted'))}` : `${remaining}%`;
  const reset = w.resetsAt !== undefined ? `$(clock) ${escapeMarkdown(relativeReset(w.resetsAt, now))}` : '';
  return `| ${escapeMarkdown(name)} | ${usageBar(remaining)} | ${percent} |${reset ? ` ${reset} ` : ' '}|`;
}

/** A refresh icon link running one of PlanSwap's own refresh commands; the hover title is our own localized text. */
export function refreshLink(command: string): string {
  return `[$(refresh)](command:${command} "${t('status.refreshUsage').replace(/["\\]/g, '')}")`;
}

/**
 * All products as one markdown table, so every column lines up across products: a product starts with its header row
 * (email at the left; plan and refresh link in the last, right-aligned cell), then one row per usage window (name, bar,
 * remaining percentage, reset time) and one row per note. The first product's header is the table header (rendered
 * bold); later headers are bold rows. Text from outside is escaped before it gets here, so `**` is our own markup.
 */
export interface TableBlock { identity: string; plan?: string; refresh?: string; rows: readonly string[]; notes: readonly string[] }
export function usageTable(blocks: readonly TableBlock[]): string {
  const lines: string[] = [];
  blocks.forEach((block, i) => {
    const bold = (text: string): string => (i > 0 && text ? `**${text}**` : text);
    const tail = [block.plan ? escapeMarkdown(block.plan) : '', block.refresh ?? ''].filter(Boolean).join(' ');
    lines.push(`| ${bold(escapeMarkdown(block.identity))} | | |${tail ? ` ${bold(tail)} ` : ' '}|`);
    if (i === 0) lines.push('|:--|:--|--:|--:|');
    lines.push(...block.rows, ...block.notes.map((note) => `| ${note} | | | |`));
  });
  return lines.join('\n');
}

const italic = (text: string): string => `_${escapeMarkdown(text)}_`;

/** Shortest windows first; windows without a duration keep their order after the others. */
function byDuration<W extends { windowMinutes?: number }>(windows: readonly W[]): W[] {
  return windows.map((w, i) => ({ w, i })).sort((x, y) => (x.w.windowMinutes ?? Infinity) - (y.w.windowMinutes ?? Infinity) || x.i - y.i).map(({ w }) => w);
}

/** What a product block shows below its first line: window table rows and short italic status lines (already markdown). */
export interface UsageParts { rows: string[]; notes: string[] }

/** The Codex observation as far as it may still be shown: not older than 24 hours, windows past their reset dropped. */
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

/** Table rows and status lines for the effective Codex account's usage limits; empty when there is nothing to say (signed out). */
export function codexUsageParts(state: CodexUsageState | undefined, now: number = Date.now()): UsageParts {
  const parts: UsageParts = { rows: [], notes: [] };
  if (!state) return parts;
  const r = state.result;
  if (r?.ok) {
    const usage = liveCodexUsage(r.usage, now);
    if (usage) {
      parts.rows.push(...byDuration(usage.windows).map((w, i) => windowRow(w, i, now)));
      if (usage.limitReached) parts.notes.push(`_$(warning) ${escapeMarkdown(t('status.usageReached'))}_`);
    }
  } else if (r && r.reason !== 'notLoggedIn') {
    parts.notes.push(italic(t('status.usageFailedShort')));
  }
  if (state.checking) parts.notes.push(italic(t('status.usageChecking')));
  return parts;
}

/**
 * Table rows and status lines for the current Claude account: the general windows, then the refresh state
 * of that directory (a failure of another directory is not shown).
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

/** The localized text of a failed Claude usage query; hasUsage: whether older values are still shown. */
export function claudeUsageFailureText(failure: { reason: ClaudeUsageFailure; detail?: string }, hasUsage: boolean): string {
  // Without values to show (too old, or all reset), "could not be refreshed" must not point at shown values
  return failure.reason === 'failed' && !failure.detail ? t('status.usageUnknownError', { detail: '' })
    : failure.reason === 'notRefreshed' && !hasUsage ? t('status.claudeUsageRefreshFailed')
      : t(CLAUDE_USAGE_FAILURE_MESSAGES[failure.reason], { detail: failure.detail ?? '' });
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

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  private codexUsage: CodexUsageState | undefined;
  private claudeUsage: ClaudeUsageState | undefined;

  constructor(
    private readonly store: AccountStore,
    private readonly labels: LabelStore,
    private readonly codex?: { store: CodexAccountStore; labels: LabelStore },
  ) {
    this.item.command = 'workbench.view.extension.planswap';
    this.item.name = 'PlanSwap';
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
    const now = Date.now();
    const products: Product[] = [];
    const blocks: Block[] = [];
    const candidates: Candidate[] = [];
    const dir = currentDir();
    const explicit = isExplicitConfigDir(dir);
    const hasClaude = fs.existsSync(dir) || fs.existsSync(claudeJsonPath(dir, explicit)) ||
      this.store.named().some((account) => fs.existsSync(account.dir));
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
    if (this.codex && (fs.existsSync(codexDir) || this.codex.store.all().some((account) => fs.existsSync(account.dir)))) {
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
    const background = backgroundIdFor(lowest?.remaining);
    this.item.text = products.length ? `$(dashboard) ${statusText(products)}` : '';
    this.item.accessibilityInformation = products.length ? { label: statusAccessibilityLabel(products), role: 'button' } : undefined;
    this.item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
    this.item.tooltip = buildTooltip(blocks);
    if (products.length) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
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

// Everything from outside (labels, emails, model names) is escaped by escapeMarkdown when the block is assembled, so only
// our own markup (italics, bars, table, $(warning), the refresh links) can act as markdown. Only the refresh commands are
// trusted.
function buildTooltip(blocks: Block[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: [CLAUDE_REFRESH_USAGE_COMMAND, REFRESH_USAGE_COMMAND] };
  md.appendMarkdown(usageTable(blocks.map((block) => ({
    identity: block.identity, plan: block.plan, refresh: block.refresh && refreshLink(block.refresh), rows: block.usage.rows, notes: block.usage.notes,
  }))));
  return md;
}
