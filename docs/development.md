# Development

Purpose: repository layout, setup, dependency and build constraints, automated checks, packaging, and editor troubleshooting. Runtime design belongs in [Claude design](design.md) / [Codex design](codex-design.md); module contracts belong in [Interfaces](interfaces.md) / [Codex interfaces](codex-interfaces.md). UI and real-account acceptance steps live in [Manual Verification](manual-verification.md). See the [documentation map](README.md) for ownership.

## Repository layout

| Path | Responsibility |
|---|---|
| `src/` | Extension activation, Claude flows and shared host modules; [module contracts](interfaces.md). |
| `src/codex/` | Codex account, environment and restart modules; [module contracts](codex-interfaces.md). |
| `src/webview/` | Frontend rendering, translations and theme-based CSS; shared protocol types come from `src/protocol.ts`. |
| `test/` | Pure-module tests, temporary-HOME helpers, in-memory Memento and the VS Code stub. |
| `scripts/run-tests.mjs` | esbuild test bundling and the `node --test` runner. |
| `resources/` | Marketplace icon (`icon.png`), activity-bar icon (`account.svg`) and README artwork. |
| `docs/` | Specialized documentation; responsibilities and task routing in [the documentation map](README.md). |
| `.vscode/` | F5 launch configuration and its pre-launch build task. |
| `.github/workflows/publish.yml` | `v*` tag workflow for VS Code Marketplace and Open VSX publication. |
| `.github/workflows/test.yml` | Type check, tests and build on every push and pull request, on `ubuntu-latest` and `windows-latest` (elevated, so the `SHARING` and `FILE_SYMLINKS` tests run on real Windows links); failing tests are also reported as an annotation. |
| `package.json`, `package.nls*.json` | Extension manifest, commands, settings and localized static strings. |
| `esbuild.mjs`, `tsconfig.json`, `src/webview/tsconfig.json`, `test/tsconfig.json` | Host/frontend bundles and separate type-check scopes. |
| `.vscodeignore`, `.gitignore` | Packaging and Git exclusions. |

## Commands

```bash
npm install
npm run typecheck    # tsc --noEmit for host (root), src/webview and test
npm test             # scripts/run-tests.mjs: bundle test/*.test.ts, run node --test
npm run build        # bundle host to dist/extension.js, frontend to dist/media/
npm run watch        # esbuild watch (both entries)
npm run package      # vsce package (prepublish runs typecheck and build)
```

## Dependencies and build

Dependency versions below describe the recorded project baseline; `package.json` and the lockfile contain the exact installed pins. The npm tag observation is from the existing 2026-09-25 dependency notes and must be checked again when upgrading.

- Runtime dependencies (`dependencies`, pinned exactly):
  - `@vscode-elements/elements` 2.5.1: Web Components library for the Webview frontend (based on Lit).
  - `@vscode/codicons` 0.0.45: icon font. The npm `latest` tag points to the prerelease 0.0.46-24, which does not satisfy the component library's peer dependency `>=0.0.40` (prereleases do not take part in normal range matching), so the latest stable 0.0.45 is pinned.
  - Both are only bundled into the frontend artifacts, never into the extension host.
- Development dependencies (2026-09-27): typescript 7.0.2, esbuild 0.28.2, @vscode/vsce 4.0.0 are the latest stable versions; @types/vscode is pinned to 1.107.0. @types/node is pinned to the latest 22.x (22.20.4) because the extension host runs on the Node bundled with the oldest supported editor server (Antigravity with the VS Code 1.107 core ships Node 22); raise it only together with the `engines.vscode` baseline.
- `engines.vscode` is `^1.107.0`. The editor actually used is Antigravity IDE with a VS Code 1.107.0 core; an extension whose `engines` is higher than the editor version is refused. `@types/vscode` must not be higher than `engines`, so the latest version cannot be used; check the editor's core version before upgrading. New frontend dependencies must not require newer editor APIs either.
- Build (`esbuild.mjs`, two entries):
  - Extension host: `src/extension.ts` → `dist/extension.js` (cjs, platform node, target node22, external vscode, with sourcemap).
  - Webview frontend: `src/webview/main.ts` → `dist/media/panel.js`, `src/webview/panel.css` → `dist/media/panel-style.css` (iife, platform browser, target es2022; regular builds minify without sourcemaps, watch mode does not minify and emits sourcemaps).
  - At build start, `codicon.css` and `codicon.ttf` are copied from `node_modules/@vscode/codicons/dist/` to `dist/media/` (`node_modules` is not included in the vsix).
  - With `--watch` both entries are watched.
