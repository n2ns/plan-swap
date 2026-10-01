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
import type { UsageFailure, UsageWindow } from './codex/codexUsage';
import { readClaudeUsage, type ClaudeUsage, type ClaudeUsageFailure, type ClaudeUsageWindow } from './claudeUsage';
import type { ClaudeUsageState } from './claudeUsageMonitor';

export const REFRESH_USAGE_COMMAND = 'planswap.codex.refreshUsage';
export const CLAUDE_REFRESH_USAGE_COMMAND = 'planswap.claude.refreshUsage';
export const CLAUDE_REFRESH_ALL_USAGE_COMMAND = 'planswap.claude.refreshAllUsage';

const INTL_LOCALES: Record<Locale, string> = { en: 'en', 'zh-cn': 'zh-CN', es: 'es', ja: 'ja' };
const USAGE_FAILURE_MESSAGES: Record<Exclude<UsageFailure, 'notLoggedIn'>, MessageKey> = {
  cliMissing: 'status.usageCliMissing',
  authExpired: 'status.usageAuthExpired',
  timeout: 'status.usageTimeout',
  homeMismatch: 'status.usageHomeMismatch',
  noRateLimits: 'status.usageNoRateLimits',
  protocolTooLong: 'status.usageProtocolTooLong',
  exited: 'status.usageExited',
  unknownError: 'status.usageUnknownError',
  failed: 'status.usageFailed',
};
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

// Time only when it falls on the same day as now, otherwise date and time; in the UI locale
export function formatTime(ms: number, now: number = Date.now()): string {
  const at = new Date(ms);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(INTL_LOCALES[getLocale()], options).format(at);
}

function windowLine(w: UsageWindow | ClaudeUsageWindow, index: number): string {
  const duration = w.windowMinutes ? formatDuration(w.windowMinutes) : `#${index + 1}`;
  const window = 'scope' in w && w.scope ? t('status.scopedWindow', { window: duration, scope: w.scope }) : duration;
  return w.resetsAt !== undefined
    ? t('status.usageWindow', { window, used: w.usedPercent, reset: formatTime(w.resetsAt * 1000) })
    : t('status.usageWindowNoReset', { window, used: w.usedPercent });
}

/** Tooltip lines for the effective Codex account's usage limits; empty when there is nothing to say (signed out). */
export function usageLines(state: CodexUsageState | undefined): string[] {
  if (!state) return [];
  const r = state.result;
  const lines: string[] = [];
  if (r?.ok) {
    lines.push(...r.usage.windows.map(windowLine));
    if (r.usage.limitReached) lines.push(t('status.usageReached'));
  } else if (r && r.reason !== 'notLoggedIn') {
    let detail = r.detail ?? '';
    if (r.reason === 'exited' && !detail) detail = t('status.usageUnknownExit');
    if (r.reason === 'unknownError' && detail) detail = ` (${detail})`;
    lines.push(t(USAGE_FAILURE_MESSAGES[r.reason], { detail }));
  }
  if (state.checking) lines.push(t('status.usageChecking'));
  else if (r?.ok) lines.push(t('status.usageChecked', { time: formatTime(r.usage.checkedAt) }));
  return lines;
}

/**
 * Tooltip lines for the current Claude account: the usage cached in its info file (usage), plus the refresh state of
 * that directory (a failure of another directory is not shown).
 */
export function claudeUsageLines(usage: ClaudeUsage | undefined, state: ClaudeUsageState | undefined, dir: string): string[] {
  const lines: string[] = usage ? usage.windows.map(windowLine) : [];
  const failure = state?.failure && samePath(state.failure.dir, dir) ? state.failure : undefined;
  if (failure) lines.push(claudeUsageFailureText(failure, usage !== undefined));
  if (state?.checking) lines.push(t('status.usageChecking'));
  else if (usage) lines.push(t('status.usageChecked', { time: formatTime(usage.checkedAt) }));
  return lines;
}

/** The localized text of a failed Claude usage query; hasUsage: whether older values are still shown. */
export function claudeUsageFailureText(failure: { reason: ClaudeUsageFailure; detail?: string }, hasUsage: boolean): string {
  // Without values to show (too old, or all reset), "could not be refreshed" must not point at shown values
  return failure.reason === 'failed' && !failure.detail ? t('status.usageUnknownError', { detail: '' })
    : failure.reason === 'notRefreshed' && !hasUsage ? t('status.claudeUsageRefreshFailed')
      : t(CLAUDE_USAGE_FAILURE_MESSAGES[failure.reason], { detail: failure.detail ?? '' });
}

