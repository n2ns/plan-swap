# Features

This document owns PlanSwap's intended user-visible behavior: what each command and `planswap.*` setting does, the outcome of the key flows including cancel and failure results, and the deliberate boundary rules. Layout and message texts live in the code and the i18n tables, and the rationale lives in [Claude design](design.md) and [Codex design](codex-design.md).

## 1. Accounts and directories

- `default` is `~/.claude` (or the host's `CLAUDE_CONFIG_DIR`) and cannot be removed. A named account `<name>` uses `~/.claude-<name>` and is created by adding it or registered by auto-discovery (section 5).
- The current account comes only from `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`; a value matching no registered account appears as a current "External directory" row. Storage, pruning, email/plan and sign-in detection: [Claude design 4](design.md#4-data-model).
- Every named account is shared or independent (section 5): chosen when adding (2.5), changed with 4.6 / 4.7.
- Aliases exist only for named accounts and change only the display (2.7).
- **Same sign-in warning**: registered accounts of one vendor signed in to the same account and workspace are named once per situation per window session ([Claude design 6.8](design.md#68-accounts-signed-in-to-the-same-identity)).
- **Environment warnings** appear at activation, at most once per window, each with a persistent "Don't Show Again": a variable that overrides the selected folder's sign-in (only its name is read, never its value); on Windows, a home folder inside OneDrive; a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` value with leading or trailing spaces.

## 2. Sidebar

The activity bar container `planswap` holds one view, `planswap.accounts`, with a Claude and a Codex tab (section 10); the last tab is remembered across reloads. Each page lists all accounts, current first, with usage refresh buttons, an add form and Tools (5.5). The title bar has `planswap.openSettings` (Settings UI filtered to PlanSwap) and `planswap.refresh` (4.5).

Settings (application scope, applied immediately):

- `planswap.usageDisplay` (`remaining` / `used`, default `remaining`) picks whether usage bars and percentages show what is left or what is used, on both pages and in the status bar text and tooltip (section 3). Bar colors and the status bar background always follow what is left.
- `planswap.sidebar.shortFormat` (default off) shortens limit labels and recommendation percentages in both sidebar pages. Reset countdowns use space-separated Latin `d` / `h` / `m` units with the existing two-unit, rounded-up minute rules. Tooltips and accessibility text keep full localized meanings and respect remaining/used display; account and model names stay unchanged. With it off, the existing full display is preserved.
- `planswap.sidebar.showEmail`, `planswap.sidebar.showFiveHourLimit` and `planswap.sidebar.showWeeklyLimit` (default on) hide a row's email, 5-hour or 7-day window on both pages; `planswap.sidebar.showModelLimits` (default off) adds Claude's model-specific windows; `planswap.usageWarningThreshold` (default 30) and `planswap.usageErrorThreshold` (default 10), both 0–100, are the shared remaining percentages at or below which sidebar bars and the status bar background turn to the warning or error color (error wins). The email setting also hides Claude and Codex account emails in the status bar tooltip, using account labels instead; user-defined names and aliases are unchanged. The other sidebar settings do not affect the status bar.
- `planswap.sidebar.showRecommendation` (default on): off hides the [recommended account](#24-recommended-account) card and the per-row exclude buttons; the marks are kept.
- `planswap.claude.usageAutoRefresh` / `planswap.codex.usageAutoRefresh` (default on) and `planswap.claude.usageRefreshMinutes` (10–1440) / `planswap.codex.usageRefreshMinutes` (5–1440; both default 15, out-of-range values clamped) control each product's automatic usage checks. Off stops every automatic check while manual refreshes still work and shown values stay (except a Codex result whose sign-in changed), and the status bar still shows the effective Codex account's stored observation, as its row does; turning on or shortening the interval checks at once if due. Automatic checks cover every registered signed-in account of the product (Codex: not API key accounts), the current / effective one first, then the others one at a time, each once its last check from any window or trigger is older than the interval; `planswap.usageAutoRefreshCurrentOnly` (default off) limits them to the current Claude and the effective Codex account. The first automatic check runs about 20 seconds after activation; after that, `planswap.usageCheckIntervalSeconds` (30–600, default 120; out-of-range values clamped) sets how often the checks look for due accounts, and a change applies at once. Refresh buttons and commands come first: automatic checks of the other accounts pause while a manual refresh waits or runs and never query an account in the same moment, and every query, manual and failed ones included, counts as that account's last check, so the automatic checks leave it alone for the interval.
- `planswap.claude.usageTimeoutSeconds` (10–120, default 30) / `planswap.codex.usageTimeoutSeconds` (5–120, default 15; out-of-range values clamped) limit how long one usage check may run before it is ended and reported as timed out. They apply to automatic checks, manual refreshes and refresh-all, from the next check on.
- `planswap.notifications.enabled` (default on) and `planswap.notifications.threshold` (1–99, default 20; out-of-range values clamped): a warning notification, with **Open PlanSwap**, when a general window (5-hour, 7-day; never a model-specific one) of the current Claude or the effective Codex account has at most the threshold percent left but more than 0, naming the account, the window, the percentage and the time to reset. A used-up window (0% or Codex's limit reached) gets none, since Claude Code and Codex report it themselves. Each window is announced once until its reset, across windows and restarts (`usage.lowNotified` in the state file); with several low windows at once the one with least left is named. Only the focused editor window announces, after a usage result, an account-info change, an automatic check tick, focus or a settings change, so a window already low is announced when the notices are turned on or the threshold raised. Checks of other accounts never notify.
- `planswap.claude.confirmSwitch` (default on): off switches Claude accounts from the panel without the modal confirmation (4.1). Codex switching always confirms (10.6).

After a switch in this window, a banner names the new account until reload, offering **Reload Window**; closing only hides it, and a later switch updates the name.

The Settings editor has five groups: **General** (7 settings), **Sidebar** (6), **Status Bar** (3), **Accounts** (5) and **Advanced** (3). Accounts lists the three Claude settings together, followed by the two Codex settings. Advanced holds `planswap.usageCheckIntervalSeconds`, `planswap.claude.usageTimeoutSeconds` and `planswap.codex.usageTimeoutSeconds`. Their keys, ranges, defaults and application scope are unchanged.

Shared colors apply immediately. Each sidebar window uses its own remaining percentage, including model-specific windows when shown; the status bar uses the lowest general remaining percentage across its shown products. Sharing thresholds does not make every window the same color. Former per-surface color keys are no longer read or contributed, and user settings are not rewritten.

### 2.3 All accounts list

Rows show the name (link badge when shared), email (or "Logged in"), plan, cached usage ([Claude usage limits](#claude-usage-limits)) and a sign-in hint on signed-out non-current rows. Row actions:

- **Switch** (4.1) on non-current rows, also by double-click or Enter; a single click does nothing.
- **Terminal / Log in** (4.4) on every row, including the external directory.
- **Link** (4.6) / **Unlink** (4.7) on non-current independent / shared named rows, each after a modal confirmation.
- **Remove** (named, non-current rows) confirms inside the row (Cancel restores it; the confirmation is dropped if the account leaves the list), then continues with 4.3; **Rename** (2.7) on named rows.
- **Exclude from recommendations** / **Include in recommendations** (lightbulb toggle, registered rows whose limits can be queried; highlighted while excluded) marks the account for the [recommended account](#24-recommended-account) card. The toggle is hidden when the page has only one account. The mark is stored per vendor ([Claude design 3](design.md#persisted-state)) and cleared when the account is removed or its directory disappears.

### 2.4 Recommended account

While the current account (Codex: the effective one) runs low, a card above the list recommends another account of the same page: **Recommended: \<name\>**, one line with its general windows as its row shows them ("5-hour limit 58% remaining · 7-day limit 46% remaining", following `planswap.usageDisplay` and the `planswap.sidebar.show*` window settings) and how long ago it was observed ("Updated 2 minutes ago", kept current every minute; shown even when the window settings hide every window), and the actions **Switch** (the same action as the row's button: Claude's usual confirmation, or the Codex selection with its restart) and **Terminal** (4.4 / `planswap.codex.openTerminal`), each with a tooltip naming the account and saying whether it switches. The rule (`recommend`, `src/recommend.ts`): the card appears while the current account's lowest general window is at or below `planswap.sidebar.recommendationThreshold` (default 10%, independent of colors), and names the registered, not excluded account with the most left in its lowest general window, provided nothing of it is used up and it is strictly better than the current account. Model-specific windows never count, since PlanSwap does not know which model comes next; while the Claude switch notice or the Codex pending-restart notice is shown, no recommendation card is shown, since the next account is already chosen. The card never queries anything: it works from the observations the rows already show, so it can be as old as the last check of that account. The display settings do not change which account is recommended, only the figures shown. `planswap.sidebar.showRecommendation` off hides it.

The independent recommendation threshold is clamped to 0–100, defaults to 10 and compares the unrounded observation. It reads only `planswap.sidebar.recommendationThreshold`; color settings do not affect it. Changes apply immediately.

Claude and Codex are recommended separately; a percentage of one subscription is not the same amount of work as the same percentage of another, so the card compares accounts of one product only.

### 2.5 Add-account section

The "+ Add" toggle or an add command opens the form; the name is checked as typed. Two options under the name choose the mode, each described by purpose: linked to the default account (selected by default; continue the same work, only the sign-in is separate) or independent (keep work and personal apart, starting from a copy of the current settings). Success collapses and clears the form; failure keeps it open with the reason. Refreshes keep the typed input and checkbox. A help line names the directory to be created; each page keeps its own form.

### 2.7 Inline rename

The pencil makes the name editable: Enter, save or blur saves, an unchanged name just leaves edit mode, Esc cancels, and an invalid name stays in edit mode with the reason. A name must be non-empty, at most 32 characters, single-line, not the external-directory name in any language, and not equal, ignoring case, to another name or alias of the same vendor; the two pages may share an alias. Entering the account's own name clears its alias.

## 3. Status bar

One item shows `$(dashboard) Claude 97% · Codex 82%`: per product, the remaining percentage (rounded down; with `planswap.usageDisplay` set to `used`, 100 minus it) of its shortest general window, normally 5 hours, and no account name. Once a longer general window has the least left and is at or below the higher of the two background thresholds, the text states that window instead, with its duration: `Claude 2% (7d)`, so the number agrees with the background. A product without a usable figure (signed out, no subscription or an API key, no fresh result, Codex run inside WSL) shows its name only. A vendor without local configuration is left out; with none left, the item is hidden. A click opens the sidebar. Color and window selection compare unrounded observations; rounding affects display only. The background turns to the error color when the lowest general window (never a model-specific one) of the shown products is at or below the error threshold, else to the warning color at or below the warning threshold ([Claude design 5.4](design.md#54-status-bar)).

Settings (application scope, applied immediately): `planswap.statusBar.enabled` (default on) hides the item when off; `planswap.statusBar.products` (`both`, `claude`, `codex`; default `both`) drops a left-out product from the text, tooltip and background; `planswap.usageWarningThreshold` (default 30) and `planswap.usageErrorThreshold` (default 10), both 0–100, set the background thresholds; `planswap.statusBar.alignment` (`left` / `right`, default `right`) picks the side.

- **Tooltip**, one block per shown product: a header with email (or the account label when emails are hidden) and plan (else "API key", the account label, or not signed in) and a refresh link (`planswap.claude.refreshUsage` / `planswap.codex.refreshUsage`) while usage can be shown; one row per general window, shortest first, with bar, remaining percentage, reset time and a used-up mark; short status lines (checking, query failed (signing out is not a failure), limit reached, a Codex selection pending restart, Codex inside WSL on native Windows). A signed-out product shows its header only. The Codex block always describes this window's effective account, never the pending selection.
- It updates with the sidebar (sections 6 and 10.10) and when `planswap.language` changes. The screen reader label spells the figures out.

## Status bar account summary

Usage figures come only from the official CLIs run under each account ([account and data safety](../AGENTS.md#account-and-data-safety)). Codex checks only the effective account automatically, never API key accounts or Codex inside WSL ([Codex design 8.7](codex-design.md#87-usage-limits)).

### Codex account usage observations

Rows of signed-in ChatGPT accounts show each last-observed window (duration, time to reset, remaining-percentage bar colored at the shared `planswap.usageWarningThreshold` / `planswap.usageErrorThreshold` settings (section 2); a used-up window shows 0%), as Claude rows do ([Claude usage limits](#claude-usage-limits)). Accounts other than the effective one are updated by the automatic checks (section 2) and by `planswap.codex.refreshAllUsage` ([10.3.1](#1031-refresh-usage-limits-of-all-codex-accounts)). Observations survive restarts and expire after 24 hours, each window at its reset; retention and clearing rules: [Codex design 8.7](codex-design.md#87-usage-limits).

### Claude usage limits

Usage checks try `claude` on PATH first (`claude.cmd` also on Windows), then the official Claude Code extension's bundled CLI if no command is found. Terminal sign-in still requires `claude` on PATH.

A refresh succeeds only when the CLI's structured usage report is valid and the account's official cache supports the result. A recent official cache hit counts as success even when its values and fetch time stay unchanged. Missing or unavailable report data causes a failed refresh, even if recent historical values remain visible; it neither triggers a second executable query nor implies an outdated CLI. A valid empty result shows no quota bars, including when old cache fields remain. Signing in as another account during the query prevents that query from succeeding.

Only subscription sign-ins have usage limits; other accounts show and start nothing. The status bar shows the current account's general windows (section 3). Every registered signed-in row shows what Claude Code last cached in that account's own `.claude.json`, with model-specific windows only under `planswap.sidebar.showModelLimits`; nothing shows when the cache is missing, older than 24 hours or from another sign-in. Automatic checks run in the focused window: the current account once both its cache (from any window or terminal) and this window's last attempt are older than the interval, then the other registered signed-in accounts under the same condition unless `planswap.usageAutoRefreshCurrentOnly` is on (section 2); a switch or sign-in checks the current account at once under the same condition ([Claude design 6.9](design.md#69-claude-usage-limits)).

### Usage refresh buttons

Each page's list heading has **Refresh** (`planswap.claude.refreshUsage` / `planswap.codex.refreshUsage`, current account) and **Refresh all** (`planswap.claude.refreshAllUsage`, 4.9 / `planswap.codex.refreshAllUsage`, 10.3.1). Each appears only when the current row, or for Refresh all some registered row, can be queried, and neither while the page is disabled.

### Manual refresh cooldown

Because both usage endpoints are rate limited per account ([Claude design 6.9](design.md#69-claude-usage-limits), [Codex design 8.7](codex-design.md#87-usage-limits)), manual refreshes (button, tooltip link, Command Palette, refresh-all) do not query an account within 60 seconds of its last query from this window, scheduled ones included; for Claude a cache fetched by any window or terminal also counts.

- A single refresh in the cooldown only shows a message; a running query is still joined.
- Refresh-all skips accounts in the cooldown and counts them in its final message; if all are, it runs nothing.
- The cooldown is per product and account, in memory only, and does not affect scheduled checks.

## 4. Commands

Claude account commands are in the Command Palette category "Claude Account"; panel actions reach the same flows ([Claude design 6](design.md#6-commands-and-flows)). A palette command that needs an account asks for it in a QuickPick; with nothing to pick, an info message appears and nothing runs.

### 4.1 Switch account `planswap.switchAccount`

From the row (switch button, double-click or Enter, with a modal confirmation unless `planswap.claude.confirmSwitch` is off) or the palette (non-current registered accounts; the pick is the confirmation). New sessions use the target, in every window (section 8); open sessions keep the old account until a reload, offered by the reload banner (or a notification while the sidebar is hidden). A missing named directory is refused; a shared target is re-linked first and problems only warn. A failed settings write is reported and the account stays unchanged.

### 4.2 Add account `planswap.addAccount`

The palette entry only focuses the sidebar's add form, which shows validation errors. `~/.claude-<name>` is created or reused as is; if creation fails nothing is registered. A shared account is linked to the default account, an independent one gets a one-time copy of the default configuration; a failure there only warns and the account is still added ([Claude design 6.2](design.md#62-add)).

### 4.3 Delete account `planswap.removeAccount`

From the row's inline confirmation or the palette (modal; named, non-current accounts). The default account and the external directory cannot be removed; the current or a busy account is refused before and after every confirmation. Removal clears the alias; deleting the directory is always a separate modal, and a kept directory is ignored by auto-discovery until its name is added again. Deletion rules: section 7.

### 4.4 Run claude in a terminal as an account `planswap.openTerminal`

From the row's terminal or "Log in" button (every row, including the external directory) or the palette (registered accounts, plus the external directory when current). Opens `Claude (<label>)` running `claude` (must be on PATH) under that account; if it closes with a named account still signed out, a warning names the likely override ([Claude design 6.4](design.md#64-open-claude-in-a-terminal)).

### 4.5 Refresh `planswap.refresh`

Title bar and palette: re-syncs both vendors' account lists with the disk (section 5) and redraws everything.

### 4.6 Share an independent account

Row link button (independent named, not current) or `planswap.shareAccount`. After a modal confirmation, refused for the current or a busy account, the account's data moves into the default directory without overwriting anything there and is replaced by links ([Claude design 6.7](design.md#67-shared-and-independent-accounts)). Account registration, current/selected state and busy state are checked again after the Windows file-link fallback dialog, before any conversion. Cancelling changes nothing; "linked" is reported only when the link exists, and after an error moved files stay in the default directory.

### 4.7 Unlink a shared account

Panel only (row unlink button; shared named, not current), with the same confirmation and refusals as 4.6. The account becomes independent with a one-time copy of the default configuration; history, sessions and the login stay, and the default directory is not modified. If copying fails the account stays shared and **Re-link** repairs it.

### 4.8 Refresh usage limits `planswap.claude.refreshUsage`

Palette, [usage refresh button](#usage-refresh-buttons) and tooltip link: queries the current account now ([Claude usage limits](#claude-usage-limits)); a running query is joined, and within the [manual refresh cooldown](#manual-refresh-cooldown) only the cooldown message appears. Signed-out and non-subscription accounts start nothing.

### 4.9 Refresh usage limits of all accounts `planswap.claude.refreshAllUsage`

Palette and the layers button, manual only: queries every registered signed-in subscription account in turn so rows can be compared before switching; the external directory is excluded and accounts in the cooldown are skipped and counted. Progress is cancellable, one failure does not stop the others, and one message summarizes the run; after a cancellation with failures, the failure warning follows it. With no eligible account nothing runs; a second run while one is active does nothing.

## 5. Auto-discovery, shared and independent accounts

- **Auto-discovery** (activation and Refresh): unregistered real `~/.claude-<name>` directories (not symlinks, not the default directory, not ignored, no case-insensitive clash with a name or alias) are registered, so hand-made folders are adopted and a lost state file does not empty the list. Accounts whose directory vanished are dropped with their alias, not ignored.
- **Shared** ("linked" in the UI): the supported configuration and history entries link to the default directory without overwriting its existing content; login identity stays separate. MCP servers, project trust and onboarding state are mirrored. An unsafe account info target (credentials, default-account data, a hardlink or a dangling file link) is refused before its contents are read; safe external info-file links remain supported. Links refresh only on add, before a switch, by Re-link's Repair and after linking; a background check of the focused window (on activation and on regaining focus, at most every 10 minutes) only points out problems that Repair can fix, once per change across windows and again after a day.
- **Independent**: a one-time, never-overwriting copy of the default configuration; history and sessions stay separate.

Rules: [Claude design 6.7](design.md#67-shared-and-independent-accounts), [AGENTS.md](../AGENTS.md#account-and-data-safety); MCP OAuth and `env` caveats: [Claude design 11](design.md#11-known-limitations-and-risks).

## 5.5 Tool buttons

The footer toolbar (both pages, even with Codex switching disabled) shows CLI and extension versions (local probes, no network), opens the user guide in the panel language and the repository, and runs Reload Window / Restart Extension Host without confirmation. The WSL server restart is only `planswap.codex.restartServer` (10.6).

Each page's Tools section opens the effective account's `CLAUDE.md` / `AGENTS.md` (a missing one is created empty after confirmation), opens Settings filtered to `claudeCode.` / `chatgpt.` (labeled Claude Settings / Codex Settings, so it is not mistaken for PlanSwap's own settings), runs Update CLI (`claude update`, or `codex update` with `CODEX_HOME` removed so the selected account cannot affect installation detection; no state change) and Re-link (only while a linked account exists), in that order. Re-link first checks every linked account without changing anything: all fine is reported as such; otherwise one notification lists, per account, missing or outdated links, missing default entries, replaced history files, an out-of-date `.claude.json` (Claude), and what blocks a repair (an account in use), with a **Repair** button when something is repairable. Links pointing elsewhere and the account's own files are listed as kept as they are, without counting as problems (all fine is still reported); Claude Code's plugin cache files (top-level files under `plugins/`) are not listed. Claude Repair touches only the accounts and repairable entries listed in that notification, including the named `.claude.json` groups; it preserves extra account MCP servers and project settings. Project MCP enable/disable lists are reconciled together: explicit default choices replace the opposite account state for those servers, while unrelated account choices stay. Codex Repair keeps its full refresh of linked accounts. One failure does not stop the rest and makes the result a warning. Claude does not report absent optional configuration or runtime targets (including `tasks` and `uploads`) as faults, but initializes them on add/switch before first use. `todos` is retired from creation and checks; existing data stays. Missing core history targets are reported with an explicit warning that creating empty targets does not restore history. Invalid source types or inaccessible targets are check errors. Claude entries intentionally kept independent do not require unused default targets. Normally expired plugin install backups do not trigger repair notifications; missing skill and plugin content still does. Codex also allows an absent optional `themes` source during checks, initializes it on add/switch, and still reports missing links to existing themes.

Palette: `planswap.tools.openClaudeMd`, `planswap.tools.openAgentsMd`, `planswap.tools.openSettings` and `planswap.tools.sync` (both ask for Claude Code or Codex), `planswap.tools.reloadWindow`, `planswap.tools.restartExtHost`, `planswap.tools.cliVersions`, `planswap.tools.diagnostics`, and `planswap.openSettings` (PlanSwap's settings, also the title-bar gear). If Codex fails to initialize, only the Codex restart and Codex Re-link stop, with a warning.

## 6. Refresh triggers

The panel and status bar refresh when `claudeCode.environmentVariables` changes; a shown row's account info file changes, including a new usage cache; the sidebar becomes visible; an account is added or removed or a PlanSwap terminal closes; Refresh runs; every minute (expired usage windows disappear); and when `planswap.language` or a `planswap.sidebar.*` setting changes.

## 7. Safety checks before deleting a directory

Only a real, existing `~/.claude-<name>` directly under home that neither is nor contains the default directory is deleted, without a shell or following links, so linked default content survives; otherwise it is kept and the reason shown ([Claude design 6.3](design.md#63-account-removal-and-directory-deletion-both-vendors), [AGENTS.md](../AGENTS.md#account-and-data-safety)).

## 8. Multi-window behavior

- A switch applies to new sessions and official panel headers in every window of the WSL distribution (or Windows profile); only the switching window shows the reload banner.
- Other windows' sidebar and status bar follow the setting change; Refresh is the fallback.
- The account list is shared through `~/.config/planswap/state.json`, so other windows and editors see additions on their next refresh.

## 9. Platform guard

Only Linux (WSL) and native Windows are supported; elsewhere activation warns once and registers nothing ([Claude design 8](design.md#8-platform-guard)).

## 10. Codex account switching

Independent of Claude switching ([Codex design](codex-design.md)). `auth.json` is only read ([Codex credentials](../AGENTS.md#account-and-data-safety)); `~/.codex` changes only through shared-account operations (10.12), which never overwrite. If the Codex part fails to initialize, Claude is unaffected: the Codex page shows as not enabled and every `planswap.codex.*` command and page action reports the reason.

### 10.1 Accounts and directories

- `default` is `~/.codex` (never removable); named accounts are `~/.codex-<name>`, added or auto-discovered as in section 5, with their own list, ignore list and aliases.
- The **selected account** is what `~/.config/planswap/codex-home` names (empty: default), shared by all windows, last writer wins. A window's **effective account** is its extension host's `CODEX_HOME` (else `~/.codex`); an unregistered one appears as an external row.
- Signed in means `auth.json` exists; a damaged file shows unknown email and plan but still counts as signed in, and API key mode shows "API key". The same-sign-in warning (section 1) compares user id plus workspace, never the email, and is skipped in API key mode.

### 10.2 Codex tab in the sidebar

Until switching is enabled (10.11) the page offers only an explanation of the restart this connection needs, an **Enable Codex switching** button and the Tools section. Once enabled it works like the Claude page, except: no reload banner, but a notice while the selected account differs from this window's effective one (including after another window's switch); and the effective and selected rows can neither be removed, linked nor unlinked.

### 10.3 Commands

Category "Codex Account"; QuickPicks as in section 4, without email.

- `planswap.codex.enable` (disabled-page button, Command Palette): on WSL/Linux runs the [pre-checks](codex-design.md#4-login-shell-configuration), writes the rc marker blocks after a modal confirmation and self-checks them; a failure reports every reason and removes only blocks written by this run. Native Windows manages the per-user `CODEX_HOME` instead and refuses enable and switch while Codex runs inside WSL ([Codex design 9a](codex-design.md#9a-native-windows)).
- `planswap.codex.disable` (Command Palette): after confirmation removes both blocks and the state file, changing nothing when a block is damaged; open windows keep `CODEX_HOME` until restarted.
- `planswap.codex.switchAccount` (switch button, double-click, Enter): 10.6.
- `planswap.codex.addAccount`: focuses the add form; 10.7.
- `planswap.codex.shareAccount` (row `link` button): 10.12.
- `planswap.codex.removeAccount` (trash button): 10.8.
- `planswap.codex.openTerminal` (terminal or sign-in button, also for an effective external directory): opens `Codex (<label>)` running `codex` as that account, or `codex login` with the sign-in tip when signed out ([Codex design 8.4](codex-design.md#84-terminal)); requires `codex` on PATH, not the extension's bundled binary.
- `planswap.codex.refreshUsage` (refresh button, tooltip link): queries the effective account now, joining a running query; within the [manual refresh cooldown](#manual-refresh-cooldown) only the cooldown message.
- `planswap.codex.refreshAllUsage` (layers button): 10.3.1.
- `planswap.codex.restartServer`: in WSL Antigravity / VSCodium, a modal confirmation and the restart of 10.6; elsewhere only the manual instructions.

All are also in the Command Palette.

### 10.3.1 Refresh usage limits of all Codex accounts

As [4.9](#49-refresh-usage-limits-of-all-accounts-planswapclauderefreshallusage), for signed-in ChatGPT accounts (not API key). The effective account is queried as by `planswap.codex.refreshUsage`; any other result becomes that account's [usage observation](#codex-account-usage-observations) unless its sign-in changed meanwhile. Cancelling stops a non-effective account's query; the effective account's finishes. Refused while Codex runs inside WSL on native Windows.

### 10.6 Switch

- Refused until enabled; requests during a switch are ignored. A target already effective in this window only resets the state file, without confirmation or restart.
- Otherwise a modal confirmation matching the [connection](codex-design.md#5-restarting-the-wsl-side-server): **Switch and restart** for WSL Antigravity / VSCodium, **Save selection** with manual restart instructions elsewhere. Cancelling, a missing target directory or the account disappearing meanwhile changes nothing.
- A shared target is re-linked first (problems only warn), then the selection is saved; if saving fails nothing restarts. Antigravity / VSCodium then restart the verified WSL server (else the manual alternative): every WSL window needs one Reload Window and integrated terminals close.

### 10.7 Add

Names are validated as in 4.2; the directory must not be, contain or link to `~/.codex`, nor be a link itself, nor (on Windows) differ from an existing folder only in letter case. `~/.codex-<name>` is created or reused; if creation fails nothing is registered. **Shared** links the entries of 10.12; **independent** copies the default configuration once without overwriting ([Codex design 8.2](codex-design.md#82-add)); only blocked or unreadable files are reported. `auth.json` is never copied or linked. Link or copy problems only warn; the account is still registered.

### 10.8 Remove

The default, effective and selected accounts and a [busy](codex-design.md#86-shared-and-independent-accounts) account are refused, re-checked after every confirmation up to the deletion. Removal unregisters the account, ignores its directory and clears its alias; deleting the directory is a separate modal with the [deletion checks](design.md#63-account-removal-and-directory-deletion-both-vendors). A shared account's linked data stays in `~/.codex`.

### 10.10 Refresh triggers

The Codex page and status bar refresh when an account's `auth.json` or the state file changes, when the panel becomes visible, after add or remove, when a PlanSwap terminal closes, on `planswap.refresh` (which also prunes and discovers `~/.codex-*` directories) and when `planswap.language` changes.

### 10.11 State file and rc marker block

On WSL/Linux, enabling writes a never-localized [marker block](codex-design.md#4-login-shell-configuration) into `~/.profile` and `~/.bashrc` that sets `CODEX_HOME` from the state file. Enabled means both files carry an intact block (Linux) or the state file exists (Windows); PlanSwap then owns `CODEX_HOME`. Activation migrates the ai-switcher 0.1.0–0.1.3 setup.

### 10.12 Shared and independent Codex accounts

Same model as section 5 with `~/.codex`; entries and rules in [Codex design 8.6](codex-design.md#86-shared-and-independent-accounts). Login, memory directories (including `memories_v2/`), logs, daemon files and caches stay per account; thread databases are shared on Linux only. A single-line `sqlite_home = "."` (or a dot-only equivalent such as `"./"`) is allowed when linking or copying configuration; unsupported SQLite paths and forced sign-in restrictions still prevent the configuration from being linked or copied. Link and Unlink are refused for the effective or selected account and while it is busy, need a modal confirmation and cannot be undone automatically. Linking moves data into `~/.codex` without overwriting and warns that another ChatGPT account's sessions may not resume; unlinking leaves shared sessions, history and databases in `~/.codex`.

## 11. Language

`planswap.language` (application scope): `auto` follows the VS Code display language, or `en`, `zh-cn`, `zh-tw`, `es`, `ja`. Changes apply without reload to everything rendered at runtime; manifest strings (commands, view names, setting descriptions) follow VS Code's display language. A legacy `aiSwitcher.language` is carried over once. Commands, paths, ids, account terminal names, plan names and the rc marker block are never translated; aliases show as typed ([Claude design 5.5](design.md#55-localization-i18n)).

## Diagnostics report

`planswap.tools.diagnostics` opens an untitled Markdown report in the PlanSwap language; only the copy action writes the clipboard and nothing is uploaded. It holds versions, platform, anonymous account references, credential-override variable names (never values) and the Codex switching state, but no names, aliases, directories, emails, identifiers or raw errors. Collecting it is read-only.
