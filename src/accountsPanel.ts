import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { DEFAULT_NAME, claudeJsonPath, findSameDir, readAccountInfo, samePath, type Account } from './paths';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import { EXTERNAL_NAME, labelFor, type LabelStore } from './labels';
import type { AccountView, FromWebview, PanelMode, PanelState, RestartInfo, TabState, ToWebview } from './protocol';
import { isSharedClaudeAccount } from './claudeShare';
import { readClaudeUsage } from './claudeUsage';
import { getLocale, intlLocale, t } from './i18n';
import { comparablePath, isWindows } from './platform';

// planswap.sidebar.* display settings; extension.ts refreshes the panel when any of them changes. Model-specific
// (scoped) Claude windows are sent only while showModelLimits is on (off by default)
export const SHOW_MODEL_LIMITS_SETTING = 'sidebar.showModelLimits';
export const SHOW_EMAIL_SETTING = 'sidebar.showEmail';
export const SHOW_FIVE_HOUR_SETTING = 'sidebar.showFiveHourLimit';
export const SHOW_WEEKLY_SETTING = 'sidebar.showWeeklyLimit';

const FIVE_HOURS = 300;
const SEVEN_DAYS = 7 * 1440;

export interface SidebarDisplay { email: boolean; fiveHour: boolean; weekly: boolean }

/** The sidebar display settings (all shown by default); read on every state push. */
export function sidebarDisplay(): SidebarDisplay {
  const config = vscode.workspace.getConfiguration('planswap');
  return {
    email: config.get<boolean>(SHOW_EMAIL_SETTING, true),
    fiveHour: config.get<boolean>(SHOW_FIVE_HOUR_SETTING, true),
    weekly: config.get<boolean>(SHOW_WEEKLY_SETTING, true),
  };
}

/**
 * Applies the sidebar display settings to the rows of either page: a hidden email is not sent, and the general 5-hour
 * and 7-day windows are dropped when hidden (model-specific windows follow their own setting; a row left with no
 * window loses its usage block).
 */
export function applySidebarDisplay(rows: AccountView[], display: SidebarDisplay): AccountView[] {
  const hidden = (w: { windowMinutes?: number; scope?: string }): boolean => !w.scope &&
    ((!display.fiveHour && w.windowMinutes === FIVE_HOURS) || (!display.weekly && w.windowMinutes === SEVEN_DAYS));
  return rows.map((row) => {
    const next = display.email ? row : { ...row, email: undefined };
    if (!next.usage) return next;
    const windows = next.usage.windows.filter((w) => !hidden(w));
    if (windows.length === next.usage.windows.length) return next;
    return { ...next, usage: windows.length ? { ...next.usage, windows } : undefined };
  });
}

export const VIEW_ID = 'planswap.accounts';

const ACTIVE_TAB_KEY = 'panel.activeTab';

/** Data source of a panel tab; Claude and Codex each implement it */
export interface PanelSource {
  // Each implementation handles the "external directory" row itself; label is already filled in
  accounts(): AccountView[];
  enabled(): boolean;
  // Returns a display name
  pendingDir(): string | undefined;
  // Absolute paths of files to watch (claude: claudeJsonPath(dir, isExplicitConfigDir(dir)) of each dir; codex: auth.json
  // of each dir + the state file)
  watchTargets(): string[];
  // codex only; copied into TabState.restart on every push
  restart?(): RestartInfo;
}

/**
 * Claude data source: one row per store.all() account (label via labelFor; email, plan, usageEligible and usage via
 * claudeRowInfo; shared via isSharedClaudeAccount for named rows), plus an "external directory" row (EXTERNAL_NAME,
 * kind 'external') when the current dir matches no registered account (findSameDir). enabled is always true and
 * pendingDir always undefined.
 */
export function claudePanelSource(store: AccountStore, labels: LabelStore): PanelSource {
  const accounts = (): AccountView[] => {
    const cur = currentDir();
    const all = store.all();
    const curIdx = findSameDir(all.map((a) => a.dir), cur);
    const rows: AccountView[] = all.map((a, i) => ({
      kind: a.name === DEFAULT_NAME ? 'default' : 'named',
      name: a.name,
      label: labelFor(a.name, labels),
      dir: a.dir,
      dirLabel: tildify(a.dir),
      ...claudeRowInfo(a.dir),
      isCurrent: i === curIdx,
      shared: a.name === DEFAULT_NAME ? undefined : isSharedClaudeAccount(a.dir),
    }));
    if (!rows.some((r) => r.isCurrent)) {
      rows.push({
        kind: 'external',
        name: EXTERNAL_NAME,
        label: labelFor(EXTERNAL_NAME, labels),
        dir: cur,
        dirLabel: tildify(cur),
        ...claudeRowInfo(cur),
        isCurrent: true,
      });
    }
    return rows;
  };
  return {
    accounts,
    enabled: () => true,
    pendingDir: () => undefined,
    // Same directories as accounts() (registered ones plus the external current dir) without reading any .claude.json
    watchTargets: () => {
      const cur = currentDir();
      const dirs = store.all().map((a) => a.dir);
      if (!dirs.some((d) => samePath(d, cur))) dirs.push(cur);
      return dirs.map((d) => claudeJsonPath(d, isExplicitConfigDir(d)));
    },
  };
}

