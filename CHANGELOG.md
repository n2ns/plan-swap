# Changelog

## [0.3.2] - 2026-10-04

### Added

- When the current account's usage runs low (its bar turns yellow), a card above the account list recommends the signed-in account with the most left, showing its limits and how long ago they were checked, with **Switch** (Claude) and **Terminal** buttons. Click the lightbulb on an account card to keep that account out of recommendations; `planswap.sidebar.showRecommendation` turns the card off.

### Fixed

- The time until reset shown next to each usage limit now keeps counting down between checks instead of staying at the value from the last refresh.
- When automatic Codex usage checks are off, the status bar now shows the Codex account's last known usage, as the sidebar does, instead of only the product name.

### Changed

- With several windows open, Codex usage is checked once per interval instead of once per window: a window shows the result another window just got instead of running its own check.
- Codex usage is no longer re-checked in every open window each time Codex renews its sign-in in the background; the shown values stay until the next scheduled check. Signing in again after an expired sign-in is still checked right away.

## [0.3.1] - 2026-10-03

### Added

- `planswap.usageCheckIntervalSeconds` (default 120, 30–600): how often automatic usage checks look for accounts whose refresh interval has passed; previously fixed at 60 seconds.
- Automatic usage checks now cover every signed-in account of each product, not only the current one: after the current account, the others are checked one at a time at the same interval, each only when no window has checked it within the interval. Turn on `planswap.usageAutoRefreshCurrentOnly` to check only the current Claude and Codex accounts. Refresh buttons take precedence: the background checks pause while one waits or runs, and leave an account alone for the interval after any check of it, a failed manual one included. A window now runs one `codex` usage process at a time, as it already did for `claude`.
- `planswap.sidebar.warningThreshold` (default 30) and `planswap.sidebar.errorThreshold` (default 10), both 0–100: the remaining percentages at or below which the sidebar's usage bars turn to the warning or error color, separate from the status bar thresholds.
- `planswap.usageDisplay` (`remaining` by default, or `used`): usage bars and percentages in the sidebar and the status bar show what is left or what is used. Colors and the status bar thresholds still follow what is left.

### Changed

- The first automatic usage check runs about 20 seconds after the window opens instead of 5, once start-up has finished.
- The Tools section below the account list is always shown instead of collapsed.
- The Tools settings button is labeled **Claude Settings** / **Codex Settings**, since it opens the official extension's settings, not PlanSwap's; **Re-link**, shown only with a linked account, moved to the end so the other buttons keep their places.
- The Tools buttons of one line are equally wide whatever their labels; a label that would not fit keeps its full width instead of being cut off.
- PlanSwap settings are grouped in the Settings editor (General, Sidebar, Status Bar, Claude, Codex), each group in a fixed order.
- Hovering a usage bar shows what is left and what is used (for example "97% left (3% used)"). The other hover texts of the usage area (collection time, remaining percentage, exact reset date) are gone.
- An account's directory is shown when hovering its avatar instead of the whole card.

### Fixed

- Refreshing the current account from its button while **Refresh all** runs no longer queries that account a second time within a minute: Refresh all joins the running refresh or takes its result (Claude and Codex).

## [0.3.0] - 2026-10-02

### Added

- Status bar settings: hide the PlanSwap item (`planswap.statusBar.enabled`), show only Claude or only Codex (`planswap.statusBar.products`), set the remaining percentages at which it turns to the warning and error colors (`planswap.statusBar.warningThreshold`, default 30, and `planswap.statusBar.errorThreshold`, default 10, both 0–100), and move it to the left side (`planswap.statusBar.alignment`).
- `planswap.claude.confirmSwitch` (default on): turn it off to switch Claude accounts from the sidebar without the confirmation dialog. Codex switching still asks, because it needs an editor restart.
- `planswap.claude.usageTimeoutSeconds` (default 30, 10–120) and `planswap.codex.usageTimeoutSeconds` (default 15, 5–120): how many seconds one usage limit check may run before it is reported as timed out, for automatic checks, manual refreshes and refresh-all alike.
- The sidebar tabs show the Claude and OpenAI logos next to their names.

### Changed

- The sidebar tabs look like folder tabs: the selected tab opens into its page, which fills the panel down to the footer, and the tabs stay at the top while the account list scrolls.

## [0.2.3] - 2026-10-02

### Added

