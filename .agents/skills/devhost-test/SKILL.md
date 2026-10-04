---
name: devhost-test
description: Runs the PlanSwap sidebar in a real, disposable VS Code (Extension Development Host) with fake Claude and Codex accounts and drives the Webview over the Chrome DevTools Protocol. Use after a sidebar or Webview change, when a check needs real theme injection, host-side state writes or settings round-trips that the synthetic preview (npm run test:ui) cannot give, or to screenshot the sidebar in real themes. Never for real accounts.
compatibility: Linux/WSL with a display (WSLg) or xvfb-run; the project's node_modules (@vscode/test-electron, playwright) and the cached VS Code in .vscode-test/.
---

# Real-editor sidebar checks with fake accounts

## What it does

`scripts/run.mjs` builds nothing: run `npm run build` first. It then creates a temporary HOME with fake accounts (`fixtures/accounts.mjs`), launches the cached VS Code 1.107.0 through `@vscode/test-electron` with `--remote-debugging-port`, connects with Playwright over CDP, finds the PlanSwap Webview frame and runs one scenario from `scenarios/`. Screenshots and `report.json` land in `.test-out/devhost/<scenario>/`; the editor is closed and the temporary HOME removed when the scenario ends, also on failure.

```bash
npm run build
node .agents/skills/devhost-test/scripts/run.mjs recommendation            # exit code 1 on any failed step
node .agents/skills/devhost-test/scripts/run.mjs recommendation --window=4040,442,2480,1500   # window position
```

Read `report.json` for the step results and look at the screenshots: the themes are real editor themes, which `npm run test:ui` cannot provide. Every run takes about 90 seconds.

## Isolation rules (not negotiable)

- The editor runs with its own HOME, XDG directories, extensions directory and `.test-out/devhost-user-data` as user data. No real account file (`~/.claude*`, `~/.codex*`, `~/.config/planswap`) is read or written; do not point the script at a real home and do not add fixtures that read one.
- `claude` and `codex` are kept off PATH and automatic usage checks are off in the editor settings, so no CLI ever runs. Keep it that way in new scenarios.
- One editor at a time; the script closes its own editor. Never kill editors by name; if a run hangs, stop the `node` process you started by its PID.
- Artifacts under `.test-out/` are ignored by git; do not commit them.

## Writing a scenario

A scenario module exports `run(ctx)` and may export `seed(home)` to replace the default fixture. `ctx` offers: `dump()` (card, banner, rows with usage levels and toggles of the visible page), `shot(file)`, `rowAction(dir, action)`, `tab(mode)`, `waitFor(pred, ms)`, `writeSettings(extra)` / `readSettings()`, `readState()`, `notifications()`, `step(label, ok, detail)`, `page`, `frame`, `dirs`, `sleep`. Use `step` for every assertion; a thrown error is recorded as a failure too. `scenarios/recommendation.mjs` is the reference.

## Known limits

- The test-mode editor refuses modal dialogs ("DialogService: refused to show dialog in tests") and reports the refusal in a notification that quotes the dialog text; use that to prove a confirmation was asked, and turn the confirmation setting off to exercise the action itself.
- VS Code only writes registered settings, so the launcher installs a stub extension declaring `claudeCode.environmentVariables`; a scenario that needs another extension's setting must extend that stub.
- It is VS Code 1.107.0 on Linux, not the user's editor version or the Windows client with a WSL server; WSL server restarts, real sign-ins and CLI queries stay user-operated ([Manual verification](../../../docs/manual-verification.md)).
- The rc marker block in the fixture duplicates `rcBlock()` from `src/codex/codexState.ts`; a drift shows as a disabled Codex page.
