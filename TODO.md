# TODO

Open issues left over from the shared / independent accounts work (2026-09-26). Each item says what is known and what
is still missing. Remove an item once it is done or decided.

## Known gaps

- **Onboarding state is not mirrored.** A new shared Claude account gets `mcpServers` and the per-project keys, but not
  `hasCompletedOnboarding` / `lastOnboardingVersion` (or `githubRepoPaths`) from the default `.claude.json`, so the CLI may
  run its first-start onboarding again. Decide whether `mirrorClaudeJson` should copy these keys.
- **Mirroring only runs on add, before a switch, after a conversion and on "Re-link".** MCP servers or project settings
  changed in the default account while a shared account is current are not propagated until the next switch or sync.
  Consider watching the default `.claude.json` and mirroring automatically.
- **Claude prompt history "storage v5".** Claude Code 2.1.274 has a feature-flagged history backend that opens
  `history.jsonl` with `O_NOFOLLOW`; when that flag is on for an account, its prompt history is silently not recorded
  through the link. Still present in 2.1.284 on Windows too ("history.jsonl is a symlink or not a regular file, which the
  storage interface never reads or writes through"; the default path reads and appends through the link, retention
  pruning skips a link). Not detected or reported by the extension.
- **`claude project purge` in a shared account.** The repair merges lines back into the default `history.jsonl` by
  appending only, so the purged prompts stay in the shared history.
- **Codex schema-versioned databases.** `state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`
  carry a version in their names. A Codex upgrade that bumps one creates a real file in each shared account, reported as a
  conflict; `CODEX_SHARED_ENTRIES` must be updated by hand. Codex corruption recovery also renames the link away.
- **Codex `plugins/cache` sharing** is based on low-to-medium-confidence research (the remote marketplace is synced per
  account). Verify plugins still install and load in a shared account.
- **Codex memories stay per account** (Codex refuses a symlinked memory root), so each account rebuilds memories from the
  shared sessions with its own quota. Revisit if Codex adds a memory location option.
- **Refusal reasons are not specific.** When `settings.json` / `config.toml` is not shared for safety, the report only
  names the file, not the identity key that caused it.
- **Windows conversion can become busy during the copy-fallback prompt.** The host checks the account before asking
  whether to copy configuration files, but `migrateClaudeToShared` / `migrateCodexToShared` do not consult the
  caller-supplied terminal-busy callback at their entry. If that account's PlanSwap terminal opens while the prompt is
  visible, the migration can begin before the final link-repair step notices it. Re-check after the prompt or include
  `LinkOptions.busy` in the migration entry guard, with a regression test for this window.
- **Codex per-account usage observations** need real-account acceptance across switches and editor restarts, including reset/24-hour expiry and sign-in changes; follow [the usage checks](docs/manual-verification.md#usage-limits-sign-in-tip-and-duplicate-sign-ins).
- **Codex usage limits in the status bar** are implemented but not yet accepted with real accounts, on WSL or Windows (`codex.cmd` fallback, the binary bundled with the Codex extension when `codex` is not on PATH). Run [the usage checks](docs/manual-verification.md#usage-limits-sign-in-tip-and-duplicate-sign-ins); re-verify the `codex app-server` protocol facts ([Codex design §2](docs/codex-design.md#2-background-facts-verified)) after CLI upgrades.

## Windows verification

- **Native Windows is implemented but not yet accepted on a real machine.** Run [the Windows checklist](docs/manual-verification.md#native-windows-user-operated). Settled on 2026-09-30 without real accounts: `<dir>.claude.json` when `CLAUDE_CONFIG_DIR` is set (claude.exe 2.1.284 with temporary folders), the Claude extension 2.1.284 applies `claudeCode.environmentVariables` to the process it starts and follows it host-side (code), Codex honors `CODEX_HOME` including non-ASCII paths (`codex app-server` with a temporary folder), and Codex's default credential store is `file` (upstream `defaults.toml`). Still open: whether the Codex extension host inherits the changed user variable after a fresh start, whether the Codex extension with `chatgpt.runCodexInWindowsSubsystemForLinux` really runs Codex in WSL and ignores the Windows `CODEX_HOME` (PlanSwap refuses Codex switching then), and rc/state behavior of the `.vsix` under a real Windows editor.
## Deferred features

- **Command Palette entry for "Share with the default account".** The conversion is only available from the panel row.
- **Real-editor theme acceptance.** `npm run test:ui` now repeats four-language, five-width layout and DOM checks, but its
  theme colors are synthetic. Verify actual light, dark and high-contrast theme injection in an installed editor;
  automated preview success does not establish that coverage.
