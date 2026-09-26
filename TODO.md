# TODO

Open issues left over from the shared / independent accounts work (2026-09-26). Each item says what is known and what
is still missing. Remove an item once it is done or decided.

## Needs verification with real accounts

- **Linux desktop support.** On 2026-09-27, user screenshots confirmed Claude's `default` → `xiaoni` switch after reload and Codex startup with the named `O4N` selection through the external launcher: official identities matched and new conversations succeeded. The user also confirmed Codex return-to-default succeeded, without a separate live environment inspection. Current product behavior is save-selection plus manual restart guidance. Installed-build acceptance remains outstanding: selection cancellation/pending state, instructions-only actions, named/default restart, multiple windows, launch-route and keyring behavior, WSL regression, and Claude return-to-default. A native Linux desktop/VM smoke test is still required before claiming non-WSLg coverage. Use the [local Linux manual checklist](docs/manual-verification.md#codex-in-a-local-linux-desktop-vs-code); the recorded environment and external launcher are in [Development](docs/development.md#2-local-linux-desktop-testing-through-wslg).
- **Resuming a session started by another account.**
  - Codex: rollouts replay reasoning and compaction items whose `encrypted_content` is bound to an organization. The server
    may reject them ("encrypted content organization_id did not match the target organization"), and codex-cli 0.157.1
    has no code that strips or recovers from this. High risk between two ChatGPT accounts.
  - Claude: transcripts carry no account id and `--resume` has no account check, but thinking-block signatures may not be
    accepted across organizations. Expected to work within one organization; untested across organizations.
  - Test with two real accounts, then document the result in README "Known limitations".
- **`claudeAccountBusy` against a live CLI.** It reads `pid` from `sessions/*.json` and matches `CLAUDE_CONFIG_DIR` in
  `/proc/<pid>/environ`. Only covered by tests with a fake `/proc`; confirm it detects a running `claude` (terminal and
  official panel) before relying on it to protect migrations.
- **`codexAccountBusy` against a live CLI.** Same situation: exe basename `codex` + `CODEX_HOME` realpath, tested with a
  fake `/proc` only. Confirm it catches the TUI and the editor extension's `codex app-server`.
- **[Manual verification checklist](docs/manual-verification.md)** (Claude items 5, 6, 8, 12, 14, 16 and Codex items 4, 5, 8, 13) has not
  been run for this feature.

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
- **Race paths are untested.** The "changed while syncing, left unchanged" branch of `syncMcpServers` /
  `mirrorClaudeJson` (the CLI rewrote `.claude.json` between read and rename) has no unit test.

## Deferred features

- **Shared → independent conversion.** Only independent → shared exists. A reverse action would replace the links by
  copies.
- **Command Palette entry for "Share with the default account".** The conversion is only available from the panel row.
- **Repeatable UI preview harness.** Width checks (200 / 240 / 280 / 340 / 420 px, both languages) were done with ad-hoc
  pages and a CDP driver in a scratch directory. A `scripts/preview` harness in the repo would make them repeatable. The
  preview theme colors were hand-written dark values, so only layout was verified, not the real theme.

## User actions pending

- **Convert the `xiaoni` account to shared** from another account (a running session in that account blocks the
  migration). One file differs on both sides and needs a manual merge afterwards:
  `projects/-home-deploy--projects/memory/MEMORY.md` (the account copy is kept as `MEMORY.md.from-xiaoni`).
