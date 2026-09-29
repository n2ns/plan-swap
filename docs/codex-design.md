# Codex Account Switching: Design

Date: 2026-09-26
Status: implemented (v9, 2026-09-29: usage limits of the effective account in the status bar tooltip through the official CLI (8.7), a warning for accounts signed in to the same identity (6), Codex refused on native Windows while the Codex extension runs it inside WSL (9a); v8, 2026-09-26: shared and independent accounts (8.6): a shared account links everything except its login identity and memories to `~/.codex`, an independent one gets a one-time copy of its configuration; `AGENTS.md` is no longer linked on its own; the `default` account can no longer be renamed (only named accounts, 8.5); v7, 2026-09-26: the WSL server restart works per editor kind detected from a whitelist of server data directories: Antigravity and VSCodium restart automatically, VS Code and unrecognized editors only get manual instructions (section 5); v6, 2026-09-26: English docs + i18n: the Codex page, commands and messages are localized in English / Simplified Chinese following `planswap.language`, while the rc marker block stays byte-identical; v5: single view with tabs + account display names + read-only `auth.json` for email and plan; on 2026-09-25 the constraint "do not decode tokens, do not show emails" was lifted at the user's request; since 2026-09-26 every registered account can be renamed, and `AGENTS.md` is shared through symlinks. Contract in codex-interfaces.md)

Purpose: Codex account-switching design, shell/environment propagation, editor restart rationale, upstream evidence and limitations. Exact module contracts are in [Codex interfaces](codex-interfaces.md), observable behavior in [Features](features.md), and acceptance procedures in [Manual Verification](manual-verification.md). See [Documentation](README.md) for ownership.

## 1. Goals and scope

- Goal: add OpenAI Codex account switching to the same sidebar extension. After a switch, the official Codex editor extension, the codex processes it starts, and the codex CLI in integrated terminals all use the selected account, without signing in again.
- Claude account switching is a separate feature; the two do not affect each other.
- Runtime environment: WSL / Linux only, the editor is Antigravity IDE (VS Code 1.107 core); VSCodium and VS Code are also recognized (section 5). WSL remote window. A local Linux desktop VS Code window (including one displayed through WSLg) only saves the selection and shows manual restart instructions (5.1); that path awaits user acceptance and is not yet a support claim. The login shell is bash.
- Cost accepted by the user: switching the Codex account requires restarting the editor's server inside WSL (automatic only for Antigravity and VSCodium, see section 5). All WSL windows disconnect and each shows "Cannot reconnect. Please reload the window." once; the user clicks "Reload Window" once in each window. Integrated terminals close.
- Non-goals:
  - `auth.json` is read-only, and only the JWT payload of its `tokens.id_token` is decoded (signature not verified) to display email and plan and to build an in-memory identity comparison key (6); no token is ever copied, swapped, cached or output (the raw `access_token`/`refresh_token`/`id_token` never reach logs, state, messages or the UI). `auth.json` is never written.
  - Never read, copy, move or link `auth.json` of any account into another directory.
  - Existing content of `~/.codex` is never overwritten. It is only changed for shared accounts (8.6): a shared entry missing there is created empty as the link target, and converting an independent account moves its files in (a file inside a linked folder that differs is kept next to the default one as `<name>.from-<account>`; a differing top-level file stays in the account as `<name>.independent-backup`, 8.6).
  - Usage limits are only obtained through the official CLI's `codex app-server`, started with the account's `CODEX_HOME` (8.7); PlanSwap makes no network request of its own, calls no non-public service interface and never switches automatically when the quota runs out.
  - Do not use `chatgpt.cliExecutable`; do not depend on extension activation order.

## 2. Background facts (verified)

Sources: `openai/codex` source code (main as of 2026-09-25), the local `openai.chatgpt-26.908.40401` extension source code, `microsoft/vscode` 1.107.0 source code, the local Antigravity server (`server-main.js`) and startup scripts, the Windows-side `antigravity-remote-wsl` extension, local logs and the process tree. **Re-verify these assumptions after upgrading Codex, the Codex extension, Antigravity, VSCodium or VS Code.**

1. All local Codex state lives in `CODEX_HOME` (default `~/.codex`). When the variable is set, the directory must already exist, and the path is resolved through symlinks. The credentials in `auth.json` are isolated per directory; in keyring mode the keys are also distinguished by a hash of the directory path.
2. The app-server reads `CODEX_HOME` once at startup and then caches the credentials in memory; it does not watch the file, and there is no interface to reload authentication or change the directory. Changing accounts requires restarting the process.
3. Signing in to a new account in the same `CODEX_HOME` revokes the authorization of the account previously in that directory. One directory per account naturally avoids this.
4. Refresh tokens are single-use and rotated; `auth.json` is not written atomically. Therefore this design never copies or swaps the file; reading tolerates half-written JSON (a parse failure means email/plan unknown). Structure of `auth.json`: `auth_mode` (`chatgpt` / `apikey`), `OPENAI_API_KEY`, `tokens.{id_token,access_token,refresh_token,account_id}`; the `id_token` payload contains `email` and `https://api.openai.com/auth`.`chatgpt_plan_type` (`free`/`go`/`plus`/`pro`/`prolite`/`team`/`business`/`enterprise`, etc.).
5. The Codex sidebar view of a WSL window is provided by the extension instance in the **WSL-side extension host** (local logs: the WSL-side instance shows all activity: UI mounting, account queries, session restore; the Windows-side instance was only activated once when the window opened and showed no activity afterwards). The environment of the codex processes started by that instance is the extension host's `process.env` plus a few fixed entries; `CODEX_HOME` comes only from the extension host environment. With remote type `wsl`, the extension does not probe the shell environment itself. The extension's own access to directories such as `ipc/`, `skills/`, `prompts/` also follows the same variable. The extension has no setting to inject environment variables, and it does not restart the codex process automatically after it exits.
6. The environment of the WSL remote extension host is resolved by the server process through a login shell (`bash -i -l -c`), and the result is cached for the lifetime of the server process; restarting the extension host or reloading a window does not resolve it again. `bash -i -l` reads `/etc/profile` and the first existing one of `~/.bash_profile`, `~/.bash_login`, `~/.profile`; it does not read `~/.bashrc` directly. This machine has neither of the first two, and `~/.profile` sources `~/.bashrc`; the interactive guard at the top of `~/.bashrc` does not trigger under `-i`. It was verified on this machine that variables exported in `~/.bashrc` reach the extension host.
7. The base environment of integrated terminal processes also comes from the server's cached environment; but the terminal shell is interactive bash and sources `~/.bashrc` again, so newly opened terminals re-run the logic in the rc files.
8. Antigravity's WSL server: the startup script is re-run by the Windows-side extension on every window connection; the script uses the pid file plus the process name to decide whether the server is running, reuses it if so, and otherwise starts a new one with the login shell environment and overwrites the pid file. The pid file records the pid of the wrapper script `sh bin/antigravity-ide-server`; its child `node out/server-main.js` is the server, and the extension host's parent process is that node process. The server runs with `--enable-remote-auto-shutdown` and exits 300 seconds after the last window disconnects. There is exactly one server per distribution, user and version, shared by all WSL windows.
9. The server's node process has no SIGTERM handler and exits on receipt. The extension host has a parent-process guard and exits by itself within about 1 second, and its children end with it. The pty host has no parent-process guard and lingers after the server dies, keeping integrated terminals and their processes alive, so it must be terminated as well.
10. After the server dies, the startup script starts a new server when the client reconnects, but the new server does not accept the old reconnection token, and the client shows the dialog "Cannot reconnect. Please reload the window."; after clicking "Reload Window" it connects to the new server normally and the extension host environment is resolved again. Antigravity has no "restart server" command.
11. Server layouts: Antigravity `~/.antigravity-ide-server/bin/<ideVersion>-<commit>/`, VSCodium `~/.vscodium-server/bin/<commit>/`, VS Code `~/.vscode-server/bin/<commit>/`. The server root (= `vscode.env.appRoot`) contains `product.json` with a top-level `commit`.
12. VSCodium's server works like Antigravity's: the pid file `<dataDir>/.<commit>.pid` holds the pid of the wrapper `sh <root>/bin/<serverApplicationName>`, which is the parent of `node <root>/out/server-main.js --start-server ...`, which is the extension host's parent (`process.ppid`). Both auto-shut down 300 seconds after the last window disconnects (`--enable-remote-auto-shutdown`).
13. VS Code (Microsoft's remote-wsl) has no pid file and no `--start-server`; its Windows-side wslDaemon caches the resolved port, so after the server is killed a reloaded window can receive a stale port while other windows keep the daemon alive. Closing all VS Code windows connected to the distro makes the daemon exit (3 s) and stop the server; reopening starts a new one. Therefore VS Code's server is never restarted automatically. (Read from the remote-wsl 0.104.3 source `dist/node/wslDaemon.js` and `scripts/wslServer.sh`; not verified at runtime.)

The following facts about shared accounts come from codex-cli 0.157.1 (source and tests in a temporary `CODEX_HOME`; re-verify after upgrades):

14. Edits of `config.toml` resolve symlinks before writing, so a linked config stays a link and the default file receives the change.
15. The thread databases (`state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`; bundled SQLite in WAL mode) work through file symlinks: SQLite creates a missing database at the link target and puts its `-wal` / `-shm` files next to the resolved target, so every account sees the same database (tested). Codex reconciles thread metadata from the rollout files under `sessions/`.
16. `history.jsonl` is appended to in place; deleting a thread rewrites `session_index.jsonl` by rename, which replaces the link of that account by a regular file (repaired by merging the lines back, 8.6). `.tmp/rollout-compression.lock` is created with `O_EXCL`, which fails on a dangling link, so it is not shared; `.tmp/rollout-maintenance.lock` is an flock file and is shared so two accounts do not maintain the shared rollouts at once.
17. Codex refuses a symlinked memories root, so `memories/` and the memories databases stay per account.
18. Resuming a thread across accounts is not blocked locally, but reasoning and compaction items carry `encrypted_content` bound to the organization that produced it; the server may reject resuming another organization's session ("encrypted content organization_id did not match").

The following facts about a **local Linux desktop editor** were read on 2026-09-27 from the installed VS Code 1.139.1 (commit `04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1`, `/usr/share/code/resources/app/out/main.js`, `vs/base/parts/sandbox/electron-browser/preload.js`, `vs/workbench/workbench.desktop.main.js`), the official Codex extension 26.917.62051 and the running WSLg test editor's process tree. They are source-derived, not runtime acceptance; re-verify after upgrades.

19. The official Codex extension resolves its home as `process.env.CODEX_HOME ?? ~/.codex` and spawns its processes with `{...process.env, ...}` of the extension host. Its extra shell probe runs only when `CODEX_HOME` is empty and `vscode.env.remoteName` is a non-`wsl` remote, so a local window uses the extension host environment as is.
20. The desktop extension host environment is `{...main process env, ...resolved shell env, ...window userEnv}`. The main process resolves the shell environment (`$SHELL -i -l -c`, cached for the main process lifetime) unless it was started with `VSCODE_CLI=1` (the `code` CLI script) and without `--force-user-env`. The first window has no `userEnv`. Reload Window and extension host restarts reuse the cached environment, so only a new main process picks up a new `CODEX_HOME`. A shell that unsets `CODEX_HOME` cannot remove a value the main process inherited, because the merge only adds keys.
21. One main process serves every window of a user data directory; a second launch with the same `--user-data-dir` hands its arguments to the running instance through `<XDG_RUNTIME_DIR>/vscode-<hash>-<version>-main.sock` and exits, so a relaunch must wait until the old main process has exited. The extension host is a utility process whose parent is the main process. Chromium rewrites the main process title, so `/proc/<pid>/cmdline` is one space-joined string and `/proc/<pid>/environ` is not usable.
22. `workbench.action.quit` asks the main process to quit and returns without waiting. Each window may veto for unsaved changes; extension hosts are shut down (and `deactivate()` runs) only for windows that do not veto. Closing the last window quits the application on Linux.
23. The editor binary runs as Node when `ELECTRON_RUN_AS_NODE=1` (VS Code uses this itself for shell resolution), so a helper needs no separate Node installation.

The following facts about the app-server protocol were verified on 2026-09-29 with codex-cli 0.139.0: the schema printed by its own `codex app-server generate-json-schema`, and a live handshake against an empty temporary `CODEX_HOME`. **Re-verify them when the CLI protocol changes.**

24. `codex app-server` speaks newline-delimited JSON-RPC over stdio. A client sends `initialize` (with `clientInfo`), then the `initialized` notification; the `initialize` result reports the `codexHome` the server uses.
25. `account/rateLimits/read` returns `rateLimits` (and `rateLimitsByLimitId`, whose `codex` bucket holds the Codex limits) with `primary` / `secondary` windows (`usedPercent`, `windowDurationMins`, `resetsAt` in unix seconds) and `rateLimitReachedType` when a limit is reached. Without credentials the request fails with an authentication-required error.
26. The server reads the credentials of its `CODEX_HOME` itself and may refresh them there, as the interactive CLI does.

The daemon liveness check also relies on the JSON format Codex writes to `<dir>/app-server-daemon/*.pid` (`pid`, `processIdentity.startTicks` / `processStartTime`); re-verify it after Codex upgrades.

## 3. Overall design

```
~/.profile and ~/.bashrc each have a marker block: read CODEX_HOME from the state file and export / unset
User clicks "Switch" on the Codex page
  → the extension writes the target directory to the state file ~/.config/planswap/codex-home (atomic write + fsync)
  → the extension terminates the WSL-side server and its leftover children (section 5)
  → every WSL window shows "Cannot reconnect"; the user clicks "Reload Window"
  → the new server resolves the environment through a login shell; CODEX_HOME points to the new directory
  → the Codex extension in the new extension host and its codex processes use the new directory
```

An account is a directory:

| Account | Directory | Notes |
|---|---|---|
| default | `~/.codex` | Always exists, cannot be removed; effective when the state file is empty |
| `<name>` | `~/.codex-<name>` | Created with "Add account", or registered automatically by scanning `~/.codex-*` on activation and refresh (a name equal to a registered name or display name, ignoring case, is skipped); an entry whose directory no longer exists is removed at the same time (its alias is cleared) |

## 4. Login shell configuration

- State file: `~/.config/planswap/codex-home`, content is the absolute path of the target directory, or empty (default account). Mode 0600, directory 0700, atomic write (temporary file + rename + directory fsync).
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
  5. If the marker block of either file is damaged (start marker `# >>> planswap codex >>>` without end marker `# <<< planswap codex <<<`, `broken` in `rcStatus`), an error asks for a manual fix before retrying.
- Self-check after writing: write a temporary state file pointing to a temporary empty directory, run `bash -i -l -c 'printf %s "$CODEX_HOME"'` and check the output, then restore the state file and delete the temporary directory. When the self-check fails, roll back **per file**: only the marker blocks newly written in this run are removed; files that already had a block before enabling are left alone; then report.
- The rc files and the state file are written atomically (temporary file in the same directory + rename), so a half-written rc file can never be left behind. A symlinked rc file is written through to its target; a dangling symlink is never replaced by a regular file (the write is refused with `codex.rc.danglingLink`).
- `planswap.codex.disable`: remove both blocks by their markers and delete the state file. If either file lacks the end marker, an error is thrown, neither file is changed (both files are checked before anything is written), and the user is asked to fix it manually.
- Pre-check reasons, the modal texts and the self-check result are localized; the block written to the files is not.
- **Migrating the pre-rename setup** (`migrateLegacyCodex`, run on every activation before the Codex store is created): versions 0.1.0 - 0.1.3 used the name `ai-switcher` (state file `~/.config/ai-switcher/codex-home`, markers `# >>> ai-switcher codex >>>` / `# <<< ai-switcher codex <<<`, variable `_ai_switcher_codex_home`; otherwise the same block). Without migration an upgraded installation shows the disabled page, and enabling again is refused because the old block's `export CODEX_HOME=` counts as the user's own. When either rc file has a legacy block: both files are checked first (a legacy start marker without its end marker → error, nothing changes, a warning is shown and the pre-check reasons explain the rest); the legacy state file's content is written to the current state file only when that does not exist yet; every legacy block is replaced in place by the current block (lines outside it, including the blank line before it, are kept, so the file is byte-identical to a fresh installation and removal still restores the original bytes; a legacy block in a file that already has a current block is dropped together with the blank line added before it); the legacy state file is deleted and its folder removed when empty. The selected directory stays the same, so the server's cached environment still matches and no restart is needed. Without a legacy block nothing is touched (a leftover legacy state file is left alone). An older extension version still running in another editor on the same distro sees its block gone and shows its disabled page until it is upgraded.

## 5. Restarting the WSL-side server

- Editor kind (whitelist, not generic parsing): the server root is the path before `/out/server-main.js` in the argv of `/proc/<ppid>/cmdline` (split on `\0`), its parent directory must be named `bin`, the data directory is the parent of that `bin`, and it must be exactly one of these directories directly under `$HOME` (symlinks in the parent path and in `$HOME` are resolved before comparing):

| Data directory | Kind | Restart |
|---|---|---|
| `~/.antigravity-ide-server`, `~/.antigravity-server` (older releases) | `antigravity` | automatic (pid file) |
| `~/.vscodium-server` | `vscodium` | automatic (pid file) |
| `~/.vscode-server` | `vscode` | manual guidance only (reason: section 2 item 13) |
| anything else, or detection failure | `unknown` | generic manual guidance only |

- Manual kinds (`vscode`, `unknown`) are never signaled; the switch still writes the state file, and the user restarts the server by hand.
- Locating (automatic kinds): server = the extension host's parent process `process.ppid`. Only act when all checks pass, in this order; otherwise refuse and show the manual method:
  - `process.ppid > 1`;
  - `/proc/<ppid>/cmdline` contains `out/server-main.js` and `--start-server`, the server root can be parsed, and the kind of its data directory can auto restart;
  - the top-level `commit` of `<root>/product.json` is 40 lowercase hex characters;
  - the basename of the root equals the commit or ends with `-<commit>`;
  - the value of the pid file `<dataDir>/.<commit>.pid` equals the parent pid in `/proc/<ppid>/stat` (i.e. the wrapper script).
- Order:
  1. Finish writing the state file first (including fsync).
  2. Enumerate `/proc/*/stat` and collect every child whose parent is the server (extension hosts, pty host, file watcher, etc.), excluding this extension host itself.
  3. Send `SIGTERM` to the server, then to the children collected in step 2. Use `process.kill`, never shell commands. This extension host exits by itself through its parent-process guard.
- Afterwards: every WSL window shows "Cannot reconnect. Please reload the window.", and the user clicks "Reload Window".
- Manual guidance is selected first by `vscode.env.remoteName`, then by server kind within a WSL window. The kernel is not used for this decision: Linux desktop VS Code displayed through WSLg is a local window.
  - `undefined` (local Linux): fully exit and relaunch the editor with `CODEX_HOME` set to the selected directory; unset it for the default account. Reload Window alone does not apply the new environment. The warning says the Linux editor cannot be restarted automatically.
  - `wsl`: preserve the existing editor-specific manual methods. Antigravity/VSCodium: close the connected windows and wait at least five minutes (300-second server shutdown delay). VS Code: close the connected windows and wait a few seconds. Unknown: close the connected windows and wait five minutes, with `wsl --shutdown` as the fallback, explicitly noting that it stops all WSL distributions.
  - Other remote names: restart the editor server in that remote environment with the selected `CODEX_HOME` (unset for default), then reconnect. This is manual guidance, not a new support guarantee for SSH or containers.
- Modal confirmation before switching uses the same connection context: restart the Linux editor locally, the WSL server in WSL, or the remote editor server elsewhere. All manual confirmations include the matching instructions; after confirming, the state file is written and no further warning is shown.
- Automatic restart is offered only when `remoteName === 'wsl'` and the server kind is Antigravity or VSCodium (existing modal, validation and signaling unchanged). Every other case, including a local desktop editor (5.1), shows the context-specific manual warning without a modal. The host reports `{ context, auto }` (`RestartInfo`) to the Webview so labels never imply an automatic restart that will not happen.

### 5.1 Local desktop editor: manual restart

Local Linux windows (including WSLg desktop) use **save selection + manual restart instructions**. This is the user-approved scope after review on 2026-09-27; the desktop auto-relaunch implementation was withdrawn.

1. Confirming an account switch writes the selection file and refreshes the pending state. Cancelling the confirmation leaves the selection unchanged.
2. The pending action, footer and restart command show local instructions only. They never quit an editor, arm a deferred request or spawn a relaunch helper. Ordinary exit or extension deactivation cannot trigger a later restart.
3. The user saves work and fully exits the intended editor instance when ready, then launches it with `CODEX_HOME` set to the selected directory (or unset for default). Preserve the original executable, profile/extensions arguments and workspace. Reload Window alone is insufficient. If the instance also contains remote windows, defer the full exit until those windows can safely close; PlanSwap does not close them.
4. Preserve the original session setup. For the WSLg test launched through `dbus-run-session`, run the original launcher again to create a fresh bus/keyring session; do not reuse the ended session's `DBUS_SESSION_BUS_ADDRESS`. The external test launcher remains outside the product.
5. The selected account remains pending until a new extension host actually reports the intended `CODEX_HOME`. Saving the selection is not activation.

Subsequent cold starts (source-derived, pending user verification):

- Desktop menu/icon (no `VSCODE_CLI`): the shell environment resolution runs the marker block, so a named selection is applied. Returning to the default account is reliable only if the graphical session itself does not carry a `CODEX_HOME` (fact 20); a session that sourced `~/.profile` while a named account was selected keeps that value until the next login.
- `code` from a terminal: no shell resolution; the terminal's environment is used, which reflects the selection at the time that terminal started.
- Any launch while an instance of the same user data directory is running is absorbed by that instance and keeps its old environment.

## 6. Data model

- State file `~/.config/planswap/state.json` (the `FileMemento` of `fileState.ts`, see design.md section 4; not `globalState`, which is client-side and shared by every WSL distribution):
  - `codex.accounts`: `Array<{ name, dir }>`, the list of non-default accounts.
  - `codex.ignoredDirs`: directories of accounts removed while keeping the directory; automatic scanning skips them.
  - `codex.labels`: per-account display names (aliases), `Record<string /*name*/, string /*label*/>`, keyed by account name; no entry means not set (the name is shown). Stored and validated by the `LabelStore` in `labels.ts` with the same rules as on the Claude side (see design.md section 4): every named account can have an alias, the default account and the external-directory row cannot; must not equal the name or label of another Codex account; display-only, the directory does not change; when adding an account the name must not equal the name or label of any Codex account (compared case-insensitively); removing an account clears its alias. Independent of `claude.labels`; the same name is allowed on both sides.
- The selected account is whatever the state file says (shared across windows, the last writer wins).
- The directory actually effective in this window = the extension host's own `process.env.CODEX_HOME`, or `~/.codex` when empty. With remote type `wsl` the Codex extension does not rewrite it. The panel marks it as "current"; when it differs from the state file, "X selected; takes effect after restarting the server" is shown (X is the display name; an unregistered directory shows its path).
- Signed-in state: whether `<dir>/auth.json` exists.
- Email and plan (`readCodexAccountInfo`): when `auth.json` exists it is parsed as JSON; `auth_mode === 'apikey'` (when `auth_mode` is missing: `OPENAI_API_KEY` non-empty and no `tokens`) → plan `API key`, no email; otherwise only the second part of `tokens.id_token` is base64url-decoded (`decodeJwtPayload`, no signature check), taking `email` and `https://api.openai.com/auth`.`chatgpt_plan_type`; the plan is capitalized by `formatCodexPlan` (`prolite` → `Pro Lite`). A parse failure means unknown but still signed in. The function never returns or logs any raw token.
- Identity (`CodexAccountInfo.identity`): an opaque comparison key from the same decoded payload, user id (`https://api.openai.com/auth`.`chatgpt_user_id`, else `.user_id`, else top-level `sub`) plus workspace (`.chatgpt_account_id`); only when both exist, never in API key mode, and never from the email (one email can belong to several workspaces, and a false warning is worse than none). It is never displayed, logged, persisted or sent to the Webview. Registered accounts (default + named) that share one produce the duplicate sign-in warning of [Claude design 6.8](design.md#68-accounts-signed-in-to-the-same-identity).

## 7. User interface

- The activity bar container "PlanSwap" ("PlanSwap") holds a single Webview view `planswap.accounts`, also named "PlanSwap"; the tab bar at the top of the panel switches between the Claude and Codex pages. The Codex page is a page rendered by the same `AccountsPanel` instance from the data provided by `codexPanelSource` (the current tab is stored in the memento `panel.activeTab`, see design.md 5.1). The frontend uses page-specific texts, all from the Webview i18n tables in the current UI language (see design.md 5.5).
- While not enabled (a file without the marker block, or with a broken one, section 4 pre-check 5), the Codex page only shows an explanation, the "Enable Codex switching" button and the "Tools" row; enabling with a broken block leads to the repair guidance.
- Once enabled the layout matches the Claude page: account list (current account pinned to the first row), "Tools" row, add input at the bottom; every named account row also has a pencil icon for renaming (aliases stored per account in `codex.labels`).
- Differences:
  - Switch button → modal confirmation → write the state file → restart the WSL server (automatic kinds only, section 5); a local desktop editor is restarted by the user (5.1). A target that is already effective in this window only realigns the state file (8.1 step 1). There is no reload banner; when the state file and the effective directory differ, the top shows "X selected; takes effect after restarting the server" ("…restarting the editor" in a local window) with a button whose label follows `RestartInfo`: "Restart server" (WSL, automatic) or "Show instructions" when only manual guidance is available.
  - Current and other rows: email and plan when there is an email (`Plus`, `Pro`, `Team`, `API key`, etc.); "Logged in" when signed in without email; "Not logged in" when signed out.
  - The "Log in" button of signed-out accounts runs `env CODEX_HOME='<dir>' codex login` in a terminal; alternatively switch and sign in directly in the Codex panel (the directory is empty, so no account is revoked).
  - The terminal icon of signed-in accounts runs `env CODEX_HOME='<dir>' codex`.
  - The current account cannot be removed.
  - The add section has the shared checkbox (help line for a valid name, checked: `codex.addHelpShared` "Will create ~/.codex-<name> linked to the default account's settings, rules, skills, history, sessions and thread databases (memories stay per account)"); shared rows have the `link` badge and independent rows that are not current have the "Link to the default account: …" button (the host also refuses the selected account, 8.6), as on the Claude page.
  - The "Tools" row has `AGENTS.md` (opens `<effectiveDir()>/AGENTS.md`), the Codex extension settings (`chatgpt.`), "Re-link" (re-links every shared Codex account, 8.6; shown only while one exists), and "Update CLI" (opens a terminal and runs `env -u CODEX_HOME codex update`; see features.md section 5.5).

## 8. Commands and flows

Command titles below are the English entries of `package.nls.json`; the category is "Codex Account" ("Codex 账号").

| Command id | Title | Behavior |
|---|---|---|
| `planswap.codex.enable` | Enable Codex Account Switching | Section 4 |
| `planswap.codex.disable` | Disable Codex Account Switching | Section 4 |
| `planswap.codex.switchAccount` | Switch Codex Account | QuickPick → 8.1 |
| `planswap.codex.addAccount` | Add Codex Account | `panel.focusAdd('codex')`: opens the panel, switches to the Codex tab and focuses the add input |
| `planswap.codex.removeAccount` | Delete Codex Account | QuickPick (without the current account) → 8.3 |
| `planswap.codex.openTerminal` | Run codex in Terminal with Codex Account | QuickPick → 8.4 |
| `planswap.codex.refreshUsage` | Refresh Codex Usage Limits | 8.7 |
| `planswap.codex.restartServer` | Apply Codex Account: Restart or Show Instructions | Section 5 / 5.1, for when the state file has been changed but the server or editor not yet restarted: restarts an automatic WSL kind after a modal, otherwise shows the manual instructions (command id unchanged) |

### 8.1 Switch

A switch request that arrives while another switch is in progress (e.g. its modal is open) is ignored.

1. Return immediately when the target equals both the directory effective in this window and the content of the state file. When it is effective but the state file says otherwise (e.g. another window switched), only the state file is written and the view refreshed: no confirmation, no restart.
2. Report an error and return when the target directory does not exist.
3. Modal confirmation (text from section 5, depending on the editor kind).
4. If the target is a shared account, `ensureCodexLinks` runs first (8.6); a non-empty report or an error only shows the warning "Re-linking X to the default account reported: …". Then write the state file atomically (empty for the default account).
5. Automatic kinds: restart the server as in section 5; when the checks fail, show the manual method. Manual kinds (including a local desktop editor, 5.1): nothing more (the confirmation already showed the manual method).

### 8.2 Add

1. Name validation as on the Claude side: `^[A-Za-z0-9_-]+$`, not equal to `default`, not equal to the name or label of any Codex account, `~/.codex-<name>` not equal to `~/.codex` (compared after resolving symlinks).
2. Create `~/.codex-<name>` (0700).
3. Shared (checkbox checked, the default): `ensureCodexLinks(dir)`; a non-empty report is shown as a warning (e.g. `config.toml` "not linked for safety"). Independent: `copyCodexIndependent(dir)` copies once, never overwriting: `config.toml` from `~/.codex` as a starting point (`copyCodexSeed`, mode 0600), then `AGENTS.md` and `hooks.json` (0600), the folders `rules`, `hooks`, `agents`, `themes` and the children of `skills/` except `.system`. If `config.toml` contains any of the following top-level keys it is not copied and the reason is explained: `forced_login_method`, `forced_chatgpt_workspace_id`, `sqlite_home`, `log_dir`, `model_provider`; `model_providers` in any form (a `[model_providers]` / `[model_providers.x]` table, a dotted key `model_providers.x.base_url = …`, an inline table `model_providers = { … }`) also prevents copying. Keys are matched after normalizing quotes and whitespace around dots (`"model_provider" = …`, `[ model_providers.x ]`), and a dotted key or table header counts when its first segment is blocked. Nothing else is copied (including `packages/`; the CLI binary stays under `~/.codex/packages` and keeps working). `auth.json` is never copied or linked. A failure of this step only warns and does not block; a failure to create the directory is reported in the help line and nothing is registered.
4. Register the account, refresh the view.

### 8.3 Remove

- The default account, the account effective in this window and the account the state file currently points to cannot be removed. The check is repeated after each modal (another window may have selected the account meanwhile): when it fails after the delete confirmation, nothing is removed; when it fails after the directory prompt, the list entry is already gone and the directory is kept.
- Remove it from the list and record it in `codex.ignoredDirs`, clear its alias with `labels.remove(name)`; then confirm with a modal whether to delete the directory (detail `codex.removeDirDetail`; for a shared account `share.removeDirDetail`: "Linked data in the default account will be kept. This account directory and everything stored locally in it, including login credentials, per-account memories, backups and other unlinked files, will be permanently deleted.").
- Checks before deleting the directory: a direct child of the home directory; the basename matches `^\.codex-[A-Za-z0-9_-]+$`; not equal to `~/.codex` after resolving symlinks; not a symlink; no live daemon. Daemon check: read `daemon.pid`, `app-server.pid`, `daemon-updater.pid`, `app-server-updater.pid` under `<dir>/app-server-daemon/` (whichever exist); the content is JSON; take `pid` and `processStartTime`/`processIdentity.startTicks` and compare with the start time in `/proc/<pid>/stat`; a match means alive and deletion is refused; a missing file or parse failure counts as not alive; a valid pid file counts as alive when `/proc` itself is missing. When the checks pass, delete with `fs.rm` and remove the directory from `codex.ignoredDirs` (`store.unignore`). For a shared account this removes only its own files and its links (`fs.rm` does not follow symlinks; covered by a test).
- **Note: the daemon check depends on the JSON format of codex's pid files (field names `pid`, `processIdentity.startTicks` / `processStartTime`); re-verify after codex upgrades.**

### 8.4 Terminal

- `createTerminal({ name: "Codex (<display name>)" })`, sends `env CODEX_HOME='<dir>' codex` or the sign-in command. The default account sends `env -u CODEX_HOME codex`, which overrides both sources: an rc file export and inheritance from the server's cached environment. Terminal names are not localized.
- The view is refreshed when the terminal closes.
- The sign-in command is accompanied by the information message `account.loginTip`: sign in in the terminal; other accounts stay signed in because each keeps its sign-in in its own directory, so there is no need to sign out first; signing out ends that account's session.

### 8.5 Rename an account

Panel `rename` message (with `dir` and `label`) → `panel.resolve('codex', dir)` finds the row (ignored when not found or when `kind !== 'named'`; the default row and the external-directory row cannot be renamed) → `labels.validate(label, account.name, store.all().map(a => ({ name: a.name, label: labelFor(a.name, labels) })))`; on error `post({ type: 'renameResult', mode: 'codex', dir, error })`; when valid `labels.set(account.name, <trimmed value>)` (cleared when it equals the account's own name) → `panel.refresh()` → `post({ type: 'renameResult', mode: 'codex', dir })`. The directory does not change; validation only looks at Codex accounts, and the same name as on the Claude side is allowed.

### 8.6 Shared and independent accounts

Same model as on the Claude side (design.md 6.7), implemented in `src/codex/codexShare.ts` (no vscode import), reusing the report types and link / merge helpers of `src/claudeShare.ts`. User-facing term: the UI calls a shared account a "linked account" ("链接账号"); the code and these documents keep "shared" as the internal term.

- **Mode detection**: shared iff `<dir>/sessions` is a symlink whose real path equals that of `~/.codex/sessions` (`isSharedCodexAccount`); never stored.
- **Shared entries** (`CODEX_SHARED_ENTRIES`, absolute symlinks to the same entry of `~/.codex`):
  - `file` (created empty in `~/.codex` when missing; `hooks.json` gets `{}`): `config.toml`, `AGENTS.md`, `hooks.json`, `history.jsonl`, `session_index.jsonl`;
  - `link-only` (linked even while the target does not exist; never pre-created, fact 15): `state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`, `.tmp/rollout-maintenance.lock` (the account's `.tmp` is a real folder created 0700, `.tmp` itself is never linked, and `~/.codex/.tmp` is created so opening the link with `O_CREAT` works);
  - `dir`: `sessions` (marker), `archived_sessions`, `rules`, `hooks`, `agents`, `themes`, `thread-writer-locks`, `rollout-migrations`, `attachments`, `generated_images`, `shell_snapshots`, `tui-thread-reference-capabilities`;
  - per child (`CODEX_CHILD_SHARED_DIRS`): `skills` except `.system`, `plugins/cache` except `openai-curated-remote`.
- **Never touched**: `auth.json`, `.credentials.json`, `.env`, `models_cache.json`, `cache/`, `memories/`, `memories_*.sqlite`, `memories_extensions/`, `logs_2.sqlite`, `log/`, `app-server-daemon/`, `app-server-control/`, `ipc/`, `packages/`, `tmp/`, `mcp-oauth-locks/`, `installation_id`, `version.json`, `.sandbox_migration`, `vendor_imports/`, `worktrees/`, the rest of `plugins/`, `.remote-plugin-install-staging`, `skills/.system`, `.tmp/rollout-compression.lock` (fact 16).
- **`config.toml` refusal**: not linked (reported under `refused`) when the default config cannot be read or `blockedConfigReason` finds one of `CODEX_IDENTITY_CONFIG_KEYS` (`model_provider`, `forced_login_method`, `forced_chatgpt_workspace_id`, `sqlite_home`, `log_dir`, `cli_auth_credentials_store`, `mcp_oauth_credentials_store`, `chatgpt_base_url`, `openai_base_url`, `profile`, `oss_provider`) at top level or a `CODEX_IDENTITY_CONFIG_TABLES` table (`model_providers`, `profiles`). The refusal is re-evaluated every time links are refreshed: an existing account link to the default `config.toml` is removed when the default config has gained identity keys since (no copy is made; the account is left without `config.toml` and the entry is reported as refused); a regular file or a link elsewhere in the account is not touched.
- **`ensureCodexLinks(dir)`** (idempotent create / repair, like `ensureClaudeLinks`): in an account that is already shared, a regular `history.jsonl` / `session_index.jsonl` (Codex replaced the link, fact 16) is repaired with `mergeLines` (shared with the Claude side): the lines the default file lacks are appended (whole-line comparison, order kept, bytes preserved), the account file is removed and the link re-created. A regular thread database in a shared account is a conflict and stays untouched. A whole-folder `skills` / `plugins/cache` link from an earlier version is replaced by per-child links; child links whose default target is gone are removed.
- **When links are refreshed**: on add (shared), after the switch confirmation (8.1 step 4), by "Re-link" and at the end of a conversion. There is nothing to mirror on the Codex side.
- **Conversion** (`share` message; refused for the account effective in this window or the selected account with "Switch away from X before linking it."; modal `share.confirmCodex`, which also warns that resuming another ChatGPT account's session may be rejected):
  1. Busy check `codexAccountBusy(dir)`: `codexDaemonAlive(dir)`, or any `/proc/<pid>` whose `exe` basename is `codex` (a ` (deleted)` suffix is ignored) and whose `CODEX_HOME` in `environ` resolves to the directory (for `~/.codex`: unset, empty or equal); an unreadable `/proc` counts as busy. Environment alone is not enough, since shells and MCP servers inherit `CODEX_HOME`. Busy → warning "Codex is still running with account X; close it (including the editor's Codex panel sessions) and try again."
  2. `migrateCodexToShared(dir, accountName)`: folders merged as on the Claude side; `history.jsonl` / `session_index.jsonl`: lines merged into the default file; `config.toml` / `AGENTS.md` / `hooks.json` / `.tmp/rollout-maintenance.lock`: when `~/.codex` lacks the file it is moved there and becomes the shared one (a `config.toml` with identity keys or tables stays in the account, not linked); identical → dropped, otherwise renamed to `<name>.independent-backup` (`config.toml` also stays when the default config is refused); thread databases: renamed with their `-wal` / `-shm` files to `<db>.independent-backup` (suffixes kept; `-2`, `-3`… when taken), then linked; `skills` / `plugins/cache` children merged; nested entries only inside a real account folder (a linked `.tmp` is never followed). Ends with `ensureCodexLinks`.
  3. Summary "X is now linked to the default account. <summary>" or "Linking X stopped: <reason>"; the view is refreshed.
- **Independent creation**: `copyCodexIndependent` (8.2 step 3). "Re-link" ignores independent accounts. Conversion back: **`makeCodexIndependent(dir, accountName)`** (throws `t('unshare.default')` / `t('unshare.notShared')`, and `t('share.busyCodex')` after the same busy check as the conversion) unlinks first the configuration entries (`config.toml`, `AGENTS.md`, `hooks.json`, the copied folders, the `skills/` children) whose link resolves into `~/.codex`, runs `copyCodexIndependent`, and only then unlinks history, `session_index.jsonl`, the databases (dangling `link-only` links included), the `sessions` marker, the other folders and the `plugins/cache` children, so a failed copy leaves the account shared and `ensureCodexLinks` repairs it; sessions, history and thread databases stay in `~/.codex`, `auth.json` and `memories/` are untouched. The host (`unshareAccount`) refuses the effective and the selected account, confirms with a modal, runs the busy check itself as well and reports "X is now independent: removed N link(s), copied <list>." (plus the skipped seed reason).

### 8.7 Usage limits

The status bar tooltip shows the usage limits of **this window's effective account** (`effectiveDir()`), never of the pending selection; the status bar text is unchanged. Claude has no equivalent: it offers no supported way without reading credentials.

- **Query** (`readCodexUsage`, facts 24-26): only when `<dir>/auth.json` exists (otherwise `notLoggedIn` and nothing is started). Starts `codex app-server` with `CODEX_HOME=<dir>` (on Windows a `codex.cmd` fallback through the shell as the single fixed command line `codex.cmd app-server`; when no `codex` is on PATH at all, the binary bundled with the Codex extension `openai.chatgpt` at `bin/<os>-<arch>/codex[.exe]`, only for this OS and architecture — a Windows install also ships `linux-x86_64` for WSL), sends `initialize` (client name `planswap`, the extension version) and `initialized`, checks that the reported `codexHome` is the requested directory (case-insensitive on Windows), then sends `account/rateLimits/read`. The `codex` bucket is preferred; `usedPercent` is clamped to 0-100. Results: ok, `authExpired` (the service refused the stored sign-in with 401; observed with codex-cli 0.139.0 as error -32603 "… 401 Unauthorized …"; checked first, since that message also says "authentication"), `notLoggedIn` (also for an authentication-required error), `cliMissing`, `timeout` (15 s) or `failed` with a short detail (server message/code or exit code). Raw protocol lines are never returned or logged. The child it started is always ended: stdin is closed, and only that child is killed after a 1 s grace.
- **Credentials**: PlanSwap never reads token values; Codex reads its own credentials in that directory and may refresh them or write helper files there, exactly as `codex` in a terminal.
- **Scheduling** (`CodexUsageMonitor`): one query at a time (concurrent refreshes join). A first check runs a few seconds after activation; afterwards only while the window is focused (a periodic tick and on regaining focus), and only when the last attempt, failed ones included, is older than 15 minutes, so with several windows open only the one in use queries and failures are not retried in a loop. On an account info change the monitor queries at once only when the effective account's `auth.json` stamp (`authFileStamp`: mtime and size from `stat`, or missing; the file is never opened) differs from the one recorded when the last query ended: a sign-in, a re-login after an expired sign-in, or a sign-out. Rewrites Codex makes during PlanSwap's own query (token refresh) are therefore not a change, and other panel pushes start nothing. API key accounts are never queried (nothing is started). `planswap.codex.refreshUsage` and the tooltip's "Refresh usage" link query immediately. Nothing is queried when Codex is not initialized or runs inside WSL (9a). Results stay in memory only.
- **Tooltip**: per window "{duration}: {used}% used, resets {time}" (e.g. 5h / 7d; local time, time only when today), "Usage limit reached" and "Checked {time}"; "Checking usage limits…" while a query runs; otherwise an "unavailable" line (codex not found, sign-in expired — sign in again, no answer in time, or the detail). Signed-out and API key accounts show no usage lines. The tooltip is a `MarkdownString` whose only trusted command is `planswap.codex.refreshUsage`; account text is appended as escaped text.

## 9. Refresh triggers

- Creation, change or deletion of `auth.json` in each account directory (a change updates email and plan, re-checks duplicate identities, and re-checks the usage limits when the effective account's `auth.json` changed, 8.7).
- State file changes (so the "takes effect after restart" banner shows up when another window switches).
- After adding or removing an account; after a terminal closes; when the refresh button is clicked.
- When `planswap.language` changes (the whole panel re-renders in the new language).

## 9a. Native Windows

Local Windows editors have no rc files and no WSL server. Selection is persisted in the per-user environment variable `CODEX_HOME` (`HKCU\Environment`):

- Switching is refused (warning `codex.notEnabled`) until Codex switching is enabled, on every platform. Enable (`planswap.codex.enable`): refused when the user already has a user-level `CODEX_HOME` that PlanSwap does not own (a value pointing at `~/.codex-<name>` is adopted, e.g. after the state file was deleted); otherwise, after a modal confirmation, the state file `~/.config/planswap/codex-home` is created (its existence means "managed"). A self-check writes a marker into the scratch user variable `PLANSWAP_SELF_CHECK` (never `CODEX_HOME` itself), reads it back and removes it; failure rolls the enablement back. Values are read through PowerShell as base64 of their UTF-8 bytes: without a console (the extension host) `reg query` prints the ANSI code page and garbles non-ASCII paths (verified 2026-09-30 on a code page 936 system).
- Switch: `CODEX_HOME` is set first and the state file written second (a failed write restores the variable). The variable is set, or removed for the default account, through `[Environment]::SetEnvironmentVariable(..., 'User')` in `powershell.exe`, which also broadcasts the change to Explorer. The value is passed in a child environment variable, never in the command line.
- Restart: not automatic. Running editors and their terminals keep the environment they were started with, so the user must quit every editor window and start the editor again from the Start menu or taskbar (a `code` launch from a terminal inherits that terminal's old value). This follows the same principle as [section 2, fact 20](#2-background-facts-verified) for local desktop editors.
- Disable removes the state file, and the user-level variable only while it still points at an account directory `~/.codex-<name>` (a value the user set in the meantime stays). The Windows texts (disabled page `disabled.textWin`, enable self-check `codex.win.selfCheckFailed`, disable confirmation `codex.win.disableConfirm`, Claude `claude.win.loginNotLanded`) name the user environment variable instead of rc files and `~/.bashrc`.
- **Databases are never linked on Windows.** SQLite derives a database's `-wal` / `-shm` names from the path it opened, not from a link's target: on the GitHub Windows runner (2026-09-30, SQLite 3.53.4) a database opened through a file link got a second WAL beside the link, a connection on the real path did not see 500 rows written through the link, and after closing both they were gone while `integrity_check` still said `ok` (Linux follows the link and loses nothing). So `ensureCodexLinks` skips `state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite` and `queue_1.sqlite` there and removes such a link left from before (`removeWindowsSqliteLink`: its side files become `<file>.windows-link-backup` so a new database never replays them; reported under `refused`, or `busy` while a side file is open); conversions keep the account's own databases, and making an account independent removes those links first. Each Windows account therefore keeps its own thread databases while rollouts, history and configuration are still shared.
- `auth.json` remains read-only; accounts stored in the OS keyring instead of `auth.json` (`cli_auth_credentials_store = keyring`/`auto`) read as signed out.
- **Codex run inside WSL**: with the Codex extension setting `chatgpt.runCodexInWindowsSubsystemForLinux` on, Codex reads the WSL-side `~/.codex` and never sees the Windows `CODEX_HOME`, and PlanSwap never reads WSL files from Windows. `codexRunsInWsl()` is then true: enable and switch are refused with `codex.win.runsInWsl` (open a WSL window and manage the accounts there, or turn the setting off), the status bar tooltip shows `status.codexRunsInWsl` instead of usage limits, and no usage query runs. The status bar re-renders when the setting changes.
- Not verified on real Windows: that the extension host inherits the changed variable after a fresh start, Codex's default credential store there, and that the Codex extension really ignores the Windows `CODEX_HOME` in its WSL mode; see [TODO](../TODO.md).

## 10. Code structure

Codex module responsibilities and signatures are maintained in [Codex interfaces](codex-interfaces.md); shared protocol, labels, panel and localization contracts are in [Interfaces](interfaces.md). The repository map is in [Development](development.md#repository-layout).

Logic shared with Claude (path safety checks, `shQuote`, avatars, link/merge helpers and `describeShareReport`) is extracted into shared functions without changing Claude's behavior.

## 11. Implementation order and verification

For changes to shell configuration or server restart behavior, validate the data-layer paths before the dependent UI flows. Automated tests use temporary HOME directories and fake process trees; they must never signal an editor server.

The self-check, server/terminal shutdown observations, reconnect environment checks and return-to-default checks are maintained in [Manual Verification](manual-verification.md#codex). Real-server restart checks are performed by the user. Outstanding acceptance work remains in [TODO](../TODO.md).

## 12. Known limitations

1. Every Codex account switch restarts the WSL-side server: all WSL windows disconnect and each needs one "Reload Window" click; integrated terminals close. The restart is automatic only in Antigravity and VSCodium; in VS Code and unrecognized editors the user closes and reopens the windows.
2. The state file is global and the last writer wins; other windows switch as well after the server restarts.
3. Independent accounts keep all local data (sessions, skills, prompts, memories, approval rules, etc.) separate. Shared accounts share sessions, history, configuration, rules, skills and thread databases with `~/.codex`, but memories stay per account (fact 17), and so do logs, caches and the daemon state.
4. Relies on two behaviors: Antigravity resolves the extension host environment through a login shell, and the server is started again automatically after it dies. Both come from the upstream VS Code implementation and must be re-verified after upgrades.
5. `~/.profile` and `~/.bashrc` contain an extra marker block maintained by this extension; the disable command removes it.
6. Only bash is supported as the login shell; zsh must be configured manually; fish is not supported.
7. A leftover Codex instance on the Windows side is unrelated to this design and is not affected.
8. When an rc marker block has been damaged by hand (start marker, no end marker), both the enable and the disable command refuse and ask for a manual fix, without changing the files.
9. Resuming a session started by another ChatGPT account (organization) may be rejected by the server because its encrypted reasoning / compaction content is organization-bound (fact 18); high risk when switching between accounts of different organizations.
10. Two accounts resuming the same session at the same time write to the same rollout file; avoid it.
11. Shared accounts are only re-linked when adding, after the switch confirmation, by "Re-link" and after a conversion; Codex replacing a link in between is repaired only then (jsonl files) or reported (other entries).
12. Converting an independent account cannot be undone automatically; differing files are kept as `<name>.from-<account>` / `<name>.independent-backup`, and the account's thread databases are only kept as backups.
13. MCP servers in the shared `config.toml` are shared, but MCP OAuth credentials are never linked or copied, so OAuth-based servers must be authorized in each account; for independent accounts, `env` values of MCP servers are copied in plain text with `config.toml`.
14. Local desktop switching (5.1) saves the selection and shows manual restart instructions. There is no desktop automatic quit/relaunch. The previously user-tested external launcher remains a manual route; installed-build acceptance of the updated guidance remains pending. Cold starts depend on the launch route (5.1).
15. Usage limits (8.7) depend on the `codex app-server` protocol (facts 24-26) and on a `codex` on the extension host's PATH or, failing that, the binary bundled with the Codex extension for this OS and architecture; each query starts a short-lived CLI process that contacts OpenAI's service as the CLI itself does. Each window keeps its own in-memory result.