- Type checking uses separate tsconfigs: `npm run typecheck` runs `tsc --noEmit` (root `tsconfig.json`, host, types node and vscode, excludes `src/webview`), `tsc --noEmit -p src/webview` (frontend, lib includes dom, no node/vscode types, includes `../protocol.ts`) and `tsc --noEmit -p test` (tests).
- Tests: `npm test` runs `scripts/run-tests.mjs`, which bundles `test/*.test.ts` with esbuild into `.test-out/` (with `vscode` aliased to `test/stubs/vscode.ts`) and runs `node --test`. Tests cover the pure modules and run every file-system operation under a temporary HOME. The test runner needs Node 21 or later because the Webview i18n module reads the global `navigator` at load time; the extension host itself runs on the Node bundled with the editor (Node 22 for VS Code 1.107).
- Packaging: `vsce package` produces the `.vsix` (`vscode:prepublish` runs typecheck and build first; `.vscodeignore` excludes `src/`, `test/`, `scripts/`, `node_modules/`, `*.map`, docs, etc.; `package.nls*.json` are included). Installation: in a WSL window via "Extensions: Install from VSIX". This extension is never installed into the user's VS Code automatically.

Frontend assets must all be emitted into `dist/media/`, the Webview's only `localResourceRoots` entry. Frontend dependencies cannot be loaded from `node_modules` at runtime. `esbuild.mjs` also injects the manifest version as `__PLANSWAP_VERSION__`.

## Verification and release boundaries

- Before committing, `npm run typecheck`, `npm test` and `npm run build` must pass.
- File-system tests use a temporary HOME via `makeTempHome` in `test/helpers.ts` (it sets both `HOME` and `USERPROFILE`, which `os.homedir()` reads on Windows), which asserts the real home is not used. Never run account, rc-file or state-file write/delete tests under the real home. Busy checks and migrations use a fake `procRoot` where applicable; never test `executeRestart` or signal the editor server or its children.
- Tests also run on native Windows. Linux/WSL remains the full run; on Windows `test/helpers.ts` skips `LINUX_ONLY` tests (rc files and bash, `/proc`, the WSL server, fifos and chmod), `SHARING` and `FILE_SYMLINKS` tests when file symbolic links are refused (Developer Mode off; `windowsNoDevMode.test.ts` covers that case) and `CASE_SENSITIVE_FS` tests; `assertMode` checks POSIX modes only off Windows. Directory link fixtures pass the `'junction'` type (ignored on Linux). On Windows the test process refuses to run `reg` / `powershell.exe`, so nothing can touch the real user-level `CODEX_HOME`.
- The local tests use disposable fixtures; UI integration and real-account acceptance are separate and follow [Manual Verification](manual-verification.md). Record what ran and what remains unverified.
- Before releasing, check `README.md` and `CHANGELOG.md`: neither may contain `[Unreleased]` content, including an empty heading. Packaging does not authorize installation or publication. Never install the `.vsix` into the user's editor automatically; the user installs it after packaging. Publish only under the user's explicit release authorization.

## Automated test coverage

- Tests cover the panel provider readiness/focus lifecycle using in-memory Webview stubs, the pure modules (paths, fileState, labels, identity, claudeSettings, claudeShare, codexPaths, codexShare, codexState, codexServer, codexUsage, codexUsageMonitor; `claudeAccountBusy` / `codexAccountBusy` / the migrations take a fake `procRoot`; `readCodexUsage` takes a fake `spawn`, so tests never start a real `codex`), `IdentityWarnings` with fake sources and a warn callback, the two account stores (accounts, codexStore) with an in-memory Memento (`MemoryMemento` in `test/helpers.ts`), i18n key and placeholder parity across all four locales, locale resolution and manifest localization, and the pure helpers exported by `commands.ts` (`validateName`, `shQuote`) and `codex/codexCommands.ts` (`validateName`); every test that touches the file system runs under a temporary HOME created by `test/helpers.ts` (`makeTempHome`, which also asserts that the real home is not used). UI behavior is verified with [Manual Verification](manual-verification.md).

