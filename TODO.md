# TODO

Open issues left over from the shared / independent accounts work (2026-09-26). Each item says what is known and what
is still missing. Remove an item once it is done or decided.

## Known gaps

- **No background mirroring.** Mirroring runs only when links are refreshed ([Claude design 6.7](docs/design.md#67-shared-and-independent-accounts), "When links are refreshed";
  [§11](docs/design.md#11-known-limitations-and-risks) item 3).
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
- **Codex schema-versioned databases.** `state_5.sqlite`, `thread_history_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`
  carry a version in their names. A Codex upgrade that bumps one creates a real file in each shared account, reported as a
  conflict; `CODEX_SHARED_ENTRIES` must be updated by hand. Codex corruption recovery also renames the link away.
- **Codex `plugins/cache` sharing** is based on low-to-medium-confidence research (the remote marketplace is synced per
  account). Verify plugins still install and load in a shared account.
- **Codex memories stay per account** ([Codex research, fact 17](docs/research/codex.md#facts)). Revisit
  if Codex adds a memory location option.
- **Refusal reasons are not specific.** When `settings.json` / `config.toml` is not shared for safety, the report only
  names the file, not the identity key that caused it.
- **Codex usage limits** (per-account observations and the status bar) are not yet accepted with real accounts, on WSL or
  Windows (`codex.cmd` fallback, the binary bundled with the Codex extension when `codex` is not on PATH), including switches, editor restarts, reset/24-hour expiry and sign-in changes. Run
  [the usage checks](docs/manual-verification.md#usage-limits-sign-in-tip-and-duplicate-sign-ins); re-verify the
  `codex app-server` facts ([Codex research](docs/research/codex.md#facts)) after CLI upgrades.
- **Status bar text, warning background and tooltip** are covered by unit tests only; a headless preview cannot render
  the status bar. Look at them in a real editor in light, dark and high-contrast themes and in every UI language
  ([Claude usage checks](docs/manual-verification.md#claude-usage-limits), step 8).
- **Claude usage limits** ([Claude design 6.9](docs/design.md#69-claude-usage-limits)) are verified only for the
  signed-in default account. Run [the Claude usage checks](docs/manual-verification.md#claude-usage-limits). Not covered
  by a step there: API-key sign-ins, a non-English locale and time zone (expired sign-ins: step 9, "Failing account"). The endpoint's own rate limits stay
  unobserved ([research](docs/research/claude-usage.md#rate-limiting)).

## Windows verification

- **Native Windows is implemented but not yet accepted on a real machine.** Run
  [the Windows checklist](docs/manual-verification.md#native-windows-user-operated). Settled facts and open questions:
  [Windows support](docs/design.md#windows-support), [Codex 9a](docs/codex-design.md#9a-native-windows). Also still
  open: rc/state behavior of the `.vsix` under a real Windows editor.

## UI polish

- **Tools stay reachable with many accounts.** The account heading, cards and Tools scroll as one block between the
  sticky tabs and the footer, so with many cards Tools ends up below the fold. Options discussed on 2026-10-03, not yet
  decided: (1) make the Tools section sticky at the bottom (a few CSS lines; the heading and its Add / Refresh buttons
  still scroll away); (2) scroll only the card list, keeping the banners, the heading with the add form and Tools fixed
  (needs a minimum list height and a fallback to whole-page scrolling in short panels). Either needs the preview checks
  and a UI test asserting Tools stays visible with many cards.
- **Consistent card height.** The current card shows usage while cards without an observation show nothing. A
  placeholder (for example "Show usage") was not added: a missing observation must not read as 0% (see
  [Features](docs/features.md#codex-account-usage-observations)), so the wording needs a decision first.
- **Spacing.** Tightening card padding and line spacing, and grouping with whitespace instead of lines, were not part of
  the last pass.
- **Real-editor theme acceptance.** `npm run test:ui` checks layout and DOM in every language and width, but its theme
  colors are synthetic (`scripts/preview/index.html`). Verify actual light, dark and
  high-contrast theme injection in an installed editor, especially the theme-dependent rules in the Webview CSS;
  automated preview success does not establish that coverage.
