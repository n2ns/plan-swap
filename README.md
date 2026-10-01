<p align="center">
  <img src="resources/icon.png" alt="PlanSwap" width="128" height="128">
</p>

# PlanSwap: Claude Code & Codex Account Switcher

Switch between the Claude Code and Codex subscription accounts you own (Claude Pro / Max, ChatGPT Plus / Pro…) from a VS Code sidebar, without signing out and back in. Built for VS Code WSL remote windows and native Windows.

> **WSL/Linux or native Windows, with a VS Code 1.107+ compatible editor.** macOS is not supported. See [Requirements](#requirements) and [Native Windows](#native-windows).

[![Version](https://img.shields.io/visual-studio-marketplace/v/n2ns.planswap?style=flat&label=version)](https://marketplace.visualstudio.com/items?itemName=n2ns.planswap)
[![Install from VS Marketplace](https://img.shields.io/badge/VS_Marketplace-Install-007ACC?style=flat)](https://marketplace.visualstudio.com/items?itemName=n2ns.planswap)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/n2ns/planswap?style=flat&label=Open%20VSX%20downloads&cacheSeconds=86400)](https://open-vsx.org/extension/n2ns/planswap)
[![CI](https://img.shields.io/github/actions/workflow/status/n2ns/planswap/test.yml?branch=main&style=flat&label=CI)](https://github.com/n2ns/planswap/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

![PlanSwap concept illustration showing separate Claude Code and Codex account switching panels](resources/planswap-banner.webp)

## Features

- **One sidebar, two tabs**: manage Claude and Codex accounts separately, with email and subscription plan shown when available.
- **Keep accounts signed in**: sign in once per account, then switch from the sidebar. Codex switches require a restart (see below).
- **Linked or independent accounts**: reuse the default account's setup, or keep separate settings and session histories.
- **Display names**: give named accounts labels that are easy to recognize.
- **Claude usage limits**: hover the status bar item to see the current Claude account's session and weekly limits, including model-specific ones. Every signed-in Claude account row shows the values its last check left in that account's own folder; values older than 24 hours are not shown.
- **Codex usage limits**: hover the status bar item to see the current Codex account's usage limits and reset times. Account rows retain the last observation with its collection time and a "not live" label; missing observations are not shown as zero usage.
- **Handy tools**: open your rules and settings, update the CLI, check installed versions and reload the editor.
- **English, Simplified Chinese, Spanish and Japanese UI**, switchable in the settings.

## Requirements

- Antigravity IDE, VSCodium or VS Code, 1.107 or later, used through a **WSL remote window** (see [Supported editors](#supported-editors)) or as a local editor on **native Windows** (see [Native Windows](#native-windows)).
- The official Claude Code and/or Codex extensions installed where the window runs (the WSL side, or Windows).
- The corresponding CLI installed there to use terminal sign-in and CLI tools.
- For Codex switching in WSL: `bash` as the login shell.

## Supported editors

For Claude, new sessions use the selected account; reload the window to update open panels. For Codex, follow the restart steps for your editor:

| Editor | After switching a Codex account |
| --- | --- |
| Antigravity IDE | After your confirmation, PlanSwap restarts the WSL server. Click **Reload Window** in each disconnected window. |
| VSCodium | After your confirmation, PlanSwap restarts the WSL server. Click **Reload Window** in each disconnected window. |
| VS Code | Close all VS Code windows connected to that WSL distribution, wait a few seconds, then reopen them. |
| Local Linux desktop editor | The selection is saved and PlanSwap shows instructions: fully exit the editor and relaunch it with `CODEX_HOME` set to the selected account directory. |
| Native Windows | The selection is saved in your user environment variable `CODEX_HOME`. Fully quit the editor and start it again from the Start menu or taskbar. |
| Other remote windows | The selection is saved and PlanSwap shows instructions for restarting the remote editor server with `CODEX_HOME` set. |

**Save your work before switching Codex accounts.** Restarting the WSL server disconnects its editor windows and closes integrated terminals and running CLI sessions. Reloading just one window does not replace this restart or a manual relaunch.

Only Antigravity IDE in WSL has been tested end to end. VSCodium, VS Code and native Windows support have not yet been verified end to end in their real editor environments.

## Install

Open the Extensions view in a **WSL window** (the extension runs on the WSL side) or in a local Windows window, search for **PlanSwap** and click **Install**.

- VS Code: [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=n2ns.planswap)
- Antigravity IDE, VSCodium: [Open VSX](https://open-vsx.org/extension/n2ns/planswap)

If you already have a `.vsix` file, run **Extensions: Install from VSIX...** in a WSL window or a local Windows window and select it.

## Quick start

Open **PlanSwap** in the activity bar. The `default` row represents your existing default account. Use the Claude or Codex tab for the service you want to manage.

**Claude**

1. Type a name (letters, digits, `-` and `_`) in **Add account** and press Enter. Leave **Link to the default account's settings and history** checked to reuse your default setup, or uncheck it for separate settings and history.
2. Click the row's **Log in** button and complete sign-in in the terminal. You can also switch to the account and sign in from the Claude Code panel.
3. Click the switch icon on any row. New sessions use that account; click **Reload Window** in the banner to move open panels over too.

**Codex**

1. On the Codex tab, click **Enable Codex switching** and confirm the shell configuration changes shown by PlanSwap.
2. Add an account, choose linked or independent, then click **Log in** and complete sign-in in the terminal.
3. Click the switch icon and follow your editor's [restart steps](#supported-editors). Codex uses the selected account after the restart.

**Tip:** signing in a new account does not sign out the others. Each account keeps its sign-in in its own folder, so there is no need to sign out first; signing out ends that account's session. PlanSwap warns you when two accounts are signed in to the same account and workspace, because switching between them gives no separate usage limits.

Use the pencil button to change a named account's display label. Use the refresh button at the top of the panel to rescan accounts and update their displayed information.

## Linked and independent accounts

Choose how each new account uses your default setup:

| | Linked | Independent |
| --- | --- | --- |
| Settings, rules and skills | Uses the default account's shared setup | Starts with a copy of the default configuration; later changes stay separate |
| History and sessions | Shares the default account's history and sessions | Keeps its own history and sessions |
| Sign-in | Separate for each account | Separate for each account |
| Best for | Accounts you use with the same setup | Accounts that need separate setups and histories |

Linked rows show a link badge. Codex memories remain separate, including for linked accounts. Sharing session files does not guarantee that another account can resume them; see [Known limitations](#known-limitations).

You can change an existing account's mode after switching away from it and closing its sessions:

- **Link to the default account** moves its settings and history into the shared setup. Conflicting files are kept for you to merge manually; review the result reported by PlanSwap.
- **Unlink from the default account** gives it a separate copy of the default configuration and keeps its sign-in. Shared history and sessions remain with the default account, so the unlinked account starts with an empty history.

Use **Re-link** in the Tools row to refresh shared settings and repair links. It appears only when the selected tab has a linked account.

The Command Palette also offers **Share with Default Account** separately for Claude and Codex. Choose an eligible independent account and review the conversion confirmation.

## Tools

The Tools row and footer let you open rules and settings, check CLI and extension versions, reload the window, or restart the extension host. Codex account switching offers a restart in its confirmation dialog when supported, or explains the manual steps.

**Update CLI** opens a terminal for the selected service. Follow its progress and prompts there. If your CLI was installed in a custom location, you may need to update it using its original installation method.

For troubleshooting, run **Preview Diagnostics Report** from the Command Palette. It opens an anonymous report of versions, account-selection state and environment checks. Review it before choosing **Copy report**; nothing is uploaded automatically.

**User guide** opens this README; **Star** opens the GitHub repository. The footer also shows your installed PlanSwap version.

## Language

In extension settings, set `planswap.language` to `auto` (follow your editor), `en` (English), `zh-cn` (简体中文), `es` (Español) or `ja` (日本語). The panel and messages update immediately; Command Palette titles and the sidebar name follow the editor's display language.

## Known limitations

- **Open sessions keep their current account.** Reload Claude panels after a switch; complete the WSL server restart or the manual relaunch for Codex.
- **Switching is not per window.** Other windows of the same editor connected to the same WSL environment are affected too.
- **Continuing another account's session can fail**, particularly between Codex accounts in different ChatGPT organizations. Avoid opening the same session from two accounts at once.
- **Some shared settings need a refresh.** After changing the default setup, use **Re-link**. If PlanSwap reports conflicting files, resolve them manually. Deleting Claude prompt history from a linked account does not necessarily remove it from the shared history.
- **MCP connections may need sign-in again for each account.** Claude MCP settings copied from the default account can include API keys stored in those settings; choose account setups accordingly.
- **Some sign-ins are not per account.** An API key, auth token or long-lived OAuth token in the environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`), a named Anthropic profile (`ANTHROPIC_PROFILE`) or a cloud provider switch outranks every account's sign-in, and PlanSwap warns when it sees one. A Claude Console sign-in *without* an API key is stored outside the account folders (`~/.config/anthropic`, on Windows `%APPDATA%\Anthropic`) and signs out every claude.ai login on the machine, so it cannot be kept per account.
- **OneDrive (Windows).** If your user folder is synced by OneDrive, PlanSwap warns: OneDrive sync has corrupted Claude Code's `.claude.json`, and all account folders live there.

## Native Windows

PlanSwap also runs in a local Windows editor (no remote window). Claude switching works as in WSL (`CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`). Differences:

- **Codex** is selected through the per-user environment variable `CODEX_HOME`. Enabling asks for confirmation and refuses when you already set that variable yourself (a value pointing at one of your `~/.codex-<name>` account folders is adopted). After a switch, **fully quit the editor and start it again from the Start menu or taskbar**; Reload Window and terminals started before the switch keep the old value. Accounts opened through PlanSwap terminals always get the right value.
- **Sharing** links folders with directory junctions (no privileges needed). Linking single files (`settings.json`, `history.jsonl`, ...) needs Windows Developer Mode or an elevated editor; without it PlanSwap still links the folders, asks in a dialog whether to copy small config files (`settings.json`, `CLAUDE.md`, `config.toml`, `AGENTS.md`, `hooks.json`) once so a shared account starts with them (later edits are not shared; declining leaves them out), keeps history and databases independent, never moves an account's files away, and tells you to turn on Developer Mode; the dialog has an **Open Developer Settings** button that opens that page of Windows Settings. Turn it on and use Re-link: missing files are linked and copies still identical to the default become links. Codex's thread databases (`*.sqlite`) are never linked on Windows, because SQLite there loses writes made through a linked database; each account keeps its own, while sessions, history and configuration are still shared.
- **Busy checks** cannot tell which account a running Claude or Codex process belongs to. PlanSwap refuses to convert an account (or remove a Claude account) while its own PlanSwap terminal is open, while a Claude session recorded in its unshared folder is still running, or while its Codex daemon runs. Close the account's sessions and any PlanSwap terminal tabs for that account before converting or removing it, even if the CLI has already exited.
- When `chatgpt.runCodexInWindowsSubsystemForLinux` is enabled, PlanSwap treats Codex as WSL-run and refuses Codex switching in the Windows window; manage those accounts from a WSL window, or turn the setting off. The Codex extension's behavior with this setting remains part of the native Windows acceptance checklist.
- Codex account information is read locally as described in [Privacy](#privacy); `auth.json` is never copied or rewritten. Accounts signed in through the OS keyring instead of `auth.json` show as signed out.

## Privacy

Account management runs locally in your WSL environment or Windows user profile. PlanSwap includes no telemetry or analytics and makes no network requests of its own. To show usage limits, it runs the official `claude` CLI (`claude -p /usage`, which sends no prompt) or `codex` CLI with the current account's folder, which asks Anthropic's or OpenAI's service as the CLI always does.

- **Local storage**: account lists, display names and hidden-account records are saved in `~/.config/planswap/state.json` inside each WSL environment (on Windows, `%USERPROFILE%\.config\planswap\state.json`). The selected sidebar tab is saved in the editor's extension storage.
- **Usage observations**: the same local state file stores Codex quota values, collection times, account directory paths and sign-in file metadata, without tokens or account identity claims. Observations survive restarts, hide when the sign-in file changes, and expire after their reset time or 24 hours.
- **Account information**: email and plan details are read locally for display. PlanSwap never reads the contents of Claude's `.credentials.json`; Claude usage values come from the usage cache Claude Code keeps in the account's `.claude.json`. It reads Codex's `auth.json` locally and decodes the `id_token` payload for account information and identity comparison, but never copies, swaps or rewrites the file, or sends raw tokens to the sidebar. Account identifiers used to detect two accounts signed in to the same account stay in memory and are never shown or saved.
- **Configuration changes**: switching updates the settings that select an account. Enabling Codex switching adds configuration to `~/.profile` and `~/.bashrc` after confirmation (on Windows it sets the user environment variable `CODEX_HOME` instead). Linking accounts shares settings and history; it never links or copies their login credential files.
- **Deleting accounts**: removing a row does not delete its files unless you separately confirm directory deletion. Deleting the directory permanently removes that account's login and local data. Shared data in the default account is kept.

Sign-in, CLI updates and AI requests are handled by the official Claude Code and Codex clients, which have their own network behavior and privacy policies. User guide and Star links open GitHub in your browser.

## Uninstall

Before uninstalling PlanSwap:

1. Switch Claude back to `default` and reload the window.
2. If you enabled Codex switching, run **Codex Account: Disable Codex Account Switching** from the Command Palette to remove its shell configuration (on Windows, the user environment variable `CODEX_HOME`).
3. Uninstall PlanSwap from the Extensions view in the window where you installed it (WSL or Windows).

Your account directories (`~/.claude-<name>` and `~/.codex-<name>`) are kept. To clear PlanSwap's saved account list and display names as well, delete `~/.config/planswap/state.json`. This does not delete the accounts' own files.

## Documentation

- [Changelog](CHANGELOG.md): changes in **0.2.1** and earlier versions.
- [Feature reference](docs/features.md): detailed instructions for managing accounts, switching and using panel tools.
- [Documentation map](docs/README.md): development, design, module contracts and verification guides.
- [Blog post](https://n2ns.com/blog/switch-claude-code-codex-accounts-planswap): why PlanSwap exists and how it switches accounts without copying or swapping credentials.

## Disclaimer

PlanSwap is an independent community project and is not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI.

## License

[MIT](LICENSE)

Built by [N2NS Lab](https://n2ns.com/), the open-source lab of [datafrog.io](https://datafrog.io/) for practical AI developer tools.