- Traditional Chinese (繁體中文) for the panel, status bar, messages, Command Palette titles, settings and the user guide. Choose it with `planswap.language` set to `zh-tw`; with `auto`, a `zh-TW`, `zh-HK` or `zh-MO` editor display language selects it, and other Chinese variants keep Simplified Chinese.
- **Refresh Usage Limits of All Codex Accounts**, in the Command Palette and as the icon button next to the refresh button on the Codex page, checks every signed-in ChatGPT Codex account (not API key) one at a time with a cancellable progress notification and reports failures, so you can compare accounts before switching.
- Settings to turn automatic usage checks on or off for each product (`planswap.claude.usageAutoRefresh`, `planswap.codex.usageAutoRefresh`, default on) and to set their interval in minutes (`planswap.claude.usageRefreshMinutes`, 10–1440, and `planswap.codex.usageRefreshMinutes`, 5–1440, default 15). Manual refreshes always work.
- A step-by-step user guide in English, Simplified Chinese, Traditional Chinese, Spanish and Japanese. The **User guide** button in the panel footer opens it in the UI language.

### Changed

- Manual usage refreshes do not query an account again within a minute of its last check (the usage services are rate limited); a single refresh says when to try again, and refresh-all skips such accounts and says how many it skipped. Scheduled checks are not affected.
- **Switch** on non-current account cards is now an icon button like the other card actions, dimmed until you hover over or focus the card. Double-click and Enter on a card still switch.
- Signed-in shared Claude accounts take the default account's onboarding state, so Claude Code no longer runs its first-start setup again in them. Signed-out accounts keep it, because that is where they sign in.
- In the status bar tooltip, each product's email is a bold header row, window names sit right next to their bars, and status lines span the whole table.
- Translations use consistent terms for usage limits, the default account and linking in every language, and English and Spanish count messages use correct singular and plural forms ("1 account", "2 accounts").
- The README was rewritten around the new user guide.

### Fixed

- Reset times now read the same in editors whose runtime lacks `Intl.DurationFormat` (Node 22): Simplified Chinese without spaces ("2天5小时") and Japanese with full units ("2 日 5 時間").
- Converting an account to a shared one is refused if a PlanSwap terminal for that account was opened while the copy-fallback prompt was showing, instead of going ahead while the account is in use.

## [0.2.2] - 2026-10-01

### Added

