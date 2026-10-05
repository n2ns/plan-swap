# Claude usage refresh validation proposal

Date: 2026-10-05. Status: implemented; real-editor acceptance remains pending. This document records the agreed scope and acceptance criteria. Results are recorded in [implementation verification](../research/claude-usage.md#implementation-verification); current behavior is owned by [Claude design](../design.md#69-claude-usage-limits).

## Objective and scope

Use the official CLI's structured `assistant.usage_report` to decide whether a Claude usage refresh succeeded. Continue reading Claude Code's official `cachedUsageUtilization` for displayed values, their fetch time, history after a failed refresh, and coordination between windows. A valid response from the official recent cache is an accepted success; a new network request is not required.

This addresses a concrete false-success case: the CLI can exit successfully after a failed fetch while the retained cache is still inside PlanSwap's two-minute freshness tolerance. The structured report distinguishes that unavailable result from an accepted cache hit. The dated observations, protocol sources and untested cases belong to the [research record](../research/claude-usage.md#structured-usage-report-verification).

The change is confined to Claude refresh validation and its tests. Keep the bundled executable fallback, existing refresh intervals, cooldowns, account selection and display architecture. Do not add a PlanSwap quota store, a new setting, a dependency on the Agent SDK, or a direct authenticated HTTP request.

## One query flow across platforms

Windows, WSL and native Linux use one query and result-validation implementation. WSL uses the Linux branch. Only executable discovery, filesystem paths and process termination have platform-specific handling.

| Extension host | Executable discovery order | Account and cache location |
|---|---|---|
| Native Windows | PATH `claude`, then PATH `claude.cmd` if missing, then the official extension's bundled `claude.exe` if missing. | The Windows host's selected account directory. |
| WSL | PATH `claude`, then the WSL-side official extension's bundled Linux `claude` if missing. | The selected account in that distribution and user environment. |
| Native Linux | PATH `claude`, then the Linux-side official extension's bundled `claude` if missing. | The Linux host's selected account directory. |

The extension host determines the environment, not the integrated terminal's shell. Do not search Windows installations or account files from WSL. Standalone and bundled executables share the same arguments, parser and cache checks; they are executable sources, not separate quota providers. Only a missing executable permits another launch attempt. Authentication, network, timeout and protocol failures must not trigger a query through another executable.

## Query and parser

1. Keep the official `/usage` command, account environment, home working directory, `--no-session-persistence` and `--setting-sources user`. Add `--verbose` to `--output-format json` so the same invocation returns the message array containing the report.
2. Retain the executable order: PATH `claude`, Windows PATH `claude.cmd` when missing, then the installed official extension's bundled executable when both are missing. A protocol error or unavailable report must not trigger an executable retry or a second `/usage` request.
3. Keep one deadline and cancellation signal across executable attempts. Bound stdout to 1 MiB of UTF-8 bytes, finish decoding split characters correctly, and parse once after normal completion and stdout exhaustion. Non-zero exit, termination by signal, timeout, cancellation, oversized output or malformed JSON cannot succeed even if an earlier message looks successful.
4. Require one terminal result with `type: "result"`, `subtype: "success"`, `is_error: false` and `local_command: "usage"`. Accept one preceding assistant report. Reject conflicting/duplicate reports or terminal results rather than selecting an arbitrary successful one. Ignore unrelated metadata messages; do not parse localized result text.
5. Treat parsed data as `unknown`. Validate only the message envelope, report containers and row fields used by this phase. Each row needs a finite numeric percentage and a string kind; reset time may be a valid timestamp or `null`. Do not require the full experimental SDK schema, session statistics or unused scope/severity fields to match a particular version. Permit additional upstream fields and unfamiliar kind values without assigning them a new display meaning. Validate any container before accessing its fields. Token counts in the final result's `usage` field are not quota limits.

Keep raw stdout, session metadata and identifiers inside the query. Return existing failure categories with bounded, non-sensitive diagnostics; do not forward verbose output or localized CLI result text into logs, notifications or the Webview.

## Result decision table

Success requires all three conditions: normal process completion with a successful terminal `/usage` result; a valid structured limit list (which may be empty); and an attributable, sufficiently recent official cache that supports the corresponding display state. A timestamp does not have to advance on every query. Retained history cannot turn an unavailable report into success.

The process and terminal-result checks run before the following decisions.

| Report state | Refresh decision | Existing displayed values |
|---|---|---|
| Valid non-empty `rate_limits.limits` | Success only after the official-cache and identity checks below pass. A recent official cache hit qualifies. | Read from the official cache with its original fetch timestamp. |
| Valid `limits: []` | Valid empty response, not an error and not zero usage; require a consistent empty official cache before publishing success. | Show no invented session/week bars. |
| Missing report, missing/null `rate_limits`, or missing/null `limits` | `noUsage`. A terminal success alone is insufficient. | Retain history only under existing ownership, age and reset rules; do not advance its timestamp. |
| Malformed report or rows, conflicting output, or unsuccessful terminal result | `failed`. | Same historical-data rules. |

Keep the current `cliMissing`, `timeout`, `noUsage`, `notRefreshed` and `failed` result categories where they express the outcome. A failed query must reach the existing failure notification path instead of producing a success notification. No new persistent last-success timestamp is introduced.

## Cache and account integrity

- Read the selected account's info file through the existing path helpers. Never read `.credentials.json`; the official CLI remains responsible for authentication.
- Preserve the cache ownership check against the signed-in account and the existing fetch-time tolerance. Also reject a cache timestamp beyond the allowed future skew. A valid report cannot make an absent, foreign or stale display cache valid: absent/foreign yields `noUsage`; an unacceptable timestamp yields `notRefreshed`.
- Compare the account identity before and after the query in memory. Missing or changed identity prevents success. A result for a directory that is no longer the selected account must not update the new account's feedback. Keep account UUIDs out of stored state, logs and UI.
- Keep `checkedAt` as the official `fetchedAtMs`. Receipt time is not a fetch time. A cache hit must not move the displayed timestamp forward merely because `/usage` ran again.
- An explicit empty cache `utilization.limits: []` must remain empty, including when old `five_hour` / `seven_day` fields remain. Restrict the old-field fallback to an absent `limits` property; explicit null or malformed modern limits must not resurrect old rows. This is a narrow cache-adapter correction needed for the result table.
- If an empty report conflicts with a non-empty or unavailable official cache, return `noUsage` and retain only eligible history. Do not erase or rewrite the official file to manufacture consistency. Do not introduce full report-to-cache equality matching: another official client may legitimately update the shared file during the query.
- Preserve the sidebar/status-bar cache readers, reset filtering, 24-hour display limit, scheduling timestamps and cross-window cooldowns. Existing timestamp coordination is not a process-wide lock; adding such a lock is outside this change.

## Output-based validation without version fallback

Do not add version probing, a version/capability cache, a version allowlist or a cache-only downgrade path. Apply the same output checks to whichever executable was selected. Missing or unavailable reports yield `noUsage`; do not infer an outdated version or tell the user to upgrade solely from that result.

The research did not compare an older CLI's refresh behavior before and after this change and did not establish a required legacy support range. SDK changelog versions do not establish a CLI version boundary. This decision supersedes the earlier research suggestion of an older-client cache fallback. Revisit compatibility only if a reproducible case establishes a need; it is not an implementation gate for this patch.

## Planned files and delivery steps

| Step | Intended scope | Completion check |
|---|---|---|
| 1. Define parsing decisions | Focused fixtures in `test/claudeUsage.test.ts`. | Fixtures distinguish accepted official cache hits, unavailable rows despite recent history, missing reports and valid empty reports. |
| 2. Implement query validation | `src/claudeUsage.ts`: arguments, bounded message-array parser, process/result checks, identity/cache checks and the narrow empty-cache correction. | Focused unit tests pass with fake spawn and temporary HOME; no production test invokes the real CLI. |
| 3. Check integration | Existing refresh callers in `src/extension.ts`, cache readers and related tests. Change callers only if needed to prevent stale account feedback. | Current, other-account and refresh-all paths preserve cancellation, cooldowns and failure feedback; Codex behavior is unchanged. |
| 4. Update behavior documentation | Module TSDoc, [Claude design](../design.md#69-claude-usage-limits), [Features](../features.md), [Manual verification](../manual-verification.md), [Privacy](../privacy.md) where the read/output contract changes, and an Unreleased changelog entry. | Descriptions distinguish query success from a new fetch. Review agent data rules for the new in-memory report read. Update guides and translations only if user instructions change. |
| 5. Verify delivery | Typecheck, complete unit suite, build and documentation checks. | Record actual results separately from earlier research. Real-editor acceptance remains a separate check. |

Implementation should use small helpers within the existing module rather than introduce a generic event-stream framework. The report is experimental, so keep assumptions explicit in tests and re-check the upstream contract when upgrading supported clients.

## Acceptance matrix

Automated checks use synthetic output, fake processes and temporary account files:

- Valid rows with an advanced cache timestamp and with an unchanged recent official timestamp both succeed.
- A successful terminal result plus `limits: null` fails even with an 80-second-old owned cache; existing historical data keeps its original timestamp.
- Signed-out/missing-report output fails even with a recent owned cache; it triggers neither a cache-only downgrade nor another executable query, and does not produce an unsupported-version diagnosis.
- Empty arrays, absent fields and null values remain distinct; stale legacy fields cannot synthesize bars for an explicit empty modern cache.
- Nullable reset times are accepted; malformed percentages/timestamps and required containers are rejected. Additional fields and unused session/scope/severity metadata do not cause rejection. Unknown kinds and surface scopes do not acquire fabricated general-limit meanings through report parsing. Extending their existing UI representation is deferred.
- Malformed/truncated JSON, multiple reports/results, missing terminal results, wrong local command, non-zero exit with successful-looking JSON, split UTF-8 chunks, excessive output and late stdout are covered.
- Foreign cache, account re-login during the query, missing identity, directory changes, stale/future cache and expired windows are covered.
- PATH and bundled executable fallback, Windows shell-tree cancellation, shared deadlines and cancellation before retries continue to pass.
- Default/explicit account environment, sequential refresh-all, shared-cache cooldowns and current/other-account scheduling remain covered. No version-discovery process or version-dependent parsing branch is introduced.

Prioritize the first two cases as the core regression pair: an accepted official recent-cache hit succeeds, while an unavailable query with retained recent history fails. Then cover missing reports, empty lists, cancellation, account changes and executable fallback.

Run focused checks first, then `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, and `git diff --check` before a code commit. UI checks become necessary if implementation changes rendered behavior beyond the existing empty/error states.

Real acceptance should cover Windows with only the official extension installed, WSL, native Linux, default and named accounts, a normal refresh, an accepted recent-cache hit, an unavailable fetch with retained history, and cancellation inside VS Code. Record Windows, WSL and native Linux results separately, including the executable source and version tested. Earlier research covered Windows 2.1.289 and WSL 2.1.286 / 2.1.289; native Linux was not separately exercised. Shared Linux code is not evidence of native Linux runtime acceptance.

Perform real-account checks under the repository's user-operated acceptance rules. Unavailable platforms, server 429s, revoked sign-ins and other cases not safely reproduced must remain explicitly unverified. Earlier CLI research does not substitute for acceptance of the implemented extension.

## Deferred work

Direct report-driven rendering, additional surface/model meter presentation, a second quota persistence format, changes to refresh frequency, private SDK control methods, new authentication flows and automatic releases are outside this proposal. This phase improves the reliability of the refresh result while retaining the official cache integration.
