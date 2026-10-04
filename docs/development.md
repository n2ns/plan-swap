# Development

Purpose: repository layout, build, test and release mechanics, localization terminology, and editor troubleshooting. Rules for agents live in [AGENTS.md](../AGENTS.md); runtime design in [Claude design](design.md) / [Codex design](codex-design.md); UI and real-account acceptance steps in [Manual Verification](manual-verification.md). Exact dependency versions and scripts are in `package.json`. See [AGENTS.md](../AGENTS.md#read-the-documents-relevant-to-the-task) for ownership.

## Repository layout

| Path | Responsibility |
|---|---|
| `src/` | Extension activation, Claude flows and shared host modules. |
| `src/codex/` | Codex account, environment and restart modules. |
| `src/webview/` | Sidebar frontend; shared message types come from `src/protocol.ts`. |
| `test/` | Unit tests, temporary-HOME helpers, in-memory Memento and the VS Code stub; `test/integration/` holds the real-editor smoke suite. |
| `scripts/` | Test, UI-test, preview and measurement runners. |
| `resources/` | Marketplace, activity-bar and README artwork. |
| `docs/` | Claude/Codex design (rationale, verified external facts), `features.md` (user-visible behavior), `manual-verification.md`, this file, and the user guides (`user-guide*.md`). Agent rules and the document routing table are in [AGENTS.md](../AGENTS.md#read-the-documents-relevant-to-the-task). |
| `docs/research/` | Dated upstream evidence and reproducible measurements. |
| `docs/branding/candidates/` | Image-generation prompts and candidate designs; not runtime behavior or coding rules. |
| `.vscode/` | F5 launch configuration and its pre-launch build task. |
| `.github/workflows/` | `test.yml` (every push and pull request) and `publish.yml` (`v*` tags); see [CI](#ci). |
| `package.json`, `package.nls*.json` | Extension manifest and localized static strings. |
| `esbuild.mjs`, `tsconfig.json`, `src/webview/tsconfig.json`, `test/tsconfig.json` | Host/frontend bundles and separate type-check scopes. |

## Testing, build and release

The rules (what must pass before committing, temporary HOME, fake processes, no restart tests, release authorization) are in [AGENTS.md](../AGENTS.md#test-and-release-safety). This section describes the mechanics.

### Commands

```bash
npm install
npm run typecheck          # host, Webview and test type-check scopes
npm test                   # bundle test/*.test.ts, run node --test
npm run build              # host to dist/extension.js, frontend to dist/media/
npm run watch              # esbuild watch (both entries)
npm run test:integration   # real VS Code smoke tests (Linux/WSL with a display)
npm run test:ui            # Webview layout and interaction checks in Chromium
npm run preview            # Webview preview at http://127.0.0.1:8768/
npm run perf --silent > report.json   # synthetic account-read measurements
npm run package            # vsce package; prepublish runs typecheck and build
```

F5 in a WSL window uses the "Run Extension" launch configuration; `.vscode/tasks.json` runs `npm run build` first, then starts the Extension Development Host.

### Dependencies and build

- The runtime dependencies (`@vscode-elements/elements`, `@vscode/codicons`) are bundled into the frontend only, never into the extension host. Frontend assets must all be emitted into `dist/media/` ([`esbuild.mjs`](../esbuild.mjs) documents the entries, the codicon copy and `__PLANSWAP_VERSION__`).
- `@vscode/codicons` is pinned to the latest stable release: on 2026-09-25 the npm `latest` tag pointed to the prerelease 0.0.46-24, which does not satisfy the component library's peer range `>=0.0.40` (prereleases do not take part in normal range matching). Re-check when upgrading.
- `engines.vscode` stays at `^1.107.0` because the editor actually used is Antigravity IDE with a VS Code 1.107.0 core, and an editor refuses an extension whose `engines` is higher than its version. `@types/vscode` must not be higher than `engines`, and new frontend dependencies must not require newer editor APIs. Check the editor's core version before upgrading.
- `@types/node` stays on the 22.x line because the extension host runs on the Node bundled with the oldest supported editor server (Node 22 for the 1.107 core); raise it only together with the `engines.vscode` baseline.
- Type checking uses three scopes: the root `tsconfig.json` (host, excludes `src/webview`), `src/webview/tsconfig.json` (DOM, no Node or vscode types) and `test/tsconfig.json`.

### Tests

- `npm test` runs `scripts/run-tests.mjs`: it bundles `test/*.test.ts` into `.test-out/` with `vscode` aliased to `test/stubs/vscode.ts` and loads `scripts/test-guard.cjs` first, which refuses `reg` / `powershell` / `pwsh` / `setx` so no test can touch the real user-level `CODEX_HOME`. The runner needs Node 21 or later because the Webview i18n module reads the global `navigator` at load time.
- `makeTempHome` (`test/helpers.ts`) points both `HOME` and `USERPROFILE` (read by `os.homedir()` on Windows) at a temporary directory, clears inherited account variables and asserts the real home is not used. The account stores are tested with `MemoryMemento`.
- On native Windows, `test/helpers.ts` skips the categories it defines (`LINUX_ONLY`, `FILE_SYMLINKS`, `SHARING`, `CASE_SENSITIVE_FS`) with the reasons given there; Linux/WSL remains the full run.
- Unit tests use disposable fixtures. UI integration and real-account acceptance are separate and follow [Manual Verification](manual-verification.md). Record what ran and what remains unverified.

### CI

- `test.yml` runs type check, tests and build on `ubuntu-latest` and `windows-latest` with Node 22 and 24. The Windows runner is elevated, so the `SHARING` and `FILE_SYMLINKS` tests run on real Windows links; a step fails the job if they are skipped there. Failing tests are reported as an annotation. A separate Linux job runs the [real editor smoke tests](#real-editor-smoke-tests).
- `publish.yml` runs on every pushed `v*` tag: it checks that the tag matches the `package.json` version, tests on Linux and Windows, packages the `.vsix` and publishes it to the VS Code Marketplace and Open VSX. Pushing such a tag is therefore a release.

### Real editor smoke tests

`npm run test:integration` builds the extension, then uses `@vscode/test-electron` to download and launch VS Code **1.107.0**, matching the engine baseline. It runs on Linux/WSL with a graphical display; use `xvfb-run -a npm run test:integration` on a headless Linux machine. The downloaded editor is cached in `.vscode-test/` and excluded from packaging.

The launcher uses `makeTempHome`, clears inherited account/editor variables, and gives the editor disposable HOME, XDG, user-data, extensions and workspace directories, removed after the test process exits. Only empty account folders are created. Tests exercise real extension activation, contributed command registration, repeated sidebar focus/refresh, signed-out usage refresh and account discovery. They do not install the extension into the user's editor, log in, run account CLIs, mutate the registry or restart an editor/server. They do not assert Webview DOM rendering, real-account usage values or native Windows behavior; those remain separate preview and manual acceptance checks.

### Real-editor sidebar checks with fake accounts

The agent skill in `.agents/skills/devhost-test/` (linked from `.claude/skills/`) launches the same cached VS Code with a disposable HOME seeded with fake Claude and Codex accounts, connects over the Chrome DevTools Protocol and drives the sidebar: `node .agents/skills/devhost-test/scripts/run.mjs recommendation` after `npm run build`. It checks what the preview cannot (real theme injection, host-side state writes, settings round-trips) and writes screenshots and a report under `.test-out/devhost/`. Rules and limits are in its `SKILL.md`; it never touches a real account and runs on demand, not in CI.

### Repeatable Webview checks

The preview serves the production `dist/media` bundle with synthetic protocol fixtures and a simulated host transport. `npm run preview` builds the extension and starts a loopback-only page at `http://127.0.0.1:8768/`; stop it with Ctrl+C. Query parameters `locale`, `width` and `active` choose an initial language, sidebar width and provider. Fixtures use only `/fixture/` paths and example identities, and no account files or CLIs are accessed.

`npm run test:ui` drives the same preview in Playwright's Chromium (install it once with `npx playwright install chromium`). It runs locally on demand; CI does not run browser UI tests. By default it is headless with a fixed viewport at 100% zoom, so no window opens; `npm run test:ui -- --headed` uses a full-screen window instead (headless Linux then needs Xvfb and a window manager such as Openbox; bare Xvfb can report a full-screen state without filling the display). The runner creates and closes its own browser, page and server, and only the sidebar container changes width. It covers every locale and width in [preview verification](manual-verification.md#preview-verification), including tab/switch/rename behavior, input preservation, delete cancellation and usage observations. Screenshots and a JSON result summary are written under `.test-out/ui/`.

These checks use synthetic theme colors and a fake host. They verify layout and frontend behavior, not actual VS Code theme injection, host-side account mutations, real login state or usage values. The [real-editor sidebar checks](#real-editor-sidebar-checks-with-fake-accounts) cover theme injection and host state with fake accounts; user-operated acceptance still applies to real accounts.

### Performance measurements

`npm run perf` uses isolated synthetic fixtures and imposes no timing threshold; see the [baseline record](research/account-read-performance.md).

### Release

- At the version bump, `## [Unreleased]` in `CHANGELOG.md` is renamed to `## [x.y.z] - <date>`. `test/changelog.test.ts` compares every section in the newest `v*` tag's `CHANGELOG.md` with the current file; it is skipped without git or tags (e.g. a shallow CI checkout).
- `npm run package` (`vsce package`) produces the `.vsix`; `.vscodeignore` excludes sources, tests, scripts, docs and sourcemaps, and keeps `package.nls*.json`. The user installs it with "Extensions: Install from VSIX..." in a WSL window or a local Windows window.

## Localization terminology

English is the source of every visible string; the translations live in `src/i18n.ts` (host messages), `src/webview/i18n.ts` (sidebar) and `package.nls.<locale>.json` (Command Palette titles and settings). Use the terms below whenever you add or change a string in any of them, and in the translated user guides (`docs/user-guide.<locale>.md`), which quote the UI labels exactly. If a term must change, change it everywhere in the same commit and update this table. The "Avoid" column lists variants that were used before.

| Concept | English | 简体中文 | 繁體中文 | Español | 日本語 | Avoid |
| --- | --- | --- | --- | --- | --- | --- |
| The `default` account | default account | 默认账号 | 預設帳號 | cuenta predeterminada | 既定のアカウント | ja デフォルトアカウント |
| The account in use (Claude) | current account | 当前账号 | 目前帳號 | cuenta actual | 現在のアカウント | |
| Codex account in effect in this window | effective account | 当前生效账号 / 生效账号 | 目前生效帳號 / 生效帳號 | cuenta efectiva | 現在有効なアカウント / 有効なアカウント | |
| Codex account applied after restart | selected account | 已选择账号 | 已選擇帳號 | cuenta seleccionada | 選択されたアカウント | |
| Account list heading | All accounts | 全部账号 | 全部帳號 | Todas las cuentas | すべてのアカウント | |
| Link (verb, mode) | link, linked account | 链接，已链接账号 | 連結，已連結帳號 | vincular, cuenta vinculada | リンク、リンク済みアカウント | es enlazar / enlazada |
| Unlink | unlink | 拆分（与默认账号拆分） | 拆分（與預設帳號拆分） | desvincular | リンク解除 | |
| Re-link tool | Re-link | 重新链接 | 重新連結 | Revincular | 再リンク | es Volver a enlazar |
| Independent mode | independent | 独立 | 獨立 | independiente | 独立 | |
| General limit (not model-specific) | general limit | 通用额度 | 一般額度 | límite general | 一般的な上限 | ja 共通の上限 |
| Usage limits | usage limits | 用量额度 | 用量額度 | límites de uso | 使用量の上限 | zh 用量限额; ja 使用上限, 使用量上限 |
| One limit window label | 5-hour limit, 7-day limit | 5 小时额度，7 天额度 | 5 小時額度，7 天額度 | Límite de 5 h, Límite de 7 días | 5 時間の上限、7 日間の上限 | zh 小时限额 / 天限额 |
| Sign-in action | sign in (button: Log in) | 登录 | 登入 | iniciar sesión (button: Acceder) | サインイン (button: ログイン) | |
| Signed-out state | Not logged in | 未登录 | 未登入 | Sin sesión | 未ログイン | |
| Switch accounts | Switch | 切换 | 切換 | Cambiar | 切り替え | |

Counts use ICU plural blocks in `src/i18n.ts` and `src/webview/i18n.ts` (not in `package.nls*.json`), e.g. `{n, plural, one {# account} other {# accounts}}`; the supported syntax is documented on `formatMessage`. Use only the CLDR categories of the locale: English and Spanish `one` / `other` (Spanish `many`, for millions, falls back to `other` and may be left out). Chinese (Simplified and Traditional) and Japanese have only `other` for whole numbers, so they write plain text with `{n}` instead of a block. Do not write `account(s)` / `cuenta(s)`. `test/i18n.test.ts` checks every block.

A file or folder link as an object (a symbolic link or junction) is not the account mode: Spanish keeps `enlace` there ("enlaces de archivo"). Product names, rc marker text, shell commands, file names, setting ids, command ids and account terminal names are never translated (see [AGENTS.md](../AGENTS.md#implementation-boundaries)).

### Adding a locale

Add the locale id to `LOCALES` and its `LOCALE_INFO` row in `src/i18n.ts`, its host message table, the Webview twins in `src/webview/i18n.ts` (`WEB_LOCALE_INFO` row and table), the `planswap.language` enum entry with its `config.language.*` label, `package.nls.<locale>.json`, the user guide named by `userGuide` in `docs/`, the locale list in `scripts/run-ui-tests.mjs`, and a column in the table above. `test/i18n.test.ts` and `test/docs.test.ts` check that the code, manifest, user guide and UI test list agree.

## Panel startup diagnostics

Search for `[planswap]` in the extension host log for activation start/completion, panel document creation, document-ready latency, and account-state read duration/counts. In the Webview developer tools console, the same prefix identifies frontend initialization, first-state wait, and first-card DOM update duration. Host and frontend durations use separate monotonic clocks; do not subtract timestamps across them. DOM update duration is not a browser-paint measurement. These diagnostics contain timings and counts, not account names, emails, paths or credentials.

For a cold-start investigation, record both logs from editor startup through the first visible cards. For a connectivity investigation, also record whether the document reloads and whether another `ready`/first-state sequence occurs. Logging does not itself establish the cause of a delay or an offline failure.

## 1. F5 does not load the extension in VS Code 1.139 (js-debug attach regression)

Recorded: 2026-09-26. This is an editor/environment issue, not extension behavior. Remove this section once the upstream fix has shipped.

### Symptoms

In a VS Code 1.139.x WSL window, pressing F5 ("Run Extension") opens the Extension Development Host, but the extension is never activated. The debugger never attaches and the debug session ends after about 10 seconds with:

```
Error processing attach: Error: Could not connect to debug target at http://localhost:<port>:
Socket closed before the connection was established
```

The remote extension host log (`~/.vscode-server/data/logs/<session>/exthost*/remoteexthost.log`) is flooded with `RequestError: connect ECONNREFUSED ::1:<port>` and ``Error: The `onCancel` handler was attached after the promise settled.`` The Windows-side `renderer.log` shows "An unknown error occurred. Please consult the log for more details." about once per second while attaching.

Ctrl+F5 (Run Without Debugging) loads the extension normally, and F5 works in Antigravity (VS Code 1.107 core).

### Cause

- For `extensionHost` launches the development extension host is started with `--inspect-brk=<port>`. It stops at the first line until a debugger attaches, and its inspector listens on `127.0.0.1` only.
- The bundled js-debug 1.117.0 looks up the target at `http://localhost:<port>` and probes `127.0.0.1` and `[::1]` in parallel.
- The race helper rejects as soon as one probe fails. The `[::1]` probe fails, the in-flight `127.0.0.1` probe is cancelled, and the lookup is retried every 200 ms until the 10 s timeout.

Upstream reports: microsoft/vscode-js-debug#2416 and #2420, microsoft/vscode#337488 and #337774; the fix is milestoned for VS Code 1.140.

Ruled out: proxy resolution (`localhost` / `127.0.0.1` are always DIRECT), system certificates (`http.experimental.systemCertificatesV2` defaults to `false`; V1 only affects HTTPS), WSL mirrored networking (`curl` to the inspector URL answers instantly) and port forwarding (no debug port forwarded or bound on Windows).

### Workaround

Patch the js-debug that VS Code runs on the WSL side so it asks for IPv4 directly. In `~/.vscode-server/bin/<commit>/extensions/ms-vscode.js-debug/src/extension.js`, in `launchProgram` of the extension host attach, replace:

```
$l(`http://localhost:${t.params.port}`
```

with:

```
$l(`http://127.0.0.1:${t.params.port}`
```

Back up the file, check that the string occurs exactly once (the minified names `$l` and `t.params.port` can differ between builds), check the result with `node --check`, then run "Developer: Reload Window" and press F5 again; restore the backup if anything goes wrong. Only this occurrence is used by F5. The similar `` Wv(`http://localhost:${t.connection}` `` belongs to the plain Node attach path and does not help.

Notes:

- This edits the editor installation, not the repository. A VS Code update replaces the server directory and drops the patch; re-check after each update.
- Alternatives that change nothing: use Ctrl+F5 in VS Code and debug with breakpoints in Antigravity, or stay on VS Code 1.138 until the fix is released.
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

Run `vscode-linux-test` (optionally with a workspace path) from the Ubuntu terminal and keep that terminal open. The launcher reads the saved selection before startup: a named selection sets `CODEX_HOME`, an empty selection unsets it for default, and an absent file preserves the unmanaged environment. An unreadable selection or a missing selected directory stops launch. Applying another selection follows [Codex design §5.1](codex-design.md#51-local-desktop-editor-manual-restart). The separate editor directories isolate editor configuration and extensions, **not HOME or account data**.

### Keyring and display observations

- The test session initially pointed to a missing `/run/user/1000/bus`. Starting GNOME Keyring and the editor under `dbus-run-session` allowed startup. A private bus ends with its wrapped process: run the launcher again to create a fresh bus/keyring session; do not reuse the ended session's `DBUS_SESSION_BUS_ADDRESS`. Secure-storage persistence/unlock across fresh sessions was not separately verified.
- WSLg displayed `xeyes` successfully. The VS Code test profile used `"window.titleBarStyle": "native"`.
- Multiple monitors with mixed scaling produced mouse-coordinate offsets. Moving the window between monitors was followed by a user report that dragging worked; this was an observed workaround, not a verified permanent fix. Upstream reports: [WSLg #324](https://github.com/microsoft/wslg/issues/324) and [WSLg #1233](https://github.com/microsoft/wslg/issues/1233).

Procedures are in [Manual Verification](manual-verification.md#codex-in-a-local-linux-desktop-vs-code) and remaining acceptance in [TODO](../TODO.md).
