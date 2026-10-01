# PlanSwap: Claude Design

Purpose: Claude account-switching design, shared sidebar architecture, the linked-account model and account deletion for both vendors, implementation rationale, upstream evidence and limitations. Signatures, per-module behavior and cross-module wiring live in the code (types and TSDoc); [Features](features.md) owns observable behavior and [Manual Verification](manual-verification.md) the acceptance procedures. See [AGENTS.md](../AGENTS.md#read-the-documents-relevant-to-the-task) for ownership.

## 1. Goals and scope

- Goal: in VS Code (WSL remote window), switch between two or more Claude Code accounts from a sidebar panel; after a switch, new sessions of the official Claude Code extension use the selected account.
- Runtime environment: WSL / Linux and native Windows (see [Windows support](#windows-support)). macOS is not supported.
- User environment: only claude.ai subscription sign-in (OAuth), no API key; WSL is opened from VS Code, using the claude CLI and the official Claude Code extension.
- Non-goals (the binding rules are in [AGENTS.md](../AGENTS.md#account-and-data-safety)):
  - Never read, write, copy, move or link `.credentials.json`; never copy or cache any token.
  - The one permitted use of an account's credentials is running the official `claude` CLI with `CLAUDE_CONFIG_DIR` set to that account (unset for the default account) to query usage limits: Claude Code reads, and may refresh, its own credentials exactly as in a terminal, and updates the usage cache in the account's own info file; PlanSwap never passes tokens anywhere and only reads that cache (6.9).
  - Existing content of `~/.claude` is never overwritten. It is only changed for shared accounts (6.7): a shared entry missing there is created empty as the link target, and converting an independent account moves its files in (a file that differs is kept next to the default one as `<name>.from-<account>`). The default account's `.claude.json` is only read.
  - Usage limits come only from the official `claude` CLI and the cache it writes (6.9; Codex: [Codex design 8.7](codex-design.md#87-usage-limits)); PlanSwap never reads credentials or calls a service itself, and there is no automatic rotation when limits are hit.
  - Do not use `claudeCode.claudeProcessWrapper`.

## 2. Background facts (verified)

The following facts come from the official documentation and the source code of the locally installed official extension `anthropic.claude-code-2.1.282-linux-x64` (the `CLAUDE_CONFIG_DIR` entry rule in fact 2 was re-checked in 2.1.284); this design rests on them. **Re-verify these assumptions after upgrading the official extension.**

1. `CLAUDE_CONFIG_DIR` is documented, supported behavior: when it is set, `.credentials.json`, `.claude.json`, `settings.json`, `projects/` and `sessions/` all live in that directory. Each directory is an independently signed-in account. User-level MCP servers are stored in `mcpServers` of `.claude.json`, not in `settings.json`.
2. The official extension setting `claudeCode.environmentVariables`:
   - scope `machine`, schema is an array of `{ "name": string, "value": string }`; the parser in the source also accepts the object form `{ KEY: value }` and converts non-string values to strings.
   - The extension reads this setting fresh every time it starts a claude process to build the environment (the extension host's `process.env` as the base, with the setting entries layered on top), so a change takes effect for new sessions immediately.
   - An entry whose `name` is `CLAUDE_CONFIG_DIR` is used only when its `value` is an absolute path string (on Windows with a drive letter or UNC); empty, relative and non-string values are skipped, and the last usable entry wins (extension 2.1.284).
   - The official extension never writes this setting itself, so there is no write race with this extension.
3. The official extension has a built-in watcher for `CLAUDE_CONFIG_DIR` changes: after a change and a settling period of about 1 second it calls `refreshEveryHost`, refreshing the account display and usage of every panel. Note: at that point every panel header (including panels still running a process of the old account) shows the new account, which does not match the account actually used by that panel's process until a reload.
4. Open sessions hold their old process and do not follow a switch; only new sessions use the new account. Transcripts of old sessions live in `projects/` of the old account directory and cannot be found in the new directory after a reload, so the effect of a reload is "all panels start over with the new account", not "old sessions move to the new account". Old sessions can be resumed after switching back.
5. Reasons for not using `claudeCode.claudeProcessWrapper`: the linux-x64 extension ships its own binary, so no wrapper is needed; the official documentation states that in wrapper mode new sessions default to Manual permission mode and do not restore plan mode; in the source `sessionConfigHome` takes a different branch in wrapper mode. The wrapper calling convention is undocumented (Issue #10491 is closed).
6. Under WSL2 the browser sign-in callback often fails; the official documentation says the "paste code" flow is used then, which is normal. After switching to a signed-out directory, the official panel shows its sign-in screen automatically.
7. Claude Code on the WSL side and on the Windows side are two independent installations with separate credentials; in a WSL window this extension only runs on the WSL side and never reads across into `/mnt/c`. A local Windows editor runs the extension natively against the Windows profile, see [Windows support](#windows-support).
8. The directory the official extension uses for its `ide/` lock files only follows the extension host process's `process.env.CLAUDE_CONFIG_DIR`, not the value in `claudeCode.environmentVariables` (source: `ey$()` calls `uX()`). Consequence: when `claude` is run in a terminal for a non-default account, the CLI looks for lock files in `~/.claude-<name>/ide/` while they are in `~/.claude/ide/`, so the `/ide` integration of the terminal CLI is expected not to work. The native panel passes the MCP configuration directly at startup and does not use lock-file discovery, so it is not affected.
9. When a machine-scope setting is written with `ConfigurationTarget.Global` in a WSL remote window, VS Code stores it in the remote Machine settings (`toEditableConfigurationTarget` in `configurationService.ts`) and also reads the remote value. Preconditions: the official extension is installed on the WSL side (otherwise the key is not registered and `update` throws); `update` also throws when the remote settings.json has a syntax error.

The following facts about shared accounts were verified with Claude Code CLI 2.1.274 in a temporary `CLAUDE_CONFIG_DIR` (re-verify after upgrades):

10. Claude Code writes `settings.json` and `.claude.json` through symlinks: it writes a temporary file next to the resolved target and renames it over the target, so a link stays a link and the default account's file receives the change. A pre-created `.claude.json` containing only `mcpServers` is recognized by `claude mcp list`, and the CLI keeps `mcpServers` when it adds its own keys.
11. `history.jsonl` is appended to in place, so a link to the default file keeps working; `claude project purge` rewrites it by replacing the file, which turns the link of that account into a regular file. The next link refresh of a shared account merges it back (lines the default file lacks are appended) and re-creates the link (6.7); lines the purge removed stay in the shared default history, because the merge only appends.
12. Session transcripts in `projects/` carry no account identifier, and `--resume` performs no account check, so an account can continue a session started by another one. The server side may still reject content bound to another organization (see limitation 12).
13. `cleanupPeriodDays` makes Claude Code delete old transcripts inside `projects/`; with a shared `projects/`, a cleanup run by any shared account (or the default account) deletes them for all of them.

The following facts about usage limits were verified with Claude Code CLI 2.1.286 on 2026-10-01 (evidence and measurements: [research record](research/claude-usage.md#official-cli-query); re-verify after upgrades):

14. `claude -p "/usage" --output-format json` is a local command (no prompt is sent, `num_turns` 0, cost 0). The first run for an account fetches the limits with Claude Code's own credentials and writes `cachedUsageUtilization` (`fetchedAtMs`, `accountUuid`, `utilization`) into that account's info file (`<dir>/.claude.json`, `~/.claude.json` for the default account without `CLAUDE_CONFIG_DIR`); Claude Code fetches at most about once per minute per account and answers other calls from the cache. When the fetch fails (e.g. offline), the command still succeeds and the cache keeps its old `fetchedAtMs`.

## 3. Overall design

```
User clicks the "Switch" button in the sidebar panel (or double-clicks an account row) and confirms the modal (skipped when `planswap.claude.confirmSwitch` is off)
  → the extension rewrites CLAUDE_CONFIG_DIR in claudeCode.environmentVariables
  → the official extension refreshes its panels 1 second later; new sessions use the new directory
  → a reload banner appears at the top of the sidebar panel (a notification when the panel is not visible); the user may reload the window (all panels start over with the new account)
```

An account is a directory:

| Account | Directory | Origin |
|---|---|---|
| default | `~/.claude` (if the extension host environment already has a non-blank `CLAUDE_CONFIG_DIR`, that value wins) | Always exists, cannot be removed |
| `<name>` | `~/.claude-<name>` | Added by the user in the panel, or registered automatically by scanning `~/.claude-*` on activation/refresh |

## 4. Data model

### Persisted state

Everything PlanSwap persists, for both vendors:

| Key or file | Store | Owner module | Written when | Migration |
|---|---|---|---|---|
| `accounts` | state file | `accounts.ts` (`AccountStore`) | Claude account added, removed or discovered | `importOnce` from `globalState` |
| `ignoredDirs` | state file | `accounts.ts` | Claude account removed while keeping its directory; cleared when the name is added again or the directory is deleted | `importOnce` |
| `claude.labels` | state file | `labels.ts` (`LabelStore`) | Claude rename; cleared on remove | `importOnce` |
| `codex.accounts`, `codex.ignoredDirs` | state file | `codex/codexStore.ts` | as the Claude keys | `importOnce` |
| `codex.labels` | state file | `labels.ts` | Codex rename; cleared on remove | `importOnce` |
| `codex.usageHistory` | state file | `codex/codexUsageHistory.ts` | accepted Codex usage observation ([Codex design 8.7](codex-design.md#87-usage-limits)) | none |
| `warnings.dismissed` | state file | `extension.ts` | "Don't show again" on an environment warning | none |
| `panel.activeTab` | `globalState` | `accountsPanel.ts` | the frontend's `setTab` message | none |
| `legacy.languageMigrated` | `globalState` | `i18nVscode.ts` | after `migrateLegacyLanguage` succeeded (5.5) | — |
| `~/.config/planswap/codex-home` | own file | `codex/codexState.ts` | Codex selection ([Codex design 4](codex-design.md#4-login-shell-configuration)) | `migrateLegacyCodex` from `~/.config/ai-switcher/codex-home` |

- The state file is `~/.config/planswap/state.json` (`FileMemento` in `fileState.ts`, a `vscode.Memento`). It is not `globalState`: a workspace extension's `globalState` lives in the Windows client's database and is shared by every WSL distribution, so the accounts of different distros would be mixed (entries of another distro point at directories that do not exist locally and get pruned, and aliases are shared between unrelated accounts of the same name). The state file follows `$HOME`, so each distribution has its own and every editor (Antigravity, VS Code, VSCodium) on that distro sees the same list. It has no cross-process lock: each update re-reads and atomically replaces the file, so two windows writing at the same moment can lose one update.
- `importOnce` copies the six account, ignore and alias keys (`STATE_KEYS`) from `globalState` once, when the state file does not exist yet; the file is created even when nothing was set, so the import never runs again.
- The default account is not stored; it is prepended at runtime. Discovery (`scanAccountDirs` in `paths.ts`, user rules in [Features §5](features.md#5-auto-discovery-shared-and-independent-accounts)) registers unregistered `~/.claude-*` directories on activation and refresh, so the list is not empty if the state file is lost; it skips `ignoredDirs`, and named entries whose directory no longer exists are pruned with their alias (not added to `ignoredDirs`).
- The single source of truth for the current account is the `CLAUDE_CONFIG_DIR` entry of `claudeCode.environmentVariables`, read as in fact 2 (array or object form, last absolute-path string wins; `currentDir()` in `claudeSettings.ts`). No usable entry → the default account; a value not in the account list (set by hand) is shown as an "External directory" row that can be switched away from. No second current-account value is persisted.
- Account display information comes from `oauthAccount` in the account info file (read-only, never copied): email `emailAddress` and the plan text from `organizationType` / `organizationRateLimitTier` (`formatClaudePlan` in `paths.ts`, covered by `test/paths.test.ts`). File location: usually `<dir>/.claude.json`; for the default account without `CLAUDE_CONFIG_DIR` it is `~/.claude.json` (in the home directory, not inside `~/.claude`), consistent with the official source `join(CLAUDE_CONFIG_DIR || homedir(), ".claude.json")`. Reading tolerates half-written JSON (the CLI is writing); parse failures count as "unknown".
- Signed-in state: the presence of `oauthAccount.emailAddress` is the primary criterion, the existence of `.credentials.json` a secondary one (consistent with how the official extension detects sign-out / account changes).
- Identity (`AccountInfo.identity`): an opaque comparison key from `oauthAccount.accountUuid` + `oauthAccount.organizationUuid` of the same file, only when both exist; never displayed, logged, persisted or sent to the Webview (panel rows copy only email, plan and sign-in state; 6.8).
- **Aliases** are display-only (panel, status bar, QuickPick, messages, terminal names): stored by account name, so the directory and internal name do not change and logic still uses name / dir. Every named account can have one; the default and external-directory rows cannot. Validation rules are in `LabelStore.validate` (`labels.ts`); names and aliases cannot collide within a vendor, the same alias is allowed across Claude and Codex.
- Whether a named account is shared or independent is never stored: it is read from disk each time (6.7).
- The UI language is not stored by the extension: it is the VS Code setting `planswap.language` (5.5); the resolved locale is kept in memory and pushed to the Webview.

## 5. User interface

### 5.1 Sidebar (Webview panel)

The sidebar is a `WebviewView` (one view, `planswap.accounts`, holding a Claude and a Codex tab rendered by one `AccountsPanel`) built with @vscode-elements/elements and the @vscode/codicons icon font, chosen over a native TreeView for cards, inline forms and per-row actions. Rendered layout, texts and interactions are owned by [Features §2](features.md#2-sidebar); this section keeps the rationale:

- The view title bar has two buttons, settings and refresh (refreshes both pages); adding accounts happens inside the panel.
- The current tab is remembered by the host (`panel.activeTab`) and in the Webview state; the frontend adopts the host's tab only when it has no local record.
- The reload banner state (`switchedTo`) is kept in memory on the extension side, so it disappears naturally after a reload.
- The current account is pinned first and emphasized with restraint: only its card carries the plan color (outline and left bar); plan tags are a neutral outline on every card, so the accents do not pile up and tier colors do not compete for attention in the list.
- The keyboard focus of a card is a `focusBorder` outline outside the card, so it never looks like the current card's (often blue) plan outline.
- Avatars: dark and high-contrast themes draw the letter in the dark base color, because their chart colors are too light for white text; light themes keep the white letter and darken the disc.
- On light themes `tier2` mixes the chart yellow with the foreground instead of white, since a softened yellow outline is nearly invisible on a light card; small error and warning text uses the theme color darkened there, where the raw colors are below 4.5:1 on the card (`panel.css`; `test/webviewColors.test.ts` only checks that colors are theme variables, not contrast).
- A single click on a row does nothing, to avoid accidental switches; double-click or Enter switches after the same confirmation as the Switch button (6.1); with `planswap.claude.confirmSwitch` off they switch directly, by the user's choice.
- The usage refresh buttons need no pending state, because the host joins concurrent queries and guards refresh-all against re-entry.
- The "Tools" section is collapsed by default to keep rarely used buttons out of the way; Re-link is shown only while the page has a linked account, since it does nothing otherwise.
- The add-account form is created once and only shown or hidden, so list refreshes keep its typed text and focus.

### 5.2 Frontend/backend split and message protocol

- The frontend (`src/webview/main.ts`) only renders and exchanges messages; business logic and validation are authoritative on the extension side, and frontend validation is only an immediate hint.
- All messages are typed in `src/protocol.ts` (types only, shared by both sides). Every message except `ready` carries `mode`, and the host dispatches by it to the Claude or Codex handler.
- When the extension receives `switch`/`terminal`/`remove`/`rename`/`share`/`unshare`, it first looks the directory up with `panel.resolve(mode, dir)` among the rows currently shown on that page and only accepts directories present in the list; `remove`, `rename`, `share` and `unshare` only act on rows with `kind === "named"`.

### 5.3 Content security policy

The rule is in [AGENTS.md](../AGENTS.md#implementation-boundaries); the reasons:

| Directive | Value | Reason |
|---|---|---|
| `default-src` | `'none'` | Everything else is blocked |
| `script-src` | `'nonce-<random>'` | Only `panel.js`; a fresh nonce (`crypto.randomBytes(16)`) every time the HTML is generated |
| `style-src` | webview source + `'unsafe-inline'` | Lit components fall back to inline `<style>` when `adoptedStyleSheets` is not supported |
| `font-src` | webview source only | Only `codicon.ttf` from the extension's own `dist/media` |

- `localResourceRoots` only contains `dist/media`.
- The `<link>` for `codicon.css` must have `id="vscode-codicon-stylesheet"`: `vscode-icon` and other components rely on it to load the icon font inside the shadow DOM.

### 5.4 Status bar

Text, tooltip layout and conditions: [Features §3](features.md#3-status-bar). The decisions behind them:

- The text shows product names with the remaining percentage of their short window and no account label; the icon is `$(dashboard)` (a gauge), because the text is a quota reading, not an account label.
- The background color is chosen separately from the text, from the lowest remaining percentage over all general windows of the shown products, long windows included (at or below `planswap.statusBar.errorThreshold`, default 10%, error; at or below `planswap.statusBar.warningThreshold`, default 30%, warning; VS Code allows only `statusBarItem.errorBackground` and `statusBarItem.warningBackground`). A used-up 7-day window therefore colors the item even though the text shows the 5-hour figure. Model-specific windows never count. This is a decision about information, not styling: the text must stay short, while the color must not hide that something will run out soon.
- The tooltip is deliberately terse, because a hover is a glance: one HTML table for all vendors (`MarkdownString.supportHtml`), so bars, percentages and reset times share their columns, with the email header spanning columns (`colspan`). A Markdown table cannot do this: it has no column spans, so an email in the first column widened the name column and left a wide gap between "5h" and its bar, and separate tables per vendor did not line up (both tried on 2026-10-02). Names, paths and collection times were dropped: they cost space and the sidebar shows them. The failure line is one short message for every reason, since the refresh-all warning still gives the detailed reasons.
- VS Code's hover sanitizer keeps `table`/`tr`/`td`, `colspan`/`align`, `strong`/`em`, `a` and `span class="codicon codicon-<name>"` (source: `src/vs/base/browser/markdownRenderer.ts` and `domSanitize.ts`); markdown and `$(icon)` syntax are not parsed inside the HTML, so icons are codicon spans and the refresh link an `<a href="command:…">`.
- Trust is limited to the two refresh commands (`isTrusted = { enabledCommands: [planswap.claude.refreshUsage, planswap.codex.refreshUsage] }`), so the hover itself can refresh the product it shows; every piece of outside text is escaped.

### 5.5 Localization (i18n)

Behavior: [Features §11](features.md#11-language); rules for code and translations: [AGENTS.md](../AGENTS.md#implementation-boundaries).

- UI wording is concise and idiomatic in each language. Product names and technical terms such as CLI, API key and Extension Host remain untranslated.
- Static strings in `package.json` (`%key%` from `package.nls*.json`) are resolved by VS Code from **its own display language**, not from `planswap.language`; this is a platform limitation.
- The brand "PlanSwap" in `displayName` (currently "PlanSwap: Claude Code & Codex Account Switcher") is permanent; the part after the colon grows as more AI tools are supported.
- Runtime strings follow the setting immediately, without a reload: the host calls `setLocale`, re-pushes the full panel state (the Webview re-renders everything) and updates the status bar.
- Pre-rename setting: versions 0.1.0 - 0.1.3 used `aiSwitcher.language`. On activation `migrateLegacyLanguage` copies a user-level `en` / `zh-cn` of the old key to `planswap.language` when the new key has no user-level value, then sets the `globalState` flag `legacy.languageMigrated` (client side, like the application-scope setting), so it runs only once and a later reset of the new setting is not overridden. The old key is no longer contributed, so the extension cannot write or remove it. A failure is only logged and retried on the next activation.

## 6. Commands and flows

Panel actions call the flow functions in `commands.ts` directly through Webview messages; the Command Palette commands ([Features §4](features.md#4-commands)) reach the same functions through a QuickPick. Every message and terminal name uses the display name of the account; logic still uses name / dir.

### 6.1 Switch

1. A target that already is the current account returns immediately. From the panel (switch button, double-click, Enter) a modal confirmation comes first, unless `planswap.claude.confirmSwitch` is off; the Command Palette pick is already an explicit choice and has no extra confirmation. A named account whose directory does not exist is refused.
2. A shared target is re-linked first (`ensureClaudeLinks` + `mirrorClaudeJson`, 6.7); steps that would move or unlink files of a running Claude process of that account are skipped and reported; any report or error only warns, and the switch continues.
3. `setConfigDir` (`claudeSettings.ts`) writes a new array (never mutating the value returned by `get()`): other entries kept, every `CLAUDE_CONFIG_DIR` entry removed, and for a non-default target `{ name: "CLAUDE_CONFIG_DIR", value: <absolute path> }` appended; the object form is written back as an array. It writes with `ConfigurationTarget.Global` (fact 9); a failure shows `claude.switchFailed`, naming the two preconditions.
4. On success the panel's `switchedTo` is set and the reload banner appears; when the panel is not visible, a non-modal notification with "Reload Window" is shown instead (not awaited). The status bar is updated.
5. A signed-out target shows the official panel's sign-in screen (fact 6).

### 6.2 Add

1. The input lives in the panel; `planswap.addAccount` only focuses it.
2. The extension validates the trimmed name authoritatively (`validateName`): the name pattern `^[A-Za-z0-9_-]+$`, not `default`, no clash with a name or alias of the same vendor (ignoring case), not the default directory, not containing the default directory after resolving links (6.7), and `~/.claude-<name>` not a symbolic link (`scanAccountDirs` skips symlinks, so adding must not register one either). Reasons go back to the panel (texts: `claude.*` / `account.*` in `src/i18n.ts`).
3. `~/.claude-<name>` is created (0700) or reused as is, without clearing; a creation failure is reported and nothing is registered.
4. Depending on `shared` (the checkbox; missing counts as shared), see 6.7:
   - shared: `ensureClaudeLinks(dir)`, then `mirrorClaudeJson` from the default account's info file;
   - independent: `copyClaudeIndependent` copies once, never overwriting: `settings.json` (0600) without identity keys and without plugin / marketplace keys (`STRIP_ENV_KEYS` / `STRIP_TOP_KEYS` in `paths.ts`), `CLAUDE.md`, the folders `agents`, `commands`, `output-styles`, `hooks`, `rules`, the `skills/` children except `synced` / `.trash`, and the user-level MCP servers (`syncMcpServers`: names the account lacks are added; nothing is removed or overwritten).
   `.credentials.json` is never read, copied or linked, and `.claude.json` is never copied as a whole. A failure of this step only warns and does not block: the account exists either way.
5. Only then is the account registered (and removed from `ignoredDirs`), and the panel and status bar refresh; the panel sends `addResult` after that.

### 6.3 Account removal and directory deletion (both vendors)

Applies to Claude (`removeAccount` in `commands.ts`) and Codex (`removeAccount` in `codex/codexCommands.ts`); the rules for agents are in [AGENTS.md](../AGENTS.md#account-and-data-safety), user-visible steps in [Features](features.md#4-commands).

1. Only named accounts can be removed. The panel's inline confirmation is the first confirmation; the Command Palette asks with a modal.
2. Guards, checked before the first confirmation and again after every modal, because another window may have switched to or selected the account, or a terminal was opened, meanwhile:
   - Claude refuses the current account (also another spelling of it, `sameRealPath`) and a busy account (`claudeAccountBusy`, 6.7, or on Windows its open PlanSwap terminal);
   - Codex refuses the account effective in this window, the selected account and a busy account (`codexAccountBusy`, [Codex design 8.6](codex-design.md#86-shared-and-independent-accounts), or on Windows its open PlanSwap terminal).
   A guard failing after the delete confirmation removes nothing; failing after the directory prompt, the list entry is already gone and the directory is kept.
3. The account leaves the list, its directory is recorded in the vendor's ignore list, its alias is cleared and the view refreshes.
4. Deleting the directory is always confirmed separately with a system modal ("Also delete directory <dir>?"). The detail says the directory holds the account's credentials and local data and cannot be recovered (Claude adds that open sessions of a just-switched-away account may still use it). For a shared account (checked before the list entry is removed) it says that linked data in the default account is kept; the Codex text also names per-account memories, which a shared Claude account does not have (its memory lives in the shared `projects/`).
5. Deletion goes only through `deleteAccountDir` / `deleteCodexDir`, which re-run `checkSafeToDelete` / `checkCodexSafeToDelete` (exact order in the code): a direct child of the home directory (so a symlinked parent cannot escape it); the basename matches `.claude-<name>` / `.codex-<name>`; not the default directory and not containing it, compared by real path (`sameRealPath`, `realPathInside`); exists, is not a symlink and is a directory; Codex also has no live daemon (below). Then, on Windows, `platform.unlinkLinks` removes every link and junction inside first, because a recursive delete could descend through a junction into the default account; finally `fs.promises.rm(dir, { recursive: true, force: true })`, never a shell. For a shared account this removes only its own files and its links; the shared content in the default directory survives (covered by tests). On success the directory leaves the ignore list, so a recreated directory is discovered again; on failure the reason is shown.
6. Codex daemon check: `<dir>/app-server-daemon/` may hold `daemon.pid`, `app-server.pid`, `daemon-updater.pid`, `app-server-updater.pid`; each is JSON with `pid` and `processIdentity.startTicks` or `processStartTime`, compared with the start time in `/proc/<pid>/stat`. A match means alive and deletion is refused; a missing or unparsable file counts as not alive; a valid pid file counts as alive when `/proc` itself is missing; on Windows a live pid counts. **The check depends on the JSON format of Codex's pid files; re-verify after Codex upgrades.**

### 6.4 Open claude in a terminal

- `createTerminal({ name: "Claude (<label>)", env: { CLAUDE_CONFIG_DIR: <dir> } })`; no env for the default account.
- On Linux the command sent is `env CLAUDE_CONFIG_DIR='<absolute path>' claude`, which bypasses a possible `export CLAUDE_CONFIG_DIR` in rc files such as `~/.bashrc`; the `env` parameter is a second safeguard. A directory with control characters is refused there, since it would end the command line early. On Windows the terminal environment alone carries the variable and `claude` is sent ([Windows support](#windows-support)). The default account gets `claude` without a variable.
- A signed-out account gets the sign-in tip (`account.loginTip`): other accounts stay signed in because each keeps its sign-in in its own directory. When a PlanSwap terminal of a named account closes and the account is still not signed in, a message says the login did not land in that directory and names the likely override (`~/.bashrc` on Linux, a user or system environment variable on Windows).
- Terminal `/ide` integration does not work for non-default accounts (fact 8).

### 6.5 Rename an account

Only named rows (`panel.resolve` + `kind === 'named'`) are renamed; `labels.validate` decides, an error goes back in `renameResult` and is shown inline; entering the account's own name clears the alias. Directory, internal name and `CLAUDE_CONFIG_DIR` do not change (section 4).

### 6.6 Tools

All tools run through `runTool(mode, tool, deps)` in `src/tools.ts`, the single entry for the panel's `tool` message and the Command Palette ([Features](features.md#55-tool-buttons)). When Codex initialization fails (exception caught in `extension.ts`), the Codex page degrades to `{ accounts: [], enabled: false }` and other Codex panel actions and `planswap.codex.*` commands show "Codex account switching is unavailable: <reason>"; `tool` messages still go through `runTool` with the Codex dependencies undefined.

### 6.7 Shared and independent accounts

Both vendors use one model; this section owns it, and [Codex design 8.6](codex-design.md#86-shared-and-independent-accounts) lists only the Codex differences. Implemented in `src/claudeShare.ts` and `src/codex/codexShare.ts` (no vscode import); `src/shareReport.ts` formats reports for both. The UI calls a shared account a "linked account"; the code and these documents keep "shared".

Goal: when one account runs out of quota, switch to another and keep working with the same settings, rules, history and sessions. An account is either **shared** (everything except its login identity is symlinked to the default account's directory, the single source of truth) or **independent** (the configuration is copied once at creation, history stays separate).

- **Mode detection**: never stored. A named account is shared iff its marker entry (Claude `projects`, Codex `sessions`) is a symlink whose real path equals that of the default entry (`isSharedClaudeAccount` / `isSharedCodexAccount`). The default and external rows have no mode.
- **Directory protection**: adding an account and the link, mirror, configuration-copy and conversion entry points reject an account directory that contains the default directory after resolving links, before any write. This also covers accounts registered before the default directory changed (for example `CLAUDE_CONFIG_DIR` now points inside an account directory).
- **Shared entries**: the lists are the constants `CLAUDE_SHARED_ENTRIES` (absolute symlinks, `fs.symlinkSync(<default entry>, <account entry>)`), `CLAUDE_CHILD_SHARED_DIRS` (`skills`, `plugins`: real folders in the account with one link per default child) and `CLAUDE_CHILD_EXCLUDES` (`synced`, `.trash`: per-account cloud-synced buckets). They cover settings, rules, history, sessions and the other per-user Claude Code folders. Not shared: `.credentials.json`, `.claude.json` (sign-in and onboarding state; mirrored instead) and every entry not listed.
- **Link refresh** (`ensureClaudeLinks`, idempotent create / repair):
  - A shared entry missing in the default directory is created empty first (folder 0700, file 0600; `settings.json` gets `{}`); a missing account entry becomes a link; a link to the default entry (absolute or relative) is fine.
  - A regular entry or a link elsewhere is left untouched and reported as a conflict, except a regular `history.jsonl` in an account that is already shared (fact 11): it is merged back with `mergeLines` (lines the default file lacks are appended, whole-line comparison, order kept) and relinked. An independent account's own `history.jsonl` stays a conflict.
  - `settings.json` is refused (reported, not linked) while the default file is not a JSON object or has an identity key (`CLAUDE_IDENTITY_SETTING_KEYS`: top-level `apiKeyHelper`, `forceLoginMethod`, `forceLoginOrgUUID`; under `env` `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`). The refusal is re-evaluated on every refresh: an existing link to the default `settings.json` is replaced by the account's own copy without identity keys. Codex instead removes such a `config.toml` link without making a copy.
  - A whole-folder `skills` / `plugins` link from an earlier version is replaced by a real folder with per-child links, and child links whose default target no longer exists are removed.
  - The steps that move or unlink account files (the history merge, replacing a whole-folder link, removing dangling child links) are skipped and reported as busy while the account is busy; the check runs lazily, only when such a step comes up, and the remaining links are still created. The default directory itself gets an empty report.
- **Mirroring `.claude.json`** (`mirrorClaudeJson`, Claude only): the source is the default account's info file (read only; missing → treated as empty; not a JSON object → throws `share.badSource`). In `<dir>/.claude.json`: `mcpServers` becomes an exact copy of the default's (servers missing there are removed); for every project path in the default's `projects` the keys `allowedTools`, `mcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `mcpContextUris`, `hasTrustDialogAccepted`, `hasClaudeMdExternalIncludesApproved`, `hasClaudeMdExternalIncludesWarningShown` are copied; the top-level `hasCompletedOnboarding` and `lastOnboardingVersion` are added only when the account lacks them and is signed in, since a signed-out account's first-start onboarding is its sign-in; nothing else is copied (`githubRepoPaths` included) and all other keys stay. No write when nothing changes; a missing file is created 0600; otherwise an atomic replace that refuses when the file changed between read and rename (`mcp.changed`) and throws `mcp.badTarget` when the target is not a JSON object.
- **When links are refreshed**: on add (shared), before a switch to a shared account (6.1; problems only warn), by the "Re-link" tool and at the end of a conversion. There is no background watcher.
- **Busy check** (`claudeAccountBusy`, also used before removal, 6.3): on Linux, for every `<dir>/sessions/*.json` whose `pid` is a positive integer, `/proc/<pid>/environ` is read; the account is busy when `CLAUDE_CONFIG_DIR` there equals the directory (for the default directory: unset or equal). Unreadable entries are skipped; when `/proc` itself is missing, any session file counts as busy. Windows: [Windows support](#windows-support).
- **Conversion to shared** (`share`; refused for the current account): modal confirmation, re-check of the current account, busy check (busy → warning to close the account's sessions and PlanSwap terminal tabs, nothing changes), then `migrateClaudeToShared`, which checks busy again and moves the account's real shared entries into the default directory without ever overwriting there:
  - folders are merged recursively (`mergeEntry`): missing in the default → moved (links are recreated after their targets moved); identical file → dropped; different → moved next to the default file as `<name>.from-<account>` (`-2`, `-3`… when taken); sockets and FIFOs stay, so their folder is reported as a conflict;
  - `history.jsonl` is appended to the default file as a whole (a newline is inserted when needed);
  - `settings.json` / `CLAUDE.md`: when the default lacks the file, the account's file moves there and becomes the shared one (a `settings.json` with identity keys stays in the account, unlinked); identical → dropped; otherwise renamed to `<name>.independent-backup` in the account;
  - it ends with `ensureClaudeLinks`; the host then mirrors `.claude.json` and reports "X is now linked…" only when the marker link exists, otherwise that X is not linked, with the report summary. An exception reports "Linking X stopped" (files already moved stay in the default directory).
- **Independent creation**: `copyClaudeIndependent` (6.2 step 5); "Re-link" ignores independent accounts.
- **Conversion back** (`makeClaudeIndependent`; the host refuses the current account, confirms, runs the busy check): first the configuration entries whose link resolves to the default entry are unlinked, then `copyClaudeIndependent` runs, and only then history, the session folders, the `projects` marker and the `plugins/` children are unlinked, so a failed copy leaves the account shared and `ensureClaudeLinks` repairs it. History and sessions stay in the default directory, the default directory is never written, and the login stays.
- **Deletion** removes the links only (6.3).
- **Reports** (`describeShareReport`): newly linked and created entries are not reported; the other parts (moved, dropped, kept both, backed up, kept the account's own, not linked for safety, busy, Windows-only parts) form one line; an empty string means nothing needs attention.

### 6.8 Accounts signed in to the same identity

Signing two directories in to the same account gives no separate usage limits, which defeats the purpose of switching. Per vendor, the identities of all registered accounts (default + named) are compared (`sameIdentityGroups`); Claude uses the `accountUuid` + `organizationUuid` key (section 4), Codex the user + workspace key of [Codex design 6](codex-design.md#6-data-model), never the email. A duplicate group is keyed by its sorted directories only, so no identity value is kept; it is warned once per window session and again only if it disappears and later recurs. The check runs at activation and whenever account info changes. Accounts without an identity (signed out, API key, missing claims) never match. Message: [Features §1](features.md#1-accounts-and-directories).

### 6.9 Claude usage limits

PlanSwap shows the usage limits of Claude subscription accounts (5-hour session, weekly and model-specific weekly windows) without reading `.credentials.json`. The status-line route (a collector installed into Claude's settings) was not pursued: graphical-chat invocation and per-account attribution are unverified, and installing into shared settings would change the default account's configuration ([research record](research/claude-usage.md)). Like Codex ([Codex design 8.7](codex-design.md#87-usage-limits)), PlanSwap instead runs the official CLI under the account and lets Claude Code use its own credentials. Function-level behavior: `src/claudeUsage.ts`, `src/claudeUsageMonitor.ts`; observable behavior: [Features](features.md#claude-usage-limits).

- **Query**: `claude -p /usage --output-format json --no-session-persistence --setting-sources user` (fact 14): only user settings load and no session transcript is written. Stderr is never read or logged, the run is limited to `planswap.claude.usageTimeoutSeconds` (default 30 s), and only the child PlanSwap started is ever ended. The environment is the host's with the variables of `claudeCode.environmentVariables` applied as the Claude extension applies them (an empty value is passed as `''`, so a credential the user cleared there is not used), and with `CLAUDE_CONFIG_DIR=<dir>` exactly when Claude Code reads `<dir>/.claude.json` for the account, so the CLI updates the very file PlanSwap reads. The JSON result is only checked for success; its text is never returned or parsed beyond a short error detail.
- **Cache**: the values come from `cachedUsageUtilization` in the account's own info file, not from the CLI output; the model name of a scoped window is shown as reported, never hard-coded.
- **Attribution**: the cache is used only when its `accountUuid` equals `oauthAccount.accountUuid` of the same file. This in-memory comparison key is never returned, displayed, logged, persisted or sent to the Webview, and it makes a re-sign-in as another account hide the old cache until Claude Code fetches again. Observations older than 24 hours (or dated more than 2 minutes in the future) are hidden, windows past their reset are hidden individually, and missing data never means 0%. Only accounts with a subscription identity show or query usage; signed-out and API-key style accounts start nothing.
- **Results**: a run counts as refreshed only when the cache's `fetchedAtMs` lies within 2 minutes before the run started or later; when the CLI succeeded with an older cache (observed offline) the old values stay visible and the result is `notRefreshed` (failure kinds: `ClaudeUsageFailure`).
- **Scheduling** (`ClaudeUsageMonitor`): only the current account is queried automatically, one query at a time (concurrent refreshes join). Automatic checks run about 5 seconds after activation, then on a 60-second tick and on regaining focus, only while the window is focused, and only when both the account's usage cache (whoever refreshed it: another window, a terminal, or Claude Code itself) and this window's last attempt for that directory, failed ones included, are older than the interval (`planswap.claude.usageRefreshMinutes`; `planswap.claude.usageAutoRefresh` turns them off). Windows thus share one schedule through the info file, a cache refreshed elsewhere starts no process, and a failure is not retried in a loop. A switch or a sign-in is checked at once under the same condition. Manual refreshes query immediately, except within the 60-second manual cooldown ([Features](features.md#manual-refresh-cooldown)).
- **Refresh all** (`planswap.claude.refreshAllUsage`, manual only, never scheduled): queries the registered accounts with a subscription identity one after another and continues after a failure; every `claude` usage process of a window, scheduled or manual, runs through one queue (`oneAtATime`), so two never run at once. Cancelling ends the running child and stops the run. The external (unregistered) current directory is not included; accounts in the manual cooldown are skipped; failures are summarized in one warning with the detailed reasons.
- **Display**: the status bar and the sidebar re-read the cache from the info files on every render; the sidebar shows the cached usage of every registered signed-in Claude account, so another account shows what its own last query (in any window, in a terminal or through refresh-all) cached. PlanSwap keeps no Claude usage store of its own (unlike `codex.usageHistory`).
- **Side effects**: Claude Code writes the usage cache and possibly other helper entries in the account directory (for the default account in `~/.claude.json`); PlanSwap only reads the cache entry.
- **Rate limits**: the usage endpoint is rate limited; Claude Code's documentation says so ("most often because the usage endpoint is rate limited", after which `/usage` shows the last bars loaded within 60 minutes) and its changelog 2.1.284 made the official views back off after a 429, but no numbers are published. Community reports (2026-03, Claude Code 2.1.69) describe 429s after a few calls and a limit shared by every session of the account, so PlanSwap's queries compete with the user's own Claude Code sessions. PlanSwap's own test on 2026-10-01 (about 70 calls, Claude Code 2.1.286) saw no 429, so the limit is not fixed and no safe rate is established ([research record](research/claude-usage.md#rate-limiting)). PlanSwap therefore keeps scheduled queries at one per account per 15 minutes across windows by default and never more often than every 10 minutes (`planswap.claude.usageRefreshMinutes`), lets the user turn them off (`planswap.claude.usageAutoRefresh`), and does not repeat a manual query of an account within 60 seconds. `claude -p /usage` is not in the documented list of commands for `-p`; the route may change with Claude Code releases.

## 7. Refresh triggers

Listed in [Features §6](features.md#6-refresh-triggers). Each shown account directory has a watcher on its info file (`claudeJsonPath(dir, isExplicitConfigDir(dir))`), which also re-checks duplicate identities (6.8); usage scheduling is in 6.9.

## 8. Platform guard

Only `linux` and `win32` are supported (`isSupportedPlatform()`); elsewhere activation warns once and registers nothing ([Features §9](features.md#9-platform-guard)). `package.json` declares `extensionKind: ["workspace"]`, so in a WSL window the extension is installed and runs on the WSL side.

### Windows support

Researched 2026-09-29 from the official Claude Code docs (authentication, settings, VS Code), the Codex docs and `openai/codex` issues, and existing switchers (account-switcher-for-claude-code, claude-account-switcher-windows, codex-switch, codex-profiles). Verified on 2026-09-30 without real accounts: with `CLAUDE_CONFIG_DIR` set, Claude Code 2.1.284 on Windows writes `<dir>\.claude.json` and nothing into the home folder (temporary config and home folders), so the existing `claudeJsonPath` rule holds; the CLI resolves `~` through `USERPROFILE`, like `os.homedir()`. The Claude extension 2.1.284 applies `claudeCode.environmentVariables` to the process it starts and follows a `CLAUDE_CONFIG_DIR` there host-side as well (its code; the older reports [#30538](https://github.com/anthropics/claude-code/issues/30538), [#34888](https://github.com/anthropics/claude-code/issues/34888) predate that); it reads the entry as in fact 2, and `claudeSettings` does the same.

- **Location.** A local Windows editor runs the workspace extension natively; `os.homedir()` is `%USERPROFILE%`, so `~/.claude`, `~/.claude-<name>`, `~/.codex-<name>` and `~/.config/planswap/` are Windows paths. Windows credentials for Claude are `<dir>\.credentials.json`, so one directory per account keeps logins apart, exactly as on Linux.
- **Paths.** `samePath` / `sameRealPath` compare case-insensitively on Windows (`platform.comparablePath`). `sameRealPath` also resolves 8.3 short names and `\\?\` prefixes through the native realpath and falls back to device + inode identity, so a `CLAUDE_CONFIG_DIR` spelled with a short name such as `C:\Users\JOHNSM~1\.claude-work` still protects that folder as the default (before, it was listed as a named account, deletable, and a conversion deleted its files as "duplicates" of themselves; reproduced on 2026-09-30). The guards before removing or converting an account (current Claude directory, effective and selected Codex directory) use it too; switching keeps the plain comparison; the "direct child of home" deletion guard and the shared-account marker check use the same comparison (Node's `realpathSync` keeps the case it was given, so a junction created under a differently cased default path still counts).
- **Files.** Replacing a file fails on Windows while any handle is open on it (antivirus, indexer, another window reading `state.json`), so atomic replaces retry for about a second (`renameReplacing`). User-edited `settings.json` / `config.toml` may carry a UTF-8 byte order mark (Notepad, Windows PowerShell 5.1); it is stripped before parsing, so the identity-key checks still see the first line. Copying a folder for an independent account turns file links into copies of their targets when Windows refuses file symlinks (dangling ones are skipped).
- **Links.** `platform.createLink`: directories become junctions (no privilege, absolute targets), files become symlinks, which need Developer Mode or elevation; a refused file symlink raises `LinkPrivilegeError` and never aborts a run; a refused junction (the account folders are not on a local NTFS drive) raises `JunctionError`, the entry is reported (`failed`) and the run goes on. Folders still link, and the affected files are reported (`noPrivilege`, `share.r.needsDevMode`). Conversions leave single files in the account when `fileLinksAvailable` fails, and JSONL merge-backs are skipped for the same reason. The modal (`linkPolicy.askCopyFallback`, asked when adding, converting and once per Re-link run, never when links work) offers Copy files, Open Developer Settings and Skip; Open Developer Settings opens `ms-settings:developers` (Settings > System > For developers on Windows 11, Update & Security > For developers on Windows 10; verified to open that page on Windows 11) and copies nothing, and when the editor cannot open it a message names that path. After the user agrees to copy, small config files (`COPYABLE_ON_NO_LINK`) are copied once; history, databases and locks never are. Copies are not reported as conflicts while links stay unavailable, and once links work a copy identical to the default is replaced by a link. Deleting an account first unlinks the links inside it (6.3).
- **Busy checks** cannot read another process's environment, so a running process cannot be attributed to an account. Claude (`windowsSessionsBusy`): a record in the account's own `sessions/*.json` whose pid is alive (signal 0 probe, never a kill) and whose process started at the recorded `procStart` (Windows FILETIME, compared through one `Get-Process` call, so a reused pid does not count; a record without `procStart` or a failed probe counts as busy). A shared account's `sessions` is the default folder, holding the records of every sharing account, so it is never busy by records. Codex: only the account's daemon pid file; a `codex.exe` is nearly always running (the Codex extension's app server, which serves the effective account that switching and conversions already refuse). For both, the commands also refuse while the account's own PlanSwap terminal is open in this window. A session started by the official panel for a formerly current account, or a terminal in another window, is not detected.
- **Terminals** get `CLAUDE_CONFIG_DIR` / `CODEX_HOME` through `createTerminal({ env })` only; there is no `env ...` command prefix (`null` removes `CODEX_HOME` for the default account). A WSL shell does not receive that environment (verified: a Windows variable is empty inside `wsl.exe`) and would run the Linux CLI, so when the default terminal profile is WSL the account terminals start Windows PowerShell instead (`terminalShell.accountTerminalShell`); other profiles (PowerShell, cmd, Git Bash) are kept.
- **Variable names** are case-insensitive on Windows: a `claude_config_dir` entry in `claudeCode.environmentVariables` counts, as it does for the Claude extension; with several entries the last accepted one wins. In a child environment Node itself passes the upper-case spelling when several exist (verified), so PlanSwap's own `CODEX_HOME` / `CLAUDE_CONFIG_DIR` always wins there.
- **CLI shims.** "CLI versions" runs through a shell on Windows so `.cmd` shims resolve (fixed literals `claude` / `codex`), and uses `where.exe` to tell a missing CLI apart, since through `cmd.exe` a missing command is only exit code 1. The usage queries fall back to `claude.cmd` / `codex.cmd` the same way.
- **Codex run inside WSL** (`chatgpt.runCodexInWindowsSubsystemForLinux`): Codex switching and usage queries are refused; see [Codex design 9a](codex-design.md#9a-native-windows).
- **Server restart** is never attempted on Windows: `executeRestart` still refuses off Linux and `detectServerKind` reports `unknown`.

## 9. Code structure

Signatures, per-module behavior and cross-module wiring live in the code (types and TSDoc). The repository and build-file map is in [Development](development.md#repository-layout).

## 10. Dependencies and build

Dependency pins, editor compatibility and type checking are maintained in [Development](development.md#dependencies-and-build), build entries and output formats in [`esbuild.mjs`](../esbuild.mjs), tests in [Development](development.md#tests) and packaging in [Development](development.md#release). Frontend/backend dependency boundaries are in [AGENTS.md](../AGENTS.md#implementation-boundaries).

## 11. Known limitations and risks

1. Open sessions do not follow a switch; after a reload all panels start over with the new account, and old session history stays in the old account directory.
2. The machine setting is shared by all WSL windows: switching in one window also changes the account for new sessions in other windows, and the official panels in other windows refresh their display as well.
3. Independent accounts: the configuration is copied once at creation and is independent afterwards; history, sessions and workspace trust records are their own. Shared accounts share settings, rules, history and sessions with the default account; workspace trust and MCP servers are mirrored only when links are refreshed (6.7), not in the background.
4. Every account directory has its own sign-in and its own `.claude.json` (never linked); a signed-in shared account only takes the default's onboarding state when it lacks it (6.7).
5. If the user exports `CLAUDE_CONFIG_DIR` in `~/.bashrc` or similar, the extension host inherits it and the "default account" actually points to that directory instead of `~/.claude`. The extension uses `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude` as the default directory to stay consistent, taking the value as is like Claude Code (spaces at its start or end are warned about; a blank value counts as unset). While Claude Code sees `CLAUDE_CODE_CUSTOM_OAUTH_URL`, account info is read from `.claude-custom-oauth.json` instead of `.claude.json` (`paths.claudeJsonName`).
6. Signing in from a terminal requires a `claude` command on PATH; signing in from the panel does not.
7. The extension depends on the official extension's behavior for `claudeCode.environmentVariables`; if the official extension changes the semantics of this setting, switching stops working, but no credentials are damaged.
8. Terminal `/ide` integration does not work for non-default accounts (fact 8); the native panel is not affected.
9. Command titles, categories and the view name follow VS Code's display language, not `planswap.language` (5.5); with a mismatched setting, the Command Palette and the panel may show different languages.
10. MCP servers copied or mirrored from the default account (6.2, 6.7): OAuth tokens of remote MCP servers live in each account's `.credentials.json`, which is never read, copied or linked, so such servers must be authorized again in each account; MCP `env` values (possibly API keys) are copied in plain text into the other accounts' `.claude.json`. For independent accounts nothing is removed later, so a server deleted from the default account stays there; shared accounts follow deletions on the next refresh. Running sessions keep their MCP list until a new session starts.
11. A link Claude Code replaced by a regular file is only repaired at the next link refresh (6.7): `history.jsonl` (e.g. after `claude project purge`, fact 11) is merged back by appending, so purged lines stay in the shared history; any other replaced entry is only reported as the account's own and must be merged by hand.
12. Resuming a session that another account started may fail: transcripts carry no account id and `--resume` does not check (fact 12), but content bound to another organization can be rejected by the server.
13. Two accounts resuming the same session at the same time write to the same transcript; avoid it.
14. Linking an independent account merges its files into the default account; unlinking does not undo that merge (history and sessions stay in the default account). Files that differed are kept as `<name>.from-<account>` / `<name>.independent-backup` for manual merging.
15. Claude usage limits (6.9) depend on a `claude` on the extension host's PATH, on the local `/usage` command and on the undocumented `cachedUsageUtilization` entry of the info file (fact 14); when upstream changes either, the values disappear (`noUsage`) rather than turn wrong. Each query starts a short-lived CLI process that contacts Anthropic's service as the CLI itself does. Only the current account is queried automatically (refresh-all queries the others on demand), so other rows show what their last query cached (hidden after 24 hours). Offline, the old values stay with the short "Usage check failed" line. Native Windows (`claude.cmd` fallback) and non-default account states are not yet accepted with real accounts ([TODO](../TODO.md)).
