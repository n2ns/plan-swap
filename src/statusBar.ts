import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { claudeJsonPath, findSameDir, readAccountInfo } from './paths';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import { EXTERNAL_NAME, labelFor, type LabelStore } from './labels';
import { getLocale, t, type Locale } from './i18n';
import type { CodexAccountStore } from './codex/codexStore';
import { codexDefaultDir, readCodexAccountInfo } from './codex/codexPaths';
import { effectiveDir, isEnabled, readSelectedDir } from './codex/codexState';
import { codexRunsInWsl } from './codex/codexCommands';
import type { CodexUsageState } from './codex/codexUsageMonitor';
import type { UsageWindow } from './codex/codexUsage';

export const REFRESH_USAGE_COMMAND = 'planswap.codex.refreshUsage';

const INTL_LOCALES: Record<Locale, string> = { en: 'en', 'zh-cn': 'zh-CN', es: 'es', ja: 'ja' };

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

function windowLine(w: UsageWindow, index: number): string {
  const window = w.windowMinutes ? formatDuration(w.windowMinutes) : `#${index + 1}`;
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
    lines.push(r.reason === 'cliMissing' ? t('status.usageCliMissing')
      : r.reason === 'authExpired' ? t('status.usageAuthExpired')
        : r.reason === 'timeout' ? t('status.usageTimeout')
          : t('status.usageFailed', { detail: r.detail ?? '' }));
  }
  if (state.checking) lines.push(t('status.usageChecking'));
  else if (r?.ok) lines.push(t('status.usageChecked', { time: formatTime(r.usage.checkedAt) }));
  return lines;
}

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  private codexUsage: CodexUsageState | undefined;

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

  update(): void {
    const text: string[] = [];
    // Each section is a list of plain-text lines; account text is escaped when the tooltip is built
    const sections: Array<{ lines: string[]; refresh?: boolean }> = [];
    const dir = currentDir();
    const explicit = isExplicitConfigDir(dir);
    const hasClaude = fs.existsSync(dir) || fs.existsSync(claudeJsonPath(dir, explicit)) ||
      this.store.named().some((account) => fs.existsSync(account.dir));
    if (hasClaude) {
      const account = sameDirAccount(this.store.all(), dir);
      const label = labelFor(account ? account.name : EXTERNAL_NAME, this.labels);
      const info = readAccountInfo(dir, explicit);
      const identity = info.email ?? t(info.loggedIn ? 'common.loggedIn' : 'common.notLoggedIn');
      text.push(`Claude: ${label}`);
      sections.push({ lines: [`Claude: ${label}`, info.plan ? `${identity} · ${info.plan}` : identity, dir] });
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
      sections.push({ lines, refresh: showUsage && this.codexUsage !== undefined });
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
// command is the usage refresh
function buildTooltip(sections: Array<{ lines: string[]; refresh?: boolean }>): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: [REFRESH_USAGE_COMMAND] };
  sections.forEach((section, i) => {
    if (i > 0) md.appendMarkdown('\n\n---\n\n');
    section.lines.forEach((line, j) => {
      if (j > 0) md.appendMarkdown('  \n');
      md.appendText(line);
    });
    if (section.refresh) md.appendMarkdown(`  \n[$(refresh) ${escapeLinkText(t('status.usageRefresh'))}](command:${REFRESH_USAGE_COMMAND})`);
  });
  return md;
}

// Our own localized label inside link brackets: only the characters that would end or break the link are escaped
function escapeLinkText(s: string): string {
  return s.replace(/[\\[\]]/g, '\\$&');
}
