// Sidebar webview frontend: only renders and exchanges messages; all business logic lives in the extension host.
// Boundaries: depends only on @vscode-elements/elements, @vscode/codicons and types from ../protocol (no Node or vscode
// imports; every message is typed in src/protocol.ts). Account text (names, labels, emails, directories) is rendered
// with textContent, never interpolated innerHTML. Visible strings go through t() with a key in every locale table.
// CSS colors in panel.css use only --vscode-* theme variables.
import '@vscode-elements/elements/dist/vscode-button/index.js';
import '@vscode-elements/elements/dist/vscode-radio/index.js';
import '@vscode-elements/elements/dist/vscode-radio-group/index.js';
import '@vscode-elements/elements/dist/vscode-textfield/index.js';
import '@vscode-elements/elements/dist/vscode-toolbar-button/index.js';
import '@vscode-elements/elements/dist/vscode-icon/index.js';
import type { AccountView, FromWebview, PanelMode, PanelState, RestartInfo, TabState, ToolId, ToWebview, UsageDisplay } from '../protocol';
import { getLocale, intlLocale, joinSentences, matchLocale, setLocale, t, WEB_LOCALE_INFO, type MessageKey } from './i18n';

declare const __PLANSWAP_VERSION__: string;

interface WebviewState {
  tab?: PanelMode;
}
declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
};
const startedAt = performance.now();
let receivedState = false;
const vscode = acquireVsCodeApi();
const send = (msg: FromWebview): void => vscode.postMessage(msg);

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_LABEL_LENGTH = 32;
const MODES: PanelMode[] = ['claude', 'codex'];

type TextField = HTMLElement & { value: string; invalid: boolean; focus(): void };
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
// Messages sent from a page: all except ready / setTab carry a mode, which Page fills in
type PageMessage = DistributiveOmit<Exclude<FromWebview, { type: 'ready' } | { type: 'setTab' }>, 'mode'>;

// The host sets the configured language before the first state arrives.
setLocale(matchLocale(document.documentElement.lang.toLowerCase()));
let state: PanelState = {
  active: 'claude',
  claude: { enabled: true, accounts: [] },
  codex: { enabled: false, accounts: [] },
  locale: getLocale(),
};
// Tab remembered by the frontend; wins over the host's active (the host only decides when there is no local record yet)
let activeTab: PanelMode | undefined = vscode.getState()?.tab;

// Per-mode constants that are never translated (directory prefixes until the host sends its own, file names);
// translated text lives in i18n.ts
const TEXT = {
  claude: { dirPrefix: '~/.claude-', mdLabel: 'CLAUDE.md' },
  codex: { dirPrefix: '~/.codex-', mdLabel: 'AGENTS.md' },
} as const;

// Restart action wording follows the host-reported context; before the first state arrives, keep the WSL wording
const codexRestart = (): RestartInfo => state.codex.restart ?? { context: 'wsl', auto: true };
const DISABLED_RESTART = { local: 'disabled.restartLocal', wsl: 'disabled.restartWsl', remote: 'disabled.restartRemote' } as const;

type Attrs = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined | false;

// Builds nodes with the DOM API; all text goes in via textContent, never concatenated HTML
function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

function onClick<T extends HTMLElement>(el: T, fn: (e: MouseEvent) => void): T {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    fn(e);
  });
  // A double-click on a button must not reach the row's dblclick (which switches accounts)
  el.addEventListener('dblclick', (e) => e.stopPropagation());
  return el;
}

// Duplicate names / aliases are compared case-insensitively (mirrors labels.sameName on the host)
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Enter / Escape while an IME is composing only confirm or cancel the candidate (keyCode 229 covers older engines)
function isComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

function toolbarButton(icon: string, label: string, fn: (e: MouseEvent) => void): HTMLElement {
  return onClick(h('vscode-toolbar-button', { icon, label, title: label, class: 'icon-btn' }), fn);
}

// Banner title with its icon on the same line, so the text and actions below get the card's full width
function bannerTitle(icon: string, text: string): HTMLElement {
  return h('div', { class: 'banner-title' }, h('vscode-icon', { name: icon, class: 'banner-icon' }), h('span', { class: 'banner-title-text' }, text));
}

/**
 * Focuses a control. A freshly created vscode-elements component is not focusable until its first async render
 * (vscode-button reflects its tabindex then); vscode-toolbar-button is never focusable itself, only its inner button
 */
function focusElement(el: HTMLElement & { updateComplete?: Promise<unknown>; hasUpdated?: boolean }): void {
  const focus = (): void => {
    if (!el.isConnected) return;
    if (el.tabIndex >= 0) el.focus();
    else el.shadowRoot?.querySelector<HTMLElement>('button')?.focus();
  };
  if (el.updateComplete && !el.hasUpdated) void el.updateComplete.then(focus);
  else focus();
}

/** Names a control (data-action) so a re-render can move the focus to its replacement in the same row */
function withAction(el: HTMLElement, action: string): HTMLElement {
  el.dataset.action = action;
  return el;
}

/** Sets --rename-h (the name line's height before editing) on the edit line; unknown keeps the CSS default */
function withHeight(el: HTMLElement, px: number | undefined): HTMLElement {
  if (px) el.style.setProperty('--rename-h', `${px}px`);
  return el;
}

// User-perceived characters; label lengths are counted this way, like labels.ts on the host
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((g) => g.segment);
}

/**
 * The name text followed by its inline icons: the last character and the icons share a nowrap span, so the icons
 * never wrap onto a line of their own and always follow the last line of a wrapped name
 */
function nameWithTail(label: string, ...icons: Child[]): Child[] {
  if (!icons.some(Boolean)) return [label];
  const chars = graphemes(label);
  const last = chars.pop() ?? '';
  return [chars.join(''), h('span', { class: 'name-tail' }, last, ...icons)];
}