- Claude usage limits for subscription sign-ins, in the status bar tooltip and on every signed-in Claude row: session, weekly and model-specific windows with remaining percentage and reset time. Model-specific windows appear in the sidebar, after the general ones and not folded, only when `planswap.sidebar.showModelLimits` is on (default off). The status bar tooltip shows general limits only.
- Values come from the official `claude` CLI (`claude -p /usage`, which sends no prompt) and the usage cache in each account's own folder. Values older than 24 hours or past their reset are hidden, and missing data never shows as 0%.
- The status bar text now shows the product names with what is left of their short (normally 5-hour) usage window, for example "Claude 97% · Codex 82%", instead of account names. The background turns to the warning color at 30% or less and the error color at 10% or less of any general window, the weekly one included.
- Icon buttons left of "+ Add" in the account list header refresh the usage limits of the current account (both pages) and of all Claude accounts (Claude page); they appear only when the account can be queried. The Command Palette entries remain.
- **Refresh Claude Usage Limits** checks the current account on demand, and a new **Refresh Usage Limits of All Claude Accounts** command (also reachable from the Claude page's sidebar buttons) checks every signed-in Claude account one at a time with a cancellable progress notification and reports failures.
- Scheduled Claude usage checks are skipped while the account's cached values are younger than 15 minutes, so several editor windows no longer each start `claude`. Manual refresh always checks.
- New settings `planswap.sidebar.showEmail`, `planswap.sidebar.showFiveHourLimit` and `planswap.sidebar.showWeeklyLimit` (all on by default) choose whether the sidebar account cards show the email, the 5-hour limit and the 7-day limit.

### Changed

- The status bar tooltip is now compact: one table for both products so their columns line up, each product a header row with the email, plan and a refresh button followed by one row per usage window (shortest first) with a remaining bar, remaining percentage, an explicit "Used up" mark at 0% and the relative reset time, plus a short italic line only when something needs saying (checking, failed, Codex restart pending or running in WSL, limit reached). The account name, directory, collection time, lowest-remaining line, detailed failure reasons and text refresh links are gone from it. Codex limits use the same layout.
- Refreshed sidebar account cards: the current account is marked by its plan-colored outline and left bar only (no check badge), every card shows a neutral plan tag, non-current cards show a visible **Switch** button, and the directory moved into the card's tooltip. **Switch** and **Log in** sit at the left and the icon buttons at the right; a card with icon buttons only shows them on the name line, left of the plan tag. The plan tag stays at the right end of the name line and moves under the name only when it does not fit. Only the name line keeps the avatar; the lines below span the whole card. Cards have a stronger outline and smaller corners.
- Usage windows take two lines: the limit with the time until its reset at the right, then the bar with the remaining percentage at its right, so all bars have the same length. Reset times are short durations with days and hours, hours and minutes, or minutes (for example "2d 5h"), with the exact date in the tooltip, in the sidebar and the status bar tooltip. A used-up window shows a hatched bar, a red 0% and its reset time in red bold, without an extra tag.
- Better contrast in dark and light themes: avatar letters stay readable on every chart color, the Max 5x current-card outline is visible on light themes, small red and amber texts are darker on light themes, and keyboard focus is an outline outside the card instead of a border that looked like the blue Pro outline.
- **Add account** is collapsed behind a "+ Add" button, the page tools are collapsed by default with smaller button text, and the footer toolbar is grouped with the destructive reload and restart actions side by side.

## [0.2.1] - 2026-10-01

### Added

- Claude and Codex each have a **Share with Default Account** command that selects an eligible independent account and opens the existing conversion confirmation.
- A localized diagnostics report previews anonymous account-selection and environment information before you choose whether to copy it for troubleshooting.
- Codex account rows show their last observed usage with a collection time and a "not live" label. Observations survive editor restarts, hide after a sign-in file change, and expire after a reset or 24 hours; accounts without an observation show no usage estimate.

### Fixed

- Account creation, linking and unlinking now refuse directories that contain the default account, including through a symbolic link, before moving or writing files.
- Account migrations preserve symbolic-link targets when files move, including relative links, targets renamed to retain conflicting data, Windows short paths and directory aliases. Independent copies also keep relative links to the copied root inside the new account.
- Codex configuration checks correctly handle escaped quotes in TOML multiline strings, so account-specific login restrictions are not overlooked or mistaken for string content.
- Codex usage results are checked against the account identity before display and history storage; signing in to another account while a query is running no longer attributes the old result to the new account.
- Codex protocol output preserves UTF-8 characters split across stream chunks, including non-ASCII account paths.
- Sidebar updates no longer move focus away from the add-account input when an invalid rename field remains open.
- Diagnostics no longer report a pending Codex restart for an unmanaged external `CODEX_HOME` without a saved PlanSwap selection.
- Codex switching re-checks that the target account still exists and is registered after the confirmation dialog closes.
- Clarified account actions, sharing confirmations, platform-specific instructions and usage errors across all four languages.
- Replaced the retired Marketplace badge in the README and updated its environment badge to include Windows.

## [0.2.0] - 2026-09-30

### Added

- Native Windows support for local VS Code-compatible editors. Claude accounts use `CLAUDE_CONFIG_DIR`; PlanSwap selects Codex accounts through the per-user `CODEX_HOME` variable, with a full editor restart required to apply a selection. Real-editor Windows acceptance remains pending.
- Codex usage limits in the status bar tooltip, with reset times, automatic refresh and a manual **Refresh Codex Usage Limits** command.
- Warnings when two registered accounts use the same Claude or Codex identity, when detected Claude environment or editor-setting credentials override per-account sign-in, and when a Windows home folder is under OneDrive.

### Changed

- On Windows, linked accounts use directory junctions. When file links are unavailable, PlanSwap can copy small configuration files once, reports the entries it could not link, and offers to open Developer Settings. Codex databases remain independent on Windows to avoid SQLite write loss through file links.
- PlanSwap account terminals on Windows use Windows PowerShell when the editor's default terminal profile is WSL, so the selected Windows account environment is preserved.
- **Re-link** is shown in the sidebar only when that provider has at least one linked account; the Command Palette action remains available.
- Opening a signed-out account terminal now explains that signing in does not sign out other accounts.

### Fixed

- Improved Windows handling for non-ASCII paths, case-insensitive names, alternate path spellings, UTF-8 BOM files, temporary file replacement failures and pre-existing `CODEX_HOME` values.
- Account deletion and conversion flows now repeat current-account and busy checks after their primary confirmations, protect default-account directories reached through links or alternate paths, and preserve files when links cannot be recreated safely.
- Account discovery now applies its changes over freshly re-read state, while atomic writers use exclusive temporary files and re-check targets before replacement retries.
- Repeated sidebar state updates no longer drop keyboard focus or interrupt input-method composition; inline delete confirmations and rename controls now restore focus reliably.
- Fixed several linked-account repairs, including Claude settings that later gain identity keys, skipping Codex history merge-back while an account is busy, deep nested links during account-directory deletion and Windows database-link migration.

## [0.1.6] - 2026-09-28

### Added

- Spanish and Japanese translations for the panel, account messages, commands and settings. Choose a language in `planswap.language`, or use `auto` to follow the editor language.
- The status bar now shows both Claude and Codex account labels when their local account configuration exists. Hover to see account details and any Codex selection waiting for a restart.

### Changed

- The account status item is now on the right side of the status bar. Services without local account configuration are omitted; the item is hidden when neither is present.

### Fixed

- The panel now shows a loading message while waiting for account data.
- Opening the add-account form now waits until the panel is ready, including after it has been hidden and reopened.

## [0.1.5] - 2026-09-27

### Changed

- The Codex row now distinguishes the account in effect from the account selected for the next restart, and the Command Palette entry is now **Apply Codex Account: Restart or Show Instructions**.
- Codex switching in a local Linux desktop editor or a non-WSL remote window now saves the selection and shows manual restart instructions instead of failing. Automatic restart remains available only in WSL windows of Antigravity IDE and VSCodium.
- Switching back to the Codex account that is already in effect no longer restarts the WSL server.
- The Claude switch failure message no longer assumes a WSL window.
- Deleting a linked account's directory now explains exactly what is kept in the default account and what is removed.
- Tabs can be changed with the arrow keys.
- Plan badges and other panel colors now follow the editor theme, including light and high-contrast themes.

### Fixed

- Busy checks now treat an unreadable `/proc` as "in use" instead of allowing a delete, share or re-link to proceed.
- Re-linking a Claude account that still has a running session no longer moves its prompt history; the switch proceeds and the skipped step is reported.
- Deleting a Claude account directory is now refused while that account has a running session.
- Collapsing the versions card no longer runs the CLI version commands.
- A linked Codex account's `config.toml` link is now removed when the default `config.toml` later gains identity keys, matching the rule applied when the link is first created.
- Broken Codex marker blocks (a start marker without its end marker) now show the Enable button with repair guidance instead of appearing enabled.
- Adding a Claude account whose directory already exists as a symbolic link is now refused.

## [0.1.4] - 2026-09-27

### Added

- **Unlink accounts** in both tabs. Switch away from a linked account and close its sessions, then choose **Unlink** to give it a separate copy of the default settings, rules and skills (including MCP settings for Claude). Its sign-in is preserved. Shared history and sessions stay with the default account, so the unlinked account starts with an empty history.

### Changed

- Account lists, removed-account exclusions and display names are now separate for each WSL distribution, preventing accounts and names from getting mixed up across distributions. Editors in the same distribution share this data. Existing data is migrated automatically.
- **Shared accounts** are now called **linked accounts**. The related buttons and messages use the new wording, and **Sync shared** is now **Re-link**. Independent accounts are unchanged.
- The rename pencil now appears beside the account name when you hover over or focus the row, including when the name wraps onto multiple lines.
- Renaming now has a save button and also saves when the input loses focus. Esc cancels; invalid names stay open for correction. The account card keeps its height while editing.
- Switching Claude accounts from the sidebar now asks for confirmation, whether you use the switch button, double-click a row or press Enter. Switching from the Command Palette is unchanged.

### Fixed

- Fixed upgrades from ai-switcher 0.1.0–0.1.3 showing Codex switching as disabled and preventing it from being enabled again. Your selected account is migrated automatically, without requiring a WSL server restart for the migration.
- Preserved your language preference when upgrading from ai-switcher.
- Creating an independent account, unlinking an account or moving its files between file systems now reports an error instead of crashing the extension host when a configuration folder cannot be read.

## [0.1.3] - 2026-09-27

### Added

- **Shared and independent accounts** for Claude and Codex. New accounts share the default account's settings, rules, skills, history and sessions by default, while keeping their sign-in separate. Uncheck **Share settings and history with the default account** to start with a separate copy of the default configuration. Shared rows show a link badge. Claude also shares MCP and project trust settings; Codex memories remain separate. Access to shared session files does not guarantee that another account can resume them.
- **Share with the default account** for existing independent accounts. Close the account's running Claude or Codex sessions before confirming. Its settings and history are moved into the shared setup; existing default files are not overwritten, and conflicting files are kept for manual merging.
- Shared accounts refresh their links before a switch; Claude also refreshes MCP and project trust settings. If a refresh fails, a warning explains the issue without blocking the switch.
- **Update CLI** in each tab's Tools row opens a terminal to update Claude Code or Codex. Codex updates also work after switching accounts when the standalone CLI is installed in the default account directory.
- **User guide** and **Star** footer buttons open the GitHub README and repository.
- The extension version is now shown below the footer buttons.

### Changed

- **Sync rules** is now **Sync shared**, and the Command Palette action is **Sync Shared Accounts with the Default Account**. It refreshes shared accounts for the chosen provider and leaves independent accounts untouched.
- Account setup now covers settings, skills and history as well as global rules. Missing shared files and folders are created as needed; existing default files are never overwritten.
- The default account is always displayed as `default` and can no longer be renamed. Previously assigned display names are ignored.

### Fixed

- Accounts whose directories were deleted or renamed outside PlanSwap are removed from the list on startup or refresh, along with their display names.
- Account names and display names can no longer differ only by letter case, such as `Work` and `work`. Automatic discovery follows the same rule.
- Claude now shows an error if you try to switch to an account whose directory no longer exists.
- Sharing a Claude account no longer stops partway through when the default configuration contains a link to a missing file. The account's own file is preserved as `<file>.independent-backup`.
- Sharing an account leaves special files used for process communication in place instead of trying to move them into the shared setup.
- The sharing confirmation now explains where conflicting files are preserved: files inside shared folders get a `.from-<name>` suffix beside the default file; top-level files and Codex thread databases are backed up as `<file>.independent-backup` in the account directory.

## [0.1.2] - 2026-09-26

### Fixed

- Double-clicking an account row's action buttons no longer accidentally switches accounts. Double-clicking the switch button performs only one switch.
- Codex ignores additional switch requests while a confirmation is already open.
- Disabling Codex switching leaves both `~/.bashrc` and `~/.profile` unchanged if either file has an incomplete PlanSwap configuration block.
- Enabling and then disabling Codex switching restores shell-file formatting, including Windows line endings and files without a final newline. Rolling back a failed enable also preserves existing shell-file links.
- Improved Codex configuration checks when setting up an independent account, reducing missed restrictions and false warnings across different configuration formats.
- Fixed garbled display names and failed renaming for accounts named `constructor` or `__proto__`.
- Automatic discovery no longer adds an account whose name matches another account's display name.
- A deleted account directory can be discovered again if you recreate it later.
- The directory-deletion confirmation now shows your chosen display name.
- Opening a linked `CLAUDE.md` or `AGENTS.md` works even when its target file needs to be created.
- Claude email and plan details now display correctly when you explicitly select the default `~/.claude` directory through `CLAUDE_CONFIG_DIR`.
- Closing a sign-in terminal no longer shows a failed-sign-in warning after a successful login.
- Errors shown while adding an account remain visible after the panel refreshes.
- An open version card updates when you change the display language.
- Pressing Enter to select an input-method candidate no longer submits an account name or rename prematurely.
- Reduced the extension's download size.

## [0.1.1] - 2026-09-26

### Fixed

- **Codex switching across editors:** Antigravity and VSCodium keep automatic WSL server restart. VS Code and unrecognized editors now show manual instructions instead: close all windows connected to the distribution, then reopen them. **Restart WSL Server** follows the same behavior.
- Confirmation and restart messages now name your editor instead of always saying "Antigravity".
- Improved editor recognition for older Antigravity releases and home directories accessed through symbolic links.

## [0.1.0] - 2026-09-26

Initial release for WSL/Linux.

### Added

- **Claude Code account switching:** manage separate signed-in accounts from the sidebar. New sessions use the selected account; use **Reload Window** to apply the switch to open panels.
- **Codex account switching:** keep a separate sign-in for each account and switch without signing in again. Enabling asks for confirmation before updating your shell configuration. Switching asks to restart the editor's WSL server, which disconnects WSL windows and closes integrated terminals.
- **Account sidebar:** Claude and Codex tabs with the current account pinned and highlighted, email and plan details, and controls to add, rename, remove or open an account in a terminal. Deleting an account's directory requires a separate confirmation.
- **Display names:** label accounts without changing their directories.
- **Shared global rules:** new accounts use the default account's `CLAUDE.md` or `AGENTS.md`. **Sync rules** applies this to existing accounts.
- **Tools:** open global rules or extension settings, check CLI and extension versions, reload the window, or restart the extension host or WSL server.
- **Automatic discovery** of existing account directories and an **External directory** row for an unregistered Claude configuration directory.
- A **status bar indicator** shows the current Claude account.
- **English and Simplified Chinese**, switchable through `planswap.language` without reloading.
