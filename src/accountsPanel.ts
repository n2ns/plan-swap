import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { DEFAULT_NAME, claudeJsonPath, readAccountInfo, samePath, type Account } from './paths';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import { EXTERNAL_NAME, labelFor, type LabelStore } from './labels';
import type { AccountView, FromWebview, PanelMode, PanelState, RestartInfo, TabState, ToWebview } from './protocol';
import { isSharedClaudeAccount } from './claudeShare';
import { getLocale, t } from './i18n';
import { comparablePath, isWindows } from './platform';

export const VIEW_ID = 'planswap.accounts';

const ACTIVE_TAB_KEY = 'panel.activeTab';

/** Data source of a panel tab; Claude and Codex each implement it */
export interface PanelSource {
  // Each implementation handles the "external directory" row itself; label is already filled in
  accounts(): AccountView[];
  enabled(): boolean;
  // Returns a display name
  pendingDir(): string | undefined;
  // Absolute paths of files to watch (claude: claudeJsonPath of each dir; codex: auth.json of each dir + the state file)
  watchTargets(): string[];
  // codex only
  restart?(): RestartInfo;
}

/** Claude data source: appends an "external directory" row when the current dir matches no registered account */
export function claudePanelSource(store: AccountStore, labels: LabelStore): PanelSource {
  const accounts = (): AccountView[] => {
    const cur = currentDir();
    const rows: AccountView[] = store.all().map((a) => ({
      kind: a.name === DEFAULT_NAME ? 'default' : 'named',
      name: a.name,
      label: labelFor(a.name, labels),
      dir: a.dir,
      dirLabel: tildify(a.dir),
      ...viewInfo(readAccountInfo(a.dir, isExplicitConfigDir(a.dir))),
      isCurrent: samePath(a.dir, cur),
      shared: a.name === DEFAULT_NAME ? undefined : isSharedClaudeAccount(a.dir),
    }));
    if (!rows.some((r) => r.isCurrent)) {
      rows.push({
        kind: 'external',
        name: EXTERNAL_NAME,
        label: labelFor(EXTERNAL_NAME, labels),
        dir: cur,
        dirLabel: tildify(cur),
        ...viewInfo(readAccountInfo(cur, isExplicitConfigDir(cur))),
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

  get activeTab(): PanelMode {
    return this.memento.get<PanelMode>(ACTIVE_TAB_KEY) === 'codex' ? 'codex' : 'claude';
  }

  /** Account rows currently displayed */
  accounts(mode: PanelMode): AccountView[] {
    return this.sources[mode].accounts();
  }

  /** Finds a displayed account by directory; only accepts directories present in the list */
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

  post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

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
    view.webview.onDidReceiveMessage((msg: FromWebview) => {
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
        // The webview is untrusted input: only the known modes reach the memento
        if (msg.mode === 'claude' || msg.mode === 'codex') void this.memento.update(ACTIVE_TAB_KEY, msg.mode);
      } else void this.handlers[msg.mode]?.(msg);
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

  dispose(): void {
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    this.changed.dispose();
  }

  private tabState(mode: PanelMode): TabState {
    const source = this.sources[mode];
    return {
      enabled: source.enabled(),
      accounts: source.accounts(),
      switchedTo: mode === 'claude' ? this.switchedTo : undefined,
      pendingDir: source.pendingDir(),
      restart: source.restart?.(),
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
<html lang="${getLocale() === 'zh-cn' ? 'zh-CN' : getLocale()}">
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

/**
 * The account-info fields a row shows. Picked explicitly rather than spread, so fields meant to stay in the host
 * (the identity comparison key) never reach the Webview.
 */
export function viewInfo(info: { email?: string; plan?: string; loggedIn: boolean }): Pick<AccountView, 'email' | 'plan' | 'loggedIn'> {
  return { email: info.email, plan: info.plan, loggedIn: info.loggedIn };
}

export function tildify(dir: string): string {
  const home = os.homedir();
  // Windows paths are case-insensitive (a drive letter or folder may differ only in case); the rest keeps its spelling
  const [d, h] = isWindows() ? [dir.toLowerCase(), home.toLowerCase()] : [dir, home];
  return d === h || d.startsWith(h + path.sep) ? '~' + dir.slice(home.length) : dir;
}
