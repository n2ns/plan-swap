# Privacy

PlanSwap manages your accounts locally, in your WSL environment, Linux account or Windows user profile. It includes no telemetry or analytics and makes no network requests of its own.

## What goes over the network

PlanSwap itself sends nothing. To show usage limits, it runs the official CLI for each account it checks: automatically every signed-in account (or only the current ones, if you choose so in the settings), and any account you refresh by hand.

- **Claude**: `claude -p /usage` with that account's directory. It sends no prompt.
- **Codex**: `codex app-server` with that account's `CODEX_HOME`, or the binary bundled with the Codex extension when `codex` is not installed.

The CLI then contacts Anthropic's or OpenAI's service as it always does. Sign-in, CLI updates and AI requests are handled by the official Claude Code and Codex clients, which have their own network behavior and privacy policies.

## What PlanSwap reads

- **Email and plan** of each account, read locally for display.
- **Claude sign-in**: PlanSwap never reads the contents of `.credentials.json`. It reads the CLI's structured usage report in memory to validate a refresh; displayed values and their fetch time come from the usage cache Claude Code keeps in the account's `.claude.json`. Raw CLI output and session metadata are never logged, saved or sent to the sidebar.
- **Codex sign-in**: PlanSwap reads `auth.json` locally and decodes its `id_token` payload for account information and identity comparison. It never copies, swaps or rewrites the file, and never sends raw tokens to the sidebar.
- **Account identifiers** used to detect duplicate sign-ins, attribute usage data and check for sign-in changes during a query stay in memory; they are never shown or saved.

## What PlanSwap stores

- **Account data**: account lists, display names, accounts excluded from recommendations, hidden-account records and dismissed warnings are saved in `~/.config/planswap/state.json` inside each WSL environment (on Windows, `%USERPROFILE%\.config\planswap\state.json`).
- **Codex usage records**: the same file keeps each Codex account's last usage values, when they were checked, the account directory and the size and modification time of its sign-in file; no tokens or account identifiers. Records survive restarts, are hidden when the sign-in file changes, and expire after their reset time or 24 hours.
- **Claude usage**: PlanSwap keeps no separate usage store; it reads Claude Code's official cache, including eligible historical values after a failed query.
- **Codex selection**: the selected Codex account is saved in `~/.config/planswap/codex-home` while Codex switching is enabled.
- **Sidebar tab**: the selected tab is saved in the editor's extension storage.

## What PlanSwap changes

- **Switching** updates the settings that select an account.
- **Enabling Codex switching** adds configuration to `~/.profile` and `~/.bashrc` after you confirm (on Windows it sets your user environment variable `CODEX_HOME` instead).
- **Linking** shares settings and history, and writes a linked Claude account's MCP servers, project trust settings and first-run status into its own `.claude.json`. It never links or copies sign-in credential files.
- **Deleting accounts**: removing a row does not delete its files unless you separately confirm directory deletion. Deleting the directory permanently removes that account's sign-in and local data; linked data in the default account is kept.

To remove what PlanSwap stored, follow the [uninstall steps](../README.md#uninstall).
