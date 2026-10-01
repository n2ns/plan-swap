# Documentation

Each document owns a different kind of information. Read the sections relevant to the task; this index is not a requirement to load every document before each change.

## Responsibilities

| Document | Owns | Does not own |
|---|---|---|
| [README](../README.md) | Product introduction, requirements, installation, quick start, privacy and concise limitations for users. | Detailed module contracts or development procedures. |
| [User guide](user-guide.md) | Step-by-step sidebar instructions, account setup, switching, usage limits, settings and everyday troubleshooting for users. English is the source; [简体中文](user-guide.zh-cn.md), [Español](user-guide.es.md) and [日本語](user-guide.ja.md) translations, opened by the footer button in that UI language, must be updated in the same change. | Detailed behavior specifications, module contracts or verification procedures. |
| [Features](features.md) | Detailed observable behavior of Claude and Codex account flows, commands, tools and localization. | Function signatures, upstream research or test execution records. |
| [Claude design](design.md) | Claude switching and shared UI architecture, data model, algorithms, rationale, dated upstream evidence and limitations. | Build instructions, exhaustive module inventories or acceptance scripts. |
| [Codex design](codex-design.md) | Codex switching, shell/environment propagation, editor restart and sharing design, dated evidence and limitations. | Shared interface definitions or developer setup. |
| [Claude and shared interfaces](interfaces.md) | Module responsibilities, exact signatures, data types, message protocol and implementation invariants for Claude and shared host/frontend code. | Build/package commands or manual acceptance steps. |
| [Codex interfaces](codex-interfaces.md) | Codex module signatures and behavior contracts, plus Codex integration with shared modules. | Copies of the shared protocol, labels or panel definitions. |
| [Development](development.md) | Repository layout, setup commands, dependencies, build/test/package details, release checks and editor troubleshooting. | Product feature specifications or real-account acceptance scripts. |
| [Manual verification](manual-verification.md) | Preview requirements, WSL acceptance setup, user-operated account checks, expected observations and cleanup. | Claims that checks have passed; outstanding verification belongs in TODO. |
| [AGENTS.md](../AGENTS.md) | Concise project instructions, essential safety/implementation boundaries and task-specific document routes. | Cross-project preferences, full architecture reference or long checklists. |
| [CLAUDE.md](../CLAUDE.md) | Imports AGENTS.md and adds Claude Code-specific execution restrictions. | A second copy of the project documentation. |
| [TODO](../TODO.md) | Open work, evidence still needed, deferred decisions and pending user actions. | A specification of already verified behavior or release history. |
| [CHANGELOG](../CHANGELOG.md) | User-facing release history. | Current plans or agent instructions. |
| [Claude usage research](research/claude-usage.md) | Dated upstream evidence for the CLI and usage-cache route (output, cache fields, side effects, rate limiting) and the rejected status-line route. | Implemented behavior (owned by [Claude design 6.9](design.md#69-claude-usage-limits)) or completed real-account acceptance. |
| [Account-read baseline](research/account-read-performance.md) | Reproducible synthetic measurements, layer boundaries and optimization decision. | Real-account workload distribution or complete UI latency. |
| [Branding candidate notes](branding/candidates/) | Image-generation prompts and candidate design records. | Runtime behavior or coding rules. |

## Choose documents by task

- **Account behavior:** read Features and the relevant vendor's design; inspect its interface contract when changing module behavior.
- **Shared state, labels, messages or localization:** use the relevant sections of Interfaces. Codex interfaces references these shared definitions rather than redefining them.
- **Upstream compatibility:** use the background evidence and limitations in the vendor's design. Preserve the recorded version, source and distinction between source inspection and runtime verification; re-check affected assumptions after upgrades.
- **Development and packaging:** use Development. Consult its troubleshooting section only when the matching editor/environment problem occurs.
- **UI changes:** use Features and the shared UI/interface sections, then the applicable preview and WSL checks in Manual Verification. Layout evidence does not establish real-account behavior.
- **Outstanding work:** use TODO and follow the linked procedure or specification. A checklist is not a completed test report.

## Maintaining the documents

- Update the owner of a fact first. Other documents may give a short summary and link to it; keep full signatures, build procedures and numbered acceptance steps in their respective owners.
- Preserve critical agent safety constraints in AGENTS.md even when the detailed rationale or procedure lives elsewhere. Global communication/review preferences belong in the user's global instructions, not these project documents.
- When code and documentation disagree, establish the intended behavior from the task, contracts and evidence before changing either. A documentation reorganization does not by itself establish that an old claim or TODO has been verified.
- Update relevant behavior, design and interface documents together when a change affects those layers. Removing a confirmed unused interface also removes its contract entry.
- Keep links and section references valid when moving content. All repository documentation remains English under the project convention.
- Reconcile completed TODO items only during the pre-commit documentation check, against the verified commit scope; retain partially complete work and its remaining acceptance criteria.