/** Remaining percentage of the tightest window (the one that runs out first), rounded down; undefined without usage. */
export function tightestRemaining(usage: ClaudeUsage | undefined): number | undefined {
  if (!usage?.windows.length) return undefined;
  return Math.floor(100 - Math.max(...usage.windows.map((w) => w.usedPercent)));
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
    this.update();
  }

  /** Usage limits of the effective Codex account, kept by CodexUsageMonitor; undefined hides the section. */
  setCodexUsage(state: CodexUsageState | undefined): void {
    this.codexUsage = state;
    this.update();
  }

  /** Refresh state of the current Claude account's usage, kept by ClaudeUsageMonitor; undefined hides the refresh link. */
  setClaudeUsage(state: ClaudeUsageState | undefined): void {
    this.claudeUsage = state;
    this.update();
  }

  update(): void {
    const text: string[] = [];
    // Each section is a list of plain-text lines; account text is escaped when the tooltip is built
    const sections: Array<{ lines: string[]; links?: Array<{ command: string; text: string }> }> = [];
    const dir = currentDir();
    const explicit = isExplicitConfigDir(dir);
    const hasClaude = fs.existsSync(dir) || fs.existsSync(claudeJsonPath(dir, explicit)) ||
      this.store.named().some((account) => fs.existsSync(account.dir));
    if (hasClaude) {
      const account = sameDirAccount(this.store.all(), dir);
      const label = labelFor(account ? account.name : EXTERNAL_NAME, this.labels);
      const info = readAccountInfo(dir, explicit);
      const identity = info.email ?? t(info.loggedIn ? 'common.loggedIn' : 'common.notLoggedIn');
      const lines = [`Claude: ${label}`, info.plan ? `${identity} · ${info.plan}` : identity, dir];
      // Usage limits exist only for a subscription sign-in (oauthAccount); signed-out accounts show none
      const showUsage = info.identity !== undefined;
      const usage = showUsage ? readClaudeUsage(dir, explicit) : undefined;
      // The status bar text carries what is left of the window that runs out first
      const left = tightestRemaining(usage);
      text.push(left === undefined ? `Claude: ${label}` : `Claude: ${label} ${t('status.remainingShort', { percent: left })}`);
      if (showUsage) lines.push(...claudeUsageLines(usage, this.claudeUsage, dir));
      sections.push({ lines, links: showUsage && this.claudeUsage !== undefined ? [
        { command: CLAUDE_REFRESH_USAGE_COMMAND, text: t('status.usageRefresh') },
        { command: CLAUDE_REFRESH_ALL_USAGE_COMMAND, text: t('status.usageRefreshAll') },
      ] : undefined });
    }
    const codexDir = effectiveDir();
    if (this.codex && (fs.existsSync(codexDir) || this.codex.store.all().some((account) => fs.existsSync(account.dir)))) {
      const all = this.codex.store.all();
      const account = sameDirAccount(all, codexDir);
      const label = labelFor(account ? account.name : EXTERNAL_NAME, this.codex.labels);
      const info = readCodexAccountInfo(codexDir);
      const apiKey = info.plan === 'API key';
      const identity = apiKey ? 'API key' :
        [info.email ?? t(info.loggedIn ? 'common.loggedIn' : 'common.notLoggedIn'), info.plan].filter(Boolean).join(' · ');
      text.push(`Codex: ${label}`);
      const lines = [`Codex: ${label}`, identity, codexDir];
      const selected = readSelectedDir() ?? codexDefaultDir();
      // A selection is only pending while PlanSwap manages CODEX_HOME (as on the panel, an unreadable rc file counts as
      // not enabled)
      if (codexSwitchingEnabled() && findSameDir([selected], codexDir) !== 0) {
        const pendingAccount = sameDirAccount(all, selected);
        const pending = pendingAccount ? labelFor(pendingAccount.name, this.codex.labels) : selected;
        lines.push(t('status.codexPending', { label: pending }));
      }
      // Codex run inside WSL by a Windows editor uses another home: its limits are not this account's
      const inWsl = codexRunsInWsl();
      const showUsage = !inWsl && !apiKey && info.loggedIn;
      if (inWsl) lines.push(t('status.codexRunsInWsl'));
      if (showUsage) lines.push(...usageLines(this.codexUsage));
      sections.push({ lines, links: showUsage && this.codexUsage !== undefined ? [{ command: REFRESH_USAGE_COMMAND, text: t('status.usageRefresh') }] : undefined });
    }
    this.item.text = text.length ? `$(account) ${text.join(' · ')}` : '';
    this.item.tooltip = buildTooltip(sections);
    if (text.length) this.item.show();
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

// Plain text goes through appendText (escaped), so labels and paths can never inject links; the only trusted
// commands are the usage refreshes
function buildTooltip(sections: Array<{ lines: string[]; links?: Array<{ command: string; text: string }> }>): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: [CLAUDE_REFRESH_USAGE_COMMAND, CLAUDE_REFRESH_ALL_USAGE_COMMAND, REFRESH_USAGE_COMMAND] };
  sections.forEach((section, i) => {
    if (i > 0) md.appendMarkdown('\n\n---\n\n');
    section.lines.forEach((line, j) => {
      if (j > 0) md.appendMarkdown('  \n');
      md.appendText(line);
    });
    if (section.links) md.appendMarkdown(`  \n${section.links.map((l) => `[$(refresh) ${escapeLinkText(l.text)}](command:${l.command})`).join(' · ')}`);
  });
  return md;
}

// Our own localized label inside link brackets: only the characters that would end or break the link are escaped
function escapeLinkText(s: string): string {
  return s.replace(/[\\[\]]/g, '\\$&');
}
