# Native Windows: research record

Evidence behind [Windows support](../design.md#windows-support) and [Codex design 9a](../codex-design.md#9a-native-windows). Checks that still need a real Windows sign-in are tracked in [TODO](../../TODO.md).

## Claude Code on Windows

Researched 2026-09-29 from the official Claude Code docs (authentication, settings, VS Code), the Codex docs and `openai/codex` issues, and existing switchers (account-switcher-for-claude-code, claude-account-switcher-windows, codex-switch, codex-profiles). Verified on 2026-09-30 without real accounts: with `CLAUDE_CONFIG_DIR` set, Claude Code 2.1.284 on Windows writes `<dir>\.claude.json` and nothing into the home folder (temporary config and home folders), so the existing `claudeJsonPath` rule holds; the CLI resolves `~` through `USERPROFILE`, like `os.homedir()`. The Claude extension 2.1.284 applies `claudeCode.environmentVariables` to the process it starts and follows a `CLAUDE_CONFIG_DIR` there host-side as well (its code; the older reports [#30538](https://github.com/anthropics/claude-code/issues/30538), [#34888](https://github.com/anthropics/claude-code/issues/34888) predate that); it reads the entry as in [fact 2](claude-code.md#facts), and `claudeSettings` does the same.

## SQLite through file links

On the GitHub Windows runner (2026-09-30, SQLite 3.53.4), a database opened through a file link got a second WAL beside the link, a connection on the real path did not see 500 rows written through the link, and after closing both the rows were gone while `integrity_check` still said `ok`. Linux follows the link and loses nothing.

## Codex on Windows

Verified on 2026-09-30 without real accounts: Codex honors `CODEX_HOME` on Windows, including non-ASCII paths (`codex app-server` with a temporary folder).
