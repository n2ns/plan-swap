# TODO

Open issues left over from the shared / independent accounts work (2026-09-26). Each item says what is known and what
is still missing. Remove an item once it is done or decided.

## Known gaps

- **Claude optional shared targets and scoped Repair (2026-10-10).** Verify in a real editor that switching initializes missing task/attachment targets, task lists and Remote Control attachments remain usable across accounts, and cleanup during an already-running session does not prevent first writes. Automated checks use temporary HOME directories and filesystem writes, not a signed-in Claude client; the current VSIX is not installed by these checks.

- **Claude prompt history "storage v5" (watch on upgrades).** The factory still returns `undefined` in Linux 2.1.296, including with the flag enabled. Recheck after upgrades; no new sharing check is needed for this build. See [the dated history recheck](docs/research/claude-code.md#history-storage-recheck-2026-10-10).
- **History retention pruning skips named-account links under HIPAA conditions.** The named account's history symlink fails the regular-file guard; the default account's real history file remains eligible. Ordinary configurations do not automatically prune prompt history. This is an upstream limitation, not a request to add PlanSwap deletion; [source and isolated-function evidence](docs/research/claude-code.md#history-storage-recheck-2026-10-10) do not replace real-client acceptance.
- **Codex schema-versioned databases (watch on upgrades).** The four shared database names still match standalone 0.162.1 and the editor's 0.162.0-alpha.17.2. Recheck future filename changes and corruption recovery that replaces a link; no current whitelist update is needed. See [the sharing recheck](docs/research/codex.md#sharing-recheck-2026-10-10).
- **Codex `plugins/cache` real-client acceptance.** The shared marketplace layout passed isolated filesystem installation, upgrade, manifest-read and MCP-path checks; the remote marketplace cache stays per account. Still verify actual plugin installation and loading in a shared account. [Evidence boundaries](docs/research/codex.md#sharing-recheck-2026-10-10).
- **Codex memories stay per account (watch on upgrades).** This includes `memories_v2/` and `memories_v2_1.sqlite`. The current source still refuses a symlinked memory root and offers no custom root setting. Revisit if that changes; see [the sharing recheck](docs/research/codex.md#sharing-recheck-2026-10-10).
- **Codex `sqlite_home` real-client acceptance.** A common SQLite path shares memory job state despite separate output directories; upstream SQL isolation reproduced cross-account running/cooldown suppression. Preserve that protection. Official-client memory behavior remains unverified; [the sharing recheck](docs/research/codex.md#sharing-recheck-2026-10-10) distinguishes source, SQL and PlanSwap evidence.
- **Codex usage limits** (per-account observations and the status bar) are not yet accepted with real accounts, on WSL or
  Windows (`codex.cmd` fallback, the binary bundled with the Codex extension when `codex` is not on PATH), including switches, editor restarts, reset/24-hour expiry and sign-in changes. Run
  [the usage checks](docs/manual-verification.md#usage-limits-sign-in-tip-and-duplicate-sign-ins); re-verify the
  `codex app-server` facts ([Codex research](docs/research/codex.md#facts)) after CLI upgrades.
- **Status bar text, warning background and tooltip** are covered by unit tests only; a headless preview cannot render
  the status bar. Look at them in a real editor in light, dark and high-contrast themes and in every UI language
  ([Claude usage checks](docs/manual-verification.md#claude-usage-limits), step 8).
- **Claude usage limits** ([Claude design 6.9](docs/design.md#69-claude-usage-limits)) still need real-editor acceptance;
  module-level checks passed for Windows default and WSL default/named accounts ([verification scope](docs/research/claude-usage.md#implementation-verification)).
  Run [the Claude usage checks](docs/manual-verification.md#claude-usage-limits). Not covered
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
