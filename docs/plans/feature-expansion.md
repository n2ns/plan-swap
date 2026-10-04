# Lightweight feature expansion proposal

Date: 2026-10-04. Status: proposal, not an implementation or release commitment.

## Objective and scope

Improve account selection, explain observed failures, and reduce the effort required to return to work while preserving PlanSwap's lightweight sidebar model. The user has already assigned restriction-aware recommendations for implementation; this plan does not modify or review that work.

Official sources, observation methods, and limitations are recorded in the [feasibility research](../research/feature-feasibility.md). Existing behavior remains owned by [Features](../features.md), [Claude design](../design.md), and [Codex design](../codex-design.md). Existing selected/effective state, cache freshness, diagnostics, and sharing behavior should be reused rather than presented as entirely new features.

This proposal excludes a proxy, credential synchronization, token injection, autonomous account rotation, and a replacement official client. Existing [account and restart safety rules](../../AGENTS.md) continue to apply.

## Delivery order

| Stage | Outcome | Feasibility and boundary |
|---|---|---|
| A: assigned work | Restriction-aware recommendations and account exclusions | Proceed within observed data; do not promise task completion or model access inferred from quota alone. |
| B | Quota reminders and actionable account recovery | Supported in principle; Codex has structured quota operations, while Claude idle-account observations retain integration uncertainty. |
| C | Project-preferred accounts | Use preferences for recommendation and explicit new terminal launch first. Do not imply existing official panels changed identity. |
| D | Recent-task recovery | Prefer documented client entry points; restrict recovery to accessible history and the correct workspace. |
| Research only | Reduce official-panel restart requirements | No sufficient public contract found for hot-switching an existing Codex IDE panel's account directory. |
| Deferred | Cross-device preferences | Reconsider only after local flows are validated; account credentials and running-task migration remain outside this proposal. |

## A. Restriction-aware recommendations

Use known quota windows, exclusions, freshness, and existing account state to explain why an account is recommended. Missing information must not count as unlimited quota. Read returned window durations rather than assuming every provider or bucket uses the same windows.

Acceptance criteria for the separately assigned work:

- A known exhausted applicable limit does not result in an unqualified available recommendation.
- Missing or stale observations remain distinguishable from fresh observations.
- Recommendation reasons describe the evidence used and avoid guarantees of remaining hours, request count, model access, or task completion.
- Claude and Codex account selection remain independent.

These are proposed acceptance boundaries, not findings about the current working tree. Any later review must establish its scope against the actual implementation.

## B. Quota reminders and recovery

Build on existing refresh results first. Avoid adding a second polling system solely to drive reminders. Distinguish three states: observed low quota, expected reset time, and recovery confirmed by a new observation. Deduplicate repeated reminders for the same observation and respect user dismissal until relevant state changes.

Display the source and age of observations where needed to explain uncertainty. A failed refresh must not turn stale data into a fresh result. An elapsed reset timer may invite refresh but must not claim confirmed recovery.

Offer recovery actions appropriate to known evidence, such as opening the official login flow or starting a new session with another selected account. Keep authentication with the official client. Do not equate credentials on disk or a separate probe's success with the identity and health of all open panels.

Claude `StopFailure` integration is optional follow-up work, not a dependency for the first delivery. It requires explicit configuration design, compatibility checks, and preservation of existing hooks. Do not capture conversation content to classify errors when the structured error type suffices.

Acceptance criteria:

- Fresh low-quota observations can produce a single relevant reminder; unchanged refreshes do not repeatedly notify.
- Missing windows, failed queries, and expired observations remain distinguishable from zero usage.
- Expected reset and confirmed recovery have different wording and transitions.
- Recovery actions target the intended vendor and account without copying credentials or silently changing running sessions.
- An unsupported upstream version results in an honest unavailable state or existing fallback, not invented success.

## C. Project-preferred accounts

Remember a user-selected preference per project and vendor. It affects recommendation and explicit terminal launch, using the existing account identity and path validation rather than an alias as the lookup key. Keep it separate from current/effective account state.

Start with the existing project/workspace identity conventions. Before implementation, settle multi-root workspace behavior and persistence ownership; do not silently treat one folder's preference as authoritative for every folder. A removed account leaves an unresolved preference with an explicit choice, not a silent switch to another account.

Acceptance criteria:

- A new terminal starts in the intended project with the intended account environment on WSL and native Windows.
- Changing a preference does not alter an already-running session or the other vendor's preference.
- Missing accounts are explained and aliases remain display-only.
- No project-local Claude setting is used to inject `CLAUDE_CONFIG_DIR`.

## D. Recent-task recovery

Start with metadata sufficient to identify the project, vendor, account context, and session. Prefer an explicitly captured session ID or a documented listing operation; transcript indexing and content synchronization are outside the initial scope.

For Claude, investigate the documented session URI. For Codex, start with interactive CLI resume. An official URI opening successfully is not proof that the intended conversation resumed: Claude may open a new conversation when the session is missing, or focus an existing tab without changing its account.

Acceptance criteria:

- Recovery targets the correct workspace and accessible account history.
- A missing or inaccessible session is not reported as successfully restored without confirmation.
- WSL and each supported editor have their routing behavior verified before enabling a panel recovery shortcut there; otherwise offer the supported terminal path.
- Recovery does not promise restoration of running tools, pending approvals, or arbitrary cross-account and cross-vendor state.
- No prompt is submitted automatically as a side effect of opening a task.

## Research gate for reducing restarts

Do not schedule an official-panel hot-switch feature until there is a supported way to address that panel's process and observe its resulting account state. Authentication operations on a separately launched app-server do not satisfy this requirement.

Evidence needed before a product commitment:

1. A documented integration contract, compatible with PlanSwap's credential boundaries and supported client versions.
2. Identification of which process and which existing sessions the action affects.
3. User-operated verification of account identity, token renewal, new-session behavior, and multiple windows on supported platforms.
4. An explicit outcome when the capability is unavailable, preserving existing restart guidance.

Do not substitute the development-only executable override or a self-hosted authentication platform for this gate. Lack of a documented route is recorded as unresolved, not as proof that all routes are impossible.

## Validation and handoff

For each approved implementation stage, first record supported upstream versions and turn its acceptance criteria into scoped checks. Use synthetic quota and account observations for automated validation. Use temporary homes and fake CLI/process inputs according to the repository rules.

Frontend changes require the repository's UI and preview checks. Real login, account switching, and restart acceptance remain user-operated as specified in [Manual verification](../manual-verification.md); agents must not test editor restart execution.

After implementation, update the documents that own the resulting behavior and translated user instructions. Track remaining work in [TODO](../../TODO.md) under its existing reconciliation rules. This proposal neither marks existing TODOs complete nor authorizes implementation, commit, installation, or release.

Current validation status: official-document feasibility reviewed; runtime compatibility and real-account acceptance not performed.
