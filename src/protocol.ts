// Message protocol between the extension and the sidebar webview (shared by both sides; imports no runtime modules)
import type { Locale } from './i18n';

export type AccountKind = 'default' | 'named' | 'external';
export type PanelMode = 'claude' | 'codex';
export type ToolId = 'openGlobalMd' | 'openSettings' | 'reloadWindow' | 'restartExtHost' | 'restartServer' | 'cliVersions' | 'sync' | 'updateCli' | 'openHelp' | 'openStar';

export interface AccountView {
  kind: AccountKind;
  // Internal name (default / name derived from the directory / EXTERNAL_NAME sentinel), for logic only
  name: string;
  // Display name: the alias (equals name when not set; localized for the external row)
  label: string;
  dir: string;
  // For display, home directory replaced with ~
  dirLabel: string;
  email?: string;
  // For display, formatted plan type (e.g. "Max 20x", "Plus", "API key")
  plan?: string;
  loggedIn: boolean;
  isCurrent: boolean;
  // Codex only: selected for the next editor/server start; independent of the effective account
  isSelected?: boolean;
  // Named rows only: true = shared with the default account (links), false = independent; undefined for default / external
  shared?: boolean;
  // A historical observation, never a live quota or a prediction after a reset. Codex: the last query result; Claude:
  // the usage cache in the account's own info file. scope names a model-specific limit (e.g. "Fable"), Claude only
  usage?: { windows: Array<{ usedPercent: number; windowMinutes?: number; resetsAt?: number; scope?: string }>; checkedAt: number };
}

// Editor connection context: local desktop (including WSLg), WSL remote, or another remote
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
  // Prefix of a new account folder for the add help, in the platform's spelling (~/.claude- / ~\.claude-)
  dirPrefix?: string;
}

export interface PanelState {
  active: PanelMode;
  // UI locale resolved on the host
  locale: Locale;
  claude: TabState;
  codex: TabState;
}

export type ToWebview =
  | { type: 'state'; state: PanelState }
  | { type: 'addResult'; mode: PanelMode; error?: string }
  | { type: 'renameResult'; mode: PanelMode; dir: string; error?: string }
  // The webview switches to that tab and focuses the input
  | { type: 'focusAdd'; mode: PanelMode }
  // CLI and extension versions, shown in a card at the bottom of the panel
  | { type: 'versions'; items: Array<{ label: string; value: string }> };

export type FromWebview =
  | { type: 'ready' }
  // The user clicked a tab; the host remembers it
  | { type: 'setTab'; mode: PanelMode }
  | { type: 'switch'; mode: PanelMode; dir: string }
  | { type: 'terminal'; mode: PanelMode; dir: string }
  | { type: 'remove'; mode: PanelMode; dir: string }
  | { type: 'add'; mode: PanelMode; name: string; shared: boolean }
  // Convert an independent named account into one shared with the default account
  | { type: 'share'; mode: PanelMode; dir: string }
  // Convert a shared named account back into an independent one (links removed, default configuration copied)
  | { type: 'unshare'; mode: PanelMode; dir: string }
  | { type: 'rename'; mode: PanelMode; dir: string; label: string }
  | { type: 'reload'; mode: PanelMode }
  | { type: 'dismissBanner'; mode: PanelMode }
  | { type: 'enable'; mode: PanelMode }
  | { type: 'restartServer'; mode: PanelMode }
  // Toolbar buttons
  | { type: 'tool'; mode: PanelMode; tool: ToolId };