## 1. F5 does not load the extension in VS Code 1.139 (js-debug attach regression)

Recorded: 2026-09-26. This is an editor/environment issue, not extension behavior.

### Symptoms

In a VS Code 1.139.x WSL window, pressing F5 ("Run Extension") opens the Extension Development Host, but the extension is never activated. The debugger never attaches and the debug session ends after about 10 seconds with:

```
Error processing attach: Error: Could not connect to debug target at http://localhost:<port>:
Socket closed before the connection was established
```

The remote extension host log (`~/.vscode-server/data/logs/<session>/exthost*/remoteexthost.log`) is flooded with:

- `RequestError: connect ECONNREFUSED ::1:<port>`
- ``Error: The `onCancel` handler was attached after the promise settled.``

The Windows-side `renderer.log` shows "An unknown error occurred. Please consult the log for more details." about once per second while attaching.

Ctrl+F5 (Run Without Debugging) loads the extension normally, and F5 works in Antigravity (VS Code 1.107 core). The extension code is not involved.

### Cause

- For `extensionHost` launches the development extension host is started with `--inspect-brk=<port>`. It stops at the first line until a debugger attaches, and its inspector listens on `127.0.0.1` only.
- The bundled js-debug 1.117.0 looks up the target at `http://localhost:<port>` and probes `127.0.0.1` and `[::1]` in parallel.
- The race helper rejects as soon as one probe fails. The `[::1]` probe fails, the in-flight `127.0.0.1` probe is cancelled, and the lookup is retried every 200 ms until the 10 s timeout.
- So the debugger never attaches, and the extension host never runs past its first line.

Upstream reports: microsoft/vscode-js-debug#2416 and #2420, microsoft/vscode#337488 and #337774; the fix is milestoned for VS Code 1.140.

Checked and ruled out:

- **Proxy resolution.** VS Code's extension-host proxy support always treats `localhost` / `127.0.0.1` as DIRECT.
- **System certificates V2.** `http.experimental.systemCertificatesV2` defaults to `false`, and V1 only affects HTTPS.
- **WSL mirrored networking.** `curl` to the inspector URL from WSL answers instantly.
- **Port forwarding.** No debug port was forwarded or bound on the Windows side.

### Workaround

Patch the js-debug that VS Code runs on the WSL side so it asks for IPv4 directly.

In `~/.vscode-server/bin/<commit>/extensions/ms-vscode.js-debug/src/extension.js`, in `launchProgram` of the extension host attach, replace:

