// Message protocol between the extension and the sidebar webview (shared by both sides; imports no runtime modules).
// Both sides type-check against these unions; the host additionally validates every incoming message at runtime
// (accountsPanel.checkMessage) and re-resolves each `dir` against its own rows before acting on it.
import type { Locale } from './i18n';

export type AccountKind = 'default' | 'named' | 'external';
export type PanelMode = 'claude' | 'codex';
// Setting planswap.usageDisplay: usage bars and percentages show what is left (the default) or what is used
export type UsageDisplay = 'remaining' | 'used';
export type ToolId = 'openGlobalMd' | 'openSettings' | 'reloadWindow' | 'restartExtHost' | 'restartServer' | 'cliVersions' | 'sync' | 'updateCli' | 'openHelp' | 'openStar' | 'refreshUsage' | 'refreshAllUsage';

export interface AccountView {
  kind: AccountKind;
  // Internal name (default / name derived from the directory / EXTERNAL_NAME sentinel), for logic only
  name: string;
  // Display name: the alias (equals name when not set; localized for the external row)
  label: string;
  // Absolute path; the row's identifier in messages
  dir: string;
  // For display, home directory replaced with ~
  dirLabel: string;
  email?: string;
  // For display, formatted plan type (e.g. "Max 20x", "Plus", "API key")
  plan?: string;
  loggedIn: boolean;
  // True when the row's usage limits can be queried: Claude, a subscription sign-in; Codex, a ChatGPT sign-in outside WSL-run Codex (not API key)
  usageEligible?: boolean;
  isCurrent: boolean;
  // Codex only: selected for the next editor/server start; independent of the effective account
  isSelected?: boolean;
  // Named rows only: true = shared with the default account (links), false = independent; undefined for default / external
  shared?: boolean;
  // A historical observation, never a live quota or a prediction after a reset. Codex: the last query result; Claude:
  // the usage cache in the account's own info file. scope names a model-specific limit (e.g. "Fable"), Claude only;
  // limitReached: the service reported the limit as reached (Codex only; the windows may still be below 100%)
  usage?: { windows: Array<{ usedPercent: number; windowMinutes?: number; resetsAt?: number; scope?: string }>; checkedAt: number; limitReached?: boolean };
  // Registered rows only: true when the user excluded the account from recommendations (src/recommend.ts)
  recommendExcluded?: boolean;
}

// Editor connection context from vscode.env.remoteName: undefined → local (including WSLg desktop), 'wsl' → wsl,
// anything else → remote
export type EditorContext = 'local' | 'wsl' | 'remote';
// How a new Codex selection takes effect in this window; auto = false means the action only shows instructions;
// userEnv: native Windows, where the selection is the per-user CODEX_HOME variable instead of rc-file blocks
export interface RestartInfo { context: EditorContext; auto: boolean; userEnv?: boolean }

export interface TabState {
  // false when codex is not enabled (always true for claude)
  enabled: boolean;
  accounts: AccountView[];
  // claude only: set when this window switched accounts but has not reloaded yet (shows a banner); value is the display name
  switchedTo?: string;
  // codex only: set when the state file points to a directory other than this window's effective one (shows "X selected, takes effect after server restart"); value is the display name
  pendingDir?: string;
  // codex only: restart context for the pending banner and disabled page
  restart?: RestartInfo;
  // Prefix of a new account folder for the add help, in the platform's spelling (~/.claude- / ~\.claude-); the
  // frontend falls back to its fixed ~/ prefix before the first state
  dirPrefix?: string;
  // Settings planswap.sidebar.showEmail: false hides the email line of every row (the host then sends no email)
  hideEmail?: boolean;
  // Directory of the account the host recommends while the current one runs low (recommend in src/recommend.ts); the
  // page shows it in a card above the list. Absent: nothing to recommend, or recommendations are off
  recommended?: string;
  // Setting planswap.sidebar.showRecommendation off: no card and no per-row exclude buttons
  hideRecommendation?: boolean;
}

export interface PanelState {
  active: PanelMode;
  // UI locale resolved on the host (one of the host LOCALES, from getLocale())
  locale: Locale;
  claude: TabState;
  codex: TabState;
  // Setting planswap.usageDisplay; absent means 'remaining'
  usageDisplay?: UsageDisplay;
  // Settings planswap.sidebar.warningThreshold / errorThreshold: remaining percentages at or below which a usage bar
  // turns to the warning / error color (error wins); absent means 30 / 10
  usageThresholds?: { warning: number; error: number };
}

export type ToWebview =
  | { type: 'state'; state: PanelState }
  // Answer to 'add'; error undefined means success. The host posts it even when the add flow throws
  | { type: 'addResult'; mode: PanelMode; error?: string }
  // Answer to 'rename' for the row `dir`; error undefined means success. Also posted when the rename throws
  | { type: 'renameResult'; mode: PanelMode; dir: string; error?: string }
  // The webview switches to that tab and focuses the input
  | { type: 'focusAdd'; mode: PanelMode }
  // CLI and extension versions, shown in a card at the bottom of the panel
  | { type: 'versions'; items: Array<{ label: string; value: string }> };

// Every message except 'ready' carries the page's mode; the host dispatches by it
export type FromWebview =
  | { type: 'ready' }
  // The user clicked a tab; the host remembers it
  | { type: 'setTab'; mode: PanelMode }
  | { type: 'switch'; mode: PanelMode; dir: string }
  | { type: 'terminal'; mode: PanelMode; dir: string }
  // Sent after the frontend's inline confirmation; the host only handles named rows
  | { type: 'remove'; mode: PanelMode; dir: string }
  // shared: the add section's checkbox; the host treats a missing value as true
  | { type: 'add'; mode: PanelMode; name: string; shared: boolean }
  // Convert an independent named account into one shared with the default account (the host confirms with a modal)
  | { type: 'share'; mode: PanelMode; dir: string }
  // Convert a shared named account back into an independent one (links removed, default configuration copied; the host
  // confirms with a modal)
  | { type: 'unshare'; mode: PanelMode; dir: string }
  // Only sent for named rows; the host ignores the default and external rows
  | { type: 'rename'; mode: PanelMode; dir: string; label: string }
  // Row button: exclude the registered account from recommendations (excluded true) or include it again; the host
  // ignores the external row and treats a non-boolean value as true
  | { type: 'recommendExclude'; mode: PanelMode; dir: string; excluded: boolean }
  // reload / dismissBanner: the Codex host ignores them
  | { type: 'reload'; mode: PanelMode }
  | { type: 'dismissBanner'; mode: PanelMode }
  // enable / restartServer: handled by the Codex host only
  | { type: 'enable'; mode: PanelMode }
  | { type: 'restartServer'; mode: PanelMode }
  // Per-page Tools buttons, footer toolbar buttons (mode = the current tab) and the usage refresh buttons
  | { type: 'tool'; mode: PanelMode; tool: ToolId };