// Avatar color: a theme chart color picked stably from the account name; the directory is the avatar's hover hint
const AVATAR_COLORS = ['blue', 'green', 'purple', 'orange', 'yellow', 'red'];
function avatar(a: AccountView): HTMLElement {
  let hash = 0;
  for (const ch of a.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const letter = a.kind === 'external' ? '?' : a.label.charAt(0).toUpperCase();
  // Default account: the same disc with a home icon instead of a letter, marking it as the home-directory account
  if (a.kind === 'default') {
    return h('div', { class: 'avatar', style: `--avatar-color: var(--vscode-charts-${color})`, title: a.dirLabel, role: 'img', 'aria-label': t('account.default') }, h('vscode-icon', { name: 'home', size: '12' }));
  }
  return h('div', { class: 'avatar', style: `--avatar-color: var(--vscode-charts-${color})`, title: a.dirLabel }, letter);
}

function planPill(a: AccountView): HTMLElement | null {
  return a.plan ? h('span', { class: 'pill plan' }, a.plan) : null;
}

// Plan string -> color class (frontend-only mapping, written to data-plan for CSS)
// Both sides share tiers by price: tier1 standard paid (Claude Pro / ChatGPT Plus), tier2 high (Claude Max 5x / ChatGPT Pro Lite), tier3 top (Claude Max 20x / ChatGPT Pro)
// Colors (panel.css; shown on the current row only, other rows keep a neutral tag): tier0 Free/Go gray, tier1 blue,
// tier2 champagne gold, tier3 amber, team (Team/Business) teal, enterprise slate, apikey orange; none keeps the normal outline
function planClass(plan: string | undefined, mode: PanelMode): string {
  if (!plan) return 'none';
  if (/API/i.test(plan)) return 'apikey';
  if (/^(Team|Business)\b/i.test(plan)) return 'team';
  if (/^Enterprise\b/i.test(plan)) return 'enterprise';
  if (/^(Free|Go)\b/i.test(plan)) return 'tier0';
  if (mode === 'claude') {
    if (/^Max\b.*20x/i.test(plan)) return 'tier3';
    if (/^Max\b/i.test(plan)) return 'tier2';
    if (/^Pro\b/i.test(plan)) return 'tier1';
  } else {
    if (/^Pro\s*Lite\b/i.test(plan)) return 'tier2';
    if (/^Pro\b/i.test(plan)) return 'tier3';
    if (/^Plus\b/i.test(plan)) return 'tier1';
  }
  return 'none';
}

// Without an email, show "Logged in" based on loggedIn; nothing when the email line is turned off in the settings
function loginStatus(a: AccountView, hideEmail?: boolean): HTMLElement | null {
  if (hideEmail) return null;
  if (a.email) return h('div', { class: 'row-sub row-identity' }, h('span', { class: 'row-email' }, a.email));
  if (a.loggedIn) return h('div', { class: 'row-sub ok' }, t('account.loggedIn'));
  // Not logged in and no email: the "Not logged in" pill on line 3 already says so; no extra line
  return null;
}

type UsageWindowView = NonNullable<AccountView['usage']>['windows'][number];

// Color level of what is left: the thresholds come from planswap.sidebar.warningThreshold / errorThreshold (error wins)
function usageLevel(remaining: number): 'empty' | 'low' | 'warn' | 'ok' {
  const { warning, error } = state.usageThresholds ?? { warning: 30, error: 10 };
  return remaining <= 0 ? 'empty' : remaining <= error ? 'low' : remaining <= warning ? 'warn' : 'ok';
}

// Remaining percentage of a usage window: 100 - usedPercent with at most two decimals (the status bar rounds down, see remainingOf in src/statusBar.ts)
const remainingPercent = (w: UsageWindowView): number => Number((100 - w.usedPercent).toFixed(2));

type DurationFormatConstructor = new (locale: string, options: { style: string }) => { format(duration: Record<string, number>): string };

// Time until a reset as a short duration in the panel language with the two largest units, a zero unit left out
// ("2d 5h" / "2天5小时", "5h 20m", "45m"), rounded up to the minute; a copy of relativeReset in src/statusBar.ts
function relativeTime(epochSeconds: number): string {
  const total = Math.max(1, Math.ceil((epochSeconds * 1000 - Date.now()) / 60000));
  const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60), minutes = total % 60;
  const parts = Object.entries(days ? { days, hours } : hours ? { hours, minutes } : { minutes }).filter(([, n]) => n > 0);
  const locale = intlLocale();
  const { durationStyle, durationUnitSeparator } = WEB_LOCALE_INFO[getLocale()];
  // Japanese narrow units are Latin letters ("2d5h") and Traditional Chinese narrow spacing is uneven ("2 天5 小時"); the short style gives "2 日 5 時間" / "2 天 5 小時"
  const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatConstructor }).DurationFormat;
  if (DurationFormat) return new DurationFormat(locale, { style: durationStyle }).format(Object.fromEntries(parts));
  // Without DurationFormat (Node 22): unit numbers in the same widths, unspaced in Simplified Chinese, as DurationFormat writes them
  const unit = { days: 'day', hours: 'hour', minutes: 'minute' } as Record<string, string>;
  return parts.map(([k, n]) => new Intl.NumberFormat(locale, { style: 'unit', unit: unit[k], unitDisplay: durationStyle }).format(n))
    .join(durationUnitSeparator);
}

// Texts that move with the clock (the card's "Updated 2 minutes ago", the windows' time until reset and the reset
// sentence in the bars' screen reader value) are refreshed every minute in place, since a state push with unchanged
// content does not re-render. The timer is restarted on every render, so the first tick comes a minute after the texts
// were computed; elements carry their times in data attributes
const UPDATED_AGO_CLASS = 'recommend-updated';
let liveTimer: ReturnType<typeof setInterval> | undefined;
function keepLive(): void {
  clearInterval(liveTimer);
  liveTimer = setInterval(refreshLiveTimes, 60_000);
}
function updatedAgoText(checkedAtMs: number): HTMLElement {
  keepLive();
  return h('span', { class: UPDATED_AGO_CLASS, 'data-checked-at': String(checkedAtMs) }, updatedAgo(checkedAtMs));
}
function resetSentence(resetsAt: number, date: string): string {
  return t('usage.resetsIn', { time: relativeTime(resetsAt), date });
}
function refreshLiveTimes(): void {
  for (const el of document.querySelectorAll<HTMLElement>(`.${UPDATED_AGO_CLASS}`)) {
    const checkedAt = Number(el.dataset.checkedAt);
    if (Number.isFinite(checkedAt)) el.textContent = updatedAgo(checkedAt);
  }
  for (const el of document.querySelectorAll<HTMLElement>('.usage-reset-time[data-resets-at]')) el.textContent = relativeTime(Number(el.dataset.resetsAt));
  for (const el of document.querySelectorAll<HTMLElement>('.usage-track[data-resets-at]')) {
    el.setAttribute('aria-valuetext', `${el.dataset.valuetextPrefix ?? ''}${resetSentence(Number(el.dataset.resetsAt), el.dataset.resetDate ?? '')}`);
  }
}
function updatedAgo(checkedAtMs: number): string {
  const minutes = Math.floor((Date.now() - checkedAtMs) / 60000);
  if (minutes < 1) return t('recommend.updatedNow');
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'always' });
  const time = minutes < 60 ? rtf.format(-minutes, 'minute') : minutes < 1440 ? rtf.format(-Math.floor(minutes / 60), 'hour') : rtf.format(-Math.floor(minutes / 1440), 'day');
  return t('recommend.updated', { time });
}

// Window duration text: "5-hour limit", "7-day limit", with the model name for Claude's model-specific limits
function windowDuration(w: UsageWindowView): string {
  const minutes = w.windowMinutes;
  const limit = minutes === undefined ? t('usage.window')
    : minutes % 1440 === 0 ? t('usage.days', { n: minutes / 1440 })
      : minutes % 60 === 0 ? t('usage.hours', { n: minutes / 60 })
        : t('usage.minutes', { n: minutes });
  // Claude model-specific limits carry the model name (account-independent text, rendered via textContent)
  return w.scope ? t('usage.scoped', { limit, scope: w.scope }) : limit;
}

