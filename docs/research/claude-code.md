# Claude Code and VS Code: research record

Facts about Claude Code, its VS Code extension and VS Code that the [Claude design](../design.md) rests on, each with the version and source it was read from or verified with. "Fact N" in the Claude design refers to the numbered list below. Windows evidence is in the [Windows research record](windows.md).

## Facts

The following facts come from the official documentation and the source code of the locally installed official extension `anthropic.claude-code-2.1.282-linux-x64` (the `CLAUDE_CONFIG_DIR` entry rule in fact 2 was re-checked in 2.1.284); this design rests on them. **Re-verify these assumptions after upgrading the official extension.**

1. `CLAUDE_CONFIG_DIR` is documented, supported behavior: when it is set, `.credentials.json`, `.claude.json`, `settings.json`, `projects/` and `sessions/` all live in that directory. Each directory is an independently signed-in account. User-level MCP servers are stored in `mcpServers` of `.claude.json`, not in `settings.json`.
2. The official extension setting `claudeCode.environmentVariables`:
   - scope `machine`, schema is an array of `{ "name": string, "value": string }`; the parser in the source also accepts the object form `{ KEY: value }` and converts non-string values to strings.
   - The extension reads this setting fresh every time it starts a claude process to build the environment (the extension host's `process.env` as the base, with the setting entries layered on top), so a change takes effect for new sessions immediately.
   - An entry whose `name` is `CLAUDE_CONFIG_DIR` is used only when its `value` is an absolute path string (on Windows with a drive letter or UNC); empty, relative and non-string values are skipped, and the last usable entry wins (extension 2.1.284).
   - The official extension never writes this setting itself, so there is no write race with this extension.
3. The official extension has a built-in watcher for `CLAUDE_CONFIG_DIR` changes: after a change and a settling period of about 1 second it calls `refreshEveryHost`, refreshing the account display and usage of every panel. Note: at that point every panel header (including panels still running a process of the old account) shows the new account, which does not match the account actually used by that panel's process until a reload.
4. Open sessions hold their old process and do not follow a switch; only new sessions use the new account. Transcripts of old sessions live in `projects/` of the old account directory and cannot be found in the new directory after a reload, so the effect of a reload is "all panels start over with the new account", not "old sessions move to the new account". Old sessions can be resumed after switching back.
5. Reasons for not using `claudeCode.claudeProcessWrapper`: the linux-x64 extension ships its own binary, so no wrapper is needed; the official documentation states that in wrapper mode new sessions default to Manual permission mode and do not restore plan mode; in the source `sessionConfigHome` takes a different branch in wrapper mode. The wrapper calling convention is undocumented (Issue #10491 is closed).
6. Under WSL2 the browser sign-in callback often fails; the official documentation says the "paste code" flow is used then, which is normal. After switching to a signed-out directory, the official panel shows its sign-in screen automatically.
7. Claude Code on the WSL side and on the Windows side are two independent installations with separate credentials. How PlanSwap handles this: [Platform guard](../design.md#8-platform-guard) and [Windows support](../design.md#windows-support).
8. The directory the official extension uses for its `ide/` lock files only follows the extension host process's `process.env.CLAUDE_CONFIG_DIR`, not the value in `claudeCode.environmentVariables` (source: `ey$()` calls `uX()`). Consequence: when `claude` is run in a terminal for a non-default account, the CLI looks for lock files in `~/.claude-<name>/ide/` while they are in `~/.claude/ide/`, so the `/ide` integration of the terminal CLI is expected not to work. The native panel passes the MCP configuration directly at startup and does not use lock-file discovery, so it is not affected.
9. When a machine-scope setting is written with `ConfigurationTarget.Global` in a WSL remote window, VS Code stores it in the remote Machine settings (`toEditableConfigurationTarget` in `configurationService.ts`) and also reads the remote value. Preconditions: the official extension is installed on the WSL side (otherwise the key is not registered and `update` throws); `update` also throws when the remote settings.json has a syntax error.

The following facts about shared accounts were verified with Claude Code CLI 2.1.274 in a temporary `CLAUDE_CONFIG_DIR` (re-verify after upgrades):

10. Claude Code writes `settings.json` and `.claude.json` through symlinks: it writes a temporary file next to the resolved target and renames it over the target, so a link stays a link and the default account's file receives the change. A pre-created `.claude.json` containing only `mcpServers` is recognized by `claude mcp list`, and the CLI keeps `mcpServers` when it adds its own keys.
11. `history.jsonl` is appended to in place, so a link to the default file keeps working; `claude project purge` rewrites it by replacing the file, which turns the link of that account into a regular file. PlanSwap's repair: [Claude design 6.7](../design.md#67-shared-and-independent-accounts) and [limitation 11](../design.md#11-known-limitations-and-risks).
12. Session transcripts in `projects/` carry no account identifier, and `--resume` performs no account check, so an account can continue a session started by another one. The server side may still reject content bound to another organization (see [Claude design, limitation 12](../design.md#11-known-limitations-and-risks)).
13. `cleanupPeriodDays` makes Claude Code delete old transcripts inside `projects/`; with a shared `projects/`, a cleanup run by any shared account (or the default account) deletes them for all of them.

The following facts about usage limits were verified with Claude Code CLI 2.1.286 on 2026-10-01 (evidence and measurements: [usage research](claude-usage.md#official-cli-query); re-verify after upgrades):

14. `claude -p "/usage" --output-format json` is a local command (no prompt is sent, `num_turns` 0, cost 0). The first run for an account fetches the limits with Claude Code's own credentials and writes `cachedUsageUtilization` (`fetchedAtMs`, `accountUuid`, `utilization`) into that account's info file (`<dir>/.claude.json`, `~/.claude.json` for the default account without `CLAUDE_CONFIG_DIR`); Claude Code fetches at most about once per minute per account and answers other calls from the cache. When the fetch fails (e.g. offline), the command still succeeds and the cache keeps its old `fetchedAtMs`.

The following facts about `settings.json` keys and sign-in were read on 2026-10-06 from the official documentation (`code.claude.com/docs/en/authentication`, `settings-reference`) and from the native binary of `anthropic.claude-code-2.1.286-linux-x64`; not verified at runtime:

15. Claude Code applies the `env` block of user, `--settings` and managed settings to its own `process.env` at startup (`Object.assign(process.env, filterSettingsEnv(…))`); only project and local settings drop a fixed list of variables, `CLAUDE_CONFIG_DIR` among them. It reads `CLAUDE_CONFIG_DIR` from `process.env` whenever it needs the configuration directory, and the credential directory from `CLAUDE_SECURESTORAGE_CONFIG_DIR` when that is set (an undocumented variable), else from the configuration directory.
16. Authentication precedence, highest first: a cloud provider (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`), `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` (after a one-time approval in interactive mode), `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, an Anthropic profile named in `ANTHROPIC_PROFILE` or the federation pair `ANTHROPIC_FEDERATION_RULE_ID` + `ANTHROPIC_ORGANIZATION_ID`, then the `/login` credential. Any of these in a settings file therefore replaces the account's own sign-in.
17. `forceLoginMethod` (`claudeai` / `console`) restricts the first-party login paths (VS Code extension, Agent SDK, `setup-token`) from any settings file; `gateway` counts only from a managed source. `forceLoginOrgUUID` enforces an organization only from a managed source; in any other settings file a single UUID only pre-selects that organization at login (and turns off the keyless Console sign-in).

The following fact was read on 2026-10-06 from the native Linux x64 binary of Claude Code 2.1.291 (npm `@anthropic-ai/claude-code-linux-x64`); re-verify after upgrades.

18. A project entry of `.claude.json` defaults to `{allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false}`: a missing entry is read as this object, and an entry that lacks one of these keys is not merged with it, but every reader treats the missing key as that default (`?.`, `?? []`, `?? {}`, `|| false`, `=== true`). A missing key therefore behaves like its default value. `mcpContextUris` and the project `allowedTools` are not read at all in this version.

The following facts were read on 2026-10-23 from the native Linux x64 binary of Claude Code 2.1.306 (`~/.local/share/claude/versions/2.1.306`); re-verify after upgrades.

19. With the plaintext credential storage (Linux and Windows), the MCP OAuth sign-ins live in `<config dir>/.credentials.json` next to the Claude sign-in (`claudeAiOauth`): `mcpOAuth` holds one entry per server (tokens, `serverName`, `serverUrl`, discovery state) and `mcpOAuthClientConfig` the registered client per server (client secret). Both are keyed `<server name>|<first 16 hex digits of the SHA-256 of {type, url, headers}>`, so the same server definition has the same key in every account. Every credentials write is a read-modify-write (`mutate`) of the whole file under a proper-lockfile lock on `<config dir>/.storage-write` (lock folder `.storage-write.lock`, 10 retries of 100-1000 ms, stale after 15 s) that re-reads the file under the lock, so a write made by another process before the lock is kept. A linked credentials file is refused (`O_NOFOLLOW`, state `refused-symlink`).
20. `firstStartTime` of `.claude.json` is written at startup whenever the file lacks it (`if(!ue().firstStartTime)` → the current ISO time, with `firstStartVersion`), not only when the file is created: an info file created by another program without it gains one at Claude Code's first start and keeps it afterwards.
21. Every write of an info file (`.claude.json`, the path from `getGlobalClaudeFile`: `<config dir>/.claude.json`, or `~/.claude.json` without `CLAUDE_CONFIG_DIR`) is a read-modify-write under a proper-lockfile lock with `lockfilePath: <that path>.lock` (lock folder next to the file, named after the path Claude Code opens, not its link target; default stale time 10 s, the folder's mtime refreshed every 5 s while held) that re-reads the file under the lock and applies the update to what it read, so a write another process made before the lock is kept. A held lock is retried 6 times (200–4000 ms, about 10 s or more in total, "Lock acquisition took longer than expected"); still held, the write is skipped ("Config lock still held by a live process after retries; skipping").


## Directory lifecycle

Read from the official [Claude directory documentation](https://code.claude.com/docs/en/claude-directory#application-data) on 2026-10-10. This is documentation evidence, not a runtime test of a signed-in client:

- `plugins/installed_plugins.set-aside.<date>.<hash>.json` and `plugins/installed_plugins.unreadable.<date>.<hash>.kept` are recovery copies removed by the retention sweep; the official deletion-impact table says nothing reads them back. A residual account link after this cleanup is not evidence of missing live plugin content.
- `todos` is legacy, no longer written, and its contents and empty directory are removed by the cleanup sweep.
- `tasks` holds persistent task lists; `uploads` holds attachments sent from web/mobile into Remote Control sessions. They are useful shared session data when present, rather than proof that an unused account is unhealthy when absent.
- `projects` holds conversation transcripts and project auto memory; `file-history` holds checkpoint snapshots. `sessions` instead holds live-session records, removed at exit or after a crash.
- `session-env` and `shell-snapshots` hold runtime data; cleanup of such data must not be interpreted as lost conversation history.

Temporary-directory filesystem tests cover target initialization and writes through shared links. They do not establish that a running official client survives target deletion without a subsequent PlanSwap refresh; real-editor task/attachment acceptance remains user-operated.

## History storage recheck (2026-10-10)

Inspected the embedded JavaScript in the installed Linux Claude Code 2.1.296 native binary without running the CLI or reading account files:

- The exported `tryCreateV5Backend` implementation (`pSr`, byte offset 220398057) still returns `undefined` regardless of the feature flag. Extracting that function and running it with both flag values confirmed the result. The v5 symlink refusal text is not evidence that this build uses a functioning v5 backend; retain upgrade monitoring.
- History retention invokes its pruning function only when the HIPAA condition and `tengu_hipaa_history_retention_prune` flag allow it. The function (`tt`, byte offset 225923285) uses `lstat`; a symlink fails the regular-file check and returns `entriesPruned: 0, errors: 1` with an error-level log. The [official directory guide](https://code.claude.com/docs/en/claude-directory#kept-until-you-delete-them) likewise limits automatic prompt-history pruning to HIPAA configurations.
- An isolated Node experiment ran the extracted pruning function against temporary synthetic history paths: the named-account symlink never reached its downstream scanner, while the default account's regular file reached it once. The scanner was stubbed, so this proves the guard and reachability, not complete retention processing or real-client acceptance. It corrects the earlier claim that shared history can never be pruned: the default account's real file remains eligible when the HIPAA condition applies.

The temporary fixture was removed. The resulting PlanSwap decision is in [Claude design, limitation 16](../design.md#11-known-limitations-and-risks). The directory guide also records that `claude project purge` was renamed to `claude purge` in 2.1.288; earlier numbered facts retain the command name of the version they describe.

## Other model services (2026-10-27)

Documentation review, GitHub issues and community tools on 2026-10-27, for running the official Claude Code extension with services other than Anthropic, as Codex API cards do ([Codex research](codex.md#api-services-for-codex-cards-2026-10-26)). Nothing here was run: no endpoint was called and no extension setting was tried.

### Official connection method

- **Two required variables.** `ANTHROPIC_BASE_URL` is the address; the credential goes in `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) or `ANTHROPIC_API_KEY` (sent as `x-api-key`), or comes from `apiKeyHelper` (sent in both headers). A credential variable outranks the claude.ai login, and the subscription's usage limits no longer apply ([LLM gateway connect](https://code.claude.com/docs/en/llm-gateway-connect.md), [LLM gateway](https://code.claude.com/docs/en/llm-gateway)).
- **Endpoint requirements.** `/v1/messages` with streaming is required; `/v1/messages/count_tokens` is optional ([Gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)).
- **Model mapping.** `ANTHROPIC_MODEL` sets the main model; `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` (and `ANTHROPIC_DEFAULT_FABLE_MODEL`) decide which model the opus / sonnet / haiku aliases use; `CLAUDE_CODE_SUBAGENT_MODEL` sets the subagent model. An unrecognized model ID is assumed to have a 200K context window, which `CLAUDE_CODE_AUTO_COMPACT_WINDOW` can correct ([Model config](https://code.claude.com/docs/en/model-config)).
- **Model picker.** `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` makes Claude Code request `GET /v1/models`, but it keeps only IDs containing `claude` or `anthropic`, so models such as deepseek or glm **do not appear automatically** in the list; only the mapping variables above select them.
- **Compatibility.** An upstream that does not recognize the beta fields Claude Code sends returns 400, which `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` resolves. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off background traffic to Anthropic.
- **Official position.** Anthropic "doesn't support routing Claude Code to non-Claude models": it works, but problems are not supported.

### VS Code extension (the key constraint)

- The official documentation says the extension reads credentials **before launch** only from `claudeCode.environmentVariables` for its login check. Values in the `env` block of `settings.json` reach the Claude process, but "not the extension's own login check" ([LLM gateway connect](https://code.claude.com/docs/en/llm-gateway-connect.md)).
- The workaround is `claudeCode.disableLoginPrompt`, a setting meant for third-party providers. With it on, the extension features that depend on a claude.ai account (usage bars, voice dictation, the Web tab) are unavailable ([VS Code docs](https://code.claude.com/docs/en/vs-code)).
- Several GitHub issues report that the extension ignores `ANTHROPIC_BASE_URL` and keeps showing the login screen ([#8522](https://github.com/anthropics/claude-code/issues/8522), [#20271](https://github.com/anthropics/claude-code/issues/20271), [#38430](https://github.com/anthropics/claude-code/issues/38430), [#9136](https://github.com/anthropics/claude-code/issues/9136)), all closed as not planned. The community workaround is `disableLoginPrompt: true` plus the environment variables.

### Anthropic-compatible endpoints of other services

| Service | Address | Source |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | Official. The [Claude Code guide](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) recommends: every model set to `deepseek-flash[1m]` (haiku and subagents `deepseek-flash`), `CLAUDE_CODE_EFFORT_LEVEL=max`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`. The service maps `claude-opus*` to v4-pro and everything else to flash ([Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)). |
| Z.ai (GLM) | `https://api.z.ai/api/anthropic` | Official [docs.z.ai](https://docs.z.ai/scenario-example), which documents the model mapping; a third party advises raising `API_TIMEOUT_MS` ([AI EngineerGuide](https://aiengineerguide.com/til/claude-code-z-ai-glm-4-7/)). |
| OpenRouter | `https://openrouter.ai/api` | Official. Needs `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` set to an empty string ([OpenRouter docs](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md)). |
| Ollama | `http://localhost:11434` | Official, from v0.14; any token value (for example `ollama`) ([Ollama docs](https://docs.ollama.com/api/anthropic-compatibility)). |
| Kimi | `https://api.moonshot.ai/anthropic` (`.cn` in mainland China) | Third-party guides only, no official documentation found ([PromptLayer](https://www.promptlayer.com/blog/how-to-use-kimi-k3-moonshot-ai-with-claude-code/)). |
| Qwen | `https://dashscope-intl.aliyuncs.com/apps/anthropic` | From what appears to be a mirror site; needs confirmation ([source](https://docs.platform.qianwenai.com/developer-guides/clients-and-developer-tools/claude-code)). |
| MiniMax, xAI, LM Studio | No official Anthropic endpoint found | — |

### Community tools

- **[claude-code-router](https://github.com/musistudio/claude-code-router)** (about 38k stars): a local gateway, by default on `127.0.0.1:3456`, that converts OpenAI, Gemini and other formats to the Anthropic format, with routing and fallback. Suited to services that offer only the OpenAI format.
- **[CC Switch](https://github.com/farion1231/cc-switch)**: a desktop app that switches providers by rewriting `~/.claude/settings.json`, and also supports Codex. Closest to PlanSwap's approach, but it changes the global file ([guide](https://www.developersdigest.tech/blog/cc-switch-claude-code-codex-guide)).
- **LiteLLM**: the general gateway the official documentation mentions.

### Extension sign-in check (source inspection, 2026-10-27)

Read from `extension.js` of the official extension `anthropic.claude-code-2.1.310-win32-x64` (installed in VSCodium) and its bundled `claude.exe`; not a runtime test:

- The panel's auth manager is built with the environment the extension passes to Claude Code (`i$()`: the extension host's `process.env` with the `claudeCode.environmentVariables` entries layered on top and `CLAUDE_CONFIG_DIR` resolved as in fact 2), with `claudeCode.disableLoginPrompt`, when a panel is created.
- `readAuthStatus` reports a sign-in only from that environment (`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`), the stored OAuth credentials of the configuration directory, or `primaryApiKey` in `<config dir>/config.json`; otherwise it logs "No authentication found" and the panel offers its sign-in screen. The `env` block of the account's `settings.json` is not read by this check.
- `isAuthLoginDisabled()` is `disableLoginPrompt || CLAUDE_CODE_SKIP_AUTH_LOGIN` (truthy value in that environment); with either, the status sent to the Webview has `skipLogin` / `loginPromptDisabled` instead of a sign-in request. `CLAUDE_CODE_SKIP_AUTH_LOGIN` is not in the public environment variable reference, and the bundled `claude.exe` does not contain the name, so it affects only the extension.
- `claudeCode.disableLoginPrompt` has no `scope` in the manifest (window scope, so a WSL window writes it to the local user settings shared by every window), while `claudeCode.environmentVariables` is `machine` scoped (fact 2, fact 9).
- The third-party provider check (`uJ`) covers the cloud provider switches plus `CLAUDE_CODE_USE_GATEWAY` (the Claude apps gateway sign-in); a plain `ANTHROPIC_BASE_URL` is not a third-party provider for the extension.

Runtime observation on 2026-10-27 (VSCodium on native Windows, extension 2.1.310, isolated user profile and home, a local mock of the Anthropic Messages API on `127.0.0.1`):

- With `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` only in the `env` block of `<CLAUDE_CONFIG_DIR>/settings.json` and nothing but `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`, the panel opened straight to the chat input without a sign-in screen, with or without `claudeCode.disableLoginPrompt`, and the first message reached the mock as `POST /v1/messages?beta=true` with `Authorization: Bearer <token>`, the configured model and streaming, after two `HEAD /api/hello` probes. So the documentation's statement that settings-file values do not reach the extension's login check does not stop the panel in this version; the source-inspection reading above is incomplete.
- The same variables in `claudeCode.environmentVariables` with `disableLoginPrompt` behaved the same.
- A configuration directory without any credential showed the sign-in screen ("How do you want to log in?"); with `disableLoginPrompt` it showed the chat, and sending answered "Not logged in · Please run /login" without any request.

The resulting PlanSwap decision is in [Claude design 6.10](../design.md#610-claude-api-cards): the card keeps the endpoint, key and model in its own `settings.json`, and switching writes only `CLAUDE_CONFIG_DIR`, since the runtime observation above shows that neither `claudeCode.disableLoginPrompt` nor a credential in `claudeCode.environmentVariables` is needed.
