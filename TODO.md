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
  through the link. Not detected or reported by the extension.
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

## Windows verification

- **Native Windows is implemented but not yet accepted on a real machine.** Run [the Windows checklist](docs/manual-verification.md#native-windows-user-operated). Open questions: where `.claude.json` lives when `CLAUDE_CONFIG_DIR` is set on Windows, whether the Claude extension honors `claudeCode.environmentVariables`, whether the Codex extension host inherits the changed user variable after a fresh start, Codex's default credential store on Windows (keyring accounts read as signed out), and rc/state behavior of the `.vsix` under a real Windows editor.
- **Add a CHANGELOG entry** for Windows support when preparing the next release (no `[Unreleased]` heading before then).
- **Windows CI** is not set up. `npm test` passes on a local Windows machine without Developer Mode (Linux-only, file-symlink and case-sensitivity tests skipped, see [Development](docs/development.md#verification-and-release-boundaries)); a run with Developer Mode on, where the `FILE_SYMLINKS` tests execute, is still unverified.

## Deferred features

- **Command Palette entry for "Share with the default account".** The conversion is only available from the panel row.
- **Repeatable UI preview harness.** Width checks (200 / 240 / 280 / 340 / 420 px, both languages) were done with ad-hoc
  pages and a CDP driver in a scratch directory. A `scripts/preview` harness in the repo would make them repeatable. The
  preview theme colors were hand-written dark values, so only layout was verified, not the real theme.