type Handler = (msg: FromWebview) => void | Promise<void>;

/**
 * The single sidebar webview provider hosting both tabs; the constructor already syncs the file watchers.
 *
 * Incoming messages are checked with checkMessage first (malformed ones are logged and dropped). 'ready' pushes the
 * state and delivers a queued focusAdd; 'setTab' only writes the memento (no push); every other message goes to the
 * handler of its mode (dispatch). The state is pushed again when the view becomes visible; when hidden the ready flag
 * is cleared, so a replacement document must send 'ready' before queued focus requests are delivered. Every state push
 * fires onDidChange.
 */
export class AccountsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly handlers: Partial<Record<PanelMode, Handler>> = {};
  private switchedTo?: string;
  // Focus request received before the panel page is ready
  private pendingFocusAdd?: PanelMode;
  private ready = false;
  private pageStartedAt = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  // Fires when accounts or watched files change, so the status bar can sync
  readonly onDidChange = this.changed.event;
  // Keyed by the absolute path of the watched file
  private readonly watchers = new Map<string, vscode.Disposable>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sources: { claude: PanelSource; codex: PanelSource },
    private readonly memento: vscode.Memento,
  ) {
    this.syncWatchers();
  }

  setHandler(mode: PanelMode, handler: Handler): void {
    this.handlers[mode] = handler;
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  /** The tab last clicked (memento 'panel.activeTab'); 'claude' by default. */
  get activeTab(): PanelMode {
    return this.memento.get<PanelMode>(ACTIVE_TAB_KEY) === 'codex' ? 'codex' : 'claude';
  }

  /** Account rows currently displayed */
  accounts(mode: PanelMode): AccountView[] {
    return this.sources[mode].accounts();
  }

  /**
   * Finds a displayed account by directory (samePath); only accepts directories present in the list, so every `dir`
   * from the webview is checked here before it is acted on.
   */
  resolve(mode: PanelMode, dir: string): (Account & { kind: AccountView['kind'] }) | undefined {
    const row = this.accounts(mode).find((r) => samePath(r.dir, dir));
    return row && { name: row.name, dir: row.dir, kind: row.kind };
  }

  /** claude only */
  setSwitchedTo(label: string | undefined): void {
    this.switchedTo = label;
    this.refresh();
  }

  /** Both tabs: sync watchers + push the full state */
  refresh(): void {
    this.syncWatchers();
    this.pushState();
  }

  /** Silently dropped while no view is resolved. */
  post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  /** Focuses the view, then asks the page to open and focus its add input; queued until the page sent 'ready'. */
  focusAdd(mode: PanelMode): void {
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`).then(() => {
      if (this.ready) this.post({ type: 'focusAdd', mode });
      else this.pendingFocusAdd = mode;
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    this.pageStartedAt = performance.now();
    console.info('[planswap] panel document created');
    const media = vscode.Uri.joinPath(this.extensionUri, 'dist', 'media');
    // Set the CSP page before options; the reverse order loads an empty page first and triggers a "missing CSP" warning
    view.webview.html = this.html(view.webview, media);
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.onDidReceiveMessage((raw: unknown) => {
      // The webview is untrusted input: malformed messages are dropped before any handler runs
      const msg = checkMessage(raw);
      if (!msg) {
        console.warn('[planswap] ignored a malformed panel message');
        return;
      }
      if (msg.type === 'ready') {
        console.info(`[planswap] panel ready: ${(performance.now() - this.pageStartedAt).toFixed(1)}ms since document creation/show`);
        this.ready = true;
        this.pushState();
        if (this.pendingFocusAdd) {
          const mode = this.pendingFocusAdd;
          this.pendingFocusAdd = undefined;
          this.post({ type: 'focusAdd', mode });
        }
      } else if (msg.type === 'setTab') {
        void this.memento.update(ACTIVE_TAB_KEY, msg.mode);
      } else void this.dispatch(msg);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.pageStartedAt = performance.now();
        this.pushState();
      } else {
        this.ready = false;
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  /** Runs the vendor handler of a checked message; a failure is logged and shown instead of an unhandled rejection. */
  async dispatch(msg: FromWebview): Promise<void> {
    if (!('mode' in msg)) return;
    try {
      await this.handlers[msg.mode]?.(msg);
    } catch (err) {
      console.error(`[planswap] panel action ${msg.type} failed:`, err);
      void vscode.window.showErrorMessage(t('panel.actionFailed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    this.changed.dispose();
  }

  private tabState(mode: PanelMode): TabState {
    const source = this.sources[mode];
    const display = sidebarDisplay();
    return {
      enabled: source.enabled(),
      accounts: applySidebarDisplay(source.accounts(), display),
      hideEmail: display.email ? undefined : true,
      switchedTo: mode === 'claude' ? this.switchedTo : undefined,
      pendingDir: source.pendingDir(),
      restart: source.restart?.(),
      // New account folders as the platform writes them: ~/.claude- on Linux, ~\.claude- on Windows
      dirPrefix: tildify(path.join(os.homedir(), mode === 'claude' ? '.claude-' : '.codex-')),
    };
  }

  private pushState(): void {
    const startedAt = performance.now();
    const state: PanelState = {
      active: this.activeTab,
      locale: getLocale(),
      claude: this.tabState('claude'),
      codex: this.tabState('codex'),
    };
    console.debug(`[planswap] state read: ${(performance.now() - startedAt).toFixed(1)}ms; claude=${state.claude.accounts.length}, codex=${state.codex.accounts.length}`);
    this.post({ type: 'state', state });
    this.changed.fire();
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
    const csp = [
      "default-src 'none'",
      `font-src ${webview.cspSource}`,
      // Lit components fall back to inline <style> when adoptedStyleSheets is unsupported
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${intlLocale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('codicon.css')}" id="vscode-codicon-stylesheet">
<link rel="stylesheet" href="${uri('panel-style.css')}">
</head>
<body>
<div id="app"><p role="status" aria-live="polite">${t('panel.loading')}</p></div>
<script nonce="${nonce}" src="${uri('panel.js')}"></script>
</body>
</html>`;
  }

  // Keep the watcher set equal to the union of both sources' watchTargets(); watcher callbacks only push state (no re-sync) to avoid loops
  private syncWatchers(): void {
    // Keyed by comparablePath: on Windows two spellings of one file (drive letter or folder case) share one watcher
    const files = new Map([...this.sources.claude.watchTargets(), ...this.sources.codex.watchTargets()].map((f) => [comparablePath(f), f]));
    for (const [key, w] of this.watchers) {
      if (!files.has(key)) {
        w.dispose();
        this.watchers.delete(key);
      }
    }
    for (const [key, file] of files) {
      if (this.watchers.has(key)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
      );
      const fire = () => this.pushState();
      this.watchers.set(
        key,
        vscode.Disposable.from(watcher, watcher.onDidCreate(fire), watcher.onDidChange(fire), watcher.onDidDelete(fire)),
      );
    }
  }
}

