# Claude usage collection: feasibility

Checked on 2026-09-30. This is a feasibility record, not an implemented PlanSwap feature or evidence of real-account acceptance.

## Supported upstream data

The official [status line documentation](https://code.claude.com/docs/en/statusline#available-data) describes JSON delivered on standard input to a configured script. `rate_limits.five_hour` and `rate_limits.seven_day` may each contain `used_percentage` and `resets_at` (Unix seconds). For Pro/Max sessions, the five-hour and seven-day fields may appear after the first API response. Gateway sessions may instead provide `rate_limits.spend_limit`. Each window is independently optional, so a gateway without five-hour/seven-day data is not evidence of a failed collector. Missing fields must not be interpreted as zero use, and an observation must carry its collection time.

The [VS Code documentation](https://code.claude.com/docs/en/vs-code) describes shared settings and differences between the graphical extension and the CLI. It does not establish that graphical chat executes `statusLine.command`. Static inspection of the locally installed official extension 2.1.285 did not establish that behavior either. This absence of evidence is not proof that it never runs; graphical-chat collection remains unverified. Internal experimental usage messages are not a public integration contract.

## PlanSwap constraints

- The selected Claude directory is resolved by `claudeSettings.currentDir()` from `claudeCode.environmentVariables`. The authoritative runtime directory for a status-line invocation would have to be verified from that invocation's environment. The documented stdin schema does not provide `CLAUDE_CONFIG_DIR`.
- Shared accounts link `settings.json` to the default account when safe. Writing through a named account's settings link would modify the default settings, which this project's data-protection contract forbids. No collector has been installed into those settings.
- Shared sessions and working-directory paths do not identify the signed-in account. A collector must not infer ownership from either, or from whichever PlanSwap row happens to be selected when a result arrives.
- A future opt-in wrapper would need to pass the same stdin to an existing status-line command, preserve its output and exit behavior, handle shell/platform semantics, and restore only settings it actually owns. That compatibility has not been implemented or tested.

## Decision

Do not ship a Claude quota collector yet. A CLI-oriented status-line mechanism is promising, but graphical-chat invocation, account attribution and installation that preserves default settings are not established together. PlanSwap's existing Codex observations remain independent.

The [settings precedence documentation](https://code.claude.com/docs/en/settings#settings-precedence) permits project-local settings. A disposable workspace's `.claude/settings.local.json` can therefore support a bounded, user-operated experiment without installing anything into the default account. This would cover that workspace only; managed settings or other higher-priority settings may prevent the experiment from taking effect.

## User-operated acceptance experiment

Use a disposable workspace and test accounts. Preserve the exact prior local setting, including whether the file existed, and restore it afterwards. Never record a raw stdin payload, tokens, credentials or identity identifiers.

1. Configure a project-local status-line script which records only invocation count, observation time, a local anonymous directory marker and whether the two rate-limit windows are present. Compare `CLAUDE_CONFIG_DIR` against the expected test-account directories locally; retain the comparison result, not personal paths, in shared evidence.
2. Establish a CLI control case, then separately start an actual conversation from the official **VS Code graphical chat**. The CLI result alone cannot satisfy graphical-chat acceptance.
3. Repeat for two independently signed-in test accounts, applying PlanSwap's normal switch/reload instructions. Verify each invocation's runtime account matches the producing session, including concurrent windows and a pending switch.
4. Repeat with an existing status-line command and confirm its output and exit behavior remain intact. Confirm default and shared account settings were unchanged.
5. Record client/editor versions, connection context, anonymous account markers and pass/fail observations. Restore the project-local settings and remove only the experiment's own files.

Only after these checks should a separate implementation define supported environments, installation/uninstallation behavior and per-account storage. This document does not authorize an agent to perform real-account acceptance.