```
$l(`http://localhost:${t.params.port}`
```

with:

```
$l(`http://127.0.0.1:${t.params.port}`
```

Steps:

1. Back up the file first.
2. Check that the string occurs exactly once. The minified names (`$l`, `t.params.port`) can differ between builds.
3. Check the result with `node --check`.
4. Run "Developer: Reload Window" and press F5 again.
5. If something goes wrong, restore the backup.

Only this occurrence is used by F5. The similar `` Wv(`http://localhost:${t.connection}` `` belongs to the plain Node attach path and does not help.

Notes:

- This edits the editor installation, not the repository. A VS Code update replaces the server directory and drops the patch. Re-check after each update, and drop the workaround once the upstream fix has shipped.
- Alternatives that change nothing:
  - Use Ctrl+F5 in VS Code and debug with breakpoints in Antigravity.
  - Stay on VS Code 1.138 until the fix is released.
- An extension host left over from a failed attempt stays paused at `--inspect-brk`. Close its window, or reload the WSL window, to reclaim it.

## 2. Local Linux desktop testing through WSLg

Recorded environment (2026-09-27; a test snapshot, not minimum requirements): Ubuntu 26.04.1 amd64 in the user-supplied `Ubuntu_26_Dev` distribution, WSL 2.6.3.0 / WSLg 1.0.71, Linux desktop VS Code 1.139.1 (`/usr/share/code/code`), PlanSwap 0.1.4, Claude Code extension 2.1.283 and Codex extension 26.917.62051. This is a local Linux editor displayed through WSLg, not Windows VS Code connected through Remote WSL. A full Linux desktop environment is not required.

### Manual test launcher

The test setup uses an external `~/.local/bin/vscode-linux-test` launcher with the following recorded contents. This script is not installed or maintained by PlanSwap; adjust the executable and profile paths for another environment.

```sh
#!/bin/sh

# Apply the saved selection before the editor and its extensions start.
planswap_selection="$HOME/.config/planswap/codex-home"
if [ -f "$planswap_selection" ]; then
  planswap_codex_home=$(cat "$planswap_selection") || exit 1
  if [ -n "$planswap_codex_home" ]; then
    if [ ! -d "$planswap_codex_home" ]; then
      printf 'Selected Codex directory does not exist: %s\n' "$planswap_codex_home" >&2
      exit 1
    fi
    export CODEX_HOME="$planswap_codex_home"
  else
    unset CODEX_HOME
  fi
fi

exec dbus-run-session -- sh -c '
  gnome-keyring-daemon --start --components=secrets
  exec /usr/share/code/code \
    --password-store=gnome-libsecret \
    --user-data-dir="$HOME/.config/Code-PlanSwap-Test" \
    --extensions-dir="$HOME/.local/share/planswap-test/extensions" \
    --new-window "$@"
' vscode-linux-test "$@"
```

Run `vscode-linux-test` (optionally with a workspace path) from the Ubuntu terminal and keep that terminal open. The launcher reads the saved selection before startup: a named selection sets `CODEX_HOME`, an empty selection unsets it for default, and an absent file preserves the unmanaged environment. An unreadable selection or a missing selected directory stops launch.

When ready to apply another selection, save work and fully exit the intended editor instance before relaunching; an existing instance with the same user data directory can absorb a new launch and keep the old environment. Preserve the original profile/extensions arguments and workspace. The separate editor directories isolate editor configuration and extensions, **not HOME or account data**. Automated account/state tests still require a temporary HOME.

### Keyring and display observations

- The test session initially pointed to a missing `/run/user/1000/bus`. Starting GNOME Keyring and the editor under `dbus-run-session` allowed startup. A private bus ends with its wrapped process: use the launcher again to create a fresh session, rather than reuse the ended bus address. Secure-storage persistence/unlock across fresh sessions was not separately verified.
- WSLg displayed `xeyes` successfully. The VS Code test profile used `"window.titleBarStyle": "native"`.
- Multiple monitors with mixed scaling produced mouse-coordinate offsets. Moving the window between monitors was followed by a user report that dragging worked; this was an observed workaround, not a verified permanent fix. Relevant upstream reports: [WSLg #324](https://github.com/microsoft/wslg/issues/324) and [WSLg #1233](https://github.com/microsoft/wslg/issues/1233).

The current manual switching contract is in [Codex design §5.1](codex-design.md#51-local-desktop-editor-manual-restart), procedures in [Manual Verification](manual-verification.md#codex-in-a-local-linux-desktop-vs-code), and remaining acceptance in [TODO](../TODO.md).

## Panel startup diagnostics

Search for `[planswap]` in the extension host log for activation start/completion, panel document creation, document-ready latency, and account-state read duration/counts. In the Webview developer tools console, the same prefix identifies frontend initialization, first-state wait, and first-card DOM update duration. Host and frontend durations use separate monotonic clocks; do not subtract timestamps across them. DOM update duration is not a browser-paint measurement. These diagnostics contain timings and counts, not account names, emails, paths or credentials.

For a cold-start investigation, record both logs from editor startup through the first visible cards. For a connectivity investigation, also record whether the document reloads and whether another `ready`/first-state sequence occurs. Logging does not itself establish the cause of a delay or an offline failure.