function usageWindow(w: UsageWindowView, display: UsageDisplay): HTMLElement {
  const duration = windowDuration(w);
  const remaining = remainingPercent(w);
  const used = Number((100 - remaining).toFixed(2));
  // planswap.usageDisplay picks what the bar and percentage show; the level (color) always follows what is left
  const shown = display === 'used' ? used : remaining;
  const label = display === 'used' ? t('usage.used', { percent: used }) : t('usage.remaining', { percent: remaining });
  const level = usageLevel(100 - w.usedPercent);
  const exhausted = level === 'empty';
  // Two lines per window: the duration with the time until the reset (clock icon + short duration) at the right, then
  // the bar with the shown percentage at its right. Only the bar has a tooltip, saying whether its length is what is
  // left or what is used; the full reset sentence and date are part of the bar's screen reader value
  const resetDate = w.resetsAt !== undefined ? new Date(w.resetsAt * 1000).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : undefined;
  const resetText = w.resetsAt !== undefined && resetSentence(w.resetsAt, resetDate!);
  const resetsAt = w.resetsAt !== undefined ? String(w.resetsAt) : undefined;
  if (resetsAt) keepLive();
  const reset = resetText && h('span', { class: 'usage-reset', 'aria-hidden': 'true' },
    h('vscode-icon', { name: 'clock', size: '12' }), h('span', { class: 'usage-reset-time', 'data-resets-at': resetsAt }, relativeTime(w.resetsAt!)));
  // The static part of the screen reader value, kept so the reset sentence can be refreshed in place
  const valuetextPrefix = [label, exhausted && t('usage.exhausted')].filter(Boolean).map((p) => `${p}, `).join('');
  return h('div', { class: 'usage-window', 'data-level': level },
    h('div', { class: 'usage-labels' }, h('span', { class: 'usage-duration' }, duration), reset),
    h('div', { class: 'usage-bar' },
      h('div', {
        class: 'usage-track', 'data-level': level, role: 'progressbar', 'aria-label': duration,
        title: t(display === 'used' ? 'usage.barTitleUsed' : 'usage.barTitle', { remaining, used }),
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown),
        'aria-valuetext': resetText ? `${valuetextPrefix}${resetText}` : valuetextPrefix.slice(0, -2),
        'data-resets-at': resetsAt, 'data-valuetext-prefix': resetsAt ? valuetextPrefix : undefined, 'data-reset-date': resetDate,
      }, h('div', { class: 'usage-fill', style: `width: ${shown}%` })),
      h('span', { class: 'usage-pct', 'aria-hidden': 'true' }, `${shown}%`),
    ),
  );
}

// Model-specific limits (Claude; only sent by the host while planswap.sidebar.showModelLimits is on) follow the general
// windows, always shown
function usageHistory(a: AccountView): HTMLElement | null {
  // No window (none observed, or all hidden by the display settings): no block
  if (!a.usage?.windows.length) return null;
  const general = a.usage.windows.filter((w) => !w.scope);
  const scoped = a.usage.windows.filter((w) => w.scope);
  const display = state.usageDisplay ?? 'remaining';
  return h('div', { class: 'row-usage' }, ...[...general, ...scoped].map((w) => usageWindow(w, display)));
}

/** One tab page: its own add section, adding state, confirmingDir and inline-rename state */
class Page {
  readonly text: (typeof TEXT)[PanelMode];
  readonly root: HTMLElement;
  // Banners, the disabled card and the loading line; the list section below is created once so the add form keeps its focus
  private readonly top = h('div', { class: 'page-top' });
  private readonly list = h('ul', { class: 'list' });
  private readonly listTitle = h('span');
  private readonly listCount = h('span', { class: 'count' });
  private readonly listSection: HTMLElement;
  private readonly addToggle: HTMLElement;
  private readonly addToggleText = h('span');
  // Usage refresh buttons left of "Add"; shown only while the page has an account whose limits can be queried
  private readonly refreshButton: HTMLElement;
  private readonly refreshAllButton: HTMLElement;
  private addOpen = false;
  private readonly addField: TextField;
  private readonly addButton: HTMLElement & { disabled: boolean };
  // Account mode: linked to the default account (selected by default) or independent (copied settings), described by
  // purpose; created once, so the choice is kept across re-renders
  private readonly addMode: HTMLElement;
  private readonly addLinked: HTMLElement & { checked: boolean };
  private readonly addIndependent: HTMLElement & { checked: boolean };
  private readonly addHelp = h('div', { class: 'help' });
  private tools: HTMLElement;
  private syncButton!: HTMLElement;
  private readonly addSection: HTMLElement;
  private adding = false;
  // Add error from the host (addResult); kept across re-renders until the input is edited or a new result arrives
  private addError?: string;
  // Time of the last switch sent from a row button; a double click whose second click lands on a re-rendered row must not switch again
  private lastSwitchAt = 0;
  // Account directory whose removal is being confirmed inline
  private confirmingDir?: string;
  // Inline rename state (keyed by dir, one row at a time): the field is created once and reused across re-renders to keep input and focus
  private renamingDir?: string;
  // Height of the row's name line before editing; the edit line keeps it so the card does not change height
  private renameTitleHeight?: number;
  private renameField?: TextField;
  private renameError?: string;
  // Re-rendering moves the field node and fires blur, which must not count as cancel
  private rendering = false;
  // After Enter, while waiting for the host's renameResult: blur does not cancel, otherwise an error would have nowhere to show
  private submitting = false;
  private submittedLabel?: string;

