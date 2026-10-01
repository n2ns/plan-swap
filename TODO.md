# TODO

Open issues left over from the shared / independent accounts work (2026-09-26). Each item says what is known and what
is still missing. Remove an item once it is done or decided.

## Known gaps

- **Mirroring only runs on add, before a switch, after a conversion and on "Re-link".** MCP servers or project settings
  changed in the default account while a shared account is current are not propagated until the next switch or sync.
  Consider watching the default `.claude.json` and mirroring automatically.
- **Claude prompt history "storage v5" (watch on upgrades).** Claude Code has a history storage backend behind the
  remote feature flag `tengu_hover_rest` (env override `CLAUDE_CODE_HOVER_REST`, cached per account in
  `.claude.json` under `cachedGrowthBookFeatures`) whose code opens `history.jsonl` with `O_NOFOLLOW`. In the public
  builds 2.1.274, 2.1.284 and 2.1.287 (Linux and Windows) its factory `tryCreateV5Backend` is an empty stub that always
  returns `undefined`, so even with the flag on prompt history takes the old path and reads and appends through the
  link (checked in the npm packages on 2026-10-02; no changelog entry or issue about it). The `claude project purge`
  refusal text ("history.jsonl is a symlink or not a regular file…") belongs to the same unreachable branch. Nothing to
  detect today; after each Claude Code upgrade, check whether the factory still returns nothing. Detecting the flag
  would need reading named accounts' `.claude.json` beyond the current contract.
- **History retention pruning skips the link.** Independent of the flag, Claude Code's old history path skips its
  retention pruning when `history.jsonl` is not a regular file (only a debug log line), so the shared history is never
  pruned by Claude Code.
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
- **Codex per-account usage observations** need real-account acceptance across switches and editor restarts, including reset/24-hour expiry and sign-in changes; follow [the usage checks](docs/manual-verification.md#usage-limits-sign-in-tip-and-duplicate-sign-ins).
- **Codex usage limits in the status bar** are implemented but not yet accepted with real accounts, on WSL or Windows (`codex.cmd` fallback, the binary bundled with the Codex extension when `codex` is not on PATH). Run [the usage checks](docs/manual-verification.md#usage-limits-sign-in-tip-and-duplicate-sign-ins); re-verify the `codex app-server` protocol facts ([Codex design §2](docs/codex-design.md#2-background-facts-verified)) after CLI upgrades.
- **Status bar text, warning background and tooltip layout** (`Claude 97% · Codex 82%`, error/warning background from the lowest remaining window, the compact per-product table tooltip with one row per window, `planswap.statusBar.showModelLimits`) are covered by unit tests and generated-markdown review only; a headless preview cannot render the status bar, so look at them in a real editor in light, dark and high-contrast themes and in all four languages ([Claude usage checks](docs/manual-verification.md#claude-usage-limits), step 8).
- **Claude usage limits** are implemented (`claude -p /usage` plus the usage cache in each account's info file, [Claude design 6.9](docs/design.md#69-claude-usage-limits)) but not yet accepted with real accounts. Run [the Claude usage checks](docs/manual-verification.md#claude-usage-limits). Verified only on 2026-10-01 for the signed-in default account (Claude Code 2.1.286: a smoke run of the real modules returned three windows; about 70 calls without a 429, see [the research record](docs/research/claude-usage.md#rate-limiting)). Still open: named accounts with `CLAUDE_CONFIG_DIR`, signed-out, API-key and expired sign-ins, a re-sign-in as another account, the offline and `claude`-missing messages, a non-English locale and time zone, whether the CLI writes anything besides the cache entry, and native Windows (`claude.cmd` fallback). The endpoint's own rate limits stay unobserved.

## Windows verification

- **Native Windows is implemented but not yet accepted on a real machine.** Run [the Windows checklist](docs/manual-verification.md#native-windows-user-operated). Settled on 2026-09-30 without real accounts: `<dir>.claude.json` when `CLAUDE_CONFIG_DIR` is set (claude.exe 2.1.284 with temporary folders), the Claude extension 2.1.284 applies `claudeCode.environmentVariables` to the process it starts and follows it host-side (code), Codex honors `CODEX_HOME` including non-ASCII paths (`codex app-server` with a temporary folder), and Codex's default credential store is `file` (upstream `defaults.toml`). Still open: whether the Codex extension host inherits the changed user variable after a fresh start, whether the Codex extension with `chatgpt.runCodexInWindowsSubsystemForLinux` really runs Codex in WSL and ignores the Windows `CODEX_HOME` (PlanSwap refuses Codex switching then), and rc/state behavior of the `.vsix` under a real Windows editor.

## UI polish

Review of the account list (2026-10-01). The plan-tag, current-card, card-content, add/Tools/footer layout and color-guard items are done; what is left:

- **Consistent card height.** The current card shows usage while cards without an observation show nothing. A
  placeholder (for example "Show usage") was not added: a missing observation must not read as 0% (see
  [Features](docs/features.md#codex-account-usage-observations)), so the wording needs a decision first.
- **Spacing.** Tightening card padding and line spacing, and grouping with whitespace instead of lines, were not part of
  the last pass.
- **Real-editor look of the new styles.** The flat current card, neutral plan tags, hatched "used up" track,
  high-contrast outline, the usage refresh icon buttons next to "+ Add", and the theme-dependent rules added later
  (dark avatar letters on dark themes, darkened avatar discs, Max 5x outline and small error/warning text on light themes,
  the outline focus ring) were previewed only with synthetic light, Solarized Light and high-contrast variables; see the
  real-editor theme acceptance under Deferred features.

## Deferred features

- **Real-editor theme acceptance.** `npm run test:ui` now repeats four-language, five-width layout and DOM checks, but its
  theme colors are synthetic. Verify actual light, dark and high-contrast theme injection in an installed editor;
  automated preview success does not establish that coverage.
