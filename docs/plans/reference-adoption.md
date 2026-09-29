# Scoped improvements and delivery checkpoints

The user authorized independent implementations, parallel `gpt-6-sol` implementation with disjoint write scopes, read-only reviews, delegated fixes, and a commit/push after each verified batch. No release or installation is included.

## Checkpoints

0. **Usage observations and editor smoke tests**: delivered in `d961713`. The refresh-discovery assertion was strengthened before delivery; 576 unit tests, type checking, build, real VS Code 1.107.0 smoke tests and the existing 20 layout checks passed.
1. **Diagnostic report (verified)**: 582 unit tests, type checking, build and real VS Code smoke tests passed. Both accepted report findings were fixed and the scoped re-review found no remaining high/medium issues. a Command Palette action previews a localized, anonymous report before offering to copy it. It includes versions, connection context, Claude's configured account and credential-override variable names, and Codex effective/selected state with restart guidance. No identities, directory names, raw logs, credentials or uploads. Verify formatting/privacy, collection boundaries, preview/copy/cancel, command registration and all four locales.
2. **Repeatable frontend checks (verified)**: 40 layout cases, 20 Codex screenshots and six interactions passed in a full-screen, non-emulated Chromium window at 100% zoom. serve the built Webview with synthetic protocol fixtures; exercise actual DOM interactions and assert account usage display. Run the five documented container widths in four locales, keeping the browser full-screen at normal zoom. Save screenshots and machine-readable assertions. This does not replace real-editor or real-account acceptance.
3. **Claude usage feasibility**: document official `statusLine` data, graphical-chat evidence, shared-settings constraints and per-account attribution. Implement no product collector unless the evidence supports its behavior and the default-directory boundary can be preserved. Unverified real-account behavior remains an explicit acceptance item.
4. **Performance evidence**: benchmark account-info reads with synthetic files under `makeTempHome`, state the measured layer and scale, and record reproducible results. Introduce optimizations only for a demonstrated relevant bottleneck, with focused behavior tests and a second measurement.

## Review contract

Each review is limited to that batch's changed files and the supported behaviors above. Independent reviewers check distinct concerns and report only concrete high/medium defects with file/line evidence and a reproduction or failing path. Existing unrelated issues, speculative hardening, feature expansion and aesthetic preferences are excluded. Accepted defects return to an implementation agent within its original write scope, then receive a read-only re-review. Stop when no high/medium findings remain and the named checks pass.

Before every commit, check the exact diff and documentation, retain pending real-account acceptance, and run type checking, unit tests and the build. Commit only that batch, push `main` to `origin/main`, and verify synchronization. Remove this execution plan when all checkpoints are reconciled into the owning documents.