  constructor(readonly mode: PanelMode) {
    this.text = TEXT[mode];
    this.addField = h('vscode-textfield') as TextField;
    this.addButton = h('vscode-button', { icon: 'add' }) as HTMLElement & { disabled: boolean };
    // Radios of one group share a name; each tab has its own group in the same document
    const radio = (value: string): HTMLElement & { checked: boolean } =>
      h('vscode-radio', { class: 'add-mode-option', name: `add-mode-${mode}`, value }) as HTMLElement & { checked: boolean };
    this.addLinked = radio('linked');
    this.addLinked.checked = true;
    this.addIndependent = radio('independent');
    this.addMode = h('vscode-radio-group', { class: 'add-mode', variant: 'vertical' }, this.addLinked, this.addIndependent);
    this.addSection = h(
      'div',
      { class: 'add', id: `add-${mode}`, hidden: true },
      h('div', { class: 'input-group' }, this.addField, this.addButton),
      this.addMode,
      this.addHelp,
    );
    this.addToggle = h('button', { type: 'button', class: 'add-toggle', 'aria-expanded': 'false', 'aria-controls': `add-${mode}` }, h('vscode-icon', { name: 'add', size: '12' }), this.addToggleText);
    this.addToggle.addEventListener('click', () => {
      this.setAddOpen(!this.addOpen);
      if (this.addOpen) this.focusAdd();
    });
    this.refreshButton = withAction(toolbarButton('refresh', '', () => this.send({ type: 'tool', tool: 'refreshUsage' })), 'refreshUsage');
    // Refreshes every registered signed-in account of the page
    this.refreshAllButton = withAction(toolbarButton('layers', '', () => this.send({ type: 'tool', tool: 'refreshAllUsage' })), 'refreshAllUsage');
    this.listSection = h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'section-title' },
        h('span', { class: 'title-main' }, this.listTitle, this.listCount),
        h('div', { class: 'title-actions' }, this.refreshButton, this.refreshAllButton, this.addToggle),
      ),
      this.addSection,
      this.list,
    );
    this.addField.addEventListener('input', () => {
      this.addError = undefined;
      this.updateAddHelp();
    });
    this.addField.addEventListener('keydown', (e) => {
      const key = e as KeyboardEvent;
      if (isComposing(key)) return;
      if (key.key === 'Enter') this.submitAdd();
      else if (key.key === 'Escape') {
        // Collapses the form (the typed name is kept) and returns the focus to the toggle
        e.preventDefault();
        this.setAddOpen(false);
        this.addToggle.focus();
      }
    });
    onClick(this.addButton, () => this.submitAdd());
    this.addMode.addEventListener('change', () => this.updateAddHelp());
    this.tools = this.renderTools();
    this.root = h('div', { class: 'page', role: 'tabpanel', id: `panel-${mode}`, 'aria-labelledby': `tab-${mode}` }, this.top, this.listSection, this.tools);
    this.applyLocale();
  }

  // Refreshes the parts created once (add section, tools); the rest is rebuilt by render()
  applyLocale(): void {
    this.addField.setAttribute('placeholder', t('add.placeholder'));
    this.addField.setAttribute('aria-label', t('add.ariaLabel'));
    this.addButton.textContent = t('add.button');
    this.addToggleText.textContent = t('add.button');
    this.addToggle.setAttribute('aria-label', t('add.title'));
    this.addToggle.title = t('add.title');
    this.listTitle.textContent = t('list.title');
    for (const [button, key] of [[this.refreshButton, 'usage.refreshTitle'], [this.refreshAllButton, 'usage.refreshAllTitle']] as const) {
      button.setAttribute('label', t(key));
      button.setAttribute('title', t(key));
    }
    this.addMode.setAttribute('aria-label', t('add.mode.ariaLabel'));
    this.addLinked.textContent = t('add.mode.linked');
    this.addIndependent.textContent = t('add.mode.independent');
    // A host add error is in the old locale; drop it so the help line shows the local validation in the new one
    if (this.addError) {
      this.addError = undefined;
      this.updateAddHelp();
    }
    const tools = this.renderTools();
    this.tools.replaceWith(tools);
    this.tools = tools;
    if (this.renameField) {
      this.renameField.setAttribute('aria-label', t('rename.ariaLabel'));
      // Re-translate a local validation error; a host error is kept as sent
      const self = this.tab.accounts.find((a) => a.dir === this.renamingDir);
      const local = self && this.validateLabel(this.renameField.value, self);
      if (local) this.renameError = local;
    }
  }

  get tab(): TabState {
    return state[this.mode];
  }

  // The host's spelling of a new account folder (backslashes on Windows); the fixed one before the first state arrives
  private dirPrefix(): string {
    return this.tab.dirPrefix ?? this.text.dirPrefix;
  }

  private send(msg: PageMessage): void {
    send({ ...msg, mode: this.mode });
  }

  private setAddOpen(open: boolean): void {
    this.addOpen = open;
    this.addSection.hidden = !open;
    this.addToggle.setAttribute('aria-expanded', String(open));
    this.addToggle.classList.toggle('is-open', open);
  }

  // Expands the add form and focuses its field (nothing to add to while the page is loading or disabled)
  focusAdd(): void {
    if (!receivedState || !this.tab.enabled) return;
    this.setAddOpen(true);
    this.addField.focus();
    this.addSection.scrollIntoView?.({ block: 'nearest' });
  }

  onState(): void {
    if (this.confirmingDir && !this.tab.accounts.some((a) => a.dir === this.confirmingDir)) this.confirmingDir = undefined;
    if (this.renamingDir && !this.tab.accounts.some((a) => a.dir === this.renamingDir)) this.stopRename();
  }

  onAddResult(error?: string): void {
    this.adding = false;
    this.addError = error;
    if (!error) {
      this.addField.value = '';
      // A successful add collapses the form; focus that sat in it moves to the toggle
      const hadFocus = this.addSection.contains(document.activeElement);
      this.setAddOpen(false);
      if (hadFocus) this.addToggle.focus();
    } else this.setAddOpen(true);
    this.updateAddHelp();
  }

  onRenameResult(dir: string, error?: string): void {
    this.submitting = false;
    if (error) {
      // If this row left edit mode (Escape or another row), re-enter it with the submitted value so the error is visible
      if (this.renamingDir !== dir) {
        const target = this.tab.accounts.find((a) => a.dir === dir);
        if (!target) return;
        this.startRename(target);
        if (this.submittedLabel !== undefined) this.renameField!.value = this.submittedLabel;
      }
      this.renameError = error;
      this.renameField!.invalid = true;
      this.render();
      this.renameField!.focus();
    } else if (this.renamingDir === dir) {
      this.stopRename();
      this.render();
    }
  }

  // ---------- Inline rename (not for the external directory) ----------
  private startRename(a: AccountView, titleHeight?: number): void {
    const field = h('vscode-textfield', { class: 'rename-field', 'aria-label': t('rename.ariaLabel'), value: a.label }) as TextField;
    field.value = a.label;
    field.addEventListener('input', () => {
      this.renameError = this.validateLabel(field.value, a);
      field.invalid = !!this.renameError;
      this.syncRenameError();
    });
    field.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (isComposing(e as KeyboardEvent)) return;
      if (key === 'Enter') {
        e.preventDefault();
        this.commitRename();
      } else if (key === 'Escape') {
        e.preventDefault();
        this.stopRename();
        this.render();
      }
    });
    // Blur saves too, like the Explorer's inline rename (re-renders and a pending save are ignored)
    field.addEventListener('blur', () => {
      if (this.rendering || this.submitting || this.renameField !== field) return;
      this.commitRename();
    });
    this.renamingDir = a.dir;
    this.renameField = field;
    this.renameTitleHeight = titleHeight;
    this.renameError = undefined;
    // A new edit never waits on an earlier submit, whose renameResult may never arrive
    this.submitting = false;
    this.render();
    // The component's first render is async; wait a frame before focusing and selecting all
    requestAnimationFrame(() => {
      field.focus();
      field.shadowRoot?.querySelector('input')?.select();
    });
  }

  // Save button after the rename field; mousedown keeps the focus in the field so the click, not a blur, saves
  private renameSaveButton(): HTMLElement {
    const button = toolbarButton('check', t('rename.save'), () => this.commitRename());
    button.classList.add('rename-save');
    button.addEventListener('mousedown', (e) => e.preventDefault());
    return button;
  }

  private stopRename(): void {
    this.renamingDir = undefined;
    this.renameField = undefined;
    this.renameError = undefined;
    this.submitting = false;
  }

  // Instant frontend validation; the host has the final say
  private validateLabel(label: string, self: AccountView): string | undefined {
    const value = label.trim();
    if (!value) return t('validate.labelEmpty');
    if (graphemes(value).length > MAX_LABEL_LENGTH) return t('validate.labelTooLong', { max: MAX_LABEL_LENGTH });
    if (/[\r\n]/.test(value)) return t('validate.labelNewline');
    if (this.tab.accounts.some((a) => a.dir !== self.dir && (sameName(a.name, value) || sameName(a.label, value)))) return t('validate.labelDuplicate');
    return undefined;
  }

  /**
   * Save action of Enter, blur and the save button: an unchanged value just leaves edit mode without a message;
   * otherwise submitRename (an invalid value stays in edit mode with its reason)
   */
  private commitRename(): void {
    const self = this.tab.accounts.find((a) => a.dir === this.renamingDir);
    if (this.submitting || !this.renameField || !self) return;
    if (this.renameField.value.trim() === self.label) {
      this.stopRename();
      this.render();
      return;
    }
    this.submitRename();
  }

  private submitRename(): void {
    const field = this.renameField;
    const dir = this.renamingDir;
    const self = this.tab.accounts.find((a) => a.dir === dir);
    if (!field || dir === undefined || !self) return;
    const error = this.validateLabel(field.value, self);
    if (error) {
      this.renameError = error;
      field.invalid = true;
      this.syncRenameError();
      return;
    }
    this.submitting = true;
    this.submittedLabel = field.value.trim();
    this.send({ type: 'rename', dir, label: this.submittedLabel });
  }

  private syncRenameError(): void {
    const el = this.list.querySelector('.row-error');
    if (this.renameError) {
      if (el) el.textContent = this.renameError;
      else this.renameField?.closest('.row')?.querySelector('.row-main')?.append(h('div', { class: 'row-error', role: 'alert' }, this.renameError));
    } else el?.remove();
  }

  // ---------- Add account ----------
  private validateName(name: string): string | undefined {
    if (!name) return undefined;
    if (!NAME_RE.test(name)) return t('validate.nameChars');
    if (sameName(name, 'default')) return t('validate.nameReserved');
    if (this.tab.accounts.some((a) => sameName(a.name, name) || sameName(a.label, name))) return t('validate.nameExists');
    return undefined;
  }

  private updateAddHelp(): void {
    const name = this.addField.value.trim();
    const error = this.addError ?? this.validateName(name);
    this.addField.invalid = !!error;
    this.addButton.disabled = this.adding || !name || !!error;
    this.addHelp.className = error ? 'help error' : 'help';
    const createKey = !this.addLinked.checked ? 'add.help.independent'
      : this.mode === 'codex' && codexRestart().userEnv ? 'codex.addHelpSharedWin'
        : (`${this.mode}.addHelpShared` as const);
    this.addHelp.textContent =
      error ?? (name ? t(createKey, { dir: this.dirPrefix() + name }) : t('add.helpIdle', { prefix: this.dirPrefix() }));
  }

  private submitAdd(): void {
    const name = this.addField.value.trim();
    if (this.adding || this.addError || !name || this.validateName(name)) return;
    this.adding = true;
    this.updateAddHelp();
    this.send({ type: 'add', name, shared: this.addLinked.checked });
  }

  // ---------- Rendering ----------
  // Codex not enabled: only the explanation and the "Enable" button
  private renderDisabled(): HTMLElement {
    return h(
      'section',
      { class: 'disabled-card' },
      h('div', { class: 'disabled-icon' }, h('vscode-icon', { name: 'plug', size: '26' })),
      h('div', { class: 'disabled-title' }, t('disabled.title')),
      h('div', { class: 'disabled-text' }, joinSentences(t(codexRestart().userEnv ? 'disabled.textWin' : 'disabled.text'), t(DISABLED_RESTART[codexRestart().context]))),
      h('div', { class: 'disabled-actions' }, onClick(h('vscode-button', { icon: 'check', 'data-action': 'enable' }, t('disabled.enable')), () => this.send({ type: 'enable' }))),
    );
  }

  // Codex: the state file changed but this window has not restarted the server yet
  private renderPending(): HTMLElement | null {
    if (this.mode !== 'codex' || !this.tab.pendingDir) return null;
    const { context } = codexRestart();
    const local = context === 'local';
    const text = context === 'remote' ? 'pending.textRemote' : local ? 'pending.textLocalManual' : 'pending.text';
    return h(
      'div',
      { class: 'banner', role: 'status' },
      h(
        'div',
        { class: 'banner-body' },
        bannerTitle('info', t(local ? 'pending.titleLocal' : 'pending.title', { name: this.tab.pendingDir })),
        h('div', { class: 'banner-text' }, t(text)),
      ),
    );
  }

  // Claude: reload banner
  private renderBanner(): HTMLElement | null {
    if (this.mode !== 'claude' || !this.tab.switchedTo) return null;
    return h(
      'div',
      { class: 'banner', role: 'status' },
      h(
        'div',
        { class: 'banner-body' },
        bannerTitle('info', t('banner.title', { name: this.tab.switchedTo })),
        h('div', { class: 'banner-text' }, t('banner.text')),
        h(
          'div',
          { class: 'banner-actions' },
          onClick(h('vscode-button', { icon: 'refresh', 'data-action': 'reload' }, t('common.reloadWindow')), () => this.send({ type: 'reload' })),
        ),
      ),
      withAction(toolbarButton('close', t('banner.dismiss'), () => this.send({ type: 'dismissBanner' })), 'dismissBanner'),
    );
  }

  // Recommendation card (the host decides, recommend in src/recommend.ts): the account's general windows as the row
  // shows them (the display settings may hide some), when it was observed, and the actions Switch (the same message
  // as the row's button, so Codex gets its usual selection and restart flow) and Terminal. The card carries no
  // data-dir: focus restore must not take it for the recommended account's row
  private renderRecommendation(): HTMLElement | null {
    if (this.mode === 'claude' ? this.tab.switchedTo : this.tab.pendingDir) return null;
    const a = this.tab.recommended !== undefined && !this.tab.hideRecommendation ? this.tab.accounts.find((x) => x.dir === this.tab.recommended) : undefined;
    if (!a) return null;
    const display = state.usageDisplay ?? 'remaining';
    const windows = (a.usage?.windows ?? []).filter((w) => !w.scope).map((w) => {
      const remaining = remainingPercent(w);
      const percent = display === 'used' ? Number((100 - remaining).toFixed(2)) : remaining;
      return `${windowDuration(w)} ${t(display === 'used' ? 'usage.used' : 'usage.remaining', { percent })}`;
    });
    const actions = h('div', { class: 'banner-actions' });
    // Each button carries a tooltip saying what it does with the recommended account (switch vs. a terminal without switching)
    actions.append(onClick(h('vscode-button', { icon: 'arrow-swap', 'data-action': 'switch', title: t(`${this.mode}.recommendSwitchTitle`, { name: a.label }) }, t('recommend.switch')), (e) => {
      if (e.detail > 1) return;
      this.lastSwitchAt = Date.now();
      this.send({ type: 'switch', dir: a.dir });
    }));
    actions.append(onClick(h('vscode-button', { secondary: true, icon: 'terminal', 'data-action': 'terminal', title: t(`${this.mode}.recommendTerminalTitle`, { name: a.label }) }, t('recommend.terminal')), () => this.send({ type: 'terminal', dir: a.dir })));
    return h(
      'div',
      { class: 'banner recommend', role: 'region', 'aria-label': t('recommend.title', { name: a.label }) },
      h(
        'div',
        { class: 'banner-body' },
        bannerTitle('lightbulb', t('recommend.title', { name: a.label })),
        h('div', { class: 'banner-text recommend-text' }, ...windows.flatMap((w) => [w, ' · ']), a.usage && updatedAgoText(a.usage.checkedAt)),
        actions,
      ),
    );
  }

  private renderRow(a: AccountView): HTMLElement {
    const classes = ['row'];
    if (a.isCurrent) classes.push('is-current');

    if (this.confirmingDir === a.dir) {
      // Leaving the confirmation returns the focus to the row's remove button
      const close = (): void => {
        this.confirmingDir = undefined;
        this.render();
        this.focusControl(a.dir, 'remove');
      };
      const row = h(
        'li',
        { class: classes.concat('is-confirming').join(' '), 'data-plan': planClass(a.plan, this.mode), 'data-dir': a.dir },
        h('div', { class: 'confirm-text' }, h('vscode-icon', { name: 'trash' }), t('confirm.text', { name: a.label })),
        h('div', { class: 'confirm-hint' }, t('confirm.hint')),
        h(
          'div',
          { class: 'confirm-actions' },
          onClick(h('vscode-button', { 'data-action': 'confirmRemove' }, t('confirm.remove')), () => {
            this.send({ type: 'remove', dir: a.dir });
            close();
          }),
          onClick(h('vscode-button', { secondary: true, 'data-action': 'confirmCancel' }, t('confirm.cancel')), close),
        ),
      );
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        close();
      });
      return row;
    }

    const editing = this.renamingDir === a.dir && !!this.renameField;
    const selected = this.mode === 'codex' && a.isSelected === true;
    const canSwitch = !a.isCurrent || (this.mode === 'codex' && a.isSelected === false);
    if (editing) classes.push('is-editing');

    // Built in edit mode too: CSS hides it there (visibility: hidden) so the card keeps its height and columns
    // Switch / Log in and the other actions are two groups, so the latter wrap together and stay on the right
    const textButtons = h('div', { class: 'row-btns' });
    const iconButtons = h('div', { class: 'row-icons' });
    {
      // Conversions are refused by the host for the current account and for the Codex account selected but not yet effective
      const convertible = a.kind === 'named' && !a.isCurrent && !selected;
      // Switch uses the same toolbar style as the other icons (double-click / Enter on the row stay as shortcuts);
      // the second click of a double-click (detail > 1) would send a duplicate switch
      if (canSwitch) {
        textButtons.append(
          withAction(
            toolbarButton('arrow-swap', t('row.switch'), (e) => {
              if (e.detail > 1) return;
              this.lastSwitchAt = Date.now();
              this.send({ type: 'switch', dir: a.dir });
            }),
            'switch',
          ),
        );
      }
      // Not logged in: a "Log in" text button; logged in: a terminal icon to run the CLI with this account
      if (!a.loggedIn) {
        textButtons.append(
          onClick(
            h('vscode-button', { class: 'row-btn', title: t(`${this.mode}.loginTitle`), 'data-action': 'terminal' }, t('row.login')),
            () => this.send({ type: 'terminal', dir: a.dir }),
          ),
        );
      }
      // Independent account: offer converting it to a shared one (the host confirms)
      if (convertible && a.shared === false) {
        iconButtons.append(withAction(toolbarButton('link', t('row.share'), () => this.send({ type: 'share', dir: a.dir })), 'share'));
      }
      // Shared account: offer converting it back to an independent one (the host confirms)
      if (convertible && a.shared === true) {
        iconButtons.append(withAction(toolbarButton('debug-disconnect', t('row.unshare'), () => this.send({ type: 'unshare', dir: a.dir })), 'unshare'));
      }
      if (a.loggedIn) {
        iconButtons.append(withAction(toolbarButton('terminal', t(`${this.mode}.terminalTitle`), () => this.send({ type: 'terminal', dir: a.dir })), 'terminal'));
      }
      // Registered accounts with usage limits can be left out of recommendations (the host keeps the mark)
      if (this.tab.accounts.length > 1 && a.kind !== 'external' && a.usageEligible && !this.tab.hideRecommendation) {
        const excluded = a.recommendExcluded === true;
        // A toggle button (role switch); the host's answer re-renders it, so the component's own flip is overridden
        const toggle = toolbarButton(excluded ? 'lightbulb-empty' : 'lightbulb', t(excluded ? 'row.recommendInclude' : 'row.recommendExclude'), () => this.send({ type: 'recommendExclude', dir: a.dir, excluded: !excluded }));
        toggle.setAttribute('toggleable', '');
        if (excluded) toggle.setAttribute('checked', '');
        iconButtons.append(withAction(toggle, 'recommendExclude'));
      }
      // The current account cannot be removed; the confirmation that opens starts with the focus on Cancel
      if (a.kind === 'named' && !a.isCurrent && !selected) {
        iconButtons.append(
          withAction(
            toolbarButton('trash', t('row.remove'), () => {
              this.confirmingDir = a.dir;
              this.render();
              this.focusControl(a.dir, 'confirmCancel');
            }),
            'remove',
          ),
        );
      }
    }

    // Shared account: a link badge right after the name
    const sharedIcon =
      a.kind === 'named' && a.shared === true && !editing && h('span', { class: 'shared-icon', title: t('account.sharedBadge'), role: 'img', 'aria-label': t('account.sharedBadge') }, h('vscode-icon', { name: 'link', size: '10' }));
    // Named account: a small pencil after the name (and the shared badge), shown on row hover / focus; it follows the
    // last line of a wrapped name because it is inline in the name's text flow
    const renameButton =
      a.kind === 'named' &&
      !editing &&
      onClick(
        h('button', { type: 'button', class: 'rename-btn', title: t('row.rename'), 'aria-label': t('row.renameAria', { name: a.label }), 'data-action': 'rename' }, h('vscode-icon', { name: 'edit', size: '12' })),
        (e) => this.startRename(a, (e.currentTarget as HTMLElement).closest('.row-title')?.getBoundingClientRect().height),
      );
    const title = editing
      ? withHeight(h('div', { class: 'row-title' }, this.renameField!, this.renameSaveButton()), this.renameTitleHeight)
      : h(
          'div',
          { class: 'row-title' },
          h('span', { class: 'row-name' }, ...nameWithTail(a.label, sharedIcon, renameButton)),
        );
    // Tags (plan, not logged in) sit at the right end of the name line and wrap under it only when they do not fit; the
    // action buttons get their own line, except rows with no Switch / Log in, which join the name line before the tags
    const inlineActions = !textButtons.hasChildNodes();
    if (inlineActions) classes.push('inline-actions');
    const actions = h('div', { class: 'row-actions' }, textButtons.hasChildNodes() && textButtons, iconButtons.hasChildNodes() && iconButtons);
    const tags = h('div', { class: 'row-tags' }, planPill(a), !a.loggedIn && h('span', { class: 'pill warn' }, t('account.notLoggedIn')));

    // .row-main is display: contents, so its lines land directly in the .row grid below the name line
    const row = h(
      'li',
      {
        class: classes.join(' '), 'data-plan': planClass(a.plan, this.mode), 'data-dir': a.dir, tabindex: !canSwitch || editing ? undefined : '0',
        // The current card is marked for assistive technology only
        'aria-current': a.isCurrent ? 'true' : undefined,
      },
      h('div', { class: 'row-head' }, h('div', { class: 'row-ident' }, avatar(a), title), inlineActions && actions, tags),
      h(
        'div',
        { class: 'row-main' },
        loginStatus(a, this.tab.hideEmail),
        usageHistory(a),
        !inlineActions && actions,
        !a.loggedIn && !a.isCurrent && h('div', { class: 'row-hint' }, t(`${this.mode}.loginHint`)),
        editing && this.renameError && h('div', { class: 'row-error', role: 'alert' }, this.renameError),
      ),
    );
    // Double-click or Enter selects an account, including the effective account when cancelling a pending selection
    if (canSwitch && !editing) {
      row.addEventListener('dblclick', () => {
        if (Date.now() - this.lastSwitchAt > 500) this.send({ type: 'switch', dir: a.dir });
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === row) this.send({ type: 'switch', dir: a.dir });
      });
    }
    return row;
  }

  // Page tools, including CLI updates (shown even when Codex is not enabled), always shown; Re-link only when the page
  // has a linked account, so it comes last and its showing or hiding never moves the other buttons
  private renderTools(): HTMLElement {
    const btn = (icon: string, label: string, title: string, tool: ToolId): HTMLElement =>
      onClick(h('vscode-button', { secondary: true, icon, title }, label), () => this.send({ type: 'tool', tool }));
    this.syncButton = btn('sync', t('tools.sync'), t(`${this.mode}.syncTitle`), 'sync');
    this.updateSyncButton();
    return h(
      'div',
      { class: 'page-tools' },
      h('div', { class: 'tools-summary' }, t('tools.title')),
      h(
        'div',
        { class: 'page-tools-row' },
        btn('symbol-ruler', this.text.mdLabel, t(`${this.mode}.mdTitle`), 'openGlobalMd'),
        btn('settings-gear', t(`${this.mode}.settingsLabel`), t(`${this.mode}.settingsTitle`), 'openSettings'),
        btn('cloud-download', t('tools.updateCli'), t('tools.updateCliTitle'), 'updateCli'),
        this.syncButton,
      ),
    );
  }

  // Re-link only acts on linked accounts, so it is hidden while the page has none
  private updateSyncButton(): void {
    this.syncButton.hidden = !this.tab.accounts.some((a) => a.kind === 'named' && a.shared === true);
  }

  // A refresh button acts on the current account (refresh-all: on every registered one), so it needs one that can be queried;
  // a refresh already running is joined by the host, so a repeated click starts nothing new
  private updateUsageButtons(): void {
    const accounts = receivedState && this.tab.enabled ? this.tab.accounts : [];
    this.refreshButton.hidden = !accounts.some((a) => a.isCurrent && a.usageEligible);
    this.refreshAllButton.hidden = !accounts.some((a) => a.kind !== 'external' && a.usageEligible);
  }

  private renderList(): void {
    // The current account always comes first; the rest keep their order
    const accounts = this.tab.accounts;
    const ordered = [...accounts.filter((a) => a.isCurrent), ...accounts.filter((a) => !a.isCurrent)];
    this.listCount.textContent = String(accounts.length);
    this.list.replaceChildren(...ordered.map((a) => this.renderRow(a)));
  }

  // What the last render showed; a state push that changes neither the page's state nor the locale keeps the DOM
  // (keyboard focus, screen-reader alerts and IME composition stay undisturbed)
  private renderedKey?: string;

  private renderKey(): string {
    return `${receivedState}|${getLocale()}|${JSON.stringify([this.tab, codexRestart(), state.usageDisplay, state.usageThresholds])}`;
  }

  renderIfChanged(): void {
    if (this.renderKey() !== this.renderedKey) this.render();
  }

  /** The focused control inside the page's rows, banners or cards, identified by its row's dir and its action */
  private focusedControl(): { dir?: string; action?: string } | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.root.contains(active) || active === this.renameField) return undefined;
    const dir = active.closest<HTMLElement>('[data-dir]')?.dataset.dir;
    const action = active.closest<HTMLElement>('[data-action]')?.dataset.action;
    return dir === undefined && action === undefined ? undefined : { dir, action };
  }

  /**
   * Focuses the control with this action in the row of this dir (dir undefined: outside the rows); without it, the row
   * itself when focusable, otherwise the row's first control
   */
  private focusControl(dir: string | undefined, action: string | undefined): void {
    const row = dir === undefined ? undefined : [...this.root.querySelectorAll<HTMLElement>('[data-dir]')].find((el) => el.dataset.dir === dir);
    if (dir !== undefined && !row) return;
    const controls = [...(row ?? this.root).querySelectorAll<HTMLElement>('[data-action]')].filter((el) => el.closest('[data-dir]') === (row ?? null));
    const target = controls.find((el) => el.dataset.action === action) ?? (row && row.tabIndex >= 0 ? row : controls[0]);
    if (target) focusElement(target);
  }

  render(): void {
    this.renderedKey = this.renderKey();
    // A rebuild replaces the focused node; remember what it was so the replacement gets the focus back
    const focused = this.focusedControl();
    const renameFocused = this.renameField !== undefined && document.activeElement === this.renameField;
    this.rendering = true;
    try {
      this.updateSyncButton();
      this.updateUsageButtons();
      if (!receivedState) {
        this.top.replaceChildren(h('p', { role: 'status', 'aria-live': 'polite' }, t('panel.loading')));
        this.listSection.hidden = true;
        return;
      }
      if (!this.tab.enabled) {
        this.top.replaceChildren(this.renderDisabled());
        this.listSection.hidden = true;
        return;
      }
      this.listSection.hidden = false;
      this.top.replaceChildren(...[this.renderPending(), this.renderBanner(), this.renderRecommendation()].filter((n): n is HTMLElement => !!n));
      this.renderList();
      this.updateAddHelp();
    } finally {
      this.rendering = false;
    }
    // Restore the moved rename field only when it actually held focus before the rebuild.
    if (renameFocused && this.renameField && !this.root.hidden) this.renameField.focus();
    else if (focused) this.focusControl(focused.dir, focused.action);
  }
}

