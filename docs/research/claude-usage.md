# Claude usage limits: research record

Checked 2026-09-30 to 2026-10-02. Dated upstream evidence behind the CLI and cache route; PlanSwap's behavior is owned by [Claude design 6.9](../design.md#69-claude-usage-limits). The status-line route was examined first and not pursued. This is not evidence of real-account acceptance.

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
