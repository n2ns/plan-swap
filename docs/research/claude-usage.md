# Claude usage limits: research record

Checked on 2026-09-30 and 2026-10-01. Dated upstream evidence behind the implemented CLI and cache route ([Claude design 6.9](../design.md#69-claude-usage-limits)); the status-line route below was examined first and not pursued. This is not evidence of real-account acceptance.

## Supported upstream data

The official [status line documentation](https://code.claude.com/docs/en/statusline#available-data) describes JSON delivered on standard input to a configured script. `rate_limits.five_hour` and `rate_limits.seven_day` may each contain `used_percentage` and `resets_at` (Unix seconds). For Pro/Max sessions, the five-hour and seven-day fields may appear after the first API response. Gateway sessions may instead provide `rate_limits.spend_limit`. Each window is independently optional, so a gateway without five-hour/seven-day data is not evidence of a failed collector. Missing fields must not be interpreted as zero use, and an observation must carry its collection time.

The [VS Code documentation](https://code.claude.com/docs/en/vs-code) describes shared settings and differences between the graphical extension and the CLI. It does not establish that graphical chat executes `statusLine.command`. Static inspection of the locally installed official extension 2.1.285 did not establish that behavior either. This absence of evidence is not proof that it never runs; graphical-chat collection remains unverified. Internal experimental usage messages are not a public integration contract.

## PlanSwap constraints

- The selected Claude directory is resolved by `claudeSettings.currentDir()` from `claudeCode.environmentVariables`. The authoritative runtime directory for a status-line invocation would have to be verified from that invocation's environment. The documented stdin schema does not provide `CLAUDE_CONFIG_DIR`.
- Shared accounts link `settings.json` to the default account when safe. Writing through a named account's settings link would modify the default settings, which this project's data-protection contract forbids. No collector has been installed into those settings.
- Shared sessions and working-directory paths do not identify the signed-in account. A collector must not infer ownership from either, or from whichever PlanSwap row happens to be selected when a result arrives.
- A future opt-in wrapper would need to pass the same stdin to an existing status-line command, preserve its output and exit behavior, handle shell/platform semantics, and restore only settings it actually owns. That compatibility has not been implemented or tested.

## Official CLI query

Checked on 2026-10-01 with Claude Code 2.1.286. The project rules permit running the official `claude` CLI with `CLAUDE_CONFIG_DIR` set to an account (unset for the default account) to query usage limits, mirroring the Codex route; PlanSwap still never reads `.credentials.json` itself.

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
- The entry stays in the file indefinitely, so its age and its `accountUuid` must be checked: PlanSwap uses it only when `accountUuid` equals the file's `oauthAccount.accountUuid` (a re-sign-in as another account leaves the previous account's cache behind) and shows nothing older than 24 hours.
- Observed 2026-10-01: with the network unavailable, `claude -p /usage` still exited 0 with `is_error: false` and answered from the old cache, `fetchedAtMs` unchanged. Success of the command therefore does not prove a refresh; PlanSwap compares `fetchedAtMs` with the start of its run.

### Rate limiting

Measured on 2026-10-01 with Claude Code 2.1.286 against the signed-in default account: about 70 calls (40 sequential, 10 in parallel, one every 15 seconds for 3 minutes) all succeeded and none produced a 429. Claude Code itself fetched at most about once per 60 seconds per account (`fetchedAtMs` advanced only about once a minute) and answered the other calls from the cache. The server-side limits of the underlying endpoint cannot be observed through the CLI, so no safe higher rate is established; PlanSwap's own cadence (one query per 15 minutes, a manual refresh at most as fast as the user clicks) stays far below what was tried. A smoke run of the real modules against the default account returned `ok` with three windows.

Not yet verified (user-operated, tracked in [TODO](../../TODO.md)): named accounts with `CLAUDE_CONFIG_DIR` set; signed-out, API-key and expired-sign-in accounts (output, `is_error` and cache); whether the call writes anything in the account directory besides the cache entry; native Windows (`claude.cmd`/`claude.exe`).

### Side effects

Checked on 2026-10-01 against the default account. Each plain `claude -p "/usage"` run writes a session transcript (about 4 KB) under `projects/<encoded working directory>/` of the account, which for a shared account is the default account's `projects/`; `--no-session-persistence` prevents it (no new transcript was written). A run in a working directory Claude Code has not seen before may create an empty `projects/<encoded directory>/memory/` folder even then. Without `--setting-sources user`, the working directory's project settings would apply; with the home directory as working directory that is `~/.claude/settings.json`, which would leak the default account's settings into an independent account's query. PlanSwap therefore runs `claude -p /usage --output-format json --no-session-persistence --setting-sources user` from the home directory. Whether user-level hooks such as `SessionStart` run for the local command was not checked.

## Decision

Implemented via the CLI and cache route: PlanSwap runs `claude -p /usage --output-format json` under the account and reads the `cachedUsageUtilization` entry that Claude Code writes into the account's own info file, attributed through `accountUuid` ([Claude design 6.9](../design.md#69-claude-usage-limits)). The status-line route was not pursued: graphical-chat invocation, account attribution and an installation that preserves default settings were never established together. PlanSwap's Codex observations remain independent.

The status-line experiment below is kept as a record of the alternative; it is not needed by the implemented route. The [settings precedence documentation](https://code.claude.com/docs/en/settings#settings-precedence) permits project-local settings. A disposable workspace's `.claude/settings.local.json` can therefore support a bounded, user-operated experiment without installing anything into the default account. This would cover that workspace only; managed settings or other higher-priority settings may prevent the experiment from taking effect.

## User-operated acceptance experiment (status-line route, not pursued)

Use a disposable workspace and test accounts. Preserve the exact prior local setting, including whether the file existed, and restore it afterwards. Never record a raw stdin payload, tokens, credentials or identity identifiers.

1. Configure a project-local status-line script which records only invocation count, observation time, a local anonymous directory marker and whether the two rate-limit windows are present. Compare `CLAUDE_CONFIG_DIR` against the expected test-account directories locally; retain the comparison result, not personal paths, in shared evidence.
2. Establish a CLI control case, then separately start an actual conversation from the official **VS Code graphical chat**. The CLI result alone cannot satisfy graphical-chat acceptance.
3. Repeat for two independently signed-in test accounts, applying PlanSwap's normal switch/reload instructions. Verify each invocation's runtime account matches the producing session, including concurrent windows and a pending switch.
4. Repeat with an existing status-line command and confirm its output and exit behavior remain intact. Confirm default and shared account settings were unchanged.
5. Record client/editor versions, connection context, anonymous account markers and pass/fail observations. Restore the project-local settings and remove only the experiment's own files.

Only after these checks should a separate implementation define supported environments, installation/uninstallation behavior and per-account storage. This document does not authorize an agent to perform real-account acceptance.
