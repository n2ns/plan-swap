# AGENTS.md

Project instructions for AI coding agents working on PlanSwap. Cross-project preferences belong in the user's global instructions; this file contains repository-specific constraints and documentation routes.

## Project scope

PlanSwap is a WSL and native Windows VS Code extension with independent Claude Code and Codex account switching in one localized sidebar. Claude switching writes `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`. Codex switching selects `CODEX_HOME` through rc marker blocks and requires an editor WSL server restart (automatic only for Antigravity and VSCodium; manual guidance for VS Code and unrecognized editors). On native Windows it selects `CODEX_HOME` through the per-user environment variable and needs a full editor restart (manual guidance only). Named accounts are shared with the default account or independent; login identities stay separate.

- Supported platforms: Linux (WSL) and native Windows (`process.platform === 'win32'`, see [Windows support](docs/design.md#windows-support)); on any other platform activation warns and returns. Never read across into `/mnt/c` (WSL) or the Windows profile from WSL, and add no macOS branches. Platform differences live in `src/platform.ts` and `src/codex/codexWindows.ts`; never signal the editor process on Windows.
- All repository docs, code comments and test names are written in English. User-visible strings use the i18n tables.
- Keep Claude and Codex behavior independent when changing shared modules.

## Read the documents relevant to the task

The [documentation map](docs/README.md) defines each document's responsibility. Read the relevant sections before changing their behavior or contracts; a task does not require reading every document.

| Task | Read |
|---|---|
| Native Windows behavior | [Windows support](docs/design.md#windows-support), [Codex Windows](docs/codex-design.md#9a-native-windows). |
| Claude accounts, sharing, settings, usage limits or switching | [Claude design](docs/design.md), [Claude/shared interfaces](docs/interfaces.md). |
| Codex accounts, sharing, rc files or WSL restart | [Codex design](docs/codex-design.md), [Codex interfaces](docs/codex-interfaces.md). |
| Shared panel, messages, aliases, state or i18n | Relevant modules in [Interfaces](docs/interfaces.md); [Claude design §5](docs/design.md#5-user-interface) for UI rationale. |
| Commands, menus, views, settings or panel interactions | [Features](docs/features.md); also check `package.json` contributions, `package.nls*.json` and `src/protocol.ts`. |
| Dependencies, building, packaging or editor troubleshooting | [Development](docs/development.md). |
| Frontend verification or real-account acceptance | [Manual Verification](docs/manual-verification.md); [TODO](TODO.md) for pending work. |
| Upgrading official clients or editor integration | Background facts in [Claude design §2](docs/design.md#2-background-facts-verified) / [Codex design §2](docs/codex-design.md#2-background-facts-verified); re-verify the affected assumptions. |

When documents and code disagree, determine which needs updating; do not change one merely to match the other. Interface contracts govern signatures and behavior, but confirmed unused exports, fields and parameters may be removed with their contract entries in the same change. Update the document that owns a fact; use links from other documents instead of duplicating detailed descriptions.

## Commands and verification

```bash
npm install
npm run typecheck    # host, Webview and tests
npm test             # esbuild bundle + node --test
npm run build        # host + Webview artifacts
npm run watch
npm run package      # vsce; prepublish runs typecheck and build
```

- Before committing, `npm run typecheck`, `npm test` and `npm run build` must pass.
- Every frontend change requires preview checks at container widths 200 / 240 / 280 / 340 / 420px in both languages, with screenshots and assertions. Follow [preview verification](docs/manual-verification.md#preview-verification), including one browser tab per agent, reuse and cleanup. Use a headless browser (no window on the user's display) at 100% zoom with a fixed viewport; adjust the sidebar/container width.
- Every file-system test must use a temporary HOME (`makeTempHome` in `test/helpers.ts`), including account creation/copy/share/unshare/migration/deletion and rc/state-file writes. Never run these tests under the real home. Use fake process trees for busy/restart planning checks.
- Never test `executeRestart` or signal the editor's WSL server or its children by another means. `planRestart` and `detectServerKind` are read-only and may be called independently. Real-account write/delete/restart acceptance steps are performed by the user, following [Manual Verification](docs/manual-verification.md).
- Before releasing, neither `README.md` nor `CHANGELOG.md` may contain `[Unreleased]` content, even an empty heading. Packaging is separate from installation/publication; never automatically install the `.vsix` into the user's editor. Release only with the user's explicit authorization.

## Account and data safety

- **Claude credentials:** never read, write, copy, move or symlink `.credentials.json`, or cache tokens. Only an existence check may help determine sign-in state. The one permitted use of an account's credentials is running the official `claude` CLI with `CLAUDE_CONFIG_DIR` set to that account (unset for the default account) to query usage limits ([Claude design §6.9](docs/design.md#69-claude-usage-limits)): Claude Code reads, and may refresh, its own credentials exactly as in a terminal, and updates the `cachedUsageUtilization` entry of the account's own `.claude.json`; PlanSwap never passes tokens anywhere and only reads that entry. `.claude.json` is never linked; shared-account mirroring copies only the permitted keys. PlanSwap's own code only reads the default account's `.claude.json`. Its `oauthAccount.accountUuid` + `organizationUuid` may be read only as an in-memory identity comparison key (duplicate sign-in warning), and `oauthAccount.accountUuid` together with `cachedUsageUtilization.accountUuid` of the same file only as an in-memory key attributing the usage cache to its account; neither is ever displayed, logged, persisted or sent to the Webview.
- **Codex credentials:** `auth.json` is read-only. Only decode the JWT payload of `tokens.id_token` (no signature check) for email, `chatgpt_plan_type` and the identity claims (`chatgpt_user_id` / `user_id` / `sub` plus `chatgpt_account_id`), the latter only as an in-memory comparison key never displayed, logged, persisted or sent to the Webview; API key mode only displays "API key". Never write, copy, swap, move, link or cache `auth.json`, and never expose raw tokens in logs, state, messages or UI. The one permitted use of an account's credentials is running the official `codex` CLI with `CODEX_HOME` set to that account (usage limits, [Codex design §8.7](docs/codex-design.md#87-usage-limits)): Codex reads, and may refresh or add helper files next to, its own credentials exactly as in a terminal; PlanSwap only checks that `auth.json` exists and never passes tokens anywhere. `memories/` and the other per-account entries in [Codex design §8.6](docs/codex-design.md#86-shared-and-independent-accounts) remain separate.
- **Default directories:** never overwrite or delete existing content in the default Claude/Codex directories. Shared-account operations may create missing link targets empty (directories 0700, files 0600; Codex `link-only` databases/locks are never pre-created), move in missing files during conversion, and append missing lines to `history.jsonl` / `session_index.jsonl`. Preserve differing files using the documented `.from-<account>` / `.independent-backup` rules. Existing account entries that cannot be linked safely are left untouched and reported; JSONL repair follows the documented append-only merge rules.
- **Deletion:** Claude account-directory deletion only goes through `paths.deleteAccountDir` and its `checkSafeToDelete`; Codex deletion only through `codexPaths.deleteCodexDir` and its `checkCodexSafeToDelete`, including daemon liveness. Never bypass these checks or use shell deletion. Compare default directories by `sameRealPath` so symlinks cannot evade protection.
- **Shared accounts:** detect mode from disk each time (`projects` / `sessions` marker link resolving to the default entry); never persist it. Create absolute symlinks with `fs.symlinkSync`; never follow links while moving files, and never delete an account file without an identical default copy. Shared-directory deletion removes links only; keep the regression tests.
- **WSL restart:** product code may call `executeRestart` only after a user modal confirmation and only for `antigravity` / `vscodium`. It disconnects all WSL windows and closes integrated terminals. Other editor kinds get manual guidance only; this permission does not authorize agents to test the restart.

## State and identity

- Claude's current account comes only from `CLAUDE_CONFIG_DIR` in the setting (`currentDir`); never persist a second current-account value. Use `defaultDir()` for the default and `claudeJsonPath(dir, isExplicitConfigDir(dir))` for account-info reads/watchers. Do not use `claudeCode.claudeProcessWrapper`.
- Codex's effective directory comes only from the extension host's `process.env.CODEX_HOME` (`effectiveDir`); its selected directory comes from `~/.config/planswap/codex-home`. Do not store either elsewhere.
- Account lists, ignore lists and aliases use `FileMemento` in `~/.config/planswap/state.json`, not `globalState`, which is shared across WSL distributions on the client. The one-time `importOnce` migration reads the six legacy keys; `globalState` still holds `panel.activeTab` and `legacy.languageMigrated`.
- Preserve activation migrations from ai-switcher 0.1.0–0.1.3 (`migrateLegacyCodex`, `migrateLegacyLanguage`); the extension id `n2ns.planswap` and memento keys were not renamed. Future persisted-name changes require migrations too.
- Aliases affect display only: logic uses account name/dir; visible labels use `labelFor`. Default/external rows cannot be renamed. Validate through `LabelStore`; names and aliases cannot collide within a vendor. Clear the alias when removing an account. Detailed storage/validation contracts live in [Interfaces](docs/interfaces.md).

## Implementation boundaries

- TypeScript strict and ESM-style imports. The host may depend only on `vscode` and Node built-ins, with the `node:` prefix. Modules documented as having no runtime `vscode` import must retain that boundary.
- The Webview may depend only on `@vscode-elements/elements`, `@vscode/codicons` and types from `src/protocol.ts`; no Node or `vscode` imports. All host/frontend messages are typed in `src/protocol.ts`.
- The host owns business logic and validation. Validate incoming account directories through `panel.resolve` and account names through `validateName`. Render account text with `textContent`, never interpolated `innerHTML`. CSS colors use only `--vscode-*` theme variables.
- Do not relax CSP: `default-src 'none'`; scripts nonce-only; styles Webview source plus `'unsafe-inline'` for Lit fallback; fonts Webview source only; `localResourceRoots` only `dist/media`. Set HTML with CSP before Webview options. Preserve `id="vscode-codicon-stylesheet"` on the codicon stylesheet link and queue `focusAdd` until `ready`.
- Pin dependencies exactly, with no `^`/`~` except `engines.vscode`; verify a new dependency is necessary and choose the latest stable release. Keep the VS Code engine baseline and `@types/vscode` at 1.107 for Antigravity compatibility. Current dependency/build details live in [Development](docs/development.md#dependencies-and-build).
- All visible strings use host/Webview `t()`, with matching keys in all four locales (English, Simplified Chinese, Spanish, Japanese); English is the source of truth. Manifest strings use `%key%` and `package.nls*.json`. Translations use the terms in [Localization terminology](docs/development.md#localization-terminology). The translated user guides (`docs/user-guide.<locale>.md`) are updated in the same change as `docs/user-guide.md`. Never localize rc marker text, shell commands, file names, setting/command ids or account terminal names (`Claude (<label>)` / `Codex (<label>)`).