// ---------- Tab bar and page assembly ----------
const pages: Record<PanelMode, Page> = { claude: new Page('claude'), codex: new Page('codex') };
// Codicon product glyphs; Codex has none of its own, so it uses the OpenAI mark
const TAB_ICONS: Record<PanelMode, string> = { claude: 'claude', codex: 'openai' };
const tabLabels: Record<PanelMode, HTMLElement> = { claude: h('span', { class: 'tab-label' }), codex: h('span', { class: 'tab-label' }) };
function tabButton(mode: PanelMode): HTMLElement {
  const button = h('button', { class: 'tab', type: 'button', role: 'tab', id: `tab-${mode}`, 'aria-controls': `panel-${mode}` },
    h('vscode-icon', { name: TAB_ICONS[mode], size: '14', 'aria-hidden': 'true' }), tabLabels[mode]);
  return onClick(button, () => {
    if (activeTab === mode) return;
    setActiveTab(mode);
    send({ type: 'setTab', mode });
  });
}
const tabButtons: Record<PanelMode, HTMLElement> = { claude: tabButton('claude'), codex: tabButton('codex') };
const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabButtons.claude, tabButtons.codex);
tabBar.addEventListener('keydown', (event) => {
  const index = MODES.findIndex((mode) => tabButtons[mode] === event.target);
  if (index < 0) return;
  let next: PanelMode;
  switch (event.key) {
    case 'ArrowRight': next = MODES[(index + 1) % MODES.length]; break;
    case 'ArrowLeft': next = MODES[(index + MODES.length - 1) % MODES.length]; break;
    case 'Home': next = MODES[0]; break;
    case 'End': next = MODES[MODES.length - 1]; break;
    default: return;
  }
  event.preventDefault();
  tabButtons[next].click();
  tabButtons[next].focus();
});


