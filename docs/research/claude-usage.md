# Claude usage limits: research record

Checked 2026-09-30 to 2026-10-05, with dates and versions recorded per section. Dated upstream evidence behind the CLI and cache route; PlanSwap's behavior is owned by [Claude design 6.9](../design.md#69-claude-usage-limits). The status-line route was examined first and not pursued. This is not evidence of real-account acceptance.

## Supported upstream data

The official [status line documentation](https://code.claude.com/docs/en/statusline#available-data) describes JSON delivered on standard input to a configured script. `rate_limits.five_hour` and `rate_limits.seven_day` may each contain `used_percentage` and `resets_at` (Unix seconds). For Pro/Max sessions, the five-hour and seven-day fields may appear after the first API response. Gateway sessions may instead provide `rate_limits.spend_limit`. Each window is independently optional, so a gateway without five-hour/seven-day data is not evidence of a failed collector. Missing fields must not be interpreted as zero use, and an observation must carry its collection time.

The [VS Code documentation](https://code.claude.com/docs/en/vs-code) describes shared settings and differences between the graphical extension and the CLI. It does not establish that graphical chat executes `statusLine.command`. Static inspection of the locally installed official extension 2.1.285 did not establish that behavior either. This absence of evidence is not proof that it never runs; graphical-chat collection remains unverified. Internal experimental usage messages are not a public integration contract.

## PlanSwap constraints

- The documented stdin schema does not provide `CLAUDE_CONFIG_DIR`, and shared sessions and working-directory paths do not identify the signed-in account, so attributing a status-line invocation to an account is unverified.
- Shared accounts link `settings.json` to the default account, so installing a collector through a named account's settings would modify the default settings, which [AGENTS.md](../../AGENTS.md#account-and-data-safety) forbids.

## Official CLI query

Checked on 2026-10-01 with Claude Code 2.1.286.

- No subcommand reports usage limits (`claude --help`). `claude auth status` reports sign-in status only.
- `claude -p "/usage"` works in print mode. At the user's request it was run once in a shell against the signed-in default account (`CLAUDE_CONFIG_DIR` unset, subscription sign-in): exit code 0, 2.5–6 seconds, empty stderr, plain-text stdout without ANSI escapes.
- It is handled locally and sends no prompt: with `--output-format json` the result has `type: "result"`, `subtype: "success"`, `is_error: false`, `local_command: "usage"`, `num_turns: 0`, `duration_api_ms: 0`, `total_cost_usd: 0` and all token counts 0. The text is in `result`.
- Observed output (personal statistics elided; PlanSwap does not parse this text, see the cache below):

  ```text
  You are currently using your subscription to power your Claude Code usage

  Current session: 0% used · resets Oct 2, 12:59am (Asia/Bangkok)
  Current week (all models): 0% used · resets Oct 8, 3:59pm (Asia/Bangkok)
  Current week (Fable): 0% used · resets Oct 8, 4pm (Asia/Bangkok)

  What's contributing to your limits usage?
  Approximate, based on local sessions on this machine — does not include other devices or claude.ai. ...
  ```

- Each limit window is one line, `Current <window>[ (<scope>)]: <N>% used · resets <time> (<IANA zone>)`, separated by U+00B7. The model-specific scope (`Fable` here) varies, so names must not be hard-coded. The reset time is localized text whose minutes are omitted on the hour (`4pm` vs `3:59pm`); it is not a timestamp.
- The `Current session` line was absent from an earlier run the user pasted on the same day; a missing window must be treated as unknown, not 0%. The section starting "What's contributing to your limits usage?" is a local estimate, not a limit, and is ignored.
- `--output-format stream-json` with a real prompt was not examined; it would consume quota and is not a read-only query.

### Usage cache

The run is what makes Claude Code fetch the limits with its own credentials, and it stores them in the account's own info file (`<dir>/.claude.json`; `~/.claude.json` for the default account without `CLAUDE_CONFIG_DIR`) as `cachedUsageUtilization`:

- `fetchedAtMs` (ms epoch of the fetch), `accountUuid` (the account the values belong to) and `utilization`.
- `utilization.limits[]`, one entry per window: `kind` (`session`, `weekly_all`, `weekly_scoped`), `percent`, `resets_at` (ISO text), and for a scoped window `scope.model.display_name` (e.g. `Fable`). Older fields `five_hour` / `seven_day` (`utilization`, `resets_at`) are the fallback when `limits` is missing.
- The entry stays in the file indefinitely; a re-sign-in as another account leaves the previous account's cache behind, so its age and `accountUuid` must be checked ([Claude design 6.9](../design.md#69-claude-usage-limits)).
- Observed 2026-10-01: with the network unavailable, `claude -p /usage` still exited 0 with `is_error: false` and answered from the old cache, `fetchedAtMs` unchanged. Success of the command therefore does not prove a refresh; only an advanced `fetchedAtMs` does.

### Rate limiting

Measured on 2026-10-01 with Claude Code 2.1.286 against the signed-in default account: about 70 calls (40 sequential, 10 in parallel, one every 15 seconds for 3 minutes) all succeeded and none produced a 429. Claude Code itself fetched at most about once per 60 seconds per account (`fetchedAtMs` advanced only about once a minute) and answered the other calls from the cache. The server-side limits of the underlying endpoint cannot be observed through the CLI, so no safe rate is established. A smoke run of the real modules against the default account returned `ok` with three windows.

Public sources checked on 2026-10-02 contradict treating this as safe. Claude Code's cost documentation states that the plan-limits request fails "most often because the usage endpoint is rate limited", after which `/usage` shows the last bars loaded within 60 minutes; changelog 2.1.284 made `/usage` and the IDE usage views back off after a rate limit. Community issues (anthropics/claude-code#31055, #30930, #31319, March 2026, Claude Code 2.1.69, no staff replies) report 429s on `api.anthropic.com/api/oauth/usage` after a few calls and a limit shared by every session of the account. No numbers are published. `claude -p /usage` is also not in the documented list of commands available with `-p`. PlanSwap's response is described in [Claude design 6.9](../design.md#69-claude-usage-limits).

Not yet observed: named accounts with `CLAUDE_CONFIG_DIR` set; signed-out, API-key and expired-sign-in accounts (output, `is_error` and cache); whether the call writes anything in the account directory besides the cache entry; native Windows (`claude.cmd`/`claude.exe`). Pending user checks are tracked in [TODO](../../TODO.md).

### Side effects

Checked on 2026-10-01 against the default account. Each plain `claude -p "/usage"` run writes a session transcript (about 4 KB) under `projects/<encoded working directory>/` of the account, which for a shared account is the default account's `projects/`; `--no-session-persistence` prevents it (no new transcript was written). A run in a working directory Claude Code has not seen before may create an empty `projects/<encoded directory>/memory/` folder even then. Without `--setting-sources user`, the working directory's project settings would apply; with the home directory as working directory that is `~/.claude/settings.json`, which would leak the default account's settings into an independent account's query. These are the reasons for the flags and working directory in [Claude design 6.9](../design.md#69-claude-usage-limits). Whether user-level hooks such as `SessionStart` run for the local command was not checked.

## Decision

Implemented via the CLI and cache route ([Claude design 6.9](../design.md#69-claude-usage-limits)). The status-line route was not pursued: graphical-chat invocation, account attribution and an installation that preserves default settings were never established together. If it is reopened, the [settings precedence documentation](https://code.claude.com/docs/en/settings#settings-precedence) permits a disposable workspace's `.claude/settings.local.json` to hold the collector without touching default settings (managed or higher-priority settings may override it); the user must first verify there that graphical chat invokes it and that attribution is correct.

## Extension-bundled CLI

Checked on 2026-10-05 with the locally installed Windows Claude Code extension 2.1.289. The [official VS Code documentation](https://code.claude.com/docs/en/vs-code#prerequisites) states that the extension bundles its own CLI for the chat panel; a standalone install is needed to run `claude` in the terminal.

- **Source inspection:** the installed extension contains `resources/native-binary/claude.exe`. Its executable resolver also supports `resources/native-binaries/<platform>-<arch>/` and an x64 fallback on Windows arm64. These internal paths are observed implementation details, not a documented integration contract.
- **Runtime check:** the bundled executable's `--version` reported 2.1.289 and `--help` completed successfully. No real-account usage query was run; this verifies executable discovery and startup, not quota refresh or account behavior.

## Structured usage report verification

Checked on 2026-10-05 after the executable-discovery fix, at the user's request. This is a feasibility check, not a product migration or real-editor acceptance. The user accepts Claude Code's own short-lived cache as a valid result; a successful check does not need to make a fresh network request every time.

### Method and scope

- Real subscription queries used the official extension binaries: Windows x64 2.1.289, and Linux x64 2.1.286 / 2.1.289 inside two already-running WSL distributions. Windows had only a default account; the 2.1.286 WSL run checked both the default and an existing named account with a different identity. Named-account queries used that account's `CLAUDE_CONFIG_DIR`; no sign-in or account switch was performed.
- The probe used `/usage`, `--no-session-persistence`, and `--setting-sources user`, with per-process `--settings` containing `disableAllHooks: true`, `--strict-mcp-config`, an empty explicit MCP configuration, and `--disallowedTools '*'`. The signed-out case used a disposable HOME and config directory with authentication override variables removed. These controls differ from the product's current launch arguments; this does not establish normal user-hook behavior.
- Failed-network checks used a temporary loopback proxy that returned HTTP 502, configured only in the queried child's environment and settings. The host network and other clients were not disconnected. Connection counts confirmed use of the failing proxy, but do not identify which endpoint each connection targeted.
- The probe never opened `.credentials.json`; only the official CLI used credentials. Raw stdout/stderr, email addresses, identity values and quota percentages were not saved. Identity comparisons and report/cache comparisons were performed in memory. Sanitized observations and disposable probe/fixture scripts are under the ignored `out/usage-report-validation/` and `out/usage-report-offline.test.ts`.

### Observed output

| Environment / case | Format | Result |
|---|---|---|
| Windows 2.1.289, default, online | `stream-json --verbose` | `system`, `assistant`, `result`; one `assistant.usage_report`, three limit rows. |
| Windows 2.1.289, default, online | `json --verbose` | A JSON array with the same three message types, one report and three rows; 8,948 bytes in this observation. |
| Windows 2.1.289, default, online | `json` without verbose | Only the final result object; no report. |
| Windows 2.1.289, signed out in a temporary HOME | `stream-json --verbose` | No report, although the final local-command result still said success. |
| Windows 2.1.289, failed network, cache about 80 seconds old | `json --verbose` | Report present with `rate_limits.limits: null`; final result still success, cache fetch time unchanged. |
| Windows 2.1.289, failed network, cache about one second old | `json --verbose` | Three valid rows from the official cache; fetch time unchanged. This is an accepted cache hit. |
| WSL 2.1.286, default and distinct named account | `json --verbose` | Three rows for each selected account; cache ownership and before/after identity checks passed. |
| WSL 2.1.289, default | `json --verbose` | Three rows; the session row's `resets_at` was `null`, which is a valid unknown reset time. |

The compared percentages, reset instants and model-scope identity/label fields agreed with each selected account's own cache. Reset comparison must accept `null === null`; `Date.parse(null)` is not a valid equality test. Comparing `JSON.stringify(scope)` is also inappropriate because property order and null/missing representation can differ. These checks do not establish equality of every possible surface-scope field.

All completed real CLI runs above reported `local_command: "usage"`, `num_turns: 0`, `duration_api_ms: 0`, `total_cost_usd: 0`, zero input/output/cache token counters and an empty `modelUsage`. No new project JSONL transcripts were observed. This establishes zero model usage in the CLI's reported accounting, not an independent packet-level audit of model requests. Account cache/info writes still occurred; metadata changes in existing skills/projects and telemetry files were also observed. Other clients remained running, so those changes cannot all be attributed to the probe. `--no-session-persistence` must not be described as making the CLI read-only.

### Protocol and cache semantics

The [official SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03273) introduced the report in 0.3.273, and [0.3.277](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03277) changed failure handling for its rows. The [published 0.3.289 types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.289/sdk.d.ts) still mark `SDKUsageReport` experimental. It is a sibling of `message` on the synthetic assistant message, not the token counters in the final result's `usage` field. The current [SDK command documentation](https://code.claude.com/docs/en/agent-sdk/slash-commands#discover-available-commands) also lists `usage`; this is newer evidence than the dated documentation observation above.

Static inspection of the installed Windows 2.1.289 binary matches the runtime results: its usage reader accepts a snapshot younger than 60 seconds as `status: "ok"`, retaining the rows. A failed fetch can use an older snapshot as `status: "seeded"`, whose rows are removed before the report is built. Therefore the type description of a current server reply must not be read as a guarantee of a new HTTP request for each report.

- A valid report with non-empty `limits` is usable even when it came from the official recent cache.
- `limits: []` means a valid empty set of meters; it must not create a synthetic 0% session/week row.
- Missing report, `rate_limits: null`, and `limits: null` provide no usable new rows. A successful exit/result alone cannot distinguish these cases, and text matching is not a reliable substitute. Retained historical values must remain visibly historical after an unavailable result.
- Rows carry `kind`, `group`, `percent`, nullable `resets_at`, `scope`, `severity`, and `is_active`. Unknown kinds, null reset times and `scope.surface` need explicit handling. The existing adapter's model-only scope handling must not silently turn a surface-specific limit into a general limit.
- The report has no account identifier or fetch timestamp. Its receipt time may be called `observedAt`; it is not evidence of the server fetch time. Keep the existing identity checks, or replace them with explicit before/after identity validation and stale-result rejection when an account changes.

### Migration recommendation and remaining gaps

Prefer a bounded `json --verbose` message-array parser over a new streaming parser: both worked, and the array format permits one JSON parse after process completion. Accept a candidate assistant report only with normal process exit and a terminal successful `usage` result. The private control method `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` is unnecessary for this route.

Do not remove the official cache integration as part of the parser change. Today the sidebar and status bar read it, and both current/other-account scheduling and cross-window cooldowns use its timestamp. Keeping that coordination initially avoids introducing a second persistence mechanism. Older clients without a report can use the cache left by the same invocation, subject to the existing attribution/freshness checks; do not start another query merely because the report is absent, or report stale fallback values as a successful refresh.

All 16 offline fixture tests passed. They exercised bounded JSON message arrays and streaming output, malformed/truncated output, terminal errors and missing results, report absence/null/empty distinctions, UTF-8 splits, nullable resets, identity/expiry checks, directory changes and shared-cache scheduling. They are candidate-protocol and current-contract checks, not tests of a shipped report implementation. A fixture with two sequential window monitors demonstrated that replacing shared cache state with isolated in-memory reports would increase queries; the existing timestamp mechanism is not a cross-process lock. The six documentation checks and `git diff --check` also passed; no desktop/UI build or acceptance was required for this research-only change.

Not exercised with real accounts: server-generated 429s, expired/revoked sign-ins, API-key/provider accounts, re-login during an in-flight query, a Windows named account, clients older than the report feature, surface-specific/unknown meters, or the final feature inside VS Code. These remain acceptance gaps; no production parsing or display behavior changed in this verification.

## Implementation verification

Checked on 2026-10-05 after implementing the [agreed validation scope](../plans/claude-usage-report-validation.md). This is a separate verification of the changed `src/claudeUsage.ts`, not a claim that the preceding feasibility probes tested the implementation.

- Four initial regression tests failed against the previous implementation: verbose-report cache hits, unavailable rows with an 80-second-old cache, missing reports with a successful final result, and empty limits with leftover older cache fields. They passed after the query/parser and empty-cache changes.
- Windows validation: typecheck and build passed; the full unit suite passed 622 tests with 60 platform-specific skips and zero failures. The focused Claude usage suite passed 36 tests with seven Linux-only skips. Running the same focused suite inside WSL passed all 43 tests with zero skips, including existing monitor, status-bar and panel tests.
- Focused tests use fake spawn and temporary HOME directories. Additional cases cover malformed/duplicate reports and terminal results, missing/null data, nullable resets, unused metadata, non-zero/signal exits, late stdout and split UTF-8, byte limits, account/organization changes, cache ownership/time/empty-state checks, cancellation and executable fallback. Existing scheduling/cooldown behavior remains covered. Independent source review found no concrete issue.

At the user's explicit authorization, a disposable harness bundled and called the changed query module with real official executables and existing signed-in accounts. It used the product's exact query arguments and process options, without the feasibility probe's extra hook/MCP restrictions. The harness supplied the discovered official extension path as the fallback callback; it did not exercise VS Code's `vscode.extensions` lookup or install an extension. It neither opened credentials nor logged raw output, identities or quota values. CLI output was inspected in memory and only sanitized observations were saved under ignored `out/usage-report-validation/`.

| Environment / case | Executable | Observed result |
|---|---|---|
| Windows, default account | Official extension 2.1.289 | PATH attempt returned ENOENT; bundled exe succeeded with one report and a displayable owned cache. |
| Windows, repeat default-account query | Official extension 2.1.289 | Success with unchanged official cache timestamp, confirming an accepted recent-cache hit. |
| WSL `Ubuntu_26_Dev`, default account | Official extension 2.1.286 | PATH attempt returned ENOENT; bundled Linux binary succeeded. |
| WSL `Ubuntu_26_Dev`, existing named account | Official extension 2.1.286 | Success using the selected account directory, including before/after identity and cache ownership checks. |
| WSL `Ubuntu_26`, default account | Official extension 2.1.289 | Success through the bundled Linux binary. |
| Windows, default account with a failing proxy for this query only | Official extension 2.1.289 | CLI exited 0 with a successful local-command result but `limits: null`; the module returned `noUsage`. Cache timestamp stayed unchanged and historical values remained displayable. |

The failing proxy returned HTTP 502 and was configured only through the query's child environment; 16 connections confirmed it was used. The official cache was about 170 seconds old at query start. The exact 80-second false-success boundary is covered by the automated fixture and the earlier feasibility observation, not by this implementation's live failure run. The proxy was closed after the check; host network settings and account selection were unchanged.

Every completed CLI query reported a local `usage` command, zero turns, zero API duration, zero cost and an empty model-usage map. These are CLI-reported accounting observations, not a packet-level audit. The official CLI may still update its own account files. The WSL 2.1.289 query took about 19 seconds; other successful queries took about 3–4 seconds. These samples do not establish a performance bound.

Not verified by this implementation check: native Linux outside WSL, Windows named accounts, a real PATH-installed CLI or `.cmd` invocation, real cancellation/re-login during a query, server-generated 429s, revoked/API-key/provider accounts, or the built extension's rendered behavior inside VS Code. Those paths have only the applicable automated coverage and remain subject to [manual acceptance](../manual-verification.md#claude-usage-limits). No VSIX was installed or published.
