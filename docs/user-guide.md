# PlanSwap User Guide

**English** · [简体中文](user-guide.zh-cn.md) · [繁體中文](user-guide.zh-tw.md) · [Español](user-guide.es.md) · [日本語](user-guide.ja.md)

PlanSwap lets you keep several Claude Code and Codex accounts signed in and choose which one your editor uses. This guide walks through the sidebar controls, account setup, switching, usage limits and everyday maintenance. Claude and Codex are managed independently: switching one does not switch the other.

Button names below use the English UI. Hover an icon to see its name in your language. The book icon in the footer at the bottom of the panel opens this guide.

## Contents

- [Before you start](#before-you-start)
- [Find your way around the sidebar](#find-your-way-around-the-sidebar)
- [Add and sign in to an account](#add-and-sign-in-to-an-account)
- [Switch Claude accounts](#switch-claude-accounts)
- [Enable and switch Codex accounts](#enable-and-switch-codex-accounts)
- [Choose linked or independent accounts](#choose-linked-or-independent-accounts)
- [Read and refresh usage limits](#read-and-refresh-usage-limits)
- [Rename or remove accounts](#rename-or-remove-accounts)
- [Use the tools](#use-the-tools)
- [Change language and display settings](#change-language-and-display-settings)
- [Troubleshoot common problems](#troubleshoot-common-problems)
- [Disable switching or uninstall](#disable-switching-or-uninstall)

## Before you start

You need:

- A VS Code 1.107+ compatible editor (VS Code, Antigravity IDE or VSCodium). PlanSwap runs in a WSL remote window, on native Windows, on a local Linux desktop or in another remote window. macOS is not supported.
- PlanSwap and the official Claude Code and/or Codex extension installed where that window runs.
- The `claude` and/or `codex` command on the PATH there to sign in from the terminal. Usage checks can also use the CLI bundled with the corresponding official extension when the command is unavailable.
- For Codex switching outside native Windows: Bash as your login shell.

See the [installation instructions](../README.md#install) and [supported editors](../README.md#supported-editors) for setup and how well each editor has been tested.

## Find your way around the sidebar

Click **PlanSwap** in the activity bar, then choose the **Claude** or **Codex** tab.

- **Default account:** your existing configuration, normally `~/.claude` or `~/.codex`. On Windows, `~` means your Windows user profile; in WSL, it means your home directory inside that distribution. If the editor already sets `CLAUDE_CONFIG_DIR`, Claude's default directory follows it.
- **Named accounts:** accounts such as `work` or `personal`, each in its own directory, for example `~/.claude-work` or `~/.codex-work`.
- **External directory:** a directory the editor is currently using that is not in PlanSwap's account list. It cannot be renamed or removed in PlanSwap.
- **Highlighted first row:** the current account. For Codex, this is the account in effect in this window, which can differ from an account you selected that waits for a restart.
- **Link badge:** a linked account, which uses the default account's settings, rules, skills, history and sessions. Its sign-in stays separate.

Terms used in this guide:

- *Sign in* and the **Log in** button mean the same thing; a row that is not signed in shows **Not logged in**.
- *Linked* is the mode the UI shows with the link badge. The **Share with Default Account** command turns an independent account into a linked one.
- For Codex, the *effective* account is the one this window uses now; the *selected* account is the one it will use after the next restart.

Each card shows the account's display name and sign-in state, plus its email, plan and usage limits once they are known. Hover the avatar to see its directory.

Two kinds of refresh buttons:

- The refresh button in the panel title bar rescans both account lists and reloads sign-in information.
- The icons next to **All accounts** check usage limits. See [Read and refresh usage limits](#read-and-refresh-usage-limits).

The footer at the bottom of the panel stays visible on both tabs. Its buttons show versions, open this guide, reload the window, restart the extension host and open the GitHub repository. Your installed PlanSwap version appears below them.

## Add and sign in to an account

For Codex, [enable switching](#enable-and-switch-codex-accounts) first.

1. In the relevant tab, click **+ Add** next to **All accounts**.
2. Enter a name such as `work`. Rules for names:
   - Use letters, digits, underscores or hyphens.
   - `default` is reserved.
   - A name cannot match another account's name or display name in the same tab, ignoring case.
3. Keep **Linked to the default account (recommended)** selected to continue the same work with another account: settings, history and sessions are shared, only the sign-in is separate. Choose **Independent** to keep work and personal apart, starting from a copy of the current settings. See [account modes](#choose-linked-or-independent-accounts) before choosing.
4. Click **Add** or press Enter. PlanSwap creates the account directory, or reuses an existing directory with that name. If it reports files it could not link or copy, read the list: those files stay as they are.
5. Click **Log in** on the new row. A terminal opens; complete the official client's first-run setup and sign-in there. For Claude, you can instead switch to the account and sign in from the Claude Code panel.
6. If the row still shows **Not logged in**, click the refresh button in the panel title bar. Closing the PlanSwap terminal also refreshes the list.

Adding or signing in to an account does not make the editor use it; switch to it when you are ready. Your other accounts stay signed in, so you do not need to sign out of them first. Signing out in a terminal ends the session of that one account.

For a signed-in account, the terminal icon opens the official CLI with that row's account, without switching the editor. Terminal tabs are named `Claude (<label>)` or `Codex (<label>)`.

## Switch Claude accounts

1. Click the **Switch to this account** arrow icon on a row that is not current. You can also double-click the card, or focus it with Tab and press Enter.
2. Confirm **Switch**. New Claude sessions use the selected account. With `planswap.claude.confirmSwitch` off, the switch happens without this dialog.
3. Click **Reload Window** in the banner to move open Claude panels to the new account. Existing sessions keep their old account until you reload.

The Command Palette command **Claude Account: Switch Account** shows an account picker and switches without the confirmation dialog.

Switching changes an editor setting shared by other windows on the same machine, so those windows switch too. Reload each window whose open Claude sessions should use the new account.

## Enable and switch Codex accounts

### Enable once

Open the **Codex** tab and click **Enable Codex switching**. Review and confirm the changes it proposes:

- **WSL, local Linux and other remote windows:** PlanSwap adds marked blocks to `~/.profile` and `~/.bashrc`, then checks that a Bash login shell picks up the selected account. If it reports a conflicting `CODEX_HOME` assignment or shell configuration, fix what it names and try again.
- **Native Windows:** PlanSwap manages your user-level `CODEX_HOME` environment variable. If you set `CODEX_HOME` yourself to another value, enabling is refused. If it already points to a PlanSwap account directory (`~/.codex-<name>`), PlanSwap takes it over.

If the Windows Codex extension is set to run inside WSL, manage its accounts from a WSL window, or turn off `chatgpt.runCodexInWindowsSubsystemForLinux` before managing Windows accounts.

### Select an account and apply it

1. Add and sign in to the account you want.
2. Save your work, then click its **Switch to this account** arrow icon.
3. Read the confirmation and follow the restart instructions for your editor.

| Environment | How the selection takes effect |
| --- | --- |
| Antigravity or VSCodium in WSL | Confirm **Switch and restart**. PlanSwap restarts the editor's WSL server; click **Reload Window** in each disconnected window. If the automatic restart is not possible, follow the manual instructions shown. |
| VS Code in WSL | Confirm **Save selection**. Close all VS Code windows connected to that distribution, wait a few seconds, then reopen them. |
| Other editors in WSL | Confirm **Save selection** and follow the manual restart instructions in the dialog. |
| Native Windows | Confirm **Save selection**, fully quit the editor, then start it again from the Start menu or taskbar. A terminal opened before switching still has the old account. |
| Local Linux or another remote window | Confirm **Save selection**. Then follow the dialog: restart the editor, or the remote server, so it starts with the selected `CODEX_HOME`. |

Restarting a WSL server disconnects its editor windows and closes their integrated terminals and CLI sessions. **Reload Window** or **Restart Extension Host** alone does not apply a Codex account selection.

Until the restart is done, a banner names the selected account, and the highlighted row is still the account in effect in this window. To see the restart steps again, run **Apply Codex Account: Restart or Show Instructions** from the Command Palette (listed under **Codex Account**).

Changed your mind before restarting? Click the arrow icon on the highlighted (effective) row. This cancels the pending selection; no restart is needed.

## Choose linked or independent accounts

| Content | Linked account | Independent account |
| --- | --- | --- |
| Settings, rules and skills | Uses the default account's | Starts with a copy; later edits stay separate |
| Prompt history and sessions | Uses the default account's | Keeps its own |
| Sign-in | Separate | Separate |
| Codex memories | Separate | Separate |
| Codex thread databases | Shared in WSL and on Linux; separate on native Windows | Separate |

Linking does not guarantee that another account can resume a session, especially across different ChatGPT organizations. Do not open the same session from two accounts at once.

Some settings are never linked. Claude: a `settings.json` that supplies or restricts a sign-in (for example an API key, an API key helper or a forced login method) is not linked; the account gets its own copy without that setting, which no longer follows later changes. Codex: a `config.toml` that sets `forced_login_method` or `forced_chatgpt_workspace_id` (which would sign out accounts that sign in differently) or `sqlite_home` is not linked, and the account runs with Codex's built-in settings until you remove that setting and use **Re-link**. The result message names the file and, for Codex, the setting.

For linked Claude accounts, PlanSwap also copies the default account's MCP servers and per-project trust settings into the account. Once the account is signed in, it also copies the default account's first-run status, so Claude Code does not repeat its first-run setup.

### Change an existing account mode

Before converting an account:

1. Switch away from it. For Codex, finish the restart so the account is neither effective nor selected.
2. Close its sessions and its PlanSwap terminal tabs.

Then:

- **Link to the default account:** click the link icon on an independent named row, or run the product's **Share with Default Account** command. The account's own settings and history move into the default account. Files that differ from the default account's are kept side by side for you to merge by hand, and the result lists them.
- **Unlink from the default account:** click the disconnect icon on a linked named row. The account gets its own copy of the default configuration and keeps its sign-in and any files that were not linked. History and sessions stay in the default account and are not copied back. Unlinking does not undo the merge made when the account was linked.
- **Re-link:** click **Re-link** in **Tools** after you change the default account's setup, or when links need repair. It first checks every linked account in that tab without changing anything. If all is well, it says so, and lists anything kept as it is on purpose or by the account, such as a link you pointed elsewhere or the account's own file. Otherwise one notification lists the problems per account, such as missing links or an account that is in use. Click **Repair** to fix what can be fixed; nothing in the default account is overwritten. For Claude, the check also looks for MCP servers and trusted projects that the default account has and the linked account lacks, and **Repair** adds them.
- **Automatic check:** PlanSwap runs the same check in the background when the editor starts and when you return to its window (at most every 10 minutes). It shows the notification only when **Repair** can fix something; an account that is in use, or a link you pointed elsewhere, is listed only when you click **Re-link**. It never repairs anything on its own. The same problems are shown only once, even with several editor windows open, and again after a day if they are still there.

### Linking on Windows

- Linked directories use directory junctions, which work without extra rights.
- Linking single files needs Windows Developer Mode or an editor run as administrator. Without it, PlanSwap offers to copy small configuration files once instead; later edits to those copies stay separate.
- To link them properly later, choose **Open Developer Settings**, turn on Developer Mode, then click **Re-link**. It creates the missing links and turns unchanged copies into links.
- If the account's PlanSwap terminal opens while PlanSwap asks about copying, the conversion stops without changing anything. Close the terminal and try again.
- Codex thread databases (`*.sqlite`) are never linked on Windows, because SQLite there can lose data written through a link. Each account keeps its own, while sessions, history and configuration are still shared.
- PlanSwap cannot tell on Windows which account a running Claude or Codex process belongs to. Close the account's sessions and PlanSwap terminal tabs before linking, unlinking or removing it, even if the CLI has already exited.

## Read and refresh usage limits

Usage bars and percentages show what is **left**; set `planswap.usageDisplay` to `used` in [settings](#change-language-and-display-settings) to show what is used instead. The duration next to each limit, such as `2d 5h`, is the time until it resets. Hover a bar to see both, for example `97% left (3% used)`. A bar turns yellow when 30% or less is left and red at 10% or less, also when it shows what is used; change these levels with `planswap.usageWarningThreshold` and `planswap.usageErrorThreshold`. A used-up limit shows its percentage and reset time in red. No usage line means no data yet, not zero usage or unlimited quota.

Usage checks need a Claude subscription sign-in, or a Codex ChatGPT sign-in (not API key mode). They run the official CLI.

### Refresh from the sidebar

The icons next to **All accounts**:

- **Refresh usage limits of the current account** (refresh icon): checks the current Claude account, or the effective Codex account. Shown when that account can be checked.
- **Refresh usage limits of all accounts** (stacked layers icon): checks every signed-in account in that tab, one at a time, so you can compare them before switching. Each row updates as soon as its check finishes. It never switches accounts, and you can cancel it in the progress notification. Shown when at least one account in the list can be checked.

On the Codex tab, neither icon appears while Codex switching is disabled, or on Windows while Codex runs inside WSL.

The Command Palette has the same actions: **Refresh Claude Usage Limits**, **Refresh Usage Limits of All Claude Accounts**, **Refresh Codex Usage Limits** and **Refresh Usage Limits of All Codex Accounts**.

An account checked less than a minute ago is not checked again. A manual refresh then shows "Usage limits were checked less than a minute ago; try again in N s." Any check counts, including automatic ones; for Claude, so does a check made in another window or terminal. Refresh-all skips such accounts and says how many it skipped.

### Automatic checks

By default, automatic checks cover eligible signed-in accounts of each product, the current Claude or effective Codex account first, then other registered accounts one at a time. The first check is about 20 seconds after activation. While the window is focused, the scheduler looks for due accounts every 120 seconds by default, using a 15-minute freshness threshold per account. Queries may wait in a queue, and fresh caches can avoid a query; this is not an exact 15-minute schedule. Turn on `planswap.usageAutoRefreshCurrentOnly` to limit the account scope, or change the intervals and automatic-check switches in [settings](#change-language-and-display-settings).

Other rows show the result of their last check. Values disappear after their reset time or after 24 hours, and are hidden when the account has since signed in again.

### Recommended account

When the current account’s lowest general remaining percentage is at or below `planswap.sidebar.recommendationThreshold` (default 10%), a green card above the list recommends another signed-in account of the same tab: the one with the most left in its lowest limit, as long as it has more left than the current account and none of its limits is used up. The card shows that account's limits and how long ago they were checked, with **Switch** and **Terminal** buttons, which do the same as the buttons on that account's card (Claude: the usual confirmation follows; Codex: the account is selected and the editor's server restart follows). On the Codex tab no card is shown while a selected account waits for the server restart. Model-specific limits are not compared, and the card never queries anything itself: its figures are as fresh as the last check of that account.

To keep an account out of the recommendations, for example a work account, click the lightbulb icon on its card; click it again to include it. Turn off `planswap.sidebar.showRecommendation` in [settings](#change-language-and-display-settings) to hide the card and the lightbulb icons.

### Status bar

The status bar shows each product's short limit, for example `Claude 97% · Codex 82%`: what is left, or what is used when `planswap.usageDisplay` is `used`. When a longer limit is the one running low, the item shows that one with its length instead, for example `Claude 2% (7d)`, since that figure only recovers days later. Its background turns to the theme's warning color when any general limit, including longer ones, is at 30% or less, and to the error color at 10% or less. You can change these thresholds, show only one product, move the item to the left or hide it ([Change language and display settings](#change-language-and-display-settings)).

Hover it for a table with one header row per product (email, plan and, when the account can be checked, a refresh icon) and one row per general limit. Click it to open PlanSwap. With `planswap.sidebar.showEmail` off, the tooltip uses account labels instead of emails; user-defined names and aliases are unchanged.

## Rename or remove accounts

### Change a display name

Hover or focus a named account and click the pencil next to its name. Type a display name, then press Enter, click the checkmark or click elsewhere to save; Escape cancels.

A display name can contain spaces, can be up to 32 characters long, and cannot match another account's name or display name in that tab. Renaming does not change the directory or the sign-in. The default and external rows cannot be renamed.

### Remove an account

1. Switch away from the account first. For Codex, finish the restart so the account is neither effective nor selected. Close that account's sessions and terminals.
2. Click the trash icon and confirm **Remove** in the row, or use the product's delete command in the Command Palette.
3. A second dialog asks whether to delete the account's directory as well.

If you keep the directory, only the list entry and its display name are removed. PlanSwap stops discovering the account until you add the same name again.

If you delete the directory, its sign-in and everything stored in it are permanently deleted:

- For a linked account, the data in the default account stays; the account's own sign-in, backups and other files that were not linked are deleted. For Codex this includes the account's memories.
- If PlanSwap refuses because the account is in use, close the sessions or processes it names and try again.

Account directories with valid names that PlanSwap finds in your home directory are added to the list automatically when it starts or refreshes.

## Use the tools

**Tools** below the account list holds actions specific to that tab:

| Tool | Action |
| --- | --- |
| `CLAUDE.md` or `AGENTS.md` | Opens the rules file of the current Claude account or the effective Codex account. If the file does not exist, asks before creating it. |
| Claude Settings or Codex Settings | Opens the settings of the official Claude Code or Codex extension (PlanSwap's own settings are behind the gear in the panel title bar). |
| Update CLI | Opens a terminal that runs the product's update command. Follow the progress and any prompts there; if you installed the CLI another way, you may need to update it that way. |
| Re-link | Checks the links of linked accounts in this tab and offers **Repair** for the problems it finds (Claude: also their MCP servers). Shown only when a linked account exists. |

The footer provides:

| Button | Action |
| --- | --- |
| Show CLI and extension versions | Shows or hides a card listing both CLIs and both official extensions. Anything not installed shows **Not found**. |
| User guide | Opens this guide on GitHub. |
| Reload Window | Reloads the current window right away, without asking. |
| Restart Extension Host | Restarts the extension host right away, without asking. |
| Star | Opens PlanSwap's GitHub repository. |

To get a troubleshooting report, run **PlanSwap: Preview Diagnostics Report** from the Command Palette. Read it, then choose **Copy report** if you want to share it. The report refers to accounts by number and leaves out account names, emails, directories and credentials. Nothing is uploaded automatically.

## Change language and display settings

Click the settings icon in the panel title bar, or run **PlanSwap: Open PlanSwap Settings**. The Settings editor groups them as General, Sidebar, Status Bar, Accounts and Advanced; the table follows that order. To find a setting, type its name from the table into the Settings search box. Changes apply immediately:

Accounts keeps the Claude settings together, followed by Codex.

| Setting | Default | Purpose |
| --- | --- | --- |
| `planswap.language` | `auto` | Language for the sidebar, status bar and messages. Command titles follow the editor language. |
| `planswap.usageDisplay` | `remaining` | Show remaining or used percentages in the sidebar and status bar. Colors always follow what is left. |
| `planswap.usageWarningThreshold` | `30` | Warning color when a limit has this percentage or less left. Applies to sidebar bars and the status bar background. Range: 0–100. |
| `planswap.usageErrorThreshold` | `10` | Error color when a limit has this percentage or less left. Applies to sidebar bars and the status bar background; error wins over warning. Range: 0–100. |
| `planswap.usageAutoRefreshCurrentOnly` | `false` | Automatic checks query only the current Claude and effective Codex accounts. When off, other signed-in accounts are checked too. Manual refresh is unchanged. |
| `planswap.notifications.enabled` | `true` | Notify when the current account’s 5-hour or 7-day quota reaches the notification threshold. Once per limit until reset; no notice for an exhausted limit. |
| `planswap.notifications.threshold` | `20` | Notify at or below this remaining percentage. Requires usage notifications to be enabled. Range: 1–99. |
| `planswap.sidebar.shortFormat` | `false` | Use short sidebar limit labels and reset times such as 5d 12h. Full localized explanations remain in tooltips and accessibility text. |
| `planswap.sidebar.showEmail` | `true` | Show emails in the sidebar and status bar tooltip. When hidden, the tooltip uses account labels; names and aliases are unchanged. |
| `planswap.sidebar.showFiveHourLimit` | `true` | Show each account’s 5-hour limit in the sidebar. |
| `planswap.sidebar.showWeeklyLimit` | `true` | Show each account’s 7-day limit in the sidebar. |
| `planswap.sidebar.showModelLimits` | `false` | Show Claude’s model-specific limits below its general limits. |
| `planswap.sidebar.showRecommendation` | `true` | Show account recommendations and the lightbulb buttons used to exclude accounts. |
| `planswap.sidebar.recommendationThreshold` | `10` | Recommend when the current account’s lowest general remaining percentage is at or below this value. Requires recommendations; independent of colors. Range: 0–100. |
| `planswap.statusBar.enabled` | `true` | Show PlanSwap in the status bar. |
| `planswap.statusBar.products` | `both` | Services shown in the status bar. Affects text, tooltip and color only; automatic checks continue. |
| `planswap.statusBar.alignment` | `right` | Place PlanSwap on the left or right of the status bar. |
| `planswap.claude.confirmSwitch` | `true` | Claude: ask before switching accounts from the sidebar. Codex always asks. |
| `planswap.claude.usageAutoRefresh` | `true` | Claude: automatically check usage while this window is focused. Account scope follows `planswap.usageAutoRefreshCurrentOnly`. Manual refresh stays available. |
| `planswap.claude.usageRefreshMinutes` | `15` | Claude: minutes before cached usage or the last check is due for automatic refresh. Requires automatic refresh; not an exact schedule. Range: 10–1440. |
| `planswap.codex.usageAutoRefresh` | `true` | Codex: automatically check usage while this window is focused. Account scope follows `planswap.usageAutoRefreshCurrentOnly`. API key accounts are skipped; manual refresh stays available. |
| `planswap.codex.usageRefreshMinutes` | `15` | Codex: minutes before cached usage or the last check is due for automatic refresh. Requires automatic refresh; not an exact schedule. Range: 5–1440. |
| `planswap.usageCheckIntervalSeconds` | `120` | Seconds between checks for accounts due for automatic refresh. Each account’s refresh age is set under Accounts. Range: 30–600. |
| `planswap.claude.usageTimeoutSeconds` | `30` | Claude: seconds before a usage query times out. Applies to automatic and manual refreshes. Range: 10–120. |
| `planswap.codex.usageTimeoutSeconds` | `15` | Codex: seconds before a usage query times out. Applies to automatic and manual refreshes. Range: 5–120. |

With automatic checks off, the refresh icons and commands still work. The email setting also controls the status bar tooltip. Colors use the shared General thresholds; recommendation and sidebar limit visibility settings do not affect the status bar. Command Palette titles and the sidebar's name follow the editor's display language, not `planswap.language`.

## Troubleshoot common problems

| What you see | What to check |
| --- | --- |
| Claude still uses the previous account | Reload the window to move open Claude panels to the new account. Check for a PlanSwap warning that environment credentials or provider settings override the account's sign-in. |
| Codex shows a pending selection | Finish the restart for your environment. Reloading the window does not replace restarting the editor or the WSL server. |
| Codex switching cannot be enabled | Read the listed shell or `CODEX_HOME` conflict. On Windows, check whether Codex is set to run inside WSL. |
| An account still says **Not logged in** | Sign in with that row's **Log in** button, then refresh. A Codex sign-in kept only in the operating system's keyring cannot be detected, because PlanSwap looks for the account's `auth.json`. |
| Two accounts trigger a duplicate sign-in warning | Both are signed in to the same account and workspace, so switching between them does not give you separate limits. Sign in to the intended identity in one of them. |
| No usage bars, or a check failed | Check that the account has a subscription (Claude) or ChatGPT (Codex) sign-in and that the `claude` command is installed (Claude). Refresh by hand and read the failure message; if it reports a cooldown, wait before retrying. If it says the CLI did not answer in time, raise `planswap.claude.usageTimeoutSeconds` or `planswap.codex.usageTimeoutSeconds`. |
| Settings or history are not shared as expected | Check the link badge and the conversion or Re-link result. Some files stay separate or need merging by hand; on Windows, check whether file links are available. |
| A list looks outdated | Click the refresh button in the panel title bar. Changes made in another window appear after a refresh. |

### Sign-ins that apply to every account

These take precedence over every account's own sign-in, so switching has no effect on Claude while one is set. PlanSwap warns when it sees one in the environment:

- an API key, auth token or long-lived OAuth token: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`;
- a named Anthropic profile (`ANTHROPIC_PROFILE`) or the federation variables (`ANTHROPIC_FEDERATION_RULE_ID` with `ANTHROPIC_ORGANIZATION_ID`);
- a cloud provider setting: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`.

A Claude Console sign-in without an API key is stored outside the account directories (`~/.config/anthropic`, on Windows `%APPDATA%\Anthropic`) and signs out every claude.ai login on the machine, so it cannot be kept per account ([Claude Code authentication](https://code.claude.com/docs/en/authentication#sign-in-without-an-api-key)).

### OneDrive on Windows

PlanSwap warns when your user folder is synced by OneDrive. OneDrive sync is known to corrupt Claude Code's `.claude.json`, and every account directory is inside that folder.

For other limits, such as continuing another account's session, see [known limitations](../README.md#known-limitations). See [privacy](privacy.md) for what PlanSwap reads, stores and sends.

## Disable switching or uninstall

1. Switch Claude back to `default` and reload the window.
2. If Codex switching is enabled, run **Disable Codex Account Switching** (under **Codex Account** in the Command Palette) and confirm. This removes PlanSwap's shell blocks (or, on Windows, its user-level `CODEX_HOME`) and clears the selection. Open windows keep the old account until you restart them as described in [Select an account and apply it](#select-an-account-and-apply-it).
3. Uninstall PlanSwap from the Extensions view if you want.

Account directories are kept. To also clear PlanSwap's saved account lists, display names and usage records, see the [uninstall instructions](../README.md#uninstall). This does not touch the accounts' own files.