function setActiveTab(mode: PanelMode): void {
  activeTab = mode;
  vscode.setState({ tab: mode });
  renderTabs();
}

function renderTabs(): void {
  const active = activeTab ?? state.active;
  for (const mode of MODES) {
    const selected = mode === active;
    tabButtons[mode].classList.toggle('is-active', selected);
    tabButtons[mode].setAttribute('aria-selected', String(selected));
    tabButtons[mode].tabIndex = selected ? 0 : -1;
    pages[mode].root.hidden = !selected;
  }
}

const app = document.getElementById('app')!;
app.replaceChildren(tabBar, pages.claude.root, pages.codex.root);

// Fixed toolbar at the bottom of the panel: shared by both pages, mode is the current tab. Groups are divided by a
// separator: information and help, the two disruptive actions together, and the star link on its own
const FOOTER_GROUPS = [
  [['info', 'footer.versions', 'cliVersions'], ['book', 'footer.help', 'openHelp']],
  [['refresh', 'common.reloadWindow', 'reloadWindow'], ['debug-restart', 'footer.restartExtHost', 'restartExtHost']],
  [['star-empty', 'footer.star', 'openStar']],
] as const satisfies ReadonlyArray<ReadonlyArray<readonly [icon: string, title: MessageKey, tool: ToolId]>>;
const footer = h('div', { class: 'tools', role: 'toolbar' });
const footerVersion = h('div', { class: 'extension-version' });
function renderFooter(): void {
  footer.setAttribute('aria-label', t('tools.title'));
  footerVersion.textContent = t('footer.version', { version: __PLANSWAP_VERSION__ });
  footer.replaceChildren(
    ...FOOTER_GROUPS.flatMap((group, index) => [
      index > 0 && h('span', { class: 'tools-sep', role: 'separator', 'aria-orientation': 'vertical' }),
      ...group.map(([icon, title, tool]) =>
        toolbarButton(icon, t(title), () => {
          // The info button hides an open versions card locally; only opening asks the host (which runs the CLIs)
          if (tool === 'cliVersions' && !versionsCard.hidden) {
            versionsCard.hidden = true;
            return;
          }
          send({ type: 'tool', mode: activeTab ?? state.active, tool });
        }),
      ),
    ]).filter((n): n is HTMLElement => !!n),
  );
}
// Versions card: shown above the footer toolbar; the info button again or the close button hides it
const versionsCard = h('div', { class: 'versions', hidden: true, role: 'status' });
let versionItems: Array<{ label: string; value: string }> = [];
// Every versions reply (a click or a locale-change refresh) replaces the items and shows the card
function showVersions(items: Array<{ label: string; value: string }>): void {
  versionItems = items;
  renderVersions();
  versionsCard.hidden = false;
}
function renderVersions(): void {
  const items = versionItems;
  versionsCard.replaceChildren(
    h('div', { class: 'versions-head' }, h('span', {}, t('versions.title')), toolbarButton('close', t('versions.close'), () => (versionsCard.hidden = true))),
    h(
      'div',
      { class: 'versions-list' },
      ...items.map((v) => h('div', { class: 'version-item' }, h('div', { class: 'version-label' }, v.label), h('div', { class: 'version-value' }, v.value))),
    ),
  );
}
app.after(versionsCard, footer, footerVersion);

