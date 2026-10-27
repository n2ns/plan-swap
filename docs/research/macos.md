# macOS: research record

Evidence behind macOS support. Runtime checks ran on 2026-10-26 and 2026-10-27 on an Intel Mac (macOS 15.8.1, x86_64) with VS Code 1.142.0, the Claude Code CLI 2.1.304 on the PATH, the Claude Code extension 2.1.311 and the Codex extension 26.1021.22027, using the default account and one test account. Checks that still need a real Mac sign-in are tracked in [TODO](../../TODO.md).

## Claude Code sign-in in the Keychain

- **Runtime check.** Claude Code keeps the sign-in in the login Keychain, one generic password per config folder. Without `CLAUDE_CONFIG_DIR` the item is `Claude Code-credentials`; with it, `Claude Code-credentials-<hash>`, where `<hash>` is the first 8 hex digits of the SHA-256 of the variable's exact string (for example `/Users/<user>/.claude-test` gave `dbefbfe1`). Signing in with one folder left the other folder's item untouched.
- **Runtime check.** The string is not normalized: `CLAUDE_CONFIG_DIR` spelled as the default folder (`$HOME/.claude`), with a trailing slash, or through a symlink to a signed-in folder each made `claude auth status` report `loggedIn: false`.
- **Source.** Per-folder items exist since Claude Code 2.1.121; up to 2.1.19 every folder shared one item ([aisw](https://aiswitcher.dev/blog/multiple-claude-code-accounts/)). [#92252](https://github.com/anthropics/claude-code/issues/92252) (open, no maintainer reply) reports the same signed-out result for `$HOME/.claude` and `$HOME/.claude/`.
- **Runtime check.** Reading an item over ssh fails with "User interaction is not allowed"; sign-in and status checks have to run in the GUI session (a `.command` file opened in Terminal).
- **Runtime check.** `claude -p /usage …` for both accounts, with both the PATH CLI and the extension's bundled CLI, succeeded in the background without a Keychain access prompt.
- **Inference.** Deleting a config folder does not delete its Keychain item, so a folder created later at the same path starts signed in to the old account. The official `claude auth logout` with the same `CLAUDE_CONFIG_DIR` is expected to remove it (to be confirmed in acceptance).
- **Source.** Signing in to the Console without an API key stores a credential outside the config folder, so it cannot be told apart per folder ([authentication](https://code.claude.com/docs/en/authentication)).
- **Source.** [#72261](https://github.com/anthropics/claude-code/issues/72261) reports that the extension ignored `claudeCode.environmentVariables` on macOS in 2.1.193–2.1.195 (closed by a bot); [#21926](https://github.com/anthropics/claude-code/issues/21926) reports that `env` in `settings.json` did not apply when the editor was started from the Dock. Whether the current extension starts the CLI with the account from `claudeCode.environmentVariables` on macOS still needs an acceptance check.

## Claude Code session records

- **Runtime check.** `<config>/sessions/*.json` records `procStart` as `ps` lstart text, for example `Mon Oct 26 20:00:10 2026`. `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` printed exactly that value; without `TZ=UTC` the machine's local time zone (+07) gave `Tue Oct 27 03:00:10 2026`.

## Bundled CLIs

- **Runtime check.** The Claude Code extension bundles its CLI at `resources/native-binary/claude`.
- **Runtime check.** The Codex extension bundles its CLI at `bin/macos-x86_64/codex` on an Intel Mac; the Apple silicon folder name (presumably `macos-aarch64`) is not verified. The extension starts `codex app-server`, which inherits `CODEX_HOME` from the extension host.

## Editor environment

- **Source.** VS Code resolves the shell environment by running the login shell as `$SHELL -i -l -c` with `VSCODE_RESOLVING_ENVIRONMENT=1`, skips this when started from its CLI (`VSCODE_CLI` set), caches the result in the main process and gives up after `application.shellEnvironmentResolutionTimeout` (10 s by default) ([shellEnv.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/shell/node/shellEnv.ts), [FAQ](https://code.visualstudio.com/docs/supporting/faq)). zsh reads `~/.zshenv`, `~/.zprofile` and `~/.zshrc` for such a shell.
- **Runtime check.** With a marker block in `~/.zshenv` that exports `CODEX_HOME` from `~/.config/planswap/codex-home`, the extension host got the selected value when VS Code was started like from the Dock (`env -u CODEX_HOME open -a`), and a new value after a full quit and restart. Started with `code` from Terminal, it also got the new value. A new window opened with the CLI in an already running instance used the CLI's environment. `open` passes the caller's environment to the app.
- **Inference.** The Codex and Claude desktop apps, started by launchd, do not run the login shell and do not follow this selection.

## Codex credentials

- **Source.** `cli_auth_credentials_store` can be `file`, `keyring`, `auto` or `ephemeral`; the documentation names no default, the source defaults to `file`, and the CLI and the extension share the sign-in ([authentication](https://learn.chatgpt.com/docs/auth)).
- **Not verified.** The format of the Codex daemon pid files on macOS.

## Other switchers

Most macOS account switchers for Claude Code ([CCSwitcher](https://github.com/XueshiQiao/CCSwitcher), [ccswitch](https://github.com/vyshnavsdeepak/ccswitch), [claude-account](https://github.com/chiliec/claude-account)) copy or swap the Keychain item; refresh tokens rotate on use, so saved copies go stale ([notes](https://gist.github.com/fortunto2/b326e4727e32f9af1742f0710dcc5f75)). One config folder per account avoids both.
