---
name: preview-verify
description: Runs a task-specific layout check against the synthetic Webview preview at every sidebar width (200, 240, 280, 340, 420 px) and locale (en, zh-cn, zh-tw, es, ja), with screenshots and a JSON report. Use for the preview verification every frontend change needs - patch the preview state to show the changed UI, assert its layout, keep the artifacts. Never for real accounts.
compatibility: Linux/WSL; the project's node_modules (esbuild, playwright with its headless Chromium) and a built dist/ (the script builds unless --no-build).
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/run.mjs *) Read
argument-hint: [check]
---

# Preview verification

One command builds the project, serves the synthetic preview in-process, opens one headless page with a fixed 1920x1080 viewport at 100% zoom and runs one check once per locale x width; it prints only the `ok`/`FAIL` step lines and a summary, exits 1 on any failure, and always closes the browser and stops the server.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/run.mjs list                        # available checks
node ${CLAUDE_SKILL_DIR}/scripts/run.mjs <check>                     # all 25 cases; --no-build skips the build
node ${CLAUDE_SKILL_DIR}/scripts/run.mjs <check> --widths=200,420 --locales=en,ja
node ${CLAUDE_SKILL_DIR}/scripts/run.mjs /path/to/my-check.mjs       # a throwaway check outside the project
```

Artifacts: `.test-out/preview/<check>/` holds `report.json` (every step with its locale-width case), the check's screenshots (clipped to the sidebar) and, for every failed step, `fail-N.png` plus `fail-N.txt` (the sidebar text at that moment). Read the report and look at the screenshots: the assertions catch what they name, the pictures catch the rest. `npm test` wipes `.test-out`.

## What belongs where

- This skill (`scripts/run.mjs`) is the tool: build, server, browser, the case loop and the check API. It does not change with the project's features.
- `test/preview/checks/*.mjs` are the checks. A check that belongs to a shipped feature stays there (`banners` is the first); a one-off check for the task at hand can live in the scratchpad and be passed by path.
- `npm run test:ui` asserts the fixed layout rules on every width and locale (regressions); `devhost-test` runs the real editor. This skill covers the layout of the change under verification, where a fixed test does not exist yet.

## Check contract

A check module exports `run(ctx)`, called once per locale x width with the page already loaded. `ctx`:

- `page`: the Playwright page; `locale`, `width`: the current case; `out`: the artifact directory.
- `apply(mutate, active?)`: resets the preview to the case (`window.preview.apply({ locale, width, active })`), deep-clones `window.preview.state()`, runs `mutate(state)` on the clone inside the page, posts the result as a `state` message and waits for the render. `mutate` is serialized, so it must be self-contained (no closures over Node values). The synthetic state is `PanelState` from `src/protocol.ts`; the fixture accounts are `/fixture/.claude`, `/fixture/.claude-work`, `/fixture/.claude-empty` and the same for `codex` (`scripts/preview/fixture.ts`).
- `step(label, ok, detail?)`: records an assertion; a failed step captures the sidebar. `shot(file)`: screenshot of `#sidebar` into `out`. `sleep(ms)`.

A thrown error is captured as a failure with a screenshot. Measure with `page.evaluate` and `getBoundingClientRect`; compare against `#sidebar`, not the viewport.

## Rules

- Headless only, with the fixed viewport the script sets: adjust the sidebar width through `apply`, never the viewport or the zoom.
- The script owns the browser and the preview server; it leaves no tab, profile or process behind. Do not start `npm run preview` or a browser for the same purpose, and if a run hangs, stop the `node run.mjs` process by its pid; never kill browsers by name.
- The preview is synthetic data only. Never point a check at real account directories or credentials.