// Re-translates everything built once; render() rebuilds the rest
function applyLocale(): void {
  setLocale(state.locale);
  for (const mode of MODES) tabLabels[mode].textContent = t(`tab.${mode}`);
  tabBar.setAttribute('aria-label', t('tabs.ariaLabel'));
  renderFooter();
  renderVersions();
  // Item labels and values are host strings in the old locale; ask the host to regenerate them
  if (!versionsCard.hidden) send({ type: 'tool', mode: activeTab ?? state.active, tool: 'cliVersions' });
  for (const mode of MODES) pages[mode].applyLocale();
}

function render(): void {
  renderTabs();
  for (const mode of MODES) pages[mode].render();
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const msg = e.data;
  if (msg.type === 'state') {
    const firstState = !receivedState;
    const renderStartedAt = performance.now();
    receivedState = true;
    if (firstState) console.info(`[planswap] first state received: ${(renderStartedAt - startedAt).toFixed(1)}ms since script start`);
    state = msg.state;
    // The host sets <html lang> only once when it creates the webview; keep it in sync on every push
    document.documentElement.lang = intlLocale(state.locale);
    if (state.locale !== getLocale()) applyLocale();
    // No local record yet: adopt the host's tab and remember it
    if (!activeTab) setActiveTab(state.active);
    for (const mode of MODES) pages[mode].onState();
    renderTabs();
    for (const mode of MODES) pages[mode].renderIfChanged();
    if (firstState) console.info(`[planswap] first cards rendered: ${(performance.now() - renderStartedAt).toFixed(1)}ms DOM update`);
  } else if (msg.type === 'addResult') {
    pages[msg.mode].onAddResult(msg.error);
  } else if (msg.type === 'renameResult') {
    pages[msg.mode].onRenameResult(msg.dir, msg.error);
  } else if (msg.type === 'versions') {
    showVersions(msg.items);
  } else if (msg.type === 'focusAdd') {
    if (activeTab !== msg.mode) {
      setActiveTab(msg.mode);
      send({ type: 'setTab', mode: msg.mode });
    }
    pages[msg.mode].focusAdd();
  }
});

applyLocale();
render();
console.info(`[planswap] frontend ready: ${(performance.now() - startedAt).toFixed(1)}ms since script start`);
send({ type: 'ready' });
