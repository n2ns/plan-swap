---
name: devhost-test
description: Runs the extension in a real, disposable VS Code (Extension Development Host) with fake data and drives its Webview over the Chrome DevTools Protocol. Use after a sidebar or Webview change, when a check needs real theme injection, host-side state writes or settings round-trips that the synthetic preview (npm run test:ui) cannot give, or to screenshot the sidebar in real themes. Never for real accounts.
compatibility: Linux/WSL with a display (WSLg) or xvfb-run; the project's node_modules (@vscode/test-electron, playwright) and the VS Code build cached in .vscode-test/.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/run.mjs *) Read
argument-hint: [scenario]
---

# Disposable-editor checks

One command builds the project, launches the cached VS Code with a temporary HOME, connects over CDP and runs one scenario; it prints only the `ok`/`FAIL` step lines and a summary, exits 1 on any failure, and always closes the editor and removes the temporary HOME.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/run.mjs list                 # available scenarios
node ${CLAUDE_SKILL_DIR}/scripts/run.mjs <scenario>           # ~90 s; --no-build skips the build
```

Artifacts: `.test-out/devhost/<scenario>/` holds `report.json`, the scenario's screenshots and, for every failed step, `fail-N.png` plus `fail-N.txt` (the Webview text at that moment); `.test-out/devhost/<scenario>.log` is the editor's full output. Read the report and the screenshots; do not re-run just to see a failure.

With `xvfb-run` installed the editor runs on a virtual display and no window opens; `--visible` uses the real display, and `--window=x,y,w,h` (or `"window"` in the machine-local `.vscode-test/devhost/local.json`) places it there. `.vscode-test/devhost/` also keeps the editor's user-data directory and the run lock (one editor at a time); `npm test` wipes `.test-out`, so artifacts are disposable and these are not.

## What belongs where

- This skill (`scripts/`) is the tool: launcher, isolation, CDP connection, driver API. It does not change with the project's features.
- `test/devhost/devhost.config.mjs` names the extension, its focus command, the Webview frame selector, project settings, stub extensions and the default fixture. `test/devhost/scenarios/*.mjs` are the checks; project DOM helpers sit next to them. Feature work edits `test/devhost/`, not this skill.

## Isolation (enforced by the launcher)

Own HOME, XDG, extensions and `.vscode-test/devhost/user-data` (settings rewritten each run; keeps only window state and the extension's globalState); `PATH` holds system directories only, so project CLIs cannot run; the config's `clearEnv` variables are unset. Never point a scenario at a real home or real credentials. If a run hangs past its 15-minute cap, stop the `node run.mjs` process by its pid; never kill editors by name.

## Scenario contract

A scenario module exports `run(ctx)` and optionally `seed(home)` (returns `ctx.dirs`). `ctx`: `page`, `frame`, `home`, `dirs`, `out`, `step(label, ok, detail)`, `shot(file)`, `waitFor(fn, pred, ms)`, `writeSettings(extra)`, `readSettings()`, `readHomeJson(rel)`, `notifications()`, `sleep`. Record every assertion with `step`; a thrown error is captured as a failure with a screenshot.

## Editor limits

- Test mode refuses modal dialogs; the refusal notification quotes the dialog text, which proves a confirmation was asked. Turn the confirmation setting off to exercise the action itself.
- VS Code only writes registered settings: declare another extension's setting through `stubExtensions` in the config.
- It is the cached VS Code on Linux, not the user's editor version or a Windows client with a WSL server.
