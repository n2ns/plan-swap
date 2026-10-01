# Features

Purpose: the detailed user-visible behavior of both Claude and Codex account switching, panel interactions, commands and localization. UI texts are quoted in English; the other supported languages show the equivalent localized strings (see section 11). Design rationale belongs in [Claude design](design.md) / [Codex design](codex-design.md), signatures in [Interfaces](interfaces.md) / [Codex interfaces](codex-interfaces.md), and test procedures in [Manual Verification](manual-verification.md). See [Documentation](README.md) for ownership.

## 1. Accounts and directories

| Account | Directory | Notes |
|---|---|---|
| `default` | `~/.claude`; if the extension host environment already has `CLAUDE_CONFIG_DIR`, that value wins | Always exists, cannot be removed |
| `<name>` | `~/.claude-<name>` | Created with "Add account", or registered by auto-discovery |

- The account list is stored in the state file `~/.config/planswap/state.json` under the `accounts` key (the file follows the WSL distribution; it is not stored in VS Code's `globalState`, which is kept on the Windows side and shared by every distro; data of an earlier version is imported from `globalState` once, on the first activation without the file); only non-default accounts (`{ name, dir }`) are stored, and the default account is always prepended at runtime. A named account whose directory no longer exists (deleted or renamed outside the extension) is removed from the list on activation and on refresh (see section 5).
- Account names and display names are compared **ignoring case** when checking for duplicates (`Work` and `work` clash); accounts registered before this rule are left as they are.
- The **current account** is determined solely by the `CLAUDE_CONFIG_DIR` entry in `claudeCode.environmentVariables`:
  - Both the array form `[{ "name": ..., "value": ... }]` and the object form `{ "KEY": value }` are accepted. As in the Claude extension (2.1.284), the last entry whose name is `CLAUDE_CONFIG_DIR` (case-insensitive on Windows) and whose value is an absolute path string (on Windows with a drive letter or a UNC path) counts; empty, relative and non-string values are skipped.
  - No entry → the current account is the default account.
  - Such an entry present → the current directory is its value (compared after `path.resolve`).
  - The value does not correspond to any registered account (e.g. set by hand) → an "External directory" ("外部目录") row is appended to the list and marked current (pinned to the first row and highlighted).
- Email and plan come from `oauthAccount` in the account info file (usually `<dir>/.claude.json`, see section 6): the email is `emailAddress`; the plan is formatted from `organizationType` and `organizationRateLimitTier` (`claude_max` → `Max`, `claude_pro` → `Pro`, `claude_team`/`team` → `Team`, `claude_enterprise`/`enterprise` → `Enterprise`, other values lose the `claude_` prefix and are capitalized; a trailing `_<n>x` of the tier becomes `<n>x`; combined as e.g. `Max 20x`; nothing is shown when both are empty). Read-only, never copied. A missing, half-written or unparsable file counts as "unknown" without an error.
- Signed-in state: an email is the primary criterion; without an email, an existing `.credentials.json` also counts as signed in (only the file's existence is checked, its content is never read).
- **Same sign-in warning**: when two registered accounts of a vendor (default included) are signed in to the same account and organization/workspace, a warning names them: "{vendor} accounts {labels} are signed in to the same account and workspace. Switching between them does not give separate usage limits; sign one of them in with a different account." It appears once per situation per window session, at activation or when account info changes. Claude compares `oauthAccount.accountUuid` + `organizationUuid`; Codex see 10.1. Nothing of this comparison is shown or stored ([Claude design 6.8](design.md#68-accounts-signed-in-to-the-same-identity)).
- **Environment warnings** (at activation, once per window; "Don't Show Again" stores the warning id in `state.json` under `warnings.dismissed`): (1) when Claude Code started by this editor would see a variable that outranks the sign-in of the selected account folder (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`, or both federation variables), in the extension host environment or in `claudeCode.environmentVariables`, the warning names them and says switching does not change the credential; only names are read, never values. The id includes the names, so a newly set variable is pointed out again. (2) Windows: when the home folder is inside a OneDrive root (`%OneDrive%`, `%OneDriveCommercial%`, `%OneDriveConsumer%`), a warning that OneDrive sync has corrupted `.claude.json` and suggests moving the profile or excluding the `.claude*` / `.codex*` folders. (3) When `CLAUDE_CONFIG_DIR` or `CODEX_HOME` has spaces at the start or end of its value: the CLIs use it as is, so they work in a folder whose name starts or ends with a space, which Windows programs and PlanSwap may not open.
- **Shared and independent accounts**: every named account is either **shared** (everything except its login identity is symlinked to the default account's directory, so settings, rules, history and sessions carry over when you switch, e.g. because one account ran out of quota) or **independent** (the default account's configuration is copied once when the account is created; history and sessions stay separate). The choice is made when adding (see 2.5); an independent account can later be linked to the default account (see 4.6), and a shared account can be made independent again (see 4.7). The mode is never stored: an account is shared when its `projects` entry is a symlink resolving to the default directory's `projects` (details in section 5). User-facing term: the UI calls a shared account a "linked account" ("链接账号"); the code and these documents keep "shared" as the internal term.
- **Account display names (aliases)**: every named account can have an alias; the default row and the external-directory row cannot (the default account is always shown as `default`, and an alias stored for it by an earlier version is ignored). Aliases are stored by account name in the state file under `claude.labels` (`Record<account name, alias>`); no entry means not set (the account name itself is shown). Aliases are display-only (sidebar, status bar, QuickPick, messages, terminal names); the directory and internal name do not change, and logic still uses the internal name and directory. How to set one: see 2.7; removing an account also clears its alias.

## 2. Sidebar

- Setting `planswap.sidebar.showModelLimits` (boolean, default `false`, scope `application`): show Claude's model-specific usage windows in the sidebar below the general windows (shown directly, not folded). Changing it updates the sidebar at once.
- Settings `planswap.sidebar.showEmail`, `planswap.sidebar.showFiveHourLimit` and `planswap.sidebar.showWeeklyLimit` (boolean, default `true`, scope `application`): show each row's email line, its general 5-hour window and its general 7-day window in the sidebar, on both pages. With the email off, a row shows no email and no "Logged in" line (the plan tag stays); a row whose every window is hidden shows no usage block. Model-specific windows follow `planswap.sidebar.showModelLimits` only. The status bar and its tooltip are not affected. Changing any of them updates the sidebar at once.
- Settings `planswap.claude.usageAutoRefresh` / `planswap.codex.usageAutoRefresh` (boolean, default `true`, scope `application`) and `planswap.claude.usageRefreshMinutes` / `planswap.codex.usageRefreshMinutes` (number, default `15`, minimum `10` for Claude and `5` for Codex, maximum `1440`, scope `application`; a value outside the range is clamped): automatic usage limit checks of each product and their interval, independent of each other. Turning automatic checks off stops the first check after activation, the periodic and on-focus checks, the check after a Claude account switch and the checks after a sign-in change (Claude: an info-file change; Codex: the effective account's `auth.json` change); manual refreshes (refresh and refresh-all buttons, Command Palette, tooltip link) always work and shown values stay, except that the Codex tooltip drops the effective account's values once its `auth.json` belongs to another identity or is signed out (a token refresh keeps them). A changed setting applies at once: turning checks on or shortening the interval checks right away when due.
- The view title bar shows a Settings gear before Refresh. It runs `planswap.openSettings` to open the Settings UI filtered to `@ext:n2ns.planswap`.
- A new account icon in the activity bar (container id `planswap`, title "PlanSwap" / "PlanSwap") containing **one** view, also named "PlanSwap" (view id `planswap.accounts`). These names follow VS Code's display language (see section 11).
- The sidebar is a Webview panel (changed from a native TreeView to a Webview); UI components come from @vscode-elements/elements, icons from @vscode/codicons; all colors follow the editor theme.
- **Tab bar**: two tab buttons at the top of the panel, Claude / Codex (segmented control style); the selected one is highlighted, and a click switches the page. The Claude page is what this section and sections 3–8 describe; the Codex page is in section 10. The frontend remembers the current tab (in the Webview's own state) and tells the host through a `setTab` message; the host stores it in the memento key `panel.activeTab` (default `claude`); the frontend only adopts the host's pushed `active` when it has no record of its own. The Command Palette's "add account" commands first switch to the corresponding tab, then expand the add-account form and focus the input.
- Each page contains, from top to bottom: banner (only when needed), all accounts list (the current account pinned to the first row and highlighted) whose heading carries usage refresh icon buttons ([Usage refresh buttons](#usage-refresh-buttons)) and a "+ Add" button that opens the add-account form (see 2.5), and a collapsed "Tools" section (see 5.5); the add inputs of the two pages keep independent state.
- Outside the tab pages, a toolbar shared by both pages and a separate extension version line below it are pinned to the bottom of the panel (see 5.5), with the content area scrolling above them; the version card, when expanded, sits directly above the toolbar.
- While the first account state is loading, the panel shows "Loading accounts…" instead of an empty account list or a disabled-Codex message.
- The default account row always exists once account data is loaded.

### 2.1 Reload banner

- Only shown at the top of the panel when an account was switched in this window and the window has not been reloaded yet.
- Content: title "Switched to <account name>"; explanation "New sessions use the new account; open sessions still use the old one. After reloading, all panels start over with the new account."
- Button **Reload Window**: reloads the window immediately.
- Close button at the top right: only hides the banner, no reload.
- Another switch updates the banner to the new account name; the banner disappears after reloading the window.

### 2.2 Current account row

There is no separate "current account" card and no top card. The current account is pinned to the first position of the list and shown with a restrained emphasis: a flat slightly lighter surface, a plan-colored outline, a 3px plan-colored accent bar on the left, and a slightly larger bold name. It has no shadow, no gradient and no badge or text tag; the row carries `aria-current="true"` for assistive technology instead. Its directory is not a card line: every row shows its directory (home directory as `~`) as the hover tooltip of the card.

The plan color is shown only on the current card (outline and accent bar); plan tags are a neutral outline on every card. The tiers of both vendors by price level, so different names map to the same color (the frontend maps the plan text to `data-plan`, and CSS picks the color; light and dark themes each have a set of values):

| Tier | Claude | ChatGPT / Codex | Color |
|---|---|---|---|
| Free | — | Free, Go | Neutral gray |
| Standard paid | Pro | Plus | Blue |
| Premium | Max (not 20x, e.g. Max 5x) | Pro Lite | Champagne gold |
| Top | Max 20x | Pro | Amber |
| Team | Team | Team, Business | Teal |
| Enterprise | Enterprise | Enterprise | Slate |
| API key | — | API key | Orange |

Rows without a plan (signed out or unknown) use the normal outline. The plan tag is a 4px rounded pill (light background + plan-colored outline and text), distinct from the capsule-shaped "Not logged in" tag. The current badge always uses the accent color and does not follow the plan.

### 2.3 All accounts list

Title "All accounts"; the count badge next to it shows the number of rows (including the external-directory row).

Each row shows:

| Position | Content |
|---|---|
| Avatar | Uniform flat 20px circle with the first letter of the display name (uppercase), `?` for the external directory, and a `home` icon instead of the letter for the default row (title "Default account"); the background is a theme chart color fixed per account name, so the same name always gets the same color; the avatar sticks to the top when the name spans several lines |
| Name | Display name, bold; the external-directory row shows "External directory"; its tooltip is the row's directory (home directory as `~`) |
| Shared badge | Shared accounts have a 16px flat round `link` badge right after the name (title explains that linked content is shared with the default account while some files may remain independent); independent accounts, the default row and the external-directory row have none |
| Email | The email (secondary text color, one contrast step above the muted color) when available; "Logged in" with a green dot when signed in without email; no line when signed out without email |
| Tag group | Plan tag (when there is a plan; neutral outline on every card, see 2.2); a "Not logged in" capsule tag when signed out |
| Usage | Subscription sign-ins with a cached usage observation show it like a Codex row (see [Claude usage limits](#claude-usage-limits)); no line otherwise |
| Sign-in hint | Rows that are signed out and not current additionally show `Click "Log in" to log in from a terminal, or switch and log in from the Claude panel` |
| Hover tooltips | The card (outside the usage block and the buttons) shows the row's directory; the usage block shows its collection time; buttons and badges have their own tooltips; emails and plan tags have none. No tooltip while the name is being edited |

Adaptive layout (flex wrapping, no width breakpoint):

- Only the name line has the avatar; the lines below it (email, usage, buttons, hints) start at the card's left padding and span its whole width.
- The tag group (plan tag, "Not logged in") sits at the right end of the name line and wraps onto the next line, still right-aligned, only when it does not fit beside the name; below come the email, the usage and the button group (Switch / Log in at the left, other icon buttons at the right); a row without Switch / Log in (e.g. the current signed-in row) puts them on the name line, left of the tag group, instead of a line of their own, so the plan tag is always at the right end; empty areas take no space.
- Wrapping: names, emails, directories and hint texts that do not fit break anywhere (`overflow-wrap: anywhere`), with no horizontal scrolling; plan tags are single-line with ellipsis; the tag group itself can wrap.

The current row has the flat raised background, the plan-colored outline and the left accent bar; other rows use the normal surface color with a neutral outline (`--line-strong`, stronger on hover). Cards have 4px corners. Plan tags are a neutral outline on every row, the current one included.

The Log in text button is always fully visible; all icon buttons, including Switch, are slightly dimmed until mouse hover or row focus. Switch / Log in and the other actions are two groups; when they do not fit side by side, the icon group wraps onto a second line as a whole, still right-aligned:

| Button | Action | Shown when |
|---|---|---|
| `arrow-swap` icon button (title and accessible name "Switch to this account", no visible text; same 24px toolbar style as the other icons) | Switch (see 4.1) | Non-current rows; the primary action, first in the group |
| `terminal` run claude with this account in a terminal | Open terminal (see 4.4) | Signed-in rows (including the external-directory row) |
| Text button "Log in" | Opens a terminal running claude to sign in (see 4.4) | Signed-out rows (including the external-directory row), primary style |
| `trash` remove account | Enters the inline remove confirmation (see 4.3) | Only rows that are not default, not external and not current |
| `link` "Link to the default account: its settings, rules, skills, history and sessions move into the default account and are linked from then on; the login stays separate" | Converts the account into a shared one after a modal confirmation (see 4.6) | Independent named accounts that are not current |
| `debug-disconnect` "Unlink from the default account: the links are removed and the account gets its own copy of the default configuration; history and sessions stay in the default account" | Converts the account back into an independent one after a modal confirmation (see 4.7) | Shared named accounts that are not current |

Other interactions:

- Double-clicking a non-current row, or focusing a non-current row with Tab and pressing Enter, also switches to that account (after the same confirmation as the Switch button); a double-click on the Switch button itself sends only one request, and a card double-click within 500 ms of a Switch click is ignored.
- Rename: a small pencil icon right after the name (after the link badge) of named account rows only (not the default row or the external-directory row). It appears when the row is hovered or has focus and enters inline rename (see 2.7). It stays on the last line of a wrapped name, together with the name's last character. While hidden it takes no room, so it never pushes the tag group onto the next line.
- A single click on the row does nothing, to avoid accidental actions; the current row is not focusable.

### 2.4 Inline remove confirmation

After clicking a row's remove button, the row turns into a confirmation area in place:

- Text "Remove <account name> from the list?";
- Hint "You will be asked separately whether to delete the account directory.";
- Buttons **Remove** / **Cancel**. Remove continues with the steps in 4.3; Cancel restores the row.
- If the account disappears from the list during the confirmation (e.g. removed elsewhere), the confirmation is cancelled automatically.

### 2.5 Add-account section

The form is collapsed by default. A small "+ Add" toggle (the `add` icon and the word "Add", `aria-label`/title "Add account", `aria-expanded`) sits at the right end of the list heading. Clicking it opens the form directly under the heading and focuses the input; clicking again collapses it. Escape in the input collapses the form (the typed text is kept) and returns the focus to the toggle. The host's focus-add request (Command Palette add commands) opens the form and focuses the input. A successful add collapses it, clears the input and returns the focus to the toggle; a failed add keeps it open with the reason. The form is created once per page, so list refreshes keep its text and focus.

Inside the form (the surface-colored box under the heading, no title of its own):

- An input (placeholder "Account name, e.g. work") and an **Add** button (with the `add` icon) joined as a group; below it a checkbox "Link to the default account's settings and history" (checked by default; its state is kept per page across list refreshes, like the typed text) and one help line.
- Typing is validated live with immediate hints (details in 4.2): an invalid name turns the input red and the help line shows the reason; the add button is disabled while the input is empty, invalid, being submitted, or showing an add failure reported by the extension. The disabled state still looks like a button: accent color mixed 40% with the input background + accent outline, text and plus sign still readable (dark accent text in light themes); the enabled state is solid accent, brighter on hover, with a glow ring on focus.
- The help line shows "Each account uses its own config directory ~/.claude-<name>" while the input is empty; for a valid name it follows the checkbox: "Will create ~/.claude-<name> linked to the default account's settings, rules, skills, history and sessions" (checked; on the Codex page "Will create ~/.codex-<name> linked to the default account's settings, rules, skills, history, sessions and thread databases (memories stay per account)"; on Windows the help explicitly keeps memories and thread databases per account) or "Will create ~/.claude-<name> with a copy of the default configuration, independent from then on" (unchecked).
- Enter or the add button submits. On success the input is cleared; on failure the reason is shown in the help line and stays (also across list refreshes) until the input is edited or the display language changes.
- List refreshes do not affect the text already typed into the input or its focus.

### 2.6 Title bar button

Only one: `$(refresh)` refresh (`planswap.refresh`), which refreshes both the Claude and the Codex page.

### 2.7 Inline rename

After clicking the pencil icon after the name of a named account row, the row's name turns into an input (prefilled with the current display name, fully selected); the edit state is keyed by the row's directory (`dir`), and only one row per page can be in edit state at a time. Edit state styling: the row outline turns to the accent color; the name line is wrapped in an opaque editor-background layer, the input uses the theme input background + accent outline and bold text, with a 1px outline plus a 3px glow when focused; when validation fails the outline and glow switch to the error color and the reason is shown in red inline. In edit state the row hides its button group, and a save button (check icon) follows the input. The card keeps its height: the button group keeps its space while invisible, and the input takes the height the name had (the tag group is hidden while editing).

- Enter, the save button and losing focus all save: they submit `rename` (with `mode`, the row's `dir` and the new display name `label`). An unchanged name just leaves edit mode; an invalid name stays in edit mode with the reason shown (losing focus does not discard the typed text). Esc cancels and restores the row.
- The extension first looks the row up by `dir` among the page's account rows and only accepts named accounts (the default row and the external-directory row cannot be renamed), then validates (the extension is authoritative, the frontend only gives immediate hints); on failure the reason is shown in red inline:
  - empty after trim: "Enter a display name";
  - more than 32 characters: "Display name can be at most 32 characters";
  - contains a line break: "Display name cannot contain line breaks";
  - equals the external-directory name (in any supported language): "Cannot use the reserved name <value>";
  - same as the account name of another account on this page: "Same as an existing account name";
  - same as the display name of another account on this page: "Same as an existing account's display name".
  Both duplicate checks ignore case. The account itself is excluded from the checks, so entering its own account name or current alias passes; the same name is allowed across the Claude and Codex pages.
- When valid, the alias is written to the state file by account name (entering the account's own name clears the alias), the panel and the status bar are refreshed, and edit state ends; the list, the status bar and the QuickPick show the new alias right away.
- The directory and internal name do not change; the `default` row still cannot be removed.

## 3. Status bar

- On the right it shows `$(dashboard) Claude 97% · Codex 82%`: the product names with what is left of each product's **short window** (the general, not model-specific, window with the shortest duration, normally the 5-hour one; without durations, the first general window), `100 - usedPercent` rounded down (en "{product} {percent}%", the same in every language). No account name or alias appears in the text. A product without a displayable figure shows its name only: Claude signed out, not a subscription or without a usable cache (nothing cached, older than 24 hours or all windows reset); Codex signed out, an API key account, run inside WSL, without a usage result yet, a failed query or an observation older than 24 hours. Windows past their reset time are ignored. A vendor without local configuration is omitted and the item is hidden when neither is present. The `dashboard` icon (a gauge) replaces the former `account` icon, because the text is now a quota reading rather than an account label. The item's name is "PlanSwap" and its screen reader label spells the figures out ("PlanSwap: Claude 97% left, Codex 82% left").
- **Warning color**: the background follows the lowest remaining percentage among *all* general windows of both products, long windows included (model-specific windows are never counted): 10% or less uses the status bar error background, 30% or less the warning background, otherwise none (the only two background colors VS Code allows). So when the 7-day window is used up while the 5-hour window still has room, the text shows the 5-hour figure on an error background; the tooltip's usage table shows the used-up window.
- **Tooltip**: one compact Markdown table for all displayed products, so the bars, percentages and reset times of Claude and Codex line up in the same columns. Each product is a group of rows:
  - header row: the email at the left (the first product's header is the table header; the next product's header row is bold, which marks where it starts) and the plan at the right, followed by a `$(refresh)` link (hover text "Refresh usage limits") that refreshes that product's usage (for example `me@example.com` … `Max 5x ⟳`); the link appears only when the product shows usage (Claude subscription sign-in, Codex signed in without API key and not run inside WSL). Without an email the left cell falls back to "API key" for a Codex API key account (no plan is added), to the account label for a sign-in without an email, or to the "Not logged in" text; a block without a plan leaves the right cell empty;
  - one row per general usage window, from the shortest to the longest: its name (`5h`, `7d`), a 10-cell bar of the remaining share (`██████░░░░`, two glyphs of the same Unicode block so every bar has the same width; a window with anything left shows at least one filled cell), the remaining percentage (`58%`) and the time until the reset as `$(clock)` plus a short duration in the UI language (`2h`, `5h 20m`, `2d 5h`; see [Codex account usage observations](#codex-account-usage-observations)). All figures are remaining values; "used" never appears. A window with nothing left shows `0% $(warning) Used up` ("已用完", as on the sidebar). A product without any window row has its header row only;
  - Claude's model-specific windows are omitted from the tooltip and never affect the text or the background color;
  - after its window rows, only when relevant, one short italic status row each (text in the first column): "Checking usage limits…"; "Usage check failed" (one text for every failure reason; Claude only for the current directory's failure, and "Checking" takes precedence); the Codex "Pending: <account> (restart required)" and "runs inside WSL" notes; "Usage limit reached" (Codex).
  There is no account name, product name, plan line, collection time, directory or lowest-remaining line in the tooltip; besides the refresh link after the plan, usage can be refreshed from the sidebar buttons and the Command Palette, see [Claude usage limits](#claude-usage-limits) and [Status bar account summary](#status-bar-account-summary). Everything that comes from outside (emails, plans, model names, error details) is escaped, so it can never become a link, icon or formatting; the tooltip trusts only the two refresh commands (`planswap.claude.refreshUsage`, `planswap.codex.refreshUsage`).
- A click opens the "PlanSwap" sidebar.
- It updates at the same times as the sidebar (see section 6), and also immediately when `planswap.language` changes.

## 4. Commands

All eight commands appear in the Command Palette in the category "Claude Account" ("Claude 账号"). Buttons, double-clicks, inputs and other actions in the panel send messages directly to the extension to run the corresponding flow, without going through the Command Palette; when a command that needs an account (switch, share, remove, open terminal) is run from the Command Palette, a QuickPick asks for the account first (each item shows the display name, the email or the correct "Logged in"/"Not logged in" state, and the directory); when there is nothing to pick, "No accounts to choose from." is shown. Messages and terminal names always use the account's display name.

### 4.1 Switch account `planswap.switchAccount`

Entry points:

- Panel: the `arrow-swap` button of a non-current row; double-clicking a non-current row; focusing a non-current row and pressing Enter.
- Command Palette: a QuickPick of registered accounts that are not current (the external directory is not included).

Flow:

1. The target already is the current account → return without doing anything. A named target whose directory does not exist → error "Account directory does not exist: <dir>", nothing is changed.
   From the panel, a modal confirmation comes first: "Switch the Claude account to X? New sessions will use it; sessions already open keep the current account until the window is reloaded." with the button "Switch" (Chinese: "将 Claude 账号切换到 X？…" / "切换"); cancelling does nothing. The Command Palette pick has no extra confirmation.
   When the target is a shared account, its links are first re-created or repaired and the default account's `.claude.json` is mirrored into it (as "Re-link" does, see section 5); anything that needs attention (entries kept as the account's own, entries not linked for safety, errors) only shows the warning "Re-linking X to the default account reported: …", and the switch still happens.
2. Read `claudeCode.environmentVariables` and build a **new array**: keep all other entries, remove every `CLAUDE_CONFIG_DIR` entry; when the target is not the default account, append `{ "name": "CLAUDE_CONFIG_DIR", "value": "<absolute path>" }`. The path contains no `~` and no trailing slash. When the original value is in object form, it is written back as an array.
3. Write with `ConfigurationTarget.Global`. In a WSL window this writes to the WSL remote Machine settings.
4. When the write fails, an error is shown: "Switch failed. Possible causes: the official Claude Code extension is not installed on the WSL side, or the remote settings.json has a syntax error. Original error: <error>"
5. After a successful write **no notification is shown**: the reload banner appears at the top of the panel (see 2.1), and the status bar updates immediately.
6. If the sidebar panel is not visible at that moment (never opened or hidden), a notification is shown instead: "Switched to X. New sessions will use this account; sessions already open are still using the old account.", with the button **Reload Window**. Opening the panel later still shows the banner.
7. After switching to a signed-out account, the official panel shows its sign-in screen automatically and you can sign in directly (paste code under WSL).

After the official extension sees the `CLAUDE_CONFIG_DIR` change, it refreshes the account display of all panels about 1 second later; this is the official extension's own behavior.

### 4.2 Add account `planswap.addAccount`

Entry point: the add-account input at the bottom of the panel (see 2.5). The Command Palette's "Add Account (Focus Sidebar Input)" only opens the sidebar and puts the focus into that input; it does not show an input box.

Flow:

1. Type the account name into the input. The panel validates live with immediate hints:
   - only letters, digits, underscores and hyphens (`^[A-Za-z0-9_-]+$`);
   - the reserved name `default` cannot be used;
   - must not equal the account name or display name of an account already in the list.
   The reserved-name and duplicate checks ignore case.
2. After submission the extension validates the name with leading/trailing whitespace removed once more (the extension is authoritative); on failure the reason is shown in the help line:
   - empty: "Enter an account name";
   - invalid characters: "Only A-Z, a-z, 0-9, underscores (_) and hyphens (-) are allowed";
   - equals `default`: "Cannot use the reserved name default";
   - same as a registered account: "An account with this name already exists";
   - same as the current display name of any account on this page: "Same as an existing account's display name";
   - its directory is the same as the default directory: "This account directory is the same as the default account directory";
   - its directory contains the default directory after resolving links: "Cannot use {dir} as an account: it contains the default account directory {default}."
   The `default`, existing-name and display-name checks ignore case (`Default`, `WORK` for an account `work`).
3. The directory `~/.claude-<name>` is created (mode 0700) if it does not exist; an existing one is reused as is, without clearing.
4. Depending on the checkbox (see "Shared and independent accounts" in section 5):
   - **shared** (checked): every shared entry is linked to the default directory (missing entries are first created empty in the default directory) and the default account's `.claude.json` is mirrored into `<new dir>/.claude.json`; when something could not be linked, the warning lists the linking issues without claiming that the account is already linked;
   - **independent** (unchecked): the default account's configuration is copied once (stripped `settings.json`, `CLAUDE.md`, the configuration folders, the `skills` children and the user-level MCP servers).
   `.credentials.json` is never read, copied or linked. A failure of this step only shows the warning "Account X was created, but linking it to the default account failed: …" / "Account X was created, but copying the default account's configuration failed: …" and does not block.
5. If creating the directory fails (e.g. a regular file with the same name exists, or permissions are insufficient), the help line shows "Failed to create account directory: <reason>" and the account is not registered.
6. The account is registered in the list (the directory is removed from the ignore list if it was there), the panel and the status bar are refreshed, and an account info file watcher is added for the directory.
7. The input is cleared and the new account appears in the list. No follow-up message is shown after adding; to sign in, click the row's terminal button, or switch to the account and sign in from the official panel.

### 4.3 Delete account `planswap.removeAccount`

Entry points:

- Panel: the `trash` button of a row that is neither default nor external, via the inline confirmation (see 2.4).
- Command Palette: a QuickPick of non-default accounts.

The default account and the external directory cannot be removed.

Flow:

1. First confirmation:
   - panel entry: clicking **Remove** in the inline confirmation goes straight to the next step, without another dialog;
   - Command Palette entry: a modal confirmation "Delete account <account name>?" with the button **Delete**.
2. The current account cannot be removed: in the panel the current row has no remove button, and the Command Palette list does not contain the current account. To remove the current account, switch to another account first.
3. The account is removed from the list, its alias (if any) is cleared, the directory's file watcher is released, and the panel and the status bar are refreshed.
4. Deleting the directory is always confirmed again with a system modal (regardless of the entry point): "Account <account name> was removed from the list. Also delete directory <dir>?", with the button **Delete Directory**. The detail text: the directory contains the sign-in credentials and session history and cannot be recovered after deletion; and if you just switched away from this account without reloading, open sessions are still using this directory. For a shared account the detail reads instead: "Linked data in the default account will be kept. This account directory and everything stored locally in it, including login credentials, per-account memories, backups and other unlinked files, will be permanently deleted."
5. After confirmation, the safety checks run first (see section 7); if they pass the directory is deleted and removed from the ignore list again (so a directory recreated later with the same name is auto-discovered); if they fail or deletion errors, "Failed to delete directory: <reason>" is shown.

If you choose not to delete the directory, it stays on disk and is recorded in the ignore list, so auto-discovery will not register it again. Typing the same name into the add-account input later registers it again and removes it from the ignore list.

Deleting the directory of a shared account removes only its own files (credentials, `.claude.json`, account-only entries) and its symlinks; `fs.rm` does not follow symlinks, so the shared settings, history and sessions in the default directory are kept.

### 4.4 Run claude in a terminal as an account `planswap.openTerminal`

Entry points:

- Panel: the `terminal` button of every row (including the external-directory row).
- Command Palette: a QuickPick of registered accounts, also including the external directory when it is current.

Flow:

1. Create a terminal named `Claude (<account name>)`; for non-default accounts `CLAUDE_CONFIG_DIR=<dir>` is set in the terminal environment.
2. Send the command:
   - non-default account: `env CLAUDE_CONFIG_DIR='<absolute path>' claude`, which bypasses a possible `export CLAUDE_CONFIG_DIR` in rc files such as `~/.bashrc`; the terminal env parameter is a second safeguard.
   - default account: no variable is injected; `claude` is sent directly.
3. Show the terminal. The first run in a new directory goes through Claude Code's first-run onboarding; under WSL sign-in uses paste code. When the account is not signed in, the information message "Sign in to Claude in the terminal. Your other accounts stay signed in: each keeps its own sign-in in its own directory, so there is no need to sign out first. Signing out ends that account's session." is shown.
4. When a terminal created by this extension closes, the panel and the status bar are refreshed; if it was neither the default account nor the external directory and the account is still not signed in (the same state the panel rows use: no email in its account info file and no `.credentials.json`, whose existence only is checked), the message "Login did not land in this directory: no login info found under <dir>. Check whether ~/.bashrc or similar overrides CLAUDE_CONFIG_DIR, or reopen the terminal and log in again." is shown.

Prerequisite: a `claude` command on PATH.

### 4.5 Refresh `planswap.refresh`

Entry points: the `$(refresh)` title bar button, the Command Palette. Removes accounts whose directory no longer exists and registers unregistered `~/.claude-*` directories (rules in section 5), re-reads each account directory's email, plan and sign-in state, redraws the panel and updates the status bar.

### 4.6 Share an independent account

Entry points: the `link` button "Link to the default account: its settings, rules, skills, history and sessions move into the default account and are linked from then on; the login stays separate" of an independent named row that is not current; or **Share with Default Account** (`planswap.shareAccount`) in the Command Palette. The command lists independent named accounts excluding the current account (including equivalent directory paths), then uses the same confirmation and conversion flow below. Cancelling the picker or confirmation changes nothing.

1. The extension resolves the row by `dir` and only accepts named accounts that are not already shared; the current account is refused with "Switch away from X before linking it.".
2. Modal confirmation "Link X to the default account? Its history, memory, settings and other folders in <dir> are moved into the default account and replaced by links; the login stays. Files that differ from the default account's are kept for manual merging: inside linked folders next to the default file with a .from-<name> suffix, top-level files in the account directory as <file>.independent-backup. This cannot be undone automatically.", button **Link**.
3. Busy check: when a Claude process is still running with this configuration directory (a `<dir>/sessions/<pid>.json` whose pid is alive and whose `/proc/<pid>/environ` has `CLAUDE_CONFIG_DIR` equal to the directory; on Windows see [Windows busy checks](design.md#windows-support), which also count the account's open PlanSwap terminal), an account-busy warning asks the user to close Claude Code sessions and any PlanSwap terminal tabs for the account and nothing changes.
4. Migration into the default directory (nothing is ever overwritten there):
   - shared folders (`projects`, `file-history`, `todos`, …) are merged recursively: files missing in the default directory are moved there, identical files are dropped, and a file that differs is moved next to the default one as `<file>.from-<account name>` for manual merging; the emptied account folder is then replaced by a link;
   - `history.jsonl`: the account's lines are appended to the default file;
   - `settings.json` / `CLAUDE.md`: when the default directory has no such file, the account's file is moved there and becomes the shared one (a `settings.json` with a login-related key stays in the account and is not linked); otherwise the default file wins: an identical account copy is dropped, a different one is renamed to `<file>.independent-backup` in the account directory (`settings.json` stays in place when the default settings cannot be shared, see section 5);
   - the children of `skills/` and `plugins/` (except `synced` and `.trash`) are merged the same way;
   - finally all links are created and the default account's `.claude.json` is mirrored.
5. The result is summarized in one notification: "X is now linked to the default account. <summary>" only when the on-disk shared marker is present; otherwise the notification says linking is incomplete. In both cases, the summary lists files moved, identical files dropped, both versions kept ("merge manually"), backups, entries kept as the account's own and entries not linked for safety, or "Nothing needed manual attention."; an error stops the migration with "Linking X stopped: <reason>" (what was already moved stays in the default directory).
6. The panel is refreshed; the row shows the shared badge only when its on-disk shared marker is present.

### 4.7 Unlink a shared account

Entry point: the `debug-disconnect` button "Unlink from the default account: the links are removed and the account gets its own copy of the default configuration; history and sessions stay in the default account" of a shared named row that is not current (panel only, no Command Palette entry).

1. The extension resolves the row by `dir` and only accepts named accounts that are shared; the current account is refused with "Switch away from X before unlinking it.".
2. Modal confirmation "Unlink X from the default account? The links in <dir> are removed and the account gets its own copy of the default settings, rules, skills and MCP servers. Shared history and sessions stay in the default account and are not copied; existing local data is kept. The login stays. This cannot be undone automatically.", button **Unlink**.
3. Busy check as in 4.6 step 3, including the instruction to close the account's PlanSwap terminal tabs.
4. `makeClaudeIndependent`: every link into the default directory is removed (the shared entries and the `skills/` / `plugins/` children whose link resolves to the default entry, compared by real path; a regular file or a link resolving elsewhere is left untouched) and the default configuration is copied once exactly as for a new independent account (4.2 step 4, independent): `settings.json` stripped, `CLAUDE.md`, the config folders, the `skills/` children and the MCP servers. Nothing is copied or moved for `projects`, `sessions`, `history.jsonl` and the other history entries: shared data stays in the default directory and is not copied; regular files already in the account remain there. The configuration entries are unlinked and copied first and the history entries (the `projects` marker last) afterwards, so when copying fails the account is still linked and **Re-link** re-creates the missing links. The default directory is never modified; the login stays.
5. Notification "X is now independent: removed N link(s), copied <list>." ("nothing" when nothing was copied); an exception shows "Unlinking X stopped: <reason>".
6. The panel is refreshed; the row loses the badge and shows the link button again.

### 4.8 Refresh usage limits `planswap.claude.refreshUsage`

Entry points: the Command Palette ("Refresh Claude Usage Limits") and the refresh icon button in the sidebar's account list header ([Usage refresh buttons](#usage-refresh-buttons)). Queries the current account's usage limits now (see [Claude usage limits](#claude-usage-limits)); a query that is already running is joined. An account queried less than a minute ago (by any query of this window, scheduled, manual or refresh-all, or a usage cache that Claude Code fetched in any window or terminal) is not queried again: the information message "Usage limits were checked less than a minute ago; try again in {seconds} s." is shown instead ([Manual refresh cooldown](#manual-refresh-cooldown)). Nothing happens, and no message appears, for a signed-out or non-subscription account.

### 4.9 Refresh usage limits of all accounts `planswap.claude.refreshAllUsage`

Entry points: the Command Palette ("Refresh Usage Limits of All Claude Accounts") and the layers icon button next to the refresh button in the Claude page's account list header ([Usage refresh buttons](#usage-refresh-buttons)). Manual only; nothing runs it automatically. It queries every registered signed-in (subscription) Claude account one after another, so the rows can be compared before switching; the external (unregistered) current directory is not included (see [Claude usage limits](#claude-usage-limits)). Accounts in the [manual refresh cooldown](#manual-refresh-cooldown) are skipped.

1. With no signed-in registered account, "No signed-in Claude account to check." is shown and nothing runs. When every such account is in the cooldown, "Every account was checked less than a minute ago; try again in {seconds} s." is shown and nothing runs.
2. A cancellable progress notification shows "Checking Claude usage limits: {label} ({done}/{total})". A failure of one account does not stop the others; cancelling also ends the `claude` process of the account being queried, and no further account is queried.
3. Afterwards the panel and the status bar are refreshed and either "Checked the usage limits of {n} Claude accounts." or the warning "Checked {ok} of {n} Claude accounts. Failed: <label> (<reason>); …" is shown, where the reason is the localized failure text of that account (at most three accounts are named, then "{n} more"). After a cancellation the message is "Cancelled after checking {ok} of {n} Claude accounts." (plus the failure warning when an account failed before). {n} counts the accounts queried; when accounts were skipped for the cooldown, "Skipped {n} account(s) checked less than a minute ago." is appended to the final message.
4. Running it again while a run is in progress does nothing.

## 5. Auto-discovery, shared and independent accounts

### Auto-discovery of `~/.claude-*`

On activation and on refresh, named accounts whose directory no longer exists are first removed from the list and their alias is cleared; they are not added to the ignore list, so a directory recreated later is discovered again. The default account is never removed.

Then the home directory is scanned; a directory that meets all of the following conditions and is not in the account list is registered automatically:

- the basename matches `^\.claude-[A-Za-z0-9_-]+$`;
- it is a real directory, not a symlink;
- it is not the default directory (compared after resolving symlinks);
- it is not in the ignore list (directories kept when removing an account go into the ignore list);
- its name does not equal, ignoring case, the name or display name (alias) of an existing account (including `default`); such a directory is skipped until the conflict is gone (e.g. `~/.claude-xiaoni` is skipped while `Xiaoni` is registered). Of two scanned directories whose names differ only in case, only the first one found is registered.

The account name is the basename without the `.claude-` prefix. This keeps the list from becoming empty when the state file is lost and also adopts manually created directories.

### Keys stripped when copying settings

When `settings.json` is copied from the default directory into a new independent account directory, the following keys are deleted (no effect if absent):

- under `env`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
- top-level: `apiKeyHelper`, `forceLoginMethod`, `forceLoginOrgUUID`, `enabledPlugins`, `extraKnownMarketplaces`, `additionalMarketplaces`

The copy happens only once; afterwards the independent account's `settings.json` is its own.

### Shared accounts

A shared account keeps only its login identity (`.credentials.json`, `.claude.json`) and a few per-account entries; everything else is an absolute symlink to the same entry of the default directory:

- files: `settings.json`, `CLAUDE.md`, `history.jsonl`;
- folders: `projects`, `file-history`, `todos`, `session-env`, `shell-snapshots`, `sessions`, `tasks`, `uploads`, `agents`, `commands`, `output-styles`, `hooks`, `rules`, `ide`;
- per child: `skills/` and `plugins/` are real folders in the account, and every child of the default account's folder is linked into them, except `synced` and `.trash` (per-account cloud-synced buckets); links whose default child no longer exists are removed, and a whole-folder `skills` / `plugins` link from an earlier version is replaced by per-child links.

Rules:

- The account is shared when `projects` is a symlink resolving to the default `projects`; this marker is read from disk every time, never stored.
- A shared entry missing in the default directory is created empty there first (folder 0700; file 0600, `settings.json` with `{}`), so the link has a target. Existing default content is never modified by linking.
- An entry the account already has as a regular file or folder, or as a link pointing elsewhere, is left untouched and reported ("kept the account's own: …"); merge it by hand, delete the account's copy, then sync again. Exception: when Claude Code has replaced the `history.jsonl` link of a shared account by a regular file (e.g. `claude project purge` rewrites it), the next refresh appends the lines the default file lacks to it, removes the account's file and re-creates the link. Lines the purge removed stay in the shared default history, because the merge only appends. An independent account's own `history.jsonl` is not merged by syncing.
- `settings.json` is not linked ("not linked for safety") when the default settings are not a valid JSON object or contain a login-related key (top-level `apiKeyHelper`, `forceLoginMethod`, `forceLoginOrgUUID`, or `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` under `env`).
- `.claude.json` is not linked (it holds the sign-in and onboarding state) but mirrored from the default account's `.claude.json` (usually `~/.claude.json`): `mcpServers` becomes an exact copy (servers removed from the default account are removed too), and for every project path of the default account the keys `allowedTools`, `mcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `mcpContextUris`, `hasTrustDialogAccepted`, `hasClaudeMdExternalIncludesApproved` and `hasClaudeMdExternalIncludesWarningShown` are copied; when the account is signed in (an email in its file, or its credentials file exists), `hasCompletedOnboarding` and `lastOnboardingVersion` are added from the default account if the account lacks them, so Claude Code does not run its first-start onboarding again (a signed-out account keeps its onboarding, which is how it signs in; `githubRepoPaths` is not copied); all other keys stay as they are. A missing file is created (0600); an existing one keeps its mode and is replaced atomically; nothing is written when nothing changed. A file that is not a JSON object, or that Claude Code rewrote while mirroring, is left unchanged and reported; an invalid default file stops the mirror ("The default account's info file is not a valid JSON object; nothing was synced").
- Links and the mirror are refreshed when adding the account, before switching to it (4.1), by "Re-link" (5.5) and after converting it (4.6); there is no background sync.
- Running sessions keep their MCP list until a new session starts.

### Independent accounts

An independent account gets a one-time copy of the default account's configuration when it is created (nothing is overwritten, symlinks inside copied folders are copied as links): `settings.json` with the keys above stripped (0600), `CLAUDE.md`, the folders `agents`, `commands`, `output-styles`, `hooks`, `rules` (a folder that is itself a link is copied from its real location), the children of `skills/` except `synced` and `.trash`, and the user-level MCP servers of the default `.claude.json` (servers the account lacks are added, differing ones kept, nothing removed). History, sessions and projects stay separate. Later changes in the default account are not copied; "Re-link" does not touch independent accounts.

For both modes `.credentials.json` is never read, copied or linked, so remote MCP servers that use OAuth must be authorized again in each account, and MCP `env` values (which may contain API keys) are copied in plain text into the other accounts' `.claude.json`.

## 5.5 Tool buttons

- **Footer toolbar pinned to the bottom of the panel** (outside the tab pages, always visible, shared by both pages): five icon buttons in three groups divided by thin separators, left to right: Show CLI and extension versions (`info`) and User guide (`book`) | Reload Window (`refresh`, no confirmation) and Restart Extension Host (`debug-restart`, no confirmation), the two disruptive actions side by side | Star (`star-empty`) on its own. Codex restart controls are not shown in the sidebar; switching offers **Switch and restart** for supported WSL editors or **Save selection** with manual restart instructions elsewhere (see 10.6).
- User guide (`book`, Chinese "使用说明") and Star (`star-empty`) open the GitHub README (`https://github.com/n2ns/planswap#readme`) and repository home (`https://github.com/n2ns/planswap`) in the external browser. Both pages share these buttons, including when Codex switching is disabled. Clicking Star only opens GitHub; the user stars the repository there.
- Below the footer toolbar, a separate centered small-text line shows the PlanSwap extension version (`v<version>`), sourced from `package.json` at build time. It stays visible on both tabs, including while Codex switching is disabled.
- **Version card**: after clicking "Show CLI and extension versions", the extension runs `claude --version` and `codex --version` in parallel (`execFile`, no shell except on Windows, where npm `.cmd` shims need one and `where.exe` first tells a missing CLI apart; 8-second timeout), reads the versions of the two official extensions, and pushes them to the panel, which expands a card above the toolbar: title "CLI and extension versions" plus a close button, and below it four items `Claude Code CLI`, "Claude Code extension", `Codex CLI`, "Codex extension", each on two vertical lines (label on one line, value on the next, the value in monospace and wrappable). Clicking the info button again or close collapses it. Not installed shows "Not found", a timeout shows "Timed out", other failures show an error summary; no network access, no update check.
- **"Tools" section inside each tab page** (below the account list, a collapsed row with a chevron and the title "Tools"; its open state is kept per page; when expanded, labeled secondary buttons that wrap automatically when they do not fit, four on each page, three while the page has no linked account):
  - `CLAUDE.md` (Claude page) / `AGENTS.md` (Codex page), ruler icon `symbol-ruler`: opens `<current effective directory>/CLAUDE.md` or `<current effective directory>/AGENTS.md` (Claude uses `currentDir()`, Codex uses `effectiveDir()`); when the file does not exist, a modal asks "File does not exist. Create it?", and after confirmation an empty file (0600) is created and opened. When the file is a dangling symlink (e.g. to a deleted default rules file), the empty file is created at the link target so the link works again; if the target's directory does not exist, "Failed to create file: <reason>" is shown.
  - Settings, icon `settings-gear`: opens the Settings UI filtered by `claudeCode.` (Claude page) / `chatgpt.` (Codex page).
  - Re-link, icon `sync` (Chinese label "重新链接"; title "Re-link linked accounts to the default account and sync its MCP servers" on the Claude page, "Re-link linked accounts to the default account" on the Codex page), shown only while the page lists at least one linked account: for every registered named account of this page that is shared, re-creates or repairs its links as when adding it and, on the Claude page, mirrors the default account's `.claude.json` (see "Shared accounts" in section 5; Codex: 10.12); independent accounts are not touched. With no shared accounts (reachable from the Command Palette): "No linked Claude accounts to re-link." (`Codex` on the Codex page). Otherwise one notification "Re-linked N linked Claude account(s) to the default account.", followed by "Needs attention: <name>: <notes>; …" (shown as a warning) when an account kept its own entries, had entries not linked for safety, or failed. The list uses each account's display name (the directory name when it is not registered). The "Tools" section is shown on the Codex page even while Codex switching is not enabled.
  - Update CLI, icon `cloud-download` (Chinese label "更新 CLI"): opens and shows a new integrated terminal named "Update Claude CLI" / "Update Codex CLI" (localized). Claude sends `claude update`; Codex sends `env -u CODEX_HOME codex update`, using the default home for this update process only so an account selected by PlanSwap does not affect standalone installation detection. The action does not change the selected account, shell startup files or extension-host environment. Progress, prompts and errors stay in the terminal; there is no pre-check or separate check button. This panel-only action is also available while Codex switching is disabled. It assumes a `claude` / `codex` command on PATH; the Codex workaround targets standalone installations under the default `~/.codex`.
- Command Palette entries (category "PlanSwap"): `planswap.tools.openClaudeMd` (open the global CLAUDE.md), `planswap.tools.openAgentsMd` (open the global AGENTS.md), `planswap.tools.openSettings` (open extension settings, first a QuickPick Claude Code / Codex), `planswap.tools.reloadWindow` (reload window), `planswap.tools.restartExtHost` (restart extension host), `planswap.tools.cliVersions` (show CLI and extension versions; the Command Palette entry uses a read-only QuickPick list instead of the panel card), `planswap.tools.sync` (Re-link Accounts to the Default Account, first a QuickPick Claude Code / Codex); restarting the WSL server reuses `planswap.codex.restartServer`.
- When the Codex part fails to initialize (see the beginning of section 10), the toolbar and the "Tools" sections of both pages keep working; only the Codex restart action and the Codex page's "Re-link" report that Codex is not initialized ("The Codex part is not initialized; cannot re-link linked accounts.").

## 6. Refresh triggers

Location of the account info file: usually `<dir>/.claude.json`; for the default account without `CLAUDE_CONFIG_DIR` (neither in the extension host environment nor set explicitly to `~/.claude` in `claudeCode.environmentVariables`) it is `~/.claude.json`. `.claude.json` below always means this file.

The panel and the status bar refresh when:

- the `claudeCode.environmentVariables` setting changes (including writes by this extension, manual edits, and changes caused by switching in another window);
- the `.claude.json` of any account row in the panel (including the external-directory row) is created, changed or deleted (one file watcher per row, added and removed along with the rows);
- the sidebar panel becomes visible again (panel only);
- after adding or removing an account;
- a terminal created by this extension closes;
- the refresh button is clicked;
- the usage cache in an account's `.claude.json` changes (the watcher above), and once a minute so that expired windows disappear;
- the `planswap.language` setting changes (both are re-rendered in the new language).

## 7. Safety checks before deleting a directory

Before deleting a directory, the following are checked one by one; if any fails, deletion is refused with the reason:

1. `path.resolve(dir)` is a direct child of the home directory (`os.homedir()`), preventing an escape outside the home directory through a symlinked parent;
2. the basename matches `^\.claude-[A-Za-z0-9_-]+$`;
3. after resolving symlinks it does not point to the default directory;
4. `lstat` says it is not a symlink.

When they pass, it is deleted with Node's `fs.rm(dir, { recursive: true, force: true })`, never through a shell.

## 8. Multi-window behavior

- `claudeCode.environmentVariables` is a machine-level setting; all VS Code windows on the same WSL share the same value.
- After an account switch in any window:
  - new sessions in all windows use the new account;
  - the official panels of all windows refresh the account shown in their headers;
  - this extension's sidebar and status bar in other windows update when that window receives the setting-change event (not specifically verified across windows; click refresh if they do not update);
  - sessions already open in each window keep using the old account and each window must be reloaded separately. The reload banner (or the notification when the panel is not visible) only appears in the window that performed the switch.
- The account list lives in the state file `~/.config/planswap/state.json`, read on every access, so other windows (including other editors on the same distro) see accounts added elsewhere on their next refresh; click refresh or reload the window when a list looks stale.
- `planswap.language` has `application` scope, so a change applies to every window.

## 9. Platform guard

- When activated on a platform other than Linux (WSL) or native Windows, only the warning "PlanSwap only supports WSL/Linux and Windows." is shown once; the sidebar, status bar and commands are not registered.
- The extension declares `extensionKind: ["workspace"]`, so in a WSL window it is installed and runs on the WSL side.

## 10. Codex account switching

Independent of Claude account switching. The implementation is based on `docs/codex-design.md` (design) and `docs/codex-interfaces.md` (module contract). This extension only reads each account directory's `auth.json` and only decodes the payload of its `tokens.id_token` to display the email and plan and to compare identities (10.1); it never copies, links, swaps, caches or outputs any token or `auth.json`. Usage limits are asked from the official `codex` CLI run with the account's `CODEX_HOME` (see [Status bar account summary](#status-bar-account-summary)). The contents of `~/.codex` are only changed for shared accounts (10.12): missing shared entries are created empty there as link targets, and converting an account moves its files in without overwriting existing ones.

If the Codex part fails to initialize on activation (e.g. an rc file is unreadable), this is only logged and Claude is not affected: the Codex page renders as "not enabled, no accounts"; account actions on the Codex page and the 9 `planswap.codex.*` commands then show "Codex account switching is unavailable: <reason>", while the toolbar and the "Tools" section work as usual (see 5.5).

### 10.1 Accounts and directories

| Account | Directory | Notes |
|---|---|---|
| `default` | `~/.codex` (fixed, ignores environment variables) | Always exists, cannot be removed; effective when the state file is empty |
| `<name>` | `~/.codex-<name>` | Created with "Add account", or registered by auto-discovery (same rules as section 5, basename matches `^\.codex-[A-Za-z0-9_-]+$`) |

- The account list is stored in the state file `~/.config/planswap/state.json` under `codex.accounts`, the ignore list under `codex.ignoredDirs`, with the same semantics as on the Claude side (entries whose directory no longer exists are pruned on activation and refresh and their alias is cleared; auto-discovery skips a name equal, ignoring case, to the name or display name of an existing Codex account; a deleted directory leaves the ignore list). Account names and display names are compared ignoring case when checking for duplicates.
- The **selected account** is whatever the state file `~/.config/planswap/codex-home` says (content is the absolute path of the directory, empty means the default account; shared across windows, the last writer wins).
- The **directory effective in this window** = the extension host's own `process.env.CODEX_HOME`, or `~/.codex` when empty. The panel marks it as "current". When the effective directory does not correspond to any registered account, an "External directory" row is appended to the list and marked current.
- Signed-in state: whether `<dir>/auth.json` exists.
- Email and plan: when `auth.json` exists it is read and parsed as JSON:
  - `auth_mode` is `apikey` (or `auth_mode` is missing, `OPENAI_API_KEY` is non-empty and there are no `tokens`) → the plan shows "API key", no email;
  - otherwise only the second part of the `tokens.id_token` JWT is decoded (base64url, no signature check), taking `email` and `https://api.openai.com/auth`.`chatgpt_plan_type` from the payload; the plan is capitalized (`plus` → `Plus`, `pro` → `Pro`, `team` → `Team`, etc.), `prolite` → `Pro Lite`;
  - when the JSON is damaged or being written, email and plan are unknown but the account still counts as signed in;
  - the raw `access_token`/`refresh_token`/`id_token` are never stored, cached or output.
- Same sign-in warning (see 1): Codex compares the user id (`chatgpt_user_id`, else `user_id`, else `sub`) plus the workspace (`chatgpt_account_id`) from the same payload, only when both exist; never the email (one email can belong to several workspaces) and never in API key mode.
- Every named Codex account is shared or independent, as on the Claude side (see 1); the marker is `sessions` (a symlink resolving to `~/.codex/sessions`), and the entries are listed in 10.12.
- Each account's display name (alias) is stored by account name in the state file under `codex.labels`, with the same rules as on the Claude side (see 1 and 2.7); the aliases of both sides are independent, and the same name is allowed across Claude and Codex.

### 10.2 Codex tab in the sidebar

- **Disabled page**: when either `~/.profile` or `~/.bashrc` has no marker block, the Codex page's account list and add-account section are replaced by an explanation card (titled "Codex account switching is not enabled"; each account uses its own `CODEX_HOME` directory; the extension writes a marker block into `~/.profile` and `~/.bashrc`; the last sentence depends on the connection: WSL "Switching accounts requires restarting the editor's WSL server; all WSL windows disconnect.", local "Switching accounts requires restarting this editor; all of its windows close and integrated terminals end.", other remote "Switching accounts requires restarting the editor server in the remote environment.") and an **Enable Codex switching** button; the "Tools" section is still shown.
- Once enabled the layout matches the Claude page: all accounts list with its "+ Add" form, "Tools" section (every named account row has a pencil button for renaming), with these differences:
  - No reload banner; the `reload` and `dismissBanner` messages are ignored for Codex.
  - **"Takes effect after restart" banner**: when the directory in the state file differs from the directory effective in this window, the top shows "<display name> selected; takes effect after restarting the server" (an unregistered directory shows its path), with the explanation "Restarting the server disconnects all WSL windows (reload or reopen them); integrated terminals close." without an action button. In a local window the title ends "…after restarting the editor" and the text is "Fully exit this editor and start it again; reloading the window is not enough.". In another remote window the text is "Restart the editor server in the remote environment, then reconnect.". Manual restart steps are explained in the switch confirmation; the banner has no restart or instructions button. When another window switches, this window shows the banner as well through its state file watcher.
  - Current and other rows: email and plan when there is an email; "Logged in" when signed in without email (API key mode or decoding failure); "Not logged in" when signed out.
  - Rows that are signed out and not current show `Click "Log in" to log in from a terminal, or switch and log in from the Codex panel`.
  - The terminal icon's title is "Run codex with this account in a terminal", and the sign-in button's title is "Run codex login in a terminal".
  - The add section's help text uses `~/.codex-<name>`; the add section has the same shared checkbox (checked by default), and rows have the same shared badge and "Link to the default account: …" button as on the Claude page (conversion in 10.12).
  - The current (effective in this window) account row has no remove button.

### 10.3 Commands

Ten commands appear in the Command Palette in the category "Codex Account" ("Codex 账号"). Commands that need an account first show a QuickPick (each item shows the display name, "Logged in"/"Not logged in", and the directory); when there is nothing to pick, "No accounts to choose from." is shown. Messages and terminal names always use the display name.

| Command id | Title | Entry points and flow |
|---|---|---|
| `planswap.codex.enable` | Enable Codex Account Switching | Disabled-page button, Command Palette → 10.4 |
| `planswap.codex.disable` | Disable Codex Account Switching | Command Palette → 10.5 |
| `planswap.codex.switchAccount` | Switch Codex Account | Panel switch button/double-click/Enter, Command Palette QuickPick (without the account that is both effective and selected) → 10.6 |
| `planswap.codex.addAccount` | Add Codex Account | Opens the panel, switches to the Codex tab and focuses the add input → 10.7 |
| `planswap.codex.shareAccount` | Share with Default Account | QuickPick of independent named accounts excluding effective and selected accounts (including equivalent directory paths), then the existing confirmation and conversion flow → 10.12; cancelling changes nothing |
| `planswap.codex.removeAccount` | Delete Codex Account | Panel trash button via inline confirmation, Command Palette QuickPick (without the effective and the selected account) → 10.8 |
| `planswap.codex.openTerminal` | Run codex in Terminal with Codex Account | Panel terminal/sign-in button, Command Palette QuickPick (also the external directory when it is current) → 10.9 |
| `planswap.codex.refreshUsage` | Refresh Codex Usage Limits | Command Palette, the refresh icon button in the Codex page header ([Usage refresh buttons](#usage-refresh-buttons)) → queries the effective account's usage limits now (see [Status bar account summary](#status-bar-account-summary)); within the [manual refresh cooldown](#manual-refresh-cooldown) only the cooldown message is shown |
| `planswap.codex.refreshAllUsage` | Refresh Usage Limits of All Codex Accounts | Command Palette, the layers icon button next to the refresh button in the Codex page header ([Usage refresh buttons](#usage-refresh-buttons)) → [10.3.1](#1031-refresh-usage-limits-of-all-codex-accounts) |
| `planswap.codex.restartServer` | Apply Codex Account: Restart or Show Instructions | Command Palette → WSL Antigravity / VSCodium: modal confirmation "Restart {editor}'s WSL server: all WSL windows disconnect and prompt to reload, all extensions restart, and integrated terminals close. Continue?", then restart as in 10.6 step 5; everywhere else (WSL VS Code / unrecognized editor, local Linux, other remotes): the context's manual warning (e.g. "This editor's WSL server cannot be restarted automatically. {hint}") directly, without a modal |

### 10.3.1 Refresh usage limits of all Codex accounts

Manual only; nothing runs it automatically. It queries every registered signed-in ChatGPT Codex account (not API key) one after another, so the rows can be compared before switching; the external (unregistered) effective directory is not included. The effective account is queried through the same path as **Refresh Codex Usage Limits** (its status bar tooltip follows); every other account's successful result becomes its usage observation ([Codex account usage observations](#codex-account-usage-observations)), unless its sign-in changed while the query ran. Each row is updated as soon as its own query ends, not only after the whole run. Accounts in the [manual refresh cooldown](#manual-refresh-cooldown) are skipped.

1. When Codex runs inside WSL (native Windows), the warning `codex.win.runsInWsl` is shown and nothing runs. With no signed-in registered ChatGPT account, "No signed-in Codex account to check." is shown and nothing runs. When every such account is in the cooldown, "Every account was checked less than a minute ago; try again in {seconds} s." is shown and nothing runs.
2. A cancellable progress notification shows "Checking Codex usage limits: {label} ({done}/{total})". A failure of one account does not stop the others; cancelling also ends the `codex` process of an account other than the effective one (a running query of the effective account finishes), and no further account is queried.
3. Afterwards the panel and the status bar are refreshed and either "Checked the usage limits of {n} Codex accounts." or the warning "Checked {ok} of {n} Codex accounts. Failed: <label> (<reason>); …" is shown, where the reason is the localized failure text of that account, e.g. "Usage limits unavailable: the sign-in has expired; sign in again." (at most three accounts are named, then "{n} more"). After a cancellation the message is "Cancelled after checking {ok} of {n} Codex accounts." (plus the failure warning when an account failed before). As for Claude, {n} counts the accounts queried and the skipped-accounts sentence is appended.
4. Running it again while a run is in progress does nothing.

### 10.4 Enable

On native Windows with the Codex extension setting `chatgpt.runCodexInWindowsSubsystemForLinux` on, enabling and switching (10.6) are refused with "The Codex extension runs Codex inside WSL here (chatgpt.runCodexInWindowsSubsystemForLinux), so it ignores the Windows CODEX_HOME. Open a WSL window and manage Codex accounts there, or turn that setting off." ([Codex design 9a](codex-design.md#9a-native-windows)).

1. Pre-checks; if any fails, an error lists all reasons and the flow returns:
   - the basename of the extension host's `SHELL` is `bash`;
   - `~/.bash_profile` and `~/.bash_login` do not exist, or their content contains `.bashrc`;
   - `~/.profile` and `~/.bashrc` contain no `export CODEX_HOME=` outside the marker block;
   - neither file contains a damaged block with "a start marker but no end marker" (`broken`).
2. Modal confirmation "The following marker block will be written to ~/.profile and ~/.bashrc to set CODEX_HOME in login shells. Continue?", with the full marker block in the detail and the button **Write**.
3. Write the marker blocks (see 10.11); files that already have a block are skipped. A write failure shows "Failed to write rc files: <reason>".
4. Self-check: back up the state file, create a temporary empty directory and point the state file to it, run `bash -i -l -c 'printf %s "$CODEX_HOME"'` (10-second timeout, take the last line of output) and compare with the temporary directory (or its realpath); restore the original state file and delete the temporary directory whether it succeeds or not.
5. Self-check failure: only the files newly written in this run are rolled back (files that already had a block before enabling are left alone), and "Self-check failed; rc files were rolled back: <details>" is shown.
6. Refresh the view.

### 10.5 Disable

1. Modal confirmation "The marker blocks in ~/.profile and ~/.bashrc will be removed and the selected Codex account cleared. CODEX_HOME in open windows does not change until the server restarts. Continue?", button **Disable**.
2. Remove both blocks by their markers; if any file has a start marker but no end marker, an error is thrown, no file is changed, "Failed to disable: <reason>" is shown and manual repair is required.
3. Delete the state file.
4. Refresh the view.

### 10.6 Switch

While another switch is in progress (e.g. its confirmation is still open), a further switch request (such as a double click) is ignored.

1. The target is both the directory effective in this window and the content of the state file → "X is already the current account." and return.
2. The target directory does not exist → error "Account directory does not exist: <dir>".
3. Detect the editor kind from the WSL server's data directory directly under `~` (whitelist): `~/.antigravity-ide-server` or `~/.antigravity-server` (older releases) → Antigravity, `~/.vscodium-server` → VSCodium (both restart automatically); `~/.vscode-server` → VS Code, anything else or a detection failure → unknown (both manual only). Modal confirmation, button **Continue**:
   - In WSL, Antigravity / VSCodium: "Switching the Codex account restarts {editor}'s WSL server: all WSL windows disconnect and prompt to reload, all extensions restart, and integrated terminals close. Continue?" (`{editor}` is "Antigravity" or "VSCodium");
   - In WSL, VS Code / unknown: "The new Codex account takes effect only after the WSL server restarts, which this editor cannot do automatically. {hint} Continue?" (`{hint}` is the manual method of step 5).
4. When the target is a shared account, its links are re-created or repaired first (10.12); anything that needs attention only shows the warning "Re-linking X to the default account reported: …", and the switch continues. Then write the state file atomically (empty for the default account); on failure "Failed to write the state file: <reason>" and return; refresh the view.
5. Restart handling depends on the connection context (see below). In WSL, VS Code / unknown: nothing is signaled and no further message is shown, because the confirmation in step 3 already contained the manual method `{hint}`, which is "Close all VS Code windows connected to this distro, wait a few seconds, then reopen them." (VS Code) or "Close all editor windows connected to this distro, wait at least 5 minutes, then reopen them. If the account has still not changed, run "wsl --shutdown" in Windows (this stops all WSL distros) and reopen." (unknown in a WSL window). VS Code is manual because its Windows-side wslDaemon caches the resolved port: after the server is killed a reloaded window can receive a stale port while other windows keep the daemon alive; closing all VS Code windows connected to the distro makes the daemon exit (3 s) and stop the server, and reopening starts a new one. Antigravity / VSCodium: first locate and verify the server (the parent process `process.ppid` is greater than 1; its cmdline contains `out/server-main.js` and `--start-server` and its data directory is Antigravity's or VSCodium's; the top-level `commit` of the server root's `product.json` is 40 lowercase hex characters and matches the root directory name; the value in the pid file `<dataDir>/.<commit>.pid` equals the server's parent pid); when verification fails, a warning "Cannot restart the WSL server automatically: <reason>" is shown together with the manual method "Manual alternative: close all {editor} windows connected to this distro, wait at least 5 minutes, then reopen." When it passes, `SIGTERM` is sent to the server, then to every process in `/proc` whose parent is the server (excluding this extension host), one by one (`ESRCH` and `EPERM` are ignored), without waiting.
6. Afterwards (Antigravity / VSCodium) every WSL window shows "Cannot reconnect. Please reload the window.", and the user clicks "Reload Window" in each one.

Manual warnings and switch confirmations use `vscode.env.remoteName`. A non-WSL remote window is instructed to restart its remote editor server with that environment and reconnect. Only WSL windows with the existing supported server kinds enter the WSL automatic restart path.

**Local desktop window** (including WSLg; [Codex design §5.1](codex-design.md#51-local-desktop-editor-manual-restart)): the confirmation explains that only the selection is saved and a manual editor restart is required. After confirmation, write the selected directory and refresh the pending state. No editor quit, relaunch helper or deferred restart is scheduled. The switch confirmation provides **Save selection** and manual instructions: fully exit the intended instance when ready and relaunch through the original session setup with `CODEX_HOME` set to the selected directory, or unset for default. Reload Window alone is insufficient.

### 10.7 Add

1. Name validation as in 4.2 (`^[A-Za-z0-9_-]+$`, not `default`, not equal to the account name or display name of any account on the Codex page, all ignoring case, `~/.codex-<name>` neither equal to nor containing `~/.codex` after resolving symlinks).
2. Create `~/.codex-<name>` (0700; reused if it exists). When this fails, the help line shows "Failed to create account directory: <reason>" and nothing is registered.
3. Depending on the shared checkbox (see 10.12):
   - **shared** (checked): every shared entry is linked to `~/.codex` (missing entries are first created empty there); when something could not be linked, the warning lists the linking issues without claiming that the account is already linked (e.g. "not linked for safety: config.toml" when the default `config.toml` sets a login-related key);
   - **independent** (unchecked): `config.toml` is copied from `~/.codex` as a starting point (skipped when the target exists or the source does not; mode 0600), then `AGENTS.md` and `hooks.json` (0600), the folders `rules`, `hooks`, `agents`, `themes` and the children of `skills/` except `.system` are copied once, never overwriting. `config.toml` is not copied when it contains one of the top-level keys `forced_login_method`, `forced_chatgpt_workspace_id`, `sqlite_home`, `log_dir`, `model_provider`, or `model_providers` in any form (a `[model_providers]` / `[model_providers.x]` table, a dotted key `model_providers.x.base_url = …`, an inline table `model_providers = { … }`); quoted keys and whitespace around dots are recognized (`"model_provider" = …`, `[ model_providers.x ]`), a dotted key or table header counts when its first segment is blocked, comment lines are ignored, and keys after entering any other table are not top-level. A message is shown only when a file was not copied because of a blocked key/section: "Account X was created; the following files were not copied: …"; a missing source, an existing target and similar cases are silent.
   `auth.json` is never copied or linked. A failure of this step only shows the warning "Account X was created, but linking it to the default account failed: …" / "… but copying the default account's configuration failed: …" and does not block.
4. Register the account (removing it from the ignore list), refresh the view.

### 10.8 Remove

- Cannot be removed: the default account, the account effective in this window ("X is the account in effect in this window and cannot be deleted. Switch to another account first."), the account the state file currently points to ("X is the selected account waiting for a restart to take effect and cannot be deleted. Switch to another account first.").
- The panel entry goes straight to the next step after the inline confirmation; the Command Palette entry shows the modal "Delete Codex account X?", button **Delete**.
- Remove it from the list and record it in `codex.ignoredDirs`, clear the account's alias, refresh the view.
- Modal confirmation "Account X was removed from the list. Also delete directory <dir>?" (detail: the directory contains the account's credentials, sessions and local data and cannot be recovered after deletion; for a shared account: "Linked data in the default account will be kept. This account directory and everything stored locally in it, including login credentials, per-account memories, backups and other unlinked files, will be permanently deleted."), button **Delete Directory**.
- Safety checks for deleting the directory (`checkCodexSafeToDelete`); if any fails, deletion is refused with "Failed to delete directory: <reason>":
  1. `path.resolve(dir)` is a direct child of the home directory;
  2. the basename matches `^\.codex-[A-Za-z0-9_-]+$`;
  3. not equal to the default directory (neither directly nor after resolving symlinks);
  4. `lstat` says it is not a symlink and is a directory;
  5. **no live daemon**: read `daemon.pid`, `app-server.pid`, `daemon-updater.pid`, `app-server-updater.pid` under `<dir>/app-server-daemon/` (whichever exist); the content is JSON; take `pid` and `processIdentity.startTicks` (or `processStartTime` when missing) and compare with the start time in `/proc/<pid>/stat` (field 22); a match means the daemon is alive and deletion is refused; a missing file or parse failure counts as not alive.
- When the checks pass, it is deleted with Node's `fs.rm(dir, { recursive: true, force: true })`, never through a shell, and removed from `codex.ignoredDirs` again (a directory recreated later with the same name is auto-discovered).
- Deleting a shared account's directory removes only its own files and its symlinks (`fs.rm` does not follow symlinks); the shared sessions, history, settings and thread databases in `~/.codex` are kept; on Windows the account's independent databases belong to its own directory.

### 10.9 Terminal

- Create a terminal named `Codex (<account name>)` and send:
  - non-default account: `env CODEX_HOME='<absolute path>' codex`; ` login` is appended when signed out.
  - default account: `env -u CODEX_HOME codex`, which overrides both sources: an rc file export and inheritance from the server's cached environment.
- With ` login`, the sign-in tip of 4.4 step 3 is shown ("Sign in to Codex in the terminal. …").
- When a terminal created by this extension closes, the view is refreshed. Prerequisite: a `codex` command on PATH.

### 10.10 Refresh triggers

- Creation, change or deletion of `auth.json` in the directory of each account row (including the external-directory row);
- creation, change or deletion of the state file `~/.config/planswap/codex-home` (so the "takes effect after restart" banner shows up when another window switches);
- when the panel becomes visible again; after adding or removing an account; after a terminal created by this extension closes; when the refresh button is clicked (which also scans and registers unregistered `~/.codex-*`); when `planswap.language` changes.

### 10.11 State file and rc marker block

- State file: `~/.config/planswap/codex-home`, directory 0700, file 0600. Content is the absolute path of the selected directory, or empty (default account). Atomic write: temporary file in the same directory + `fsync` + `rename` + directory `fsync`.
- The marker block is written to both `~/.profile` and `~/.bashrc` with the following content (login shells use the former, non-login interactive terminals the latter; when `~/.profile` sources `~/.bashrc` it runs twice, which is idempotent and harmless). The block is never localized; it is identical whatever the UI language:

```bash
# >>> planswap codex >>>
if [ -r "$HOME/.config/planswap/codex-home" ]; then
  _planswap_codex_home="$(cat "$HOME/.config/planswap/codex-home" 2>/dev/null)"
  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then
    export CODEX_HOME="$_planswap_codex_home"
  else
    unset CODEX_HOME
  fi
  unset _planswap_codex_home
fi
# <<< planswap codex <<<
```

- In `~/.bashrc` it is inserted before the interactive guard (the `case $- in` line) with a blank line added before the block; if no guard is found it is appended at the end. In `~/.profile` it is appended at the end. The files keep their original permissions; a missing file is created with 0644. The rc files are written atomically.
- When the state file is empty or the directory does not exist, the block runs `unset`, so after switching back to the default account new terminals do not inherit the old value cached by the server. Once enabled, this extension owns `CODEX_HOME` exclusively.
- Appending at the end adds a blank line before the block when the file ends with a newline, and only the missing newline otherwise.
- Removal deletes everything from the start marker to the end marker (including the marker lines) and the blank line (or newline) added on installation, so install + remove restores the original bytes of a file that existed before (a file created by enabling is left empty); when the end marker is missing in either file an error is thrown and neither file is changed.
- "Enabled" for the Codex page = both files have the marker block.
- Upgrading from 0.1.0 - 0.1.3 (named ai-switcher): on activation the old blocks (`# >>> ai-switcher codex >>>`) are replaced in place by the block above and the selected account in `~/.config/ai-switcher/codex-home` moves to the new state file, so Codex switching stays enabled with the same account and no server restart is needed. If an old block lacks its end marker, a warning is shown, nothing is changed and the Codex page shows the pre-check reason; fix the block by hand. An older version still installed in another editor on the same distro shows Codex switching as disabled until it is upgraded.

### 10.12 Shared and independent Codex accounts

Same model as on the Claude side (section 5), with the default directory `~/.codex`.

- **Shared entries** (absolute symlinks to the same entry of `~/.codex`):
  - files: `config.toml`, `AGENTS.md`, `hooks.json` (created with `{}` when missing), `history.jsonl`, `session_index.jsonl`;
  - on Linux, thread databases linked as single files even while the default one does not exist yet (Codex creates it at the link target; nothing is pre-created): `state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`; SQLite puts its `-wal` / `-shm` files next to the target;
  - `.tmp/rollout-maintenance.lock` (inside a real `.tmp` folder of the account; `.tmp` itself is never linked, and `~/.codex/.tmp` is created when missing), so two accounts do not maintain the shared rollouts at the same time;
  - folders: `sessions` (the marker), `archived_sessions`, `rules`, `hooks`, `agents`, `themes`, `thread-writer-locks`, `rollout-migrations`, `attachments`, `generated_images`, `shell_snapshots`, `tui-thread-reference-capabilities`;
  - per child: every child of `~/.codex/skills` except `.system`, and of `~/.codex/plugins/cache` except `openai-curated-remote`.
- **Never shared** (stay per account): `auth.json`, `memories/` and the memories databases (Codex refuses a symlinked memory root), logs, the app-server daemon files, caches, `installation_id`, `version.json`, the rest of `plugins/`, `.tmp/rollout-compression.lock` (Codex creates it with `O_EXCL`, which fails on a dangling link), and every other entry not listed above.
- `config.toml` is not linked ("not linked for safety") when the default config cannot be read or sets one of the top-level keys `model_provider`, `forced_login_method`, `forced_chatgpt_workspace_id`, `sqlite_home`, `log_dir`, `cli_auth_credentials_store`, `mcp_oauth_credentials_store`, `chatgpt_base_url`, `openai_base_url`, `profile`, `oss_provider`, or a `model_providers` / `profiles` table (same TOML detection as in 10.7).
- Repair: when Codex has replaced the `history.jsonl` or `session_index.jsonl` link of a shared account by a regular file (it rewrites `session_index.jsonl` by rename when a thread is deleted), the lines the default file lacks are appended to it, the account file is removed and the link re-created. A regular thread database in a shared account (after a Codex version bump or corruption recovery) is reported as kept and left untouched. Other entries the account has as its own are reported and left untouched, as on the Claude side.
- Links are refreshed when adding the account, after the switch confirmation (10.6), by "Re-link" (5.5) and after converting it; there is no `.claude.json`-style mirror on the Codex side.
- **Independent accounts**: see 10.7 step 3.
- **Converting** an independent account (the row's `link` button; not for the account effective in this window or the selected account: "Switch away from X before linking it."):
  1. On Windows, the confirmation explicitly keeps thread databases per account and explains that files which cannot be linked remain local. On Linux, modal confirmation "Link X to the default account? Its sessions, history, settings, rules, skills and thread databases in <dir> are moved into the default account and replaced by links; the login and memories stay per account. Files that differ from the default account's are kept for manual merging: inside linked folders next to the default file with a .from-<name> suffix; config.toml, AGENTS.md, hooks.json and the thread databases in the account directory as <file>.independent-backup. Resuming a session started by another ChatGPT account may be rejected by the server. This cannot be undone automatically.", button **Link**.
  2. Busy check: a live app-server daemon of the account (as in 10.8), or any process whose executable is named `codex` and whose `CODEX_HOME` (from `/proc/<pid>/environ`) resolves to the account directory (on Windows only the daemon and the account's open PlanSwap terminal, see [Windows support](design.md#windows-support)) → an account-busy warning asks the user to close Codex sessions and any PlanSwap terminal tabs for the account, and nothing changes. On Linux, processes that merely inherit `CODEX_HOME` (shells, MCP servers) do not count; on Windows an open PlanSwap account terminal still blocks the operation after its CLI exits.
  3. Migration into `~/.codex`, never overwriting: folders are merged as on the Claude side (differing files kept as `<file>.from-<account name>`); `history.jsonl` / `session_index.jsonl`: the lines the default file lacks are appended; `config.toml` / `AGENTS.md` / `hooks.json` / `.tmp/rollout-maintenance.lock`: when `~/.codex` lacks the file it is moved there and becomes the shared one (a `config.toml` with a login-related key stays in the account and is not linked); otherwise the default wins, an identical copy is dropped and a different one is renamed to `<file>.independent-backup` (`config.toml` stays when the default config cannot be shared); each thread database is renamed with its `-wal` / `-shm` files to `<db>.independent-backup` (Codex rebuilds thread metadata from the session files); the `skills` and `plugins/cache` children are merged; finally all links are created.
  4. Summary notification as on the Claude side (4.6 step 5), then the view is refreshed.
- **Unlink a shared Codex account**: the `debug-disconnect` button of a shared named row that is neither effective nor selected (otherwise "Switch away from X before unlinking it."), as in 4.7: Windows uses a separate confirmation that keeps thread databases and any existing local data in the account. The Linux modal reads "Unlink X from the default account? The links in <dir> are removed and the account gets its own copy of the default configuration, rules and skills. Shared sessions, history and thread databases stay in the default account and are not copied; existing local data is kept. The login and memories stay. This cannot be undone automatically." (button **Unlink**), busy check as in step 2 above, then `makeCodexIndependent` removes every link into `~/.codex` (including dangling `link-only` links such as the thread databases and `.tmp/rollout-maintenance.lock`, and the `skills/` / `plugins/cache` children) and copies the default configuration once as `copyCodexIndependent` does (`config.toml` seed with its blocked-key rules, `AGENTS.md`, `hooks.json`, the config folders and the `skills/` children). `sessions`, `history.jsonl`, `session_index.jsonl` and the thread databases stay in `~/.codex`; `auth.json` and `memories/` are untouched. Notification "X is now independent: removed N link(s), copied <list>." plus " Not copied: <file> (<reason>)." when the seed was skipped.

## 11. Language

- Setting `planswap.language` (scope `application`): `auto` (default) follows the VS Code display language (language family `zh` → `zh-cn`, `es` → `es`, `ja` → `ja`, otherwise `en`, including regional variants such as `es-MX`, `es-ES` and `ja-JP`); `en` English; `zh-cn` 简体中文; `es` Español; `ja` 日本語.
- Upgrading from 0.1.0 - 0.1.3 (named ai-switcher): a user-level `aiSwitcher.language` of `en` / `zh-cn` is copied once to `planswap.language` on activation when the new setting has no user-level value. The old key stays in settings.json (it can no longer be written by the extension); remove it by hand if you like.
- Changing the setting takes effect immediately, without a reload, for everything rendered at runtime:
  - the sidebar panel re-renders completely in the new language: tabs, section titles, banners, buttons, tooltips, aria-labels, placeholders, the add-section help text, validation messages, the disabled Codex page, the "Tools" section, the footer toolbar titles and the version card;
  - the status bar text and tooltip ("Not logged in", "External directory");
  - notifications, warnings, errors, modal dialogs and their buttons, QuickPick items and placeholders, and error reasons produced by the extension (validation messages, safety-check reasons, pre-check reasons, restart errors).
- Command titles, command categories, the activity bar container and view names, and the setting's own description are static `package.json` strings resolved by VS Code from `package.nls.json` (English), `package.nls.zh-cn.json` (Simplified Chinese), `package.nls.es.json` (Spanish) and `package.nls.ja.json` (Japanese) according to **VS Code's display language**; they do not follow `planswap.language` (platform limitation). Change VS Code's display language to change them.
- Never translated: shell commands sent to terminals, file names and paths, setting ids, command ids, terminal names `Claude (<label>)` / `Codex (<label>)`, plan names (`Pro`, `Max 20x`, `Plus`, `API key`, ...), and the rc marker block written to `~/.profile` / `~/.bashrc` (see 10.11).
- Aliases are user data and are shown as typed in every language. The external-directory name is reserved in all four languages (every localized name is rejected as an alias).

### Account action and keyboard semantics

- The Claude/Codex tabs support Left/Right (wrapping) and Home/End; selection and keyboard focus move together.
- Codex rows distinguish the effective account from the selected account. While a selection is pending, selecting the effective account again cancels that pending selection. Switch buttons, Enter and double-click use the same rule. Selected accounts do not offer link, unlink or removal actions; host validation remains authoritative.
- Deleting a linked account directory preserves link targets in the default account, but permanently removes local credentials, per-account memories, backups and other unlinked data. The confirmation states this boundary.
- Re-link results claim success only for clean reports. Reports with notes or exceptions use an attempted-operation summary and retain the details.

## Status bar account summary

The right side of the VS Code status bar shows the product names Claude and Codex with the remaining percentage of their short usage window (section 3). Only vendors with local account configuration are shown; when neither is present, the item is hidden. Hover to see each displayed vendor's email, plan and usage windows. Codex shows the effective account and separately identifies any pending selection requiring a restart. Click to open PlanSwap. This display uses local files and remains available offline.

The Codex block of the tooltip also shows the **usage limits of the effective Codex account** ([Codex design 8.7](codex-design.md#87-usage-limits)):

- one table row per limit window laid out as the Claude rows (section 3: name, bar, remaining percentage, relative reset time; `$(warning) Used up` at 0%); windows past their reset time and observations older than 24 hours are left out;
- the italic status lines of section 3: "Checking usage limits…" while a query runs, "Usage check failed" when it fails, "Usage limit reached" when a limit is hit;
- a refresh link after the plan in the header row; the sidebar button and the Command Palette refresh too ([Usage refresh buttons](#usage-refresh-buttons));
- nothing for signed-out accounts; API key accounts show "API key" in the header without usage rows; on native Windows with Codex run inside WSL, the note "Codex runs inside WSL here (chatgpt.runCodexInWindowsSubsystemForLinux); switch its accounts from a WSL window." instead.

PlanSwap asks the official `codex` CLI (`codex app-server` with the account's `CODEX_HOME`), which contacts OpenAI's service; it uses `codex` from PATH or, when there is none, the binary bundled with the Codex extension (`openai.chatgpt`) for this OS and architecture. It checks a few seconds after activation, then at most every 15 minutes (`planswap.codex.usageRefreshMinutes`) and only while the window is focused, right after the effective account's `auth.json` changes (a sign-in, re-login or sign-out), and on demand; `planswap.codex.usageAutoRefresh` off leaves only the on-demand checks. API key accounts are never queried. Live tooltip results stay in memory; successful observations also populate the local account history described below.

### Codex account usage observations

Signed-in ChatGPT account rows show each last-observed usage window as a remaining percentage (`100 - usedPercent`, rounded to at most two decimal places) and a progress bar. Labels follow the reported duration, such as "5-hour limit" and "7-day limit". Each window is two lines: the duration at the left with the time until the reset at the right (a `clock` icon and a short duration), then the progress bar with the remaining percentage (`58%`) in a fixed-width column at its right, so every bar has the same length and the reset time and percentage form one right-hand column; a duration that does not fit wraps between words in its own column. The short duration uses `Intl.DurationFormat` in the panel language with the two largest units and a zero unit left out, rounded up to the minute: at least a day shows days and hours ("2d 5h", Chinese "2天5小时", Japanese "2 日 5 時間"), under a day hours and minutes ("5h 20m"), under an hour minutes ("45m"). Its tooltip is the full sentence with the exact local date/time (month/day and 24-hour hours/minutes without year or seconds, e.g. Chinese "3小时后重置（10月4日 07:30）"), which is also part of the bar's screen reader value; the percentage's tooltip is "58% remaining". No reset label is shown when the time is missing. A window with nothing left (0% remaining) shows a hatched, outlined empty track, a red "0%" and its reset time in red bold, since when it comes back matters most; there is no separate "Used up" tag (the progress bar's screen reader value still says it). The bar color follows the remaining share (green, amber at 30% or less, red at 10% or less), but the percentage text always states it too; high-contrast themes outline the track with the contrast border. The localized collection date/time appears only when hovering over the usage area; there is no visible collection timestamp or "not live" label. This helps compare previously used accounts before switching. Only the effective account is queried automatically; an account without an observation has no usage line. Use **Refresh Codex Usage Limits** to update the effective account, or **Refresh Usage Limits of All Codex Accounts** ([10.3.1](#1031-refresh-usage-limits-of-all-codex-accounts)) to query every registered signed-in ChatGPT account. Observations remain available after reopening the editor, expire after 24 hours, and hide individual windows, including their reset labels, once the current time reaches their reset time. The existing minute refresh updates expiry (up to one minute of display delay). A changed sign-in file hides old values until the account is queried again. API-key accounts have no usage observations; Claude rows are described in [Claude usage limits](#claude-usage-limits). See [Codex design 8.7](codex-design.md#87-usage-limits) for storage and scheduling.

### Claude usage limits

The Claude block of the status bar tooltip shows the **usage limits of the current Claude account** when it is a subscription sign-in ([Claude design 6.9](design.md#69-claude-usage-limits)):

- one table row per general limit window as in section 3, e.g. `5h ██████░░░░ 58% $(clock) 2h`, and `7d …`, no model-specific rows;
- the italic status lines of section 3: "Checking usage limits…" while a query runs, and "Usage check failed" for a failed query of the current account (whatever the reason);
- a refresh link after the plan in the header row (current account only); see also [Usage refresh buttons](#usage-refresh-buttons);
- nothing for signed-out and non-subscription accounts, and nothing is started for them.

### Usage refresh buttons

The account list title row of each page has icon buttons to the left of "+ Add" (on narrow widths they wrap below the title, right-aligned); title and screen reader label are the same text:

- `refresh` ("Refresh usage limits of the current account", both pages) runs the page's refresh command (`planswap.claude.refreshUsage` / `planswap.codex.refreshUsage`) through the panel's `tool` message (`refreshUsage`);
- `layers` ("Refresh usage limits of all accounts", both pages) runs the page's refresh-all command (`planswap.claude.refreshAllUsage`, 4.9 / `planswap.codex.refreshAllUsage`, 10.3.1) through the panel's `tool` message (`refreshAllUsage`).

A button is shown only when it can do something: the refresh button when the current row can be queried (Claude: a subscription sign-in; Codex: a signed-in ChatGPT account, not API key, and Codex not run inside WSL), the refresh-all button when any registered (non-external) row of that page can be queried; both are hidden while the page is disabled or no account qualifies. There is no extra "checking" state on the buttons: repeated clicks join a running query, and a running refresh-all ignores a second one. The Command Palette commands stay available.

### Manual refresh cooldown

The usage endpoints behind both official CLIs are rate limited per account (Claude documents it; see [Claude design 6.9](design.md#69-claude-usage-limits)), so manual refreshes (the refresh button, the tooltip link, the Command Palette and refresh-all) do not query an account again within 60 seconds of its last query. Every query of the window counts, including scheduled ones; for Claude, so does a usage cache that Claude Code fetched in any window or terminal. A single refresh within the cooldown shows "Usage limits were checked less than a minute ago; try again in {seconds} s." and starts nothing (a query that is already running is still joined); refresh-all skips such accounts and says how many it skipped. Scheduled checks follow their own interval and are not affected. The cooldown is per product and per account, kept in memory only.

Signed-in Claude rows show the usage that Claude Code last cached in that account's own `.claude.json`, rendered like Codex observations: remaining percentage with a progress bar per window, labels such as "5-hour limit" and "7-day limit" (model-specific windows appear only when `planswap.sidebar.showModelLimits` is enabled; windows such as "7-day limit · Fable" then follow the general windows, always shown and never folded), the reset time in each window's label line (as for Codex), and the collection time on hover. This covers every registered signed-in account, not only the current one, but only the current account is queried automatically; **Refresh Usage Limits of All Claude Accounts** queries every registered signed-in account on demand, and otherwise another row shows what its last query (in any window or from a terminal) left behind. A row has no usage line when nothing was cached, the cache is older than 24 hours, or it belongs to a different sign-in than the one now in that directory (after a re-login the old values are hidden until the new account is queried); a window disappears at its reset time (within a minute). Missing data never means 0%. There is no separate saved history.

PlanSwap runs `claude -p /usage` (a local Claude Code command that sends no prompt) with the account's `CLAUDE_CONFIG_DIR`, unset for the default account, and Claude Code refreshes the cache itself. It checks a few seconds after activation and afterwards only while the window is focused, and only when the account's cached values are older than 15 minutes (`planswap.claude.usageRefreshMinutes`; whoever refreshed them: another window, a terminal, or Claude Code itself; `planswap.claude.usageAutoRefresh` off leaves only manual refreshes), so several windows do not each start `claude`; a switch to an account with an older cache is checked at once. **Refresh Claude Usage Limits** always queries the current account; **Refresh Usage Limits of All Claude Accounts** (4.9) queries all registered signed-in accounts, one at a time, and never runs by itself.

## Diagnostics report

Run **Preview Diagnostics Report** in the PlanSwap tools category of the Command Palette. An untitled Markdown document shows the report in the configured PlanSwap language. After previewing it, choose **Copy report** in the notification to put that report on the clipboard; dismissing the notification leaves the clipboard unchanged. Nothing is uploaded automatically.

The report contains PlanSwap/editor/CLI/official-extension versions, platform and connection type, anonymous account references and named-account counts, Claude credential-override variable names (never their values), and Codex switching state, pre-check status and restart guidance. Named accounts use numbered references consistent within the report; aliases, account names, directories, emails, identity identifiers and raw errors are omitted. Unrecognized version output is reported as unknown. Claude's configured account is not proof of the official extension's live login identity. Windows run-in-WSL mode omits local account and switching-state lines and directs the user to a WSL window; the report cannot inspect that side's accounts.

Collection is read-only: CLI probes only request versions, account references come from local configuration, and Codex enable checks do not install rc blocks, change environment variables or restart anything. The report is a troubleshooting snapshot, not a real-account acceptance test.
