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
- Development dependencies (2026-09-25): typescript 7.0.2, esbuild 0.28.2, @types/node 26.6.2, @vscode/vsce 4.0.0 are the latest stable versions; @types/vscode is pinned to 1.107.0.
- `engines.vscode` is `^1.107.0`. The editor actually used is Antigravity IDE with a VS Code 1.107.0 core; an extension whose `engines` is higher than the editor version is refused. `@types/vscode` must not be higher than `engines`, so the latest version cannot be used; check the editor's core version before upgrading. New frontend dependencies must not require newer editor APIs either.
- Build (`esbuild.mjs`, two entries):
  - Extension host: `src/extension.ts` → `dist/extension.js` (cjs, platform node, target node20, external vscode, with sourcemap).
  - Webview frontend: `src/webview/main.ts` → `dist/media/panel.js`, `src/webview/panel.css` → `dist/media/panel-style.css` (iife, platform browser, target es2022; regular builds minify without sourcemaps, watch mode does not minify and emits sourcemaps).
  - At build start, `codicon.css` and `codicon.ttf` are copied from `node_modules/@vscode/codicons/dist/` to `dist/media/` (`node_modules` is not included in the vsix).
  - With `--watch` both entries are watched.
- Type checking uses separate tsconfigs: `npm run typecheck` runs `tsc --noEmit` (root `tsconfig.json`, host, types node and vscode, excludes `src/webview`), `tsc --noEmit -p src/webview` (frontend, lib includes dom, no node/vscode types, includes `../protocol.ts`) and `tsc --noEmit -p test` (tests).
- Tests: `npm test` runs `scripts/run-tests.mjs`, which bundles `test/*.test.ts` with esbuild into `.test-out/` (with `vscode` aliased to `test/stubs/vscode.ts`) and runs `node --test`. Tests cover the pure modules and run every file-system operation under a temporary HOME.
- Packaging: `vsce package` produces the `.vsix` (`vscode:prepublish` runs typecheck and build first; `.vscodeignore` excludes `src/`, `test/`, `scripts/`, `node_modules/`, `*.map`, docs, etc.; `package.nls*.json` are included). Installation: in a WSL window via "Extensions: Install from VSIX". This extension is never installed into the user's VS Code automatically.

Frontend assets must all be emitted into `dist/media/`, the Webview's only `localResourceRoots` entry. Frontend dependencies cannot be loaded from `node_modules` at runtime. `esbuild.mjs` also injects the manifest version as `__PLANSWAP_VERSION__`.

## Verification and release boundaries

- Before committing, `npm run typecheck`, `npm test` and `npm run build` must pass.
- File-system tests use a temporary HOME via `makeTempHome` in `test/helpers.ts` (it sets both `HOME` and `USERPROFILE`, which `os.homedir()` reads on Windows), which asserts the real home is not used. Never run account, rc-file or state-file write/delete tests under the real home. Busy checks and migrations use a fake `procRoot` where applicable; never test `executeRestart` or signal the editor server or its children.
- The local tests use disposable fixtures; UI integration and real-account acceptance are separate and follow [Manual Verification](manual-verification.md). Record what ran and what remains unverified.
- Before releasing, check `README.md` and `CHANGELOG.md`: neither may contain `[Unreleased]` content, including an empty heading. Packaging does not authorize installation or publication. Never install the `.vsix` into the user's editor automatically; the user installs it after packaging. Publish only under the user's explicit release authorization.

## Automated test coverage

- Tests only cover the pure modules (paths, fileState, labels, claudeSettings, claudeShare, codexPaths, codexShare, codexState, codexServer; `claudeAccountBusy` / `codexAccountBusy` / the migrations take a fake `procRoot`), the two account stores (accounts, codexStore) with an in-memory Memento (`MemoryMemento` in `test/helpers.ts`), i18n key parity, and the pure helpers exported by `commands.ts` (`validateName`, `shQuote`) and `codex/codexCommands.ts` (`validateName`); every test that touches the file system runs under a temporary HOME created by `test/helpers.ts` (`makeTempHome`, which also asserts that the real home is not used). UI behavior is verified with [Manual Verification](manual-verification.md).

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
