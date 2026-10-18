# Document map

Which document owns which kind of information, and the rules for keeping them. Read this before adding, moving or editing a document. Each fact has one owner; other documents link to it instead of repeating it.

### For users

| Document | Owns (not) |
|---|---|
| [README](../README.md) | Product intro, requirements, install, quick start, privacy summary, short limitations for users, including which environments have been accepted with real accounts (not module contracts or dev procedures). |
| [Privacy](privacy.md) | For users: what PlanSwap reads, stores, changes and sends over the network (not credential rules for agents, which stay in AGENTS.md). |
| [User guide](user-guide.md) | Step-by-step user instructions: sidebar, setup, switching, usage limits, settings, troubleshooting. English is the source of the `zh-cn` / `zh-tw` / `es` / `ja` / `ko` translations (not behavior specs, contracts or verification). |
| [CHANGELOG](../CHANGELOG.md) | User-facing release history (not current plans or agent instructions). |

### For maintainers

| Document | Owns (not) |
|---|---|
| [Features](features.md) | Observable behavior of Claude/Codex flows, commands, tools and localization: what the user can see or do in the sidebar, status bar, commands, settings, notifications and the files the user is told about (not storage keys, message names, function or module names, signatures, upstream research or test records). |
| [Claude design](design.md) | Claude switching and shared UI architecture, data model (storage keys included), message protocol, algorithms, rationale, limitations, and the conclusions drawn from upstream facts (not the dated evidence itself, build steps, module inventories or acceptance scripts). |
| [Codex design](codex-design.md) | Codex switching, shell/env propagation, editor restart, sharing design, Codex storage keys, limitations, and the conclusions drawn from upstream facts (not the dated evidence itself, shared contracts or developer setup). |
| [Development](development.md) | Repository layout, setup, dependencies, build/test/package, release checks, localization terminology, editor troubleshooting (not feature specs or acceptance scripts). |
| [Manual verification](manual-verification.md) | Preview requirements, WSL acceptance setup, user-operated account checks, expected observations, cleanup (not results of checks; pending verification goes in TODO). |
| [TODO](../TODO.md) | Open work, missing evidence, deferred decisions, pending user actions (not verified behavior, acceptance results or release history). |

### Evidence and proposals

| Document | Owns (not) |
|---|---|
| Research: [Claude Code](research/claude-code.md), [Codex](research/codex.md), [Windows](research/windows.md), [Claude usage](research/claude-usage.md), [Account-read baseline](research/account-read-performance.md) | All dated upstream evidence: the numbered facts the designs rest on, each with its version and source, upstream and own measurements, and how each was obtained (source inspection or runtime check) (not design decisions, implemented behavior or real-account acceptance). |
| [Feature feasibility research](research/feature-feasibility.md) | Dated official-interface evidence and verification limits for proposed account workflow improvements. |
| [Feature expansion proposal](plans/feature-expansion.md) | Proposed delivery order, scope, acceptance criteria, and research gates (not implemented behavior or release commitments). |

### For agents

| Document | Owns (not) |
|---|---|
| [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md) | Agent rules, safety/implementation boundaries, commands, task routing (not a full architecture reference); CLAUDE.md imports AGENTS.md and adds only Claude Code-specific rules. |
| [Skills](../.agents/skills/) | Step-by-step agent procedures: devhost checks, preview layout checks, adding a user-visible string, releasing (not the rules, which stay in AGENTS.md, nor acceptance criteria, which stay in Manual verification). |
| [Document map](doc-map.md) | These tables and the documentation rules below. |

## Rules

- Contracts (signatures, per-module behavior, cross-module wiring) live in code: types and TSDoc, with cross-module wiring in the header of the module that does the wiring (e.g. `src/extension.ts`).
- When documents and code disagree, establish the intended behavior from the task, contracts and evidence, then determine which needs updating; do not change one merely to match the other.
- Update the document that owns a fact and link to it from others. When a change affects several layers (behavior, design, contracts), update every affected owner in the same change. Confirmed unused exports, fields and parameters may be removed together with any documentation of them.
- Features or design: a statement that needs a storage key, message name, function or module name belongs in a design document; Features describes only what can be observed and links to the design for the mechanism.
- Real-account acceptance results are not kept as records. When a check passes, remove its TODO item (or the passed part of it); a conclusion users rely on, such as which environments are accepted, becomes a sentence in README's Known limitations.
- Proposals (`plans/`) and research written only for a proposal (such as the feature feasibility research) are temporary. Once a proposal is implemented or abandoned, move what still holds to its owners (current behavior to Features and the designs, pending acceptance to TODO) and delete the proposal, its research and their rows here.
- Keep every critical agent safety constraint in AGENTS.md, even when its rationale or procedure lives elsewhere.
- Keep AGENTS.md short (Codex stops adding instruction files at 32 KiB in total, and longer files are followed less reliably): add a rule only after an agent repeated a mistake or for a new safety boundary, put what matters only to one module in that module's header comment, and when changing the file check it for outdated or conflicting rules (in Claude Code, `/doctor prompt-audit`).
- Upstream evidence lives in `docs/research/`, keeps its recorded version and source, and distinguishes source inspection from runtime verification; re-check affected facts after upgrades. A design document states the conclusion and the decision it leads to and links the evidence; a short "verified" note inside a design sentence may stay.
- A documentation reorganization does not by itself verify an old claim or TODO.
- Reconcile completed TODO items only during the pre-commit documentation check, against the verified commit scope; keep partially complete work with its remaining acceptance criteria.
- The translated user guides (`user-guide.<locale>.md`) are updated in the same change as `user-guide.md`. A new document gets a row in the tables above; a row linking a directory covers every file below it (`test/docs.test.ts` checks every file under `docs/`, subdirectories included).
