# Codex Account Switching: Design

Purpose: Codex account-switching design, shell/environment propagation, editor restart rationale, upstream evidence and limitations. Signatures, per-module behavior and cross-module wiring live in the code (types and TSDoc); observable behavior is in [Features](features.md#10-codex-account-switching), and acceptance procedures in [Manual Verification](manual-verification.md#codex). See [AGENTS.md](../AGENTS.md#read-the-documents-relevant-to-the-task) for ownership.

## 1. Goals and scope

- Goal: add OpenAI Codex account switching to the same sidebar extension. After a switch, the official Codex editor extension, the codex processes it starts, and the codex CLI in integrated terminals all use the selected account, without signing in again.
- Claude account switching is a separate feature; the two do not affect each other.
- Runtime environments: a WSL remote window, where the editor is Antigravity IDE (VS Code 1.107 core) or the also recognized VSCodium and VS Code (section 5), and native Windows (9a). A local Linux desktop window (including one displayed through WSLg, 5.1) and other remote windows only save the selection and show manual restart instructions. On Linux the login shell is bash (section 4).
- Cost accepted by the user: in a WSL window, switching the Codex account requires restarting the editor's server inside WSL (automatic only for Antigravity and VSCodium, see section 5). All WSL windows disconnect and each shows "Cannot reconnect. Please reload the window." once; the user clicks "Reload Window" once in each window. Integrated terminals close. Elsewhere the user restarts the editor or remote server by hand (5.1, 9a).
- Non-goals:
  - `auth.json` is read-only: it is never written, copied, swapped, moved or linked into another directory, and no raw token is cached or output. Only the JWT payload of `tokens.id_token` is decoded (6); the earlier constraint "do not decode tokens, do not show emails" was lifted at the user's request on 2026-09-25. The binding rule is [Codex credentials](../AGENTS.md#account-and-data-safety).
  - Existing content of `~/.codex` is never overwritten; only shared-account operations add to it (8.6).
  - Usage limits are only obtained through the official CLI's `codex app-server`, started with the account's `CODEX_HOME` (8.7); PlanSwap makes no network request of its own, calls no non-public service interface and never switches automatically when the quota runs out.
  - Do not use `chatgpt.cliExecutable`; do not depend on extension activation order.

## 2. Background facts (verified)

This design rests on facts about Codex, the official Codex extension, VS Code and the WSL editor servers, read from source code, logs and the process tree and verified at runtime where noted. They are numbered in the [Codex research record](research/codex.md#facts), with the version and source of each; "fact N" in this document refers to that list. **Re-verify the affected facts after upgrading Codex, the Codex extension, Antigravity, VSCodium or VS Code.**

## 3. Overall design

The WSL flow:

```
~/.profile and ~/.bashrc each have a marker block: read CODEX_HOME from the state file and export / unset
User clicks "Switch" on the Codex page
  → the extension writes the target directory to the state file ~/.config/planswap/codex-home (atomic write + fsync)
  → the extension terminates the WSL-side server and its leftover children (section 5)
  → every WSL window shows "Cannot reconnect"; the user clicks "Reload Window"
  → the new server resolves the environment through a login shell; CODEX_HOME points to the new directory
  → the Codex extension in the new extension host and its codex processes use the new directory
```

An account is a directory: the default account is `~/.codex` (always exists, cannot be removed, effective when the state file is empty), a named account is `~/.codex-<name>`. Registration and auto-discovery are described in [Features 10.1](features.md#101-accounts-and-directories).

## 4. Login shell configuration

- State file: `~/.config/planswap/codex-home`, content is the absolute path of the target directory, or empty (default account). Mode 0600, directory 0700, atomic write (temporary file + fsync + rename + directory fsync).
- Content of the marker block, written in two places, `~/.profile` and `~/.bashrc` (login shells use the former, non-login interactive terminals the latter; when `~/.profile` sources `~/.bashrc` the block runs twice, which is idempotent and harmless). The block is never localized; it is byte-identical whatever the UI language:

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

- When the state file is empty or the directory does not exist, the block runs `unset` instead of doing nothing: after switching back to the default account, newly opened terminals do not inherit the old value cached by the server. Once enabled, this extension owns the variable exclusively.
- In `~/.bashrc` the block is inserted before the interactive guard (`case $- in *i*) ;; *) return;; esac`); if no guard is found it is appended to the end of the file. This way non-interactive login shells such as `bash -lc` also see it.
- Pre-checks before writing (`planswap.codex.enable`):
  1. The extension host's `process.env.SHELL` is bash. For zsh only a snippet is shown for the user to add to `~/.zprofile` and `~/.zshrc`; fish is not supported.
  2. `~/.bash_profile` and `~/.bash_login` do not exist, or they source `~/.bashrc` (a line mentioning `.bashrc` outside a `#` comment); otherwise the reason is shown and nothing is written.
  3. `~/.profile` and `~/.bashrc` contain no `export CODEX_HOME` of the user's own; if they do, the conflict is shown and nothing is written.
  4. A modal confirmation shows the content to be written; an existing marker block is not written again.
  5. If the marker block of either file is damaged (start marker without end marker), an error asks for a manual fix before retrying.
- Self-check after writing: point the state file at a scratch directory next to it, run `bash -i -l -c` printing `__PLANSWAP_CODEX_HOME__=$CODEX_HOME` and check that marked line (other output of the login shell, such as Ubuntu's sudo hint, is ignored), then restore the state file (only while it still names the scratch directory, so another window's switch is kept) and remove the scratch directory non-recursively. When the self-check fails, roll back **per file**: only the marker blocks newly written in this run are removed; files that already had a block before enabling are left alone; then report.
- The rc files are written atomically (temporary file in the same directory + rename), so a half-written rc file can never be left behind. A symlinked rc file is written through to its target; a dangling symlink is never replaced by a regular file (the write is refused with `codex.rc.danglingLink`).
- `planswap.codex.disable`: remove both blocks by their markers and delete the state file. If either file lacks the end marker, an error is thrown, neither file is changed (both files are checked before anything is written), and the user is asked to fix it manually.
- Pre-check reasons, the modal texts and the self-check result are localized; the block written to the files is not.
- **Migrating the pre-rename setup** (`migrateLegacyCodex`, run on every activation before the Codex store is created): versions 0.1.0 - 0.1.3 used the name `ai-switcher` (state file `~/.config/ai-switcher/codex-home`, markers `# >>> ai-switcher codex >>>` / `# <<< ai-switcher codex <<<`, variable `_ai_switcher_codex_home`; otherwise the same block). Without migration an upgraded installation shows the disabled page, and enabling again is refused because the old block's `export CODEX_HOME=` counts as the user's own. The migration replaces each legacy block in place so the file is byte-identical to a fresh installation and removal still restores the original bytes; the algorithm is documented on `migrateLegacyCodex`. The selected directory stays the same, so the server's cached environment still matches and no restart is needed. An older extension version still running in another editor on the same distro sees its block gone and shows its disabled page until it is upgraded.

## 5. Restarting the WSL-side server

- Editor kind (whitelist, not generic parsing): the server root comes from the argv of the extension host's parent (`/proc/<ppid>/cmdline`), its data directory must be exactly one of these directories directly under `$HOME` (symlinks resolved before comparing; see `classifyDataDir`):

| Data directory | Kind | Restart |
|---|---|---|
| `~/.antigravity-ide-server`, `~/.antigravity-server` (older releases) | `antigravity` | automatic (pid file) |
| `~/.vscodium-server` | `vscodium` | automatic (pid file) |
| `~/.vscode-server` | `vscode` | manual guidance only (reason: section 2 item 13) |
| anything else, or detection failure | `unknown` | generic manual guidance only |

- Manual kinds (`vscode`, `unknown`) are never signaled; the switch still writes the state file, and the user restarts the server by hand.
- Locating (automatic kinds): server = the extension host's parent process `process.ppid`. Only act when every check of `planRestart` passes (parent pid, `server-main.js --start-server` argv of an automatic kind, the `product.json` commit, the root directory name, and the pid file `<dataDir>/.<commit>.pid` naming the server's parent wrapper); otherwise refuse and show the manual method.
- Order:
  1. Finish writing the state file first (including fsync).
  2. Enumerate `/proc/*/stat` and collect every child whose parent is the server (extension hosts, pty host, file watcher, etc.), excluding this extension host itself.
  3. Send `SIGTERM` to the server, then to the children collected in step 2. Use `process.kill`, never shell commands. This extension host exits by itself through its parent-process guard.
- Afterwards: every WSL window shows "Cannot reconnect. Please reload the window.", and the user clicks "Reload Window".
- Manual guidance is selected first by `vscode.env.remoteName`, then by server kind within a WSL window. The kernel is not used for this decision: Linux desktop VS Code displayed through WSLg is a local window.
  - `undefined` (local Linux): fully exit and relaunch the editor with `CODEX_HOME` set to the selected directory; unset it for the default account. Reload Window alone does not apply the new environment. Native Windows has its own guidance (9a).
  - `wsl`: Antigravity/VSCodium: close the connected windows and wait at least five minutes (300-second server shutdown delay). VS Code: close the connected windows and wait a few seconds. Unknown: close the connected windows and wait five minutes, with `wsl --shutdown` as the fallback, explicitly noting that it stops all WSL distributions.
  - Other remote names: restart the editor server in that remote environment with the selected `CODEX_HOME` (unset for default), then reconnect. This is manual guidance, not a support guarantee for SSH or containers.
- The switch confirmation uses the same connection context, and every manual confirmation already contains the matching instructions; after confirming, the state file is written and no further warning is shown.
- Automatic restart is offered only when `remoteName === 'wsl'` and the server kind is Antigravity or VSCodium. Every other case shows the context-specific manual guidance. The Webview is told whether a restart is automatic, so labels never imply an automatic restart that will not happen.

### 5.1 Local desktop editor: manual restart

Local Linux windows (including WSLg desktop) use **save selection + manual restart instructions**. This is the user-approved scope after review on 2026-09-27; the desktop auto-relaunch implementation was withdrawn.

1. Confirming an account switch writes the selection file and refreshes the pending state. Cancelling the confirmation leaves the selection unchanged.
2. The switch confirmation and Command Palette restart command show local instructions. The pending banner is informational and the footer has no Codex restart action. They never quit an editor, arm a deferred request or spawn a relaunch helper. Ordinary exit or extension deactivation cannot trigger a later restart.
3. The user saves work and fully exits the intended editor instance when ready, then launches it with `CODEX_HOME` set to the selected directory (or unset for default). Preserve the original executable, profile/extensions arguments, workspace and session setup (item 4). Reload Window alone is insufficient. If the instance also contains remote windows, defer the full exit until those windows can safely close; PlanSwap does not close them.
4. Preserve the original session setup. For the WSLg test launched through `dbus-run-session`, run the original launcher again to create a fresh bus/keyring session; do not reuse the ended session's `DBUS_SESSION_BUS_ADDRESS`. The external test launcher remains outside the product.
5. The selected account remains pending until a new extension host actually reports the intended `CODEX_HOME`. Saving the selection is not activation.

Subsequent cold starts (source-derived, pending user verification):

- Desktop menu/icon (no `VSCODE_CLI`): the shell environment resolution runs the marker block, so a named selection is applied. Returning to the default account is reliable only if the graphical session itself does not carry a `CODEX_HOME` (fact 20); a session that sourced `~/.profile` while a named account was selected keeps that value until the next login.
- `code` from a terminal: no shell resolution; the terminal's environment is used, which reflects the selection at the time that terminal started.
- Any launch while an instance of the same user data directory is running is absorbed by that instance and keeps its old environment.

## 6. Data model

- `~/.config/planswap/state.json` (the `FileMemento`, not `globalState`, which is client-side and shared by every WSL distribution) holds `codex.accounts`, `codex.ignoredDirs` (directories of accounts removed while keeping the directory; auto-discovery skips them), `codex.labels` (aliases) and `codex.usageHistory` (8.7); see [Claude design §4](design.md#4-data-model). Codex aliases follow the same `LabelStore` rules as Claude's but are validated only against Codex accounts; the same name is allowed on both sides.
- The selected account is whatever the state file says (shared across windows, the last writer wins).
- The directory actually effective in this window = the extension host's own `process.env.CODEX_HOME`, or `~/.codex` when empty. With remote type `wsl` the Codex extension does not rewrite it. When it differs from the state file, the panel shows the selection as pending ([Features 10.2](features.md#102-codex-tab-in-the-sidebar)).
- Signed-in state: whether `<dir>/auth.json` exists. Email and plan come from the decoded `id_token` payload (`email`, `https://api.openai.com/auth`.`chatgpt_plan_type`), or "API key" for API key mode (`auth_mode === 'apikey'`, or no `auth_mode`, a non-empty `OPENAI_API_KEY` and no `tokens`); a parse failure means unknown but still signed in ([Features 10.1](features.md#101-accounts-and-directories)).
- Identity (`CodexAccountInfo.identity`): an opaque comparison key from the same decoded payload, user id (`https://api.openai.com/auth`.`chatgpt_user_id`, else `.user_id`, else top-level `sub`) plus workspace (`.chatgpt_account_id`); only when both exist, never in API key mode, and never from the email (one email can belong to several workspaces, and a false warning is worse than none). It is never displayed, logged, persisted or sent to the Webview. Registered accounts (default + named) that share one produce the duplicate sign-in warning of [Claude design 6.8](design.md#68-accounts-signed-in-to-the-same-identity).

## 7. User interface

The Codex page is a page of the same `AccountsPanel` instance, fed by `codexPanelSource`; its layout and texts are in [Features 10.2](features.md#102-codex-tab-in-the-sidebar) and the Tools section in [Features 5.5](features.md#55-tool-buttons). Codex-specific choices:

- There is no reload banner: a pending selection is shown with an explanation but no action button, and the footer has no Codex restart action; restarting is explained in the switch confirmation (section 5).
- A signed-out account can also be switched to and signed in directly in the Codex panel: its directory is empty, so no other account's sign-in is revoked (fact 3).
- The account effective in this window and the selected account cannot be removed, linked or unlinked.

## 8. Commands and flows

The command list is in [Features 10.3](features.md#103-commands); the flows below keep the design rules.

### 8.1 Switch

The observable steps are in [Features 10.6](features.md#106-switch). A switch request that arrives while another switch is in progress (e.g. its modal is open) is ignored.

1. When the target equals both the directory effective in this window and the content of the state file, nothing happens. When it is effective but the state file says otherwise (e.g. another window switched), only the state file is written and the view refreshed: no confirmation, no restart.
2. After the modal confirmation (section 5), re-check that the target directory exists and the same account name and directory are still registered; if another window removed the account, refresh the panel and stop without changing the selection.
3. A shared target is re-linked (`ensureCodexLinks`, 8.6) before the state file is written; a problem only warns and the switch continues.
4. Automatic kinds restart the server as in section 5; when the checks fail, the manual method is shown. Manual kinds (including a local desktop editor, 5.1) need nothing more.

### 8.2 Add

The flow and the copy rules are in [Features 10.7](features.md#107-add). An independent account gets a one-time copy of the default configuration (`copyCodexIndependent`); `config.toml` is not copied when it sets a login, storage or provider key (`BLOCKED_TOP_KEYS` / `BLOCKED_TABLE` in `codexPaths.ts`). `packages/` is not copied: the CLI binary stays under `~/.codex/packages` and keeps working.

### 8.3 Remove

The flow is in [Features 10.8](features.md#108-remove). Guards, deletion checks, the daemon pid-file check and its re-verify note: [Claude design 6.3](design.md#63-account-removal-and-directory-deletion-both-vendors). For a shared account the directory prompt (`share.removeDirDetail`) also names per-account memories, which are deleted with the directory.

### 8.4 Terminal

- On Linux the terminal named `Codex (<display name>)` is sent `env CODEX_HOME='<dir>' codex` or the sign-in command. The default account sends `env -u CODEX_HOME codex`, which overrides both sources: an rc file export and inheritance from the server's cached environment. On Windows the terminal environment carries `CODEX_HOME` (removed for the default account) and only `codex` is sent. Terminal names are not localized.
- The sign-in command is accompanied by the information message `account.loginTip` ([Claude design 6.4](design.md#64-open-claude-in-a-terminal)).

### 8.5 Rename an account

As on the Claude side ([Claude design 6.5](design.md#65-rename-an-account)) with mode `codex`; only named accounts can be renamed, and validation only looks at Codex accounts.

### 8.6 Shared and independent accounts

[Claude design 6.7](design.md#67-shared-and-independent-accounts) owns the common model for both vendors, including mode detection for both markers, directory protection and the refused-configuration-link difference. Implemented in `src/codex/codexShare.ts`, reusing the report types and link / merge helpers of `src/claudeShare.ts`. The UI calls a shared account a "linked account"; the code and these documents keep "shared" as the internal term. The entry lists are the constants `CODEX_SHARED_ENTRIES`, `CODEX_CHILD_SHARED_DIRS` and `CODEX_IDENTITY_CONFIG_KEYS` / `CODEX_IDENTITY_CONFIG_TABLES`. Codex differences and their reasons:

- **Mode detection**: shared iff `<dir>/sessions` is a symlink whose real path equals that of `~/.codex/sessions` (`isSharedCodexAccount`); never stored.
- **Directory protection**: adding an account and the link, configuration-copy and conversion entry points reject an account directory that contains the default directory after resolving links, before any writes. This also protects previously registered accounts when `~/.codex` is later linked into one of them.
- **Thread databases** are `link-only`: linked even while the target does not exist and never pre-created, because SQLite creates them at the link target (fact 15). On Windows they are never linked (9a).
- **`.tmp`**: `.tmp/rollout-maintenance.lock` is linked inside a real account `.tmp` folder (0700; `.tmp` itself is never linked, `~/.codex/.tmp` is created so opening the link with `O_CREAT` works); `.tmp/rollout-compression.lock` is not (fact 16).
- **Never touched**: `auth.json`, `.credentials.json`, `.env`, `models_cache.json`, `cache/`, `memories/`, `memories_*.sqlite`, `memories_extensions/`, `logs_2.sqlite`, `log/`, `app-server-daemon/`, `app-server-control/`, `ipc/`, `packages/`, `tmp/`, `mcp-oauth-locks/`, `installation_id`, `version.json`, `.sandbox_migration`, `vendor_imports/`, `worktrees/`, the rest of `plugins/`, `.remote-plugin-install-staging`, `skills/.system`, `.tmp/rollout-compression.lock` (fact 16).
- **`config.toml` refusal**: not linked (reported under `refused`) when the default config cannot be read or sets an identity key or table. The refusal is re-evaluated every time links are refreshed: an existing account link to the default `config.toml` is removed when the default config has gained identity keys since. No copy is made, unlike Claude's stripped `settings.json` copy; the account is left without `config.toml`. A regular file or a link elsewhere in the account is not touched.
- **Repair** (`ensureCodexLinks`): in a shared account, a regular `history.jsonl` / `session_index.jsonl` (Codex replaced the link, fact 16) is merged back with `mergeLines` and relinked. A regular thread database in a shared account is a conflict and stays untouched. A whole-folder `skills` / `plugins/cache` link from an earlier version is replaced by per-child links; child links whose default target is gone are removed. Links are refreshed only on add (shared), after the switch confirmation (8.1), by "Re-link" and at the end of a conversion. There is nothing to mirror on the Codex side.
- **Busy check** (`codexAccountBusy`): a live daemon of the account ([Claude design 6.3](design.md#63-account-removal-and-directory-deletion-both-vendors)), or any `/proc/<pid>` whose `exe` basename is `codex` (a ` (deleted)` suffix is ignored) and whose `CODEX_HOME` in `environ` resolves to the directory (for `~/.codex`: unset, empty or equal); an unreadable `/proc` counts as busy. Environment alone is not enough, since shells and MCP servers inherit `CODEX_HOME`. On Windows only the daemon and the account's open PlanSwap terminal count, even after its CLI has exited.
- **Conversion** (`migrateCodexToShared`; refused for the effective and the selected account; the modal also warns that resuming another ChatGPT account's session may be rejected, fact 18): folders are merged as on the Claude side; `history.jsonl` / `session_index.jsonl` lines are merged into the default file; `config.toml` / `AGENTS.md` / `hooks.json` / `.tmp/rollout-maintenance.lock` are moved to `~/.codex` when it lacks them (a `config.toml` with identity keys or tables stays in the account, not linked), an identical copy is dropped and a differing one is renamed to `<name>.independent-backup`; thread databases are renamed with their `-wal` / `-shm` files to `<db>.independent-backup` (suffixes kept; `-2`, `-3`… when taken), then linked, since Codex rebuilds thread metadata from the rollouts (fact 15); nested entries are handled only inside a real account folder (a linked `.tmp` is never followed). On Windows the account's databases are kept (9a). The success notice is shown only when the shared marker is present; otherwise the notification reports incomplete linking.
- **Back to independent** (`makeCodexIndependent`): after the same busy check, the configuration entries linked into `~/.codex` are unlinked first, `copyCodexIndependent` runs, and only then are history, `session_index.jsonl`, the databases (dangling `link-only` links included), the `sessions` marker, the other folders and the `plugins/cache` children unlinked, so a failed copy leaves the account shared and `ensureCodexLinks` repairs it. Sessions, history and thread databases stay in `~/.codex`; `auth.json` and `memories/` are untouched.

### 8.7 Usage limits

The status bar tooltip's Codex block shows the usage limits of **this window's effective account** (`effectiveDir()`), never of the pending selection; the status bar text and tooltip layout are in [Features §3](features.md#3-status-bar) and their rationale in [Claude design 5.4](design.md#54-status-bar). Claude has its own, independent usage limits through the official `claude` CLI ([Claude design 6.9](design.md#69-claude-usage-limits)); they share no state with the Codex monitor or `codex.usageHistory`.

- **Query** (`readCodexUsage`, facts 24-26): only when `<dir>/auth.json` exists; otherwise nothing is started. It starts `codex app-server` with `CODEX_HOME=<dir>` (falling back to `codex.cmd` on Windows and to the binary bundled with the Codex extension for this OS and architecture), checks that the reported `codexHome` is the requested directory, then sends `account/rateLimits/read`. The whole query is limited to `planswap.codex.usageTimeoutSeconds` (default 15 s). The service refusing the stored sign-in was observed with codex-cli 0.139.0 as error -32603 "… 401 Unauthorized …"; it is checked first (`authExpired`), since that message also says "authentication". Raw protocol lines are never returned or logged, and only the child it started is ever killed.
- **Rate limits**: `account/rateLimits/read` makes one usage request and no model request, and no frequency limit is published; the practical risk is two processes refreshing the token of one `auth.json` at once ([research record](research/codex.md#rate-limits)). PlanSwap queries one account at a time.
- **Credentials**: see [Codex credentials](../AGENTS.md#account-and-data-safety). To verify result attribution, the monitor reuses the identity key of section 6, in memory only.
- **Scheduling** (`CodexUsageMonitor` for the effective account, `OtherAccountChecks` for the other registered signed-in ChatGPT accounts unless `planswap.usageAutoRefreshCurrentOnly` is on; settings and cooldown in [Features](features.md#manual-refresh-cooldown)): one `codex` process at a time in a window, scheduled, manual and refresh-all queries alike. Other accounts are queried after the effective one, each once both its last observation in the shared history and this window's last attempt for it are older than the refresh interval, with the same identity and stamp check as refresh-all. Timed checks (activation, interval) run only while the window is focused and only when the last attempt, failed ones included, is older than the refresh interval, so with several windows open only the one in use queries and failures are not retried in a loop. An account-info change is checked in every window, focused or not, and queries at once only when the effective account's `auth.json` stamp (mtime and size; the file is never opened) differs from the one of the last accepted response. Identity and stamp are compared before and after each query: a token refresh for the same identity is accepted, a changed identity or an unverified stamp change discards the response. With automatic checks off, an auth change only drops a live result that no longer belongs to the accepted sign-in. API key accounts are never queried. Nothing is queried when Codex runs inside WSL (9a).
- **Account observations** (`CodexUsageHistory`, display in [Features](features.md#codex-account-usage-observations)): automatic checks also query the other accounts (Scheduling above); selecting an account does not query it. **Refresh all** ([Features 10.3.1](features.md#1031-refresh-usage-limits-of-all-codex-accounts)) is manual only and queries one account at a time, with the same identity and stamp check for every account. Observations are stored in `codex.usageHistory` with quota values, collection time and the `auth.json` stat stamp only (no email, identity key or credentials). A changed or missing stamp hides an observation; a result whose accepted stamp has already changed is not recorded, and identity is checked again after the asynchronous history write before the live result is published. Sign-out or rejected authentication clears an observation, while temporary query failures retain it. Missing observations never imply zero usage.

## 9. Refresh triggers

See [Features 10.10](features.md#1010-refresh-triggers). An `auth.json` change of the effective account also re-checks the usage limits (8.7).

## 9a. Native Windows

Local Windows editors have no rc files and no WSL server. Selection is persisted in the per-user environment variable `CODEX_HOME` (`HKCU\Environment`):

- Switching is refused (warning `codex.notEnabled`) until Codex switching is enabled, on every platform. Enable (`planswap.codex.enable`): refused when the user already has a user-level `CODEX_HOME` that PlanSwap does not own (a value pointing at `~/.codex-<name>` is adopted, e.g. after the state file was deleted); otherwise, after a modal confirmation, the state file `~/.config/planswap/codex-home` is created (its existence means "managed"). A self-check writes a marker into the scratch user variable `PLANSWAP_SELF_CHECK` (never `CODEX_HOME` itself), reads it back and removes it; failure removes only a state file created by this attempt, preserving any earlier enablement. Values are read through PowerShell as base64 of their UTF-8 bytes: without a console (the extension host) `reg query` prints the ANSI code page and garbles non-ASCII paths (verified 2026-09-30 on a code page 936 system).
- Switch: `CODEX_HOME` is set first and the state file written second (a failed write restores the variable). The variable is set, or removed for the default account, through `[Environment]::SetEnvironmentVariable(..., 'User')` in `powershell.exe`, which also broadcasts the change to Explorer. The value is passed in a child environment variable, never in the command line.
- Restart: not automatic. Running editors and their terminals keep the environment they were started with, so the user must quit every editor window and start the editor again from the Start menu or taskbar (a `code` launch from a terminal inherits that terminal's old value). This follows the same principle as [section 2, fact 20](#2-background-facts-verified) for local desktop editors.
- Disable removes the state file, and the user-level variable only while it still points at an account directory `~/.codex-<name>` (a value the user set in the meantime stays). The Windows texts name the user environment variable instead of rc files and `~/.bashrc`.
- **Databases are never linked on Windows.** SQLite derives a database's `-wal` / `-shm` names from the path it opened, not from a link's target, so on Windows rows written through a link can be lost without any integrity error ([evidence](research/windows.md#sqlite-through-file-links)). So `ensureCodexLinks` skips `state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite` and `queue_1.sqlite` there and removes such a link left from before (`removeWindowsSqliteLink`: its side files become `<file>.windows-link-backup` so a new database never replays them; reported under `refused`, or `busy` while a side file is open); conversions keep the account's own databases, and making an account independent removes those links first. Each Windows account therefore keeps its own thread databases while rollouts, history and configuration are still shared.
- `auth.json` remains read-only; accounts stored in the OS keyring instead of `auth.json` (`cli_auth_credentials_store = keyring`/`auto`) read as signed out.
- **Codex run inside WSL**: with the Codex extension setting `chatgpt.runCodexInWindowsSubsystemForLinux` on, PlanSwap treats Codex as using the WSL-side `~/.codex` rather than the Windows `CODEX_HOME`, and PlanSwap never reads WSL files from Windows. `codexRunsInWsl()` is then true: enable and switch are refused with `codex.win.runsInWsl` (open a WSL window and manage the accounts there, or turn the setting off), the status bar tooltip shows `status.codexRunsInWsl` instead of usage limits, and no usage query runs. The status bar re-renders when the setting changes. The Codex extension's actual WSL-mode behavior remains part of the real-Windows acceptance work below.
- Codex honors `CODEX_HOME` on Windows, including non-ASCII paths ([evidence](research/windows.md#codex-on-windows)).
- Not verified with a real Windows sign-in: that the extension host inherits the changed variable after a fresh start, the observed credential-store behavior (the upstream default is `file`), and that the Codex extension really ignores the Windows `CODEX_HOME` in its WSL mode; see [TODO](../TODO.md).

## 10. Code structure

Codex module responsibilities, and the shared protocol, labels, panel and localization contracts, are in the code (types and TSDoc; `src/protocol.ts` for messages). The repository map is in [Development](development.md#repository-layout).

## 11. Implementation order and verification

For changes to shell configuration or server restart behavior, validate the data-layer paths before the dependent UI flows. Automated tests use temporary HOME directories and fake process trees; they must never signal an editor server.

The self-check, server/terminal shutdown observations, reconnect environment checks and return-to-default checks are maintained in [Manual Verification](manual-verification.md#codex). Real-server restart checks are performed by the user. Outstanding acceptance work remains in [TODO](../TODO.md).

## 12. Known limitations

1. In a WSL window a Codex account switch restarts the WSL-side server: all WSL windows disconnect and each needs one "Reload Window" click; integrated terminals close. The restart is automatic only in Antigravity and VSCodium; in VS Code and unrecognized editors the user closes and reopens the windows. A local desktop editor (5.1), native Windows (9a) and other remote windows need a manual restart.
2. The state file is global and the last writer wins; other windows switch as well after the server restarts.
3. Independent accounts keep all local data (sessions, skills, prompts, memories, approval rules, etc.) separate. Shared accounts share sessions, history, configuration, rules and skills with `~/.codex`; thread databases are shared on Linux and kept independent on Windows (9a), while memories stay per account (fact 17), so each account rebuilds memories from the shared sessions with its own quota; logs, caches and the daemon state also stay per account.
4. Relies on two behaviors: Antigravity resolves the extension host environment through a login shell, and the server is started again automatically after it dies. Both come from the upstream VS Code implementation and must be re-verified after upgrades.
5. `~/.profile` and `~/.bashrc` carry a marker block maintained by this extension; only bash is supported, and a hand-damaged block makes enable and disable refuse (section 4).
6. A leftover Codex instance on the Windows side is unrelated to this design and is not affected.
7. Resuming a session started by another ChatGPT account (organization) may be rejected by the server because its encrypted reasoning / compaction content is organization-bound (fact 18); high risk when switching between accounts of different organizations.
8. Two accounts resuming the same session at the same time write to the same rollout file; avoid it.
9. Links replaced by Codex between link refreshes (8.6) are repaired only at the next refresh (jsonl files) or reported (other entries).
10. Converting an independent account cannot be undone automatically; differing files are kept as `<name>.from-<account>` / `<name>.independent-backup`, and on Linux the account's thread databases are kept as backups; Windows keeps them as independent databases.
11. MCP servers in the shared `config.toml` are shared, but MCP OAuth credentials are never linked or copied, so OAuth-based servers must be authorized in each account; for independent accounts, `env` values of MCP servers are copied in plain text with `config.toml`.
12. Local desktop switching (5.1) has no automatic quit/relaunch, and cold starts depend on the launch route; installed-build acceptance of the guidance is pending.
13. Usage limits (8.7) depend on the `codex app-server` protocol (facts 24-26) and a `codex` binary; each query starts a short-lived CLI process that contacts OpenAI's service as the CLI itself does.
