# Document map

Which document owns which kind of information, and the rules for keeping them. Read this before adding, moving or editing a document. Each fact has one owner; other documents link to it instead of repeating it.

| Document | Owns (not) |
|---|---|
| [README](../README.md) | Product intro, requirements, install, quick start, privacy summary, short limitations for users (not module contracts or dev procedures). |
| [Privacy](privacy.md) | For users: what PlanSwap reads, stores, changes and sends over the network (not credential rules for agents, which stay in AGENTS.md). |
| [User guide](user-guide.md) | Step-by-step user instructions: sidebar, setup, switching, usage limits, settings, troubleshooting. English is the source of the `zh-cn` / `zh-tw` / `es` / `ja` translations (not behavior specs, contracts or verification). |
| [Features](features.md) | Observable behavior of Claude/Codex flows, commands, tools and localization (not signatures, upstream research or test records). |
| [Claude design](design.md) | Claude switching and shared UI architecture, data model, algorithms, rationale, limitations, and the conclusions drawn from upstream facts (not the dated evidence itself, build steps, module inventories or acceptance scripts). |
| [Codex design](codex-design.md) | Codex switching, shell/env propagation, editor restart, sharing design, limitations, and the conclusions drawn from upstream facts (not the dated evidence itself, shared contracts or developer setup). |
| [Development](development.md) | Repository layout, setup, dependencies, build/test/package, release checks, localization terminology, editor troubleshooting (not feature specs or acceptance scripts). |
| [Manual verification](manual-verification.md) | Preview requirements, WSL acceptance setup, user-operated account checks, expected observations, cleanup (not claims that checks passed; pending verification goes in TODO). |
| [Document map](doc-map.md) | This table and the documentation rules below. |
| [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md) | Agent rules, safety/implementation boundaries, commands, task routing (not a full architecture reference); CLAUDE.md imports AGENTS.md and adds only Claude Code-specific rules. |
| [TODO](../TODO.md) | Open work, missing evidence, deferred decisions, pending user actions (not verified behavior or release history). |
| [CHANGELOG](../CHANGELOG.md) | User-facing release history (not current plans or agent instructions). |
| Research: [Claude Code](research/claude-code.md), [Codex](research/codex.md), [Windows](research/windows.md), [Claude usage](research/claude-usage.md), [Account-read baseline](research/account-read-performance.md) | All dated upstream evidence: the numbered facts the designs rest on, each with its version and source, upstream and own measurements, and how each was obtained (source inspection or runtime check) (not design decisions, implemented behavior or real-account acceptance). |
| [Branding candidates](branding/candidates/) | Image-generation prompts and candidate design records. |

## Rules

- Contracts (signatures, per-module behavior, cross-module wiring) live in code: types and TSDoc, with cross-module wiring in the header of the module that does the wiring (e.g. `src/extension.ts`).
- When documents and code disagree, establish the intended behavior from the task, contracts and evidence, then determine which needs updating; do not change one merely to match the other.
- Update the document that owns a fact and link to it from others. When a change affects several layers (behavior, design, contracts), update every affected owner in the same change. Confirmed unused exports, fields and parameters may be removed together with any documentation of them.
- Keep every critical agent safety constraint in AGENTS.md, even when its rationale or procedure lives elsewhere.
- Keep AGENTS.md short (Codex stops adding instruction files at 32 KiB in total, and longer files are followed less reliably): add a rule only after an agent repeated a mistake or for a new safety boundary, put what matters only to one module in that module's header comment, and when changing the file check it for outdated or conflicting rules (in Claude Code, `/doctor prompt-audit`).
- Upstream evidence lives in `docs/research/`, keeps its recorded version and source, and distinguishes source inspection from runtime verification; re-check affected facts after upgrades. A design document states the conclusion and the decision it leads to and links the evidence; a short "verified" note inside a design sentence may stay.
- A documentation reorganization does not by itself verify an old claim or TODO.
- Reconcile completed TODO items only during the pre-commit documentation check, against the verified commit scope; keep partially complete work with its remaining acceptance criteria.
- The translated user guides (`user-guide.<locale>.md`) are updated in the same change as `user-guide.md`. A new document gets a row in the table above (`test/docs.test.ts` checks it).
