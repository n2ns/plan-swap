---
name: release
description: Prepares a PlanSwap release commit — version bump, CHANGELOG section, the required checks and the `release:` commit — and stops before the tag. Use when the user asks to release, bump the version or cut a release; the tag push that publishes to the VS Code Marketplace and Open VSX needs the user's explicit release authorization.
argument-hint: [version]
---

# Release preparation

A release is a commit on the current branch that bumps `package.json` / `package-lock.json` and turns `## [Unreleased]` in `CHANGELOG.md` into the version's section. Pushing the `v<version>` tag is the publication ([Development: Release](../../../docs/development.md#release), `.github/workflows/publish.yml`); this skill prepares everything up to the commit and does nothing to the tag unless the user has explicitly authorized the release.

## Steps

1. **Clean tree.** `git status --porcelain` must be empty; every change that belongs to the release is already committed. Do not mix release and feature changes in one commit.
2. **Version.** Use the version the user named. Without one, add 1 to the last number of the current `npm pkg get version` and say so; never choose a larger bump yourself.
3. **CHANGELOG.** Rename `## [Unreleased]` to `## [<version>] - <today, YYYY-MM-DD>`. Every entry is user-facing (what the user sees, with **bold** UI labels as in the user guide), no empty `###` sections, no agent or test details. Sections of versions that already carry a `v*` tag are never edited (`test/changelog.test.ts`). Afterwards `grep -n Unreleased README.md CHANGELOG.md` prints nothing.
4. **Bump.** `npm version <version> --no-git-tag-version` updates `package.json` and `package-lock.json`.
5. **Checks.** `npm run typecheck && npm test && npm run build` must pass. `test/changelog.test.ts` compares the frozen sections against the newest tag.
6. **Commit** on the current branch: `release: <version> with <what the CHANGELOG section is about, one line>`. No `Co-Authored-By` or other generation marker. Push only when the user asked for a push.
7. **Tag.** Only with the user's explicit release authorization in this conversation: `git tag v<version>` and `git push origin v<version>`. The workflow checks that the tag matches `package.json`, tests on Linux and Windows, packages the `.vsix` and publishes it. Without that authorization, report that the commit is ready and that tagging publishes.

`npm run package` is separate from releasing and the `.vsix` is never installed into the user's editor.
