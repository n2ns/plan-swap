# AGENTS.md

Project instructions for AI coding agents working on PlanSwap. Cross-project preferences belong in the user's global instructions; this file holds repository-specific rules.

## Project scope

PlanSwap is a WSL and native Windows VS Code extension with independent Claude Code and Codex account switching in one localized sidebar. Claude switching writes `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`. Codex switching selects `CODEX_HOME` through rc marker blocks and needs an editor WSL server restart ([Codex design §5](docs/codex-design.md#5-restarting-the-wsl-side-server)); on native Windows it uses the per-user environment variable and needs a full editor restart ([§9a](docs/codex-design.md#9a-native-windows)). Named accounts are shared with the default account or independent; login identities stay separate.

- Supported platforms: Linux (WSL) and native Windows (`process.platform === 'win32'`, see [Windows support](docs/design.md#windows-support)); on any other platform activation warns and returns. Never read across into `/mnt/c` (WSL) or the Windows profile from WSL, and add no macOS branches. Platform differences live in `src/platform.ts` and `src/codex/codexWindows.ts`; never signal the editor process on Windows.
- All repository docs, code comments and test names are written in English. User-visible strings use the i18n tables.
- Keep Claude and Codex behavior independent when changing shared modules.

## Commands

```bash
npm run typecheck   # host, Webview and test type-check scopes
npm test            # unit tests (bundled, node --test)
npm run build       # host to dist/extension.js, Webview to dist/media/
npm run test:ui     # headless Chromium checks of the Webview preview in every width and locale
npm run preview     # Webview preview at http://127.0.0.1:8768/ with synthetic data; stop it by PID
```

- Before committing, `npm run typecheck`, `npm test` and `npm run build` must pass.
- Every frontend change also needs `npm run test:ui` and the [preview verification](docs/manual-verification.md#preview-verification): every width and locale listed there, screenshots and assertions, a headless browser at 100% zoom with a fixed viewport (adjust the sidebar width, not the viewport), one browser tab per agent, reused and closed afterwards.
- Other commands (watch, integration, perf, package): [Development](docs/development.md#commands).

## Read the documents relevant to the task

Read the relevant sections before changing their behavior or contracts; a task does not require reading every document. Contracts live in code (types and TSDoc). Before adding, moving or editing a document, read the [document map](docs/doc-map.md): which document owns which fact, and the documentation rules.

| Task | Read |
|---|---|
| Native Windows behavior | [Windows support](docs/design.md#windows-support), [Codex Windows](docs/codex-design.md#9a-native-windows). |
| Claude accounts, sharing, settings, usage limits or switching | [Claude design](docs/design.md), [Features](docs/features.md), TSDoc of the modules involved. |
| Codex accounts, sharing, rc files or WSL restart | [Codex design](docs/codex-design.md), [Features](docs/features.md), TSDoc of the modules involved. |
| Shared panel, messages, aliases, state or i18n | TSDoc of the modules involved and `src/protocol.ts`; [Claude design §5](docs/design.md#5-user-interface) for UI rationale. |
| Webview code | The headers of `src/webview/main.ts` and `src/accountsPanel.ts` (boundaries, CSP). |
| Commands, menus, views, settings or panel interactions | [Features](docs/features.md); also check `package.json` contributions, `package.nls*.json` and `src/protocol.ts`. |
| Dependencies, building, packaging or editor troubleshooting | [Development](docs/development.md). |
| Frontend verification or real-account acceptance | [Manual verification](docs/manual-verification.md); [TODO](TODO.md) for pending work. |
| Sidebar checks in a real editor with fake accounts | The `devhost-test` skill ([SKILL.md](.agents/skills/devhost-test/SKILL.md)). |
| Upgrading official clients or editor integration | The numbered facts in [Claude Code research](docs/research/claude-code.md#facts) / [Codex research](docs/research/codex.md#facts) (Windows: [Windows research](docs/research/windows.md)); re-verify the affected facts. |

## Test and release safety

- Every file-system test uses a temporary HOME (`makeTempHome` in `test/helpers.ts`), including account creation/copy/share/unshare/migration/deletion and rc/state-file writes. Never run them under the real home. Busy/restart planning checks and the shared-conversion migrations (`migrateClaudeToShared` / `migrateCodexToShared`, which default to the real `/proc`) use fake process trees (`procRoot`). Code that runs the `claude` / `codex` CLI is tested with a fake `spawn`, never the real CLI.
- Never test `executeRestart` or signal the editor's WSL server or its children by another means. `planRestart` and `detectServerKind` are read-only and may be called. Real-account write/delete/restart acceptance steps are performed by the user ([Manual verification](docs/manual-verification.md)).
- New `CHANGELOG.md` entries go under `## [Unreleased]` (or the bumped, not yet tagged version); never edit a tagged version's section (`test/changelog.test.ts`). Before releasing, neither `README.md` nor `CHANGELOG.md` may contain `[Unreleased]` content, even an empty heading.
- Packaging is separate from installation and publication; never install the `.vsix` into the user's editor. Pushing a `v*` tag publishes to the VS Code Marketplace and Open VSX (`.github/workflows/publish.yml`): create or push such a tag, or release otherwise, only with the user's explicit release authorization.

## Account and data safety

- **Claude credentials:** never read, write, copy, move or symlink `.credentials.json`, or cache tokens; only an existence check may help determine sign-in state. The one permitted use of an account's credentials is running the official `claude` CLI with that account's `CLAUDE_CONFIG_DIR` (unset for the default account) to query usage limits ([Claude design §6.9](docs/design.md#69-claude-usage-limits)); PlanSwap never passes tokens anywhere and only reads the resulting `cachedUsageUtilization` entry. `.claude.json` is never linked; shared-account mirroring copies only the permitted keys. PlanSwap's own code only reads the default account's `.claude.json`. Its `oauthAccount.accountUuid` + `organizationUuid` may be read only as an in-memory identity comparison key (duplicate sign-in warning), and `oauthAccount.accountUuid` together with `cachedUsageUtilization.accountUuid` of the same file only as an in-memory key attributing the usage cache to its account; neither is ever displayed, logged, persisted or sent to the Webview.
- **Codex credentials:** `auth.json` is read-only. Only the JWT payload of `tokens.id_token` is decoded (no signature check), for email, `chatgpt_plan_type` and the identity claims (`chatgpt_user_id` / `user_id` / `sub` plus `chatgpt_account_id`); the identity claims are in-memory comparison keys only, never displayed, logged, persisted or sent to the Webview. API key mode only displays "API key". Never write, copy, swap, move, link or cache `auth.json`, and never expose raw tokens in logs, state, messages or UI. The one permitted use of an account's credentials is running the official `codex` CLI with that account's `CODEX_HOME` for usage limits ([Codex design §8.7](docs/codex-design.md#87-usage-limits)); PlanSwap only checks that `auth.json` exists. `memories/` and the other per-account entries of [Codex design §8.6](docs/codex-design.md#86-shared-and-independent-accounts) stay separate.
- **Default directories:** never overwrite or delete existing content in the default Claude/Codex directories. Shared-account operations may only create missing link targets, move in missing files during conversion and append to history files, as specified in [Claude design §6.7](docs/design.md#67-shared-and-independent-accounts) and [Codex design §8.6](docs/codex-design.md#86-shared-and-independent-accounts) (permissions, `.from-<account>` / `.independent-backup`, append-only merges). Account entries that cannot be linked safely are left untouched and reported.
- **Deletion:** Claude account directories are deleted only through `paths.deleteAccountDir` and its `checkSafeToDelete`, Codex ones only through `codexPaths.deleteCodexDir` and its `checkCodexSafeToDelete` (including daemon liveness). Never bypass these checks or use shell deletion. Compare default directories with `sameRealPath` so symlinks cannot evade protection.
- **Shared accounts:** detect the mode from disk every time (`projects` / `sessions` marker link resolving to the default entry); never persist it. Create absolute symlinks with `fs.symlinkSync`; never follow links while moving files, and never delete an account file without an identical default copy. Deleting a shared directory removes links only; keep the regression tests.
- **WSL restart:** product code may call `executeRestart` only after a user modal confirmation and only for `antigravity` / `vscodium`. It disconnects all WSL windows and closes integrated terminals. Other editor kinds get manual guidance only; this does not authorize agents to test the restart.

## State and identity

- Claude's current account comes only from `CLAUDE_CONFIG_DIR` in the setting (`currentDir`); never persist a second current-account value. Use `defaultDir()` for the default and `claudeJsonPath(dir, isExplicitConfigDir(dir))` for account-info reads and watchers, and do not use `claudeCode.claudeProcessWrapper`. Codex's effective directory comes only from the extension host's `process.env.CODEX_HOME` (`effectiveDir`), its selected directory only from `~/.config/planswap/codex-home`.
- Persisted state uses `FileMemento` (`~/.config/planswap/state.json`), not `globalState`, which is shared across WSL distributions; `globalState` holds only `panel.activeTab` and `legacy.languageMigrated`. Keep the ai-switcher 0.1.x migrations (`migrateLegacyCodex`, `migrateLegacyLanguage`); the extension id `n2ns.planswap` and memento keys were not renamed, and future persisted-name changes need migrations too.
- Aliases affect display only: logic uses account name/dir, visible labels use `labelFor`, validation goes through `LabelStore` (names and aliases cannot collide within a vendor; default/external rows cannot be renamed); clear the alias when removing an account.

## Implementation boundaries

- TypeScript strict, ESM-style imports. The host depends only on `vscode` and Node built-ins with the `node:` prefix; modules documented as having no runtime `vscode` import keep that boundary.
- The host owns business logic and validation: incoming account directories go through `panel.resolve`, account names through `validateName`. All host/Webview messages are typed in `src/protocol.ts`.
- Webview: no Node or `vscode` imports, account text rendered with `textContent`, and the CSP is never relaxed; the full boundaries are in the headers of `src/webview/main.ts` and `src/accountsPanel.ts`.
- Pin dependencies exactly (no `^`/`~` except `engines.vscode`); verify a new dependency is necessary and choose the latest stable release. Keep the VS Code engine baseline and `@types/vscode` at 1.107 for Antigravity compatibility ([Development](docs/development.md#dependencies-and-build)).
- All visible strings use host/Webview `t()` with matching keys in every locale of `LOCALES` (`src/i18n.ts`); English is the source of truth. Manifest strings use `%key%` and `package.nls*.json`. Translations use the terms in [Localization terminology](docs/development.md#localization-terminology). The translated user guides are updated in the same change as `docs/user-guide.md`. Never localize rc marker text, shell commands, file names, setting/command ids or account terminal names (`Claude (<label>)` / `Codex (<label>)`).
