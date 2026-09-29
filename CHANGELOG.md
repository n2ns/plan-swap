# Changelog

## [Unreleased]

### Added

- Claude and Codex each have a **Share with Default Account** command that selects an eligible independent account and opens the existing conversion confirmation.
- A localized diagnostics report previews anonymous account-selection and environment information before you choose whether to copy it for troubleshooting.
- Codex account rows show their last observed usage with a collection time and a "not live" label. Observations survive editor restarts, hide after a sign-in file change, and expire after a reset or 24 hours; accounts without an observation show no usage estimate.

### Fixed

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