// String fields each message type must carry (besides type and mode); a type missing here is not accepted
const MESSAGE_FIELDS: Record<FromWebview['type'], readonly string[]> = {
  ready: [],
  setTab: [],
  switch: ['dir'],
  terminal: ['dir'],
  remove: ['dir'],
  add: ['name'],
  share: ['dir'],
  unshare: ['dir'],
  rename: ['dir', 'label'],
  reload: [],
  dismissBanner: [],
  enable: [],
  restartServer: [],
  tool: ['tool'],
};

/**
 * Checks a message from the webview (untrusted input) against the protocol: a known type, a known mode (every type but
 * 'ready'), and string values for its string fields. Returns the message, or undefined when it is malformed.
 */
export function checkMessage(raw: unknown): FromWebview | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string' || !Object.hasOwn(MESSAGE_FIELDS, msg.type)) return undefined;
  const type = msg.type as FromWebview['type'];
  if (type !== 'ready' && msg.mode !== 'claude' && msg.mode !== 'codex') return undefined;
  if (!MESSAGE_FIELDS[type].every((f) => typeof msg[f] === 'string')) return undefined;
  return raw as FromWebview;
}

// Account info plus the usage Claude Code cached in the same file; only subscription sign-ins (oauthAccount) have usage
// (and usageEligible). Scoped windows are dropped unless SHOW_MODEL_LIMITS_SETTING is on
function claudeRowInfo(dir: string): Pick<AccountView, 'email' | 'plan' | 'loggedIn' | 'usage' | 'usageEligible'> {
  const explicit = isExplicitConfigDir(dir);
  const info = readAccountInfo(dir, explicit);
  const usage = info.identity !== undefined ? readClaudeUsage(dir, explicit) : undefined;
  const view = info.identity !== undefined ? { ...viewInfo(info), usageEligible: true } : viewInfo(info);
  if (!usage) return view;
  const showModelLimits = vscode.workspace.getConfiguration('planswap').get<boolean>(SHOW_MODEL_LIMITS_SETTING, false);
  return { ...view, usage: { ...usage, windows: usage.windows.filter((w) => showModelLimits || !w.scope) } };
}

/**
 * The account-info fields a row shows. Picked explicitly rather than spread, so fields meant to stay in the host
 * (the identity comparison key) never reach the Webview; both vendors' row builders go through it.
 */
export function viewInfo(info: { email?: string; plan?: string; loggedIn: boolean }): Pick<AccountView, 'email' | 'plan' | 'loggedIn'> {
  return { email: info.email, plan: info.plan, loggedIn: info.loggedIn };
}

/** Replaces the home directory with ~ (case-insensitive on Windows); other paths are returned unchanged. */
export function tildify(dir: string): string {
  const home = os.homedir();
  // Windows paths are case-insensitive (a drive letter or folder may differ only in case); the rest keeps its spelling
  const [d, h] = isWindows() ? [dir.toLowerCase(), home.toLowerCase()] : [dir, home];
  return d === h || d.startsWith(h + path.sep) ? '~' + dir.slice(home.length) : dir;
}
