# Feature feasibility: official integration surfaces

Research date: 2026-10-04. Method: official documentation review, with existing repository research used to identify current integration boundaries. No real-account login, switching, model requests, or editor restart was performed. Documentation describes upstream capabilities, not capabilities verified in the user's installed versions.

This document owns the dated evidence. The [implementation proposal](../plans/feature-expansion.md) owns prioritization and acceptance criteria. Existing implementation research remains in [Claude usage](claude-usage.md), [Claude Code](claude-code.md), and [Codex](codex.md); this record does not retroactively validate their version-specific findings.

## Facts

### 1. Codex exposes structured account and quota operations

The official [App Server documentation](https://learn.chatgpt.com/docs/app-server) documents `account/read`, managed login operations, `account/rateLimits/read`, and `account/rateLimits/updated`. Quota results include window duration, percentage, reset time, optional windows, and potentially multiple buckets. These support account-scoped observations; they do not establish the identity of another running client.

App Server is an integration surface for clients connected to that server. Its authentication methods are not documentation of a third-party extension API for changing an already-running official IDE panel's `CODEX_HOME`. No such public contract was found in the reviewed documentation. This is an evidence gap, not proof of technical impossibility.

### 2. Claude documents quota output with session-dependent availability

The official [status line documentation](https://code.claude.com/docs/en/statusline) exposes `rate_limits.five_hour` and `rate_limits.seven_day`, including usage percentage and reset timestamps. Subscription quota fields apply to supported subscribers and appear only after the session's first API response. Windows can be independently absent; elapsed windows are dropped. This is not an idle-account query API.

The [usage documentation](https://code.claude.com/docs/en/costs) explains that failed `/usage` requests can display a timestamped previous result. An elapsed reset timestamp alone therefore cannot confirm current availability.

The existing [Claude usage investigation](claude-usage.md) records PlanSwap's CLI/cache approach. No reviewed official document establishes `cachedUsageUtilization` as a stable external API. Its continued operation requires version-specific verification; documented status-line output is not a drop-in replacement for querying every account.

### 3. Login status is narrower than operational health

[Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents `claude auth status` with JSON output and `claude auth login`. The `configDirectory` status field requires v2.1.268 or later. [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) documents `codex login status`; successful status indicates credentials are present, not that a model request will succeed.

[Codex authentication](https://learn.chatgpt.com/docs/auth) documents file, keyring, automatic, and ephemeral storage. Consequently, absence of `auth.json` is not universal proof that the upstream client is logged out. Supporting a storage mode in PlanSwap is a separate integration decision.

### 4. Account directories support explicit process launch

[Claude environment variables](https://code.claude.com/docs/en/env-vars) documents `CLAUDE_CONFIG_DIR` and using it to run multiple accounts side by side. Project and local settings cannot set this variable. [Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables) documents `CODEX_HOME` as the state root used by the CLI, IDE extension, and app-server; an explicitly supplied directory must already exist.

These are grounds for launching a new process with a selected account directory, not a promise that existing processes adopt environment changes. [Codex configuration profiles](https://learn.chatgpt.com/docs/config-file/config-advanced) are configuration overlays, not interchangeable account-directory profiles.

### 5. History recovery has official entry points

[Claude VS Code integration](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools) documents `vscode://anthropic.claude-code/open?session=<sessionId>`. The session must belong to the current workspace. A missing session opens a new conversation; an already-open session focuses its existing tab. The documented parameters do not select an account. The focused VS Code window receives the URL.

[Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) documents `codex resume`, including session selection and working-directory behavior. Neither source establishes unrestricted cross-account migration of running tasks. Availability in VS Code forks and WSL URL routing was not tested.

### 6. Claude can report classified session failures

[Claude hooks](https://code.claude.com/docs/en/hooks#stopfailure) documents `StopFailure` error classes including rate limits, authentication failures, organization restrictions, and billing errors. The hook has no decision control. It can inform recovery UI for sessions with the hook installed; it does not itself switch accounts or resume failed work.

### 7. Replacing the official Codex executable is not a stable shortcut

[Codex IDE settings](https://learn.chatgpt.com/docs/developer-settings?surface=ide) labels `chatgpt.cliExecutable` as development-only and warns that overriding the bundled executable can break extension functionality. This does not provide a supported account-switching contract.

## Evidence limits

- Recheck the affected interface against the installed standalone CLI and bundled extension version before implementation. They need not be the same version.
- No quota source reviewed here guarantees remaining requests, remaining working hours, or successful completion of a particular task.
- Distinguish an observed login, a successful quota query, the selected account directory, and the identity of a particular live session.
- Managed policy, authentication mode, and missing fields can narrow availability. Unknown data must remain unknown.
- Credential copying and token ownership are also constrained by PlanSwap's [project rules](../../AGENTS.md). Those product boundaries are not claims that upstream forbids every alternative architecture.
