# Codex Module Interfaces

Purpose: Codex module responsibilities, signatures, state-file and restart contracts, and integration with the shared panel. Implementations must follow these contracts. Shared definitions remain in [Interfaces](interfaces.md); acceptance procedures are in [Manual Verification](manual-verification.md). See [Documentation](README.md) for ownership.

Companion design: docs/codex-design.md (v8). For shared parts (full signatures of `protocol.ts`, `labels.ts`, `accountsPanel.ts`, `i18n.ts`), docs/interfaces.md is authoritative; this document only lists the Codex side. All files: TypeScript strict, ESM imports, Node built-in modules with the `node:` prefix. The host only depends on `vscode` and Node built-ins. User-visible text always goes through `t()` from `src/i18n.ts` (English / Simplified Chinese, see docs/interfaces.md); where this contract quotes a message it gives the English text. The rc marker block is never localized.

## src/codex/codexPaths.ts (no vscode import)

```ts
export const CODEX_DEFAULT_NAME = 'default';
export const CODEX_DIR_BASENAME_RE = /^\.codex-[A-Za-z0-9_-]+$/;
export interface CodexAccount { name: string; dir: string }        // dir is an absolute path after path.resolve

export function codexDefaultDir(): string;                          // path.resolve(os.homedir(), '.codex'), ignores environment variables
export function codexAccountDir(name: string): string;              // path.resolve(os.homedir(), '.codex-' + name)
export function codexLoggedIn(dir: string): boolean;                // <dir>/auth.json exists
export interface CodexAccountInfo { email?: string; plan?: string; loggedIn: boolean }
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined; // only decodes the second JWT part (base64url → JSON), no signature check; any exception returns undefined
export function formatCodexPlan(planType?: string): string | undefined; // chatgpt_plan_type → capitalized (plus→Plus, pro→Pro, team→Team…), prolite→"Pro Lite"; empty returns undefined
export function readCodexAccountInfo(dir: string): CodexAccountInfo; // auth.json missing → { loggedIn: false }; present → loggedIn: true, and: auth_mode==='apikey', or auth_mode missing with non-empty OPENAI_API_KEY and no tokens → plan 'API key', no email; otherwise only the tokens.id_token payload is decoded for email and 'https://api.openai.com/auth'.chatgpt_plan_type (via formatCodexPlan); damaged JSON means unknown; never returns or logs the raw access_token/refresh_token/id_token
export function scanCodexDirs(): CodexAccount[];                    // real directories ~/.codex-* (not symlinks), excluding sameRealPath(codexDefaultDir())
export function ensureCodexDir(dir: string): void;                  // mkdir recursive 0700
export interface CopyResult { copied: string[]; skipped: Array<{ file: string; reason: string }> }
export function copyCodexSeed(fromDir: string, toDir: string): CopyResult;
//   Only copies config.toml (skipped when the target exists, reason "target already exists"; skipped when the source is missing or unreadable); written with 0600 and flag 'wx'.
//   Everything else of an independent account (AGENTS.md, hooks.json, rules/ hooks/ agents/ themes/, skills children) is copied by codexShare.copyCodexIndependent.
//   Blocked roots: forced_login_method / forced_chatgpt_workspace_id / sqlite_home / log_dir / model_provider / model_providers. config.toml is skipped when
//   a top-level key's first dotted segment is a blocked root (plain, "quoted" or 'quoted' keys, dotted keys such as model_providers.x.base_url, inline tables such as model_providers = { ... }),
//   or a table header ([t], [[t]]) has a blocked root as its first segment (e.g. [model_providers], [ model_providers.x ], ["model_providers".x]).
//   Line-based scan: whitespace around dots and quotes in keys and headers are normalized, leading whitespace allowed, # comment lines ignored, keys after any other table header are not top-level,
//   lines inside a multi-line value (array, inline table, `"""` / `'''` string) are skipped, so they are never read as keys or headers. The reason names the key ("top-level key <root>") or the normalized header ("[<header>] section"). Reasons are localized via t().
export function blockedConfigReason(text: string, roots?: readonly string[]): string | undefined; // the TOML scan above; roots defaults to the seed-copy list; codexShare passes CODEX_IDENTITY_CONFIG_KEYS + CODEX_IDENTITY_CONFIG_TABLES; returns the localized reason or undefined
export function checkCodexSafeToDelete(dir: string): string | undefined;  // localized refusal reason or undefined; rules in design 8.3 (direct child, basename, not the default directory by realpath, not a symlink, no live daemon)
export function codexDaemonAlive(dir: string, procRoot?: string): boolean; // the daemon check of design 8.3; missing file / parse failure returns false; a valid pid file with a missing procRoot returns true; procRoot defaults to '/proc' (tests pass a fake)
export async function deleteCodexDir(dir: string): Promise<void>;   // checkCodexSafeToDelete first, throw when unsafe; fs.promises.rm recursive force
```
`samePath` and `sameRealPath` are reused from `../paths` (already exported there).

## src/codex/codexShare.ts (shared vs independent Codex accounts, no vscode import)

Design in codex-design.md 8.6. Reuses `ShareReport` / `MigrateReport` and the link / merge helpers exported by `src/claudeShare.ts` (including `mergeLines` and `moveEntry`) (identical semantics; re-exports the two types), `blockedConfigReason`, `codexDaemonAlive`, `codexDefaultDir` and `copyCodexSeed` from `./codexPaths`. Every file-system test runs under `makeTempHome`.

```ts
export const CODEX_SHARED_ENTRIES: ReadonlyArray<{ name: string; kind: 'file' | 'dir' | 'link-only' }>;
//   file (created empty in ~/.codex when missing; hooks.json '{}\n'): config.toml, AGENTS.md, hooks.json, history.jsonl, session_index.jsonl
//   link-only (linked even when the target is missing, never pre-created): state_5.sqlite, thread_history_1.sqlite, goals_1.sqlite, queue_1.sqlite, .tmp/rollout-maintenance.lock
//   dir: sessions (marker), archived_sessions, rules, hooks, agents, themes, thread-writer-locks, rollout-migrations, attachments, generated_images, shell_snapshots, tui-thread-reference-capabilities
//   Nested entries ('.tmp/…') need a real parent folder in the account (created 0700); '.tmp' itself is never linked. .tmp/rollout-compression.lock is not shared (O_EXCL)
export const CODEX_CHILD_SHARED_DIRS: ReadonlyArray<{ dir: string; excludes: readonly string[] }>; // [{ dir: 'skills', excludes: ['.system'] }, { dir: 'plugins/cache', excludes: ['openai-curated-remote'] }]
export const CODEX_IDENTITY_CONFIG_KEYS: string[];   // model_provider, forced_login_method, forced_chatgpt_workspace_id, sqlite_home, log_dir, cli_auth_credentials_store, mcp_oauth_credentials_store, chatgpt_base_url, openai_base_url, profile, oss_provider
export const CODEX_IDENTITY_CONFIG_TABLES: string[]; // model_providers, profiles
// config.toml is not linked (reported in `refused`) when the default config is unreadable or blockedConfigReason(text, [...KEYS, ...TABLES]) finds one

export function isSharedCodexAccount(dir: string): boolean;   // <dir>/sessions is a symlink and realpath equals realpath(~/.codex/sessions); the default dir → false
export function ensureCodexLinks(dir: string): ShareReport;    // idempotent create/repair like ensureClaudeLinks; in an already shared account a regular history.jsonl / session_index.jsonl is merged back with claudeShare.mergeLines (lines the default lacks appended, account file removed) and relinked (reported under linked); a regular sqlite db stays a conflict; the default dir → empty report
export function codexAccountBusy(dir: string, procRoot?: string): boolean; // codexDaemonAlive(dir), or a <procRoot>/<pid> whose exe basename is 'codex' (' (deleted)' stripped) and whose environ CODEX_HOME resolves to dir (for the default dir: unset, empty or ~/.codex); unreadable entries skipped; an unreadable procRoot → true; environ alone never matches; procRoot defaults to '/proc'
export function migrateCodexToShared(dir: string, accountName: string, procRoot?: string): MigrateReport; // throws Error(t('share.busyCodex', { name: accountName })) when busy; dirs merged recursively; history.jsonl / session_index.jsonl lines merged; config.toml / AGENTS.md / hooks.json / .tmp/rollout-maintenance.lock: moved into ~/.codex when it lacks the file (a config.toml with identity keys/tables stays, unlinked), identical dropped, else '<name>.independent-backup' (config.toml stays when the default is refused); sqlite dbs renamed with -wal / -shm to '<name>.independent-backup' (+ suffixes); skills / plugins/cache children merged; nested entries only inside a real account folder; ends with ensureCodexLinks(dir)
export function makeCodexIndependent(dir: string): { removed: string[]; copied: string[]; skipped: Array<{ file: string; reason: string }> }; // throws Error(t('unshare.default', { dir })) for ~/.codex and Error(t('unshare.notShared', { dir })) when not shared; uses claudeShare.unlinkIfLinksTo / unlinkChildLinks (linksTo compares real paths; regular files and links resolving elsewhere stay; link-only links removed even when dangling; nested entries only inside a real folder): first config.toml, AGENTS.md, hooks.json, the INDEPENDENT_COPY_DIRS and the skills/ children, then copyCodexIndependent(dir), then history, session_index, the databases, the sessions marker, the other folders and the plugins/cache children — a failed copy leaves the account shared and ensureCodexLinks re-creates the missing links; auth.json and memories untouched
export function copyCodexIndependent(dir: string): { copied: string[]; skipped: Array<{ file: string; reason: string }> }; // copyCodexSeed(~/.codex, dir) + AGENTS.md, hooks.json (0600) + rules/ hooks/ agents/ themes/ (a linked folder is copied from its real location) + skills children except .system; never overwrites; no symlinks followed inside copied folders; skipped comes from copyCodexSeed
```
Never touched by this module: `auth.json` and the other per-account entries listed in codex-design.md 8.6.

## src/codex/codexState.ts (no vscode import)

```ts
export const STATE_FILE = () => path.join(os.homedir(), '.config', 'planswap', 'codex-home');
export function readSelectedDir(): string | undefined;             // state file content trimmed; non-empty → path.resolve; missing/empty → undefined
export function writeSelectedDir(dir: string | undefined): void;  // atomic write: directory 0700, temporary file 0600 + fsync + rename + directory fsync; undefined writes an empty file
export function effectiveDir(): string;                            // process.env.CODEX_HOME non-empty → path.resolve(it), otherwise codexDefaultDir()

export const RC_BEGIN = '# >>> planswap codex >>>';
export const RC_END = '# <<< planswap codex <<<';
export function rcBlock(): string;                                 // the block from design section 4 (with both markers, trailing newline); never localized
export interface RcFileStatus { file: string; hasBlock: boolean; broken: boolean; hasUserExport: boolean }
export function rcStatus(): RcFileStatus[];                        // checks ~/.profile and ~/.bashrc; hasUserExport = /^\s*export\s+CODEX_HOME=/ outside the marker block; broken = start marker without end marker (block damaged by hand)
export interface PreCheck { ok: boolean; reasons: string[] }
export function preCheck(): PreCheck;                              // pre-checks 1–3 of design section 4 (SHELL is bash; bash_profile/bash_login missing or containing ".bashrc"; no user export); a broken file is also reported (manual fix required); no modal confirmation; reasons localized via t()
export function installRcBlocks(): void;                           // writes both files: in ~/.bashrc before the interactive guard (/^\s*case\s+\$-\s+in/), appended at the end when not found; appended at the end of ~/.profile (after a blank line when the file ends with a newline, after only the missing newline otherwise); skipped when a block exists; keeps the original mode, missing files created with 0644; atomic write (temporary file + rename) to the symlink target
export function removeRcBlocks(): void;                            // removes both blocks by their markers (including marker lines and the blank line, or the missing trailing newline, added on installation, so install + remove restores the original bytes of a file that existed before; a file created by the installation is left empty); does nothing without a block; computes both files first: a start marker without end marker in any file → throw Error (localized reasons of all such files combined) without changing either file; atomic write through the symlink target, mode kept
export function removeRcBlockFrom(file: string): void;             // the same removal for a single file (enable rollback): throws without changing the file when an end marker is missing; same atomic, symlink-following write as installRcBlocks
export function migrateLegacyCodex(): boolean;                     // migrates the pre-rename ai-switcher setup (design section 4): when ~/.bashrc or ~/.profile has a '# >>> ai-switcher codex >>>' block, checks both files first (legacy start marker without end marker → throw Error, localized codex.rc.missingEnd reasons combined, nothing written), copies ~/.config/ai-switcher/codex-home to STATE_FILE when STATE_FILE is missing (writeSelectedDir; empty content → empty file), replaces each legacy block in place by rcBlock() (dropped together with the blank line or newline added before it when the file already has a current block; writeRc: atomic, symlink target, mode kept), deletes the legacy state file and rmdir its folder (errors ignored); returns true when a legacy block was found, false (nothing touched) otherwise
export function selfCheck(): { ok: boolean; detail: string };      // creates a temporary empty directory + temporary state file content pointing to it, spawnSync('bash', ['-i','-l','-c','printf %s "$CODEX_HOME"'], {timeout: 10000}), compares the output; restores the original state file and deletes the temporary directory whether it succeeds or not
```
Note: selfCheck must first back up the original state file content (which may not exist) and restore it afterwards exactly (deleting it if it did not exist).

## src/codex/codexServer.ts (no vscode import)

```ts
export type ServerKind = 'antigravity' | 'vscodium' | 'vscode' | 'unknown';
export interface ServerPlan { serverPid: number; children: number[]; commit: string }
export function parseStatParentPid(statText: string): number;      // field 4 (parent pid) of /proc/<pid>/stat, parsed after the last ')' (comm may contain spaces and parentheses); throws when unparsable
export function parseServerRoot(argv: string[]): string | undefined; // the path before `/out/server-main.js` (first argument ending with it, suffix stripped); undefined if absent
export function classifyDataDir(dataDir: string, home: string): ServerKind; // whitelist; dataDir must be <name> directly under home (symlinks resolved): .antigravity-ide-server / .antigravity-server → 'antigravity', .vscodium-server → 'vscodium', .vscode-server → 'vscode', otherwise 'unknown'
export function detectServerKind(): ServerKind;                    // readArgv(process.ppid) → root → dataDir (the parent of root must be named `bin`; dataDir is its parent) → classifyDataDir(dataDir, os.homedir()); never throws, any failure → 'unknown'
export function canAutoRestart(kind: ServerKind): boolean;         // true only for 'antigravity' and 'vscodium'
export function readServerCommit(root: string): string;            // top-level `commit` of <root>/product.json; must be 40 lowercase hex, else throws t('server.noCommit')
export function readArgv(pid: number): string[];                   // /proc/<pid>/cmdline split on \0 (empty entries dropped), so arguments may contain spaces
export function verifyServer(argv: string[], wrapperPid: number, home: string): string; // checks 2–5 below for an auto-restartable server; returns the commit; only reads product.json and the pid file
export function listChildren(parentPid: number): number[];         // numeric /proc entries with ppid === parentPid, excluding process.pid
export function planRestart(): ServerPlan;   // check 1, reads the wrapper pid from /proc/<ppid>/stat, then verifyServer(readArgv(ppid), wrapperPid, os.homedir()); any failure → throw Error(localized reason). children are the processes in /proc with ppid === serverPid and pid !== process.pid
export function executeRestart(plan: ServerPlan): void; // process.kill(serverPid,'SIGTERM'), then process.kill(pid,'SIGTERM') for each child (ESRCH and EPERM ignored, other errors thrown). No waiting. Throws Error(t('ext.linuxOnly')) without signaling when process.platform is not 'linux'. Only after a modal confirmation by the user; never in tests
```
`planRestart` checks, in order (each failure throws the localized error in parentheses):
1. `process.ppid <= 1` (`server.notFound`);
2. the root is parsed from argv, its parent directory is named `bin`, argv contains `--start-server`, and `canAutoRestart(classifyDataDir(dataDir, home))` (`server.unsupported` with `{cmdline}` = the first 120 characters of the space-joined argv: "Parent process is not a WSL server that supports automatic restart: {cmdline}");
3. `commit = readServerCommit(root)` (`server.noCommit`: "Cannot read the server commit from product.json");
4. `basename(root) === commit` or it ends with `-<commit>` (`server.noCommit`);
5. the pid file `<dataDir>/.<commit>.pid` is readable (`server.pidReadFailed` `{file}`) and equals the wrapper pid, i.e. field 4 of `/proc/<ppid>/stat` (`server.pidMismatch`).

Field 4 of `/proc/<ppid>/stat` is the parent pid (note that the comm field can contain spaces and parentheses, so parse after the last `)`). `server.statUnparseable` is kept. `parseCommitFromCmdline`, `readCmdline` and the former `server.notAntigravity` key are removed.

## src/codex/codexStore.ts (imports vscode only for the Memento type)

Same shape as `AccountStore` in `src/accounts.ts`, with the keys `codex.accounts` and `codex.ignoredDirs`, the default account `{ name: CODEX_DEFAULT_NAME, dir: codexDefaultDir() }`, and scanning via `scanCodexDirs()`. Class name `CodexAccountStore`, methods: `named() all() find(name) findByDir(dir) add(a) remove(name) unignore(dir) syncWithDisk(labels?)`. `unignore(dir: string): Promise<void>` removes `dir` from `codex.ignoredDirs` (called after `deleteCodexDir` succeeds, so a recreated directory is discovered again). `syncWithDisk(labels?: LabelStore): Promise<void>` first prunes named entries whose directory no longer exists (`!fs.existsSync(dir)`; their alias is cleared with `labels?.remove(name)`, and the directory is not added to `codex.ignoredDirs`), then registers scanned directories, skipping names equal (`sameName`, case-insensitive) to `default`, to the name of a remaining registered Codex account or, with `labels`, to its `labelFor(a.name, labels)` (callers pass the Codex `LabelStore`); it saves only when something changed.

## src/protocol.ts

Full definition in docs/interfaces.md. Used on the Codex side: `PanelMode = 'codex'`; `PanelState.codex: TabState` (`enabled` means both rc files have the marker block; `pendingDir` is the display name when the directory in the state file differs from the directory effective in this window, the path for an unregistered directory); `PanelState.locale` (shared by both pages); `AccountView.email` / `plan` are filled by `readCodexAccountInfo` (`plan` is `'API key'` in API key mode), `AccountView.shared` by `isSharedCodexAccount` for named rows; `add` carries `shared`, `share` converts an independent account; `enable` / `restartServer` of `FromWebview` only make sense for codex, `reload` / `dismissBanner` are ignored for codex; `rename` (with `dir`, `label`) and `renameResult` (with `dir`, optional `error`) are shared by both pages and dispatched by `mode`.

## src/accountsPanel.ts

Single instance, signatures in docs/interfaces.md. The Codex side only provides a data source:

```ts
// src/codex/codexCommands.ts
export function codexPanelSource(store: CodexAccountStore, labels: LabelStore): PanelSource;
//   accounts(): maps store.all() (kind, name, label via labelFor(a.name, labels), dir, dirLabel, ...readCodexAccountInfo(dir), isCurrent = samePath(dir, effectiveDir()), shared = isSharedCodexAccount(dir) for named rows, undefined for default);
//              when effectiveDir() does not correspond to any account, appends a current row with kind='external' (name EXTERNAL_NAME, label labelFor(EXTERNAL_NAME, labels), also using readCodexAccountInfo).
//   enabled(): rcStatus() reports hasBlock for both files.
//   pendingDir(): when readSelectedDir() ?? codexDefaultDir() differs from effectiveDir(), returns the display name of that directory's account, or the path if unregistered; undefined when equal.
//   watchTargets(): <dir>/auth.json of each row + STATE_FILE().
```
Messages with `mode === 'codex'` are dispatched to `panel.setHandler('codex', ...)`; `panel.resolve('codex', dir)`, `panel.accounts('codex')`, `panel.focusAdd('codex')`.

## src/webview/main.ts

When the top tab bar switches to Codex, the page is rendered from `state.codex`, with all texts from `src/webview/i18n.ts` in `state.locale`:
- `!enabled`: only the explanation (design section 7) and the "Enable Codex switching" button (sends `{type:'enable', mode:'codex'}`) plus the "Tools" row are rendered; the other blocks are hidden.
- No reload banner; when `pendingDir` is set, the top shows "X selected; takes effect after restarting the server" with a "Restart server" button (sends `{type:'restartServer', mode:'codex'}`); the add section's help text uses `~/.codex-<name>`; the sign-in button's title is "Run codex login in a terminal"; the terminal icon's title is "Run codex with this account in a terminal"; the signed-out hint is `Click "Log in" to log in from a terminal, or switch and log in from the Codex panel`.
- Current and other rows: email and `plan` when there is an `email`; "Logged in" when `loggedIn` without `email`; "Not logged in" when signed out.
- Pencil renaming of named account rows (not the default or external row) works as on the Claude page (`rename` with `dir`, `label`, edit state keyed by `dir`), with messages carrying `mode:'codex'`.
- The "Tools" row shows `AGENTS.md`, the Codex extension settings, "Re-link" and "Update CLI" (`tool` messages with `mode:'codex'`; syncing sends `tool:'sync'`, updating `tool:'updateCli'`).
- The add section's shared checkbox, the shared badge and the "Link to the default account: …" row button work as on the Claude page (`add` with `shared`, `share` with `dir`, `mode:'codex'`).
- Claude page behavior is unchanged.

## src/codex/codexCommands.ts (imports vscode)

```ts
export interface CodexDeps { store: CodexAccountStore; panel: AccountsPanel; labels: LabelStore; tools: ToolDeps } // labels is codex.labels; tools is passed to runTool for Codex page tool messages
export function registerCodexCommands(deps: CodexDeps): vscode.Disposable[];
export function validateName(name: string, store: CodexAccountStore, labels: LabelStore): string | undefined; // exported so it can be unit-tested
export function codexPanelSource(store: CodexAccountStore, labels: LabelStore): PanelSource;
export async function restartServerInteractive(): Promise<void>; // "Restart WSL Server" with modal confirmation, shared by the panel banner button, the Command Palette and the footer toolbar (ToolDeps.codexRestart)
```
Command ids and behavior in design section 8. QuickPick items, messages and terminal names always use `labelFor(a.name, labels)`; all texts come from `t()`. `validateName` compares the reserved `default`, existing Codex account names and display names case-insensitively (`sameName`), and adds "equals `labelFor(a.name, labels)` of any Codex account → 'Same as an existing account's display name'" (only Codex accounts are checked; the same name as on the Claude side is allowed). Panel messages (`panel.setHandler('codex', ...)`): `enable` → if preCheck fails, showErrorMessage(reasons); otherwise modal confirmation (showing rcBlock() verbatim) → installRcBlocks → selfCheck; on failure only the files newly written in this run are rolled back with `removeRcBlockFrom` (files that already had a block before enabling are left alone) and an error is shown → refresh. `add` (with `shared = msg.shared !== false`) → validateName → ensureCodexDir (failure → "Failed to create account directory: <reason>" in `addResult`) → shared: `ensureCodexLinks(dir)` (a non-empty `describeShareReport` → `showWarningMessage(t('share.addNotes'))`); independent: `copyCodexIndependent(dir)`, and a message is shown only when a file was skipped because of a blocked key/section (a missing source, an existing target and similar cases are silent); an exception of this step only shows `t('share.addLinkFailed' | 'share.addCopyFailed')` → store.add; the result is `post({ type: 'addResult', mode: 'codex', error })`. `share` → `panel.resolve('codex', dir)` with `kind === 'named'`; ignored for `default` or an already shared account; the effective or selected account → `showWarningMessage(t('share.current'))`; modal `t('share.confirmCodex', { label, dir })` with `t('share.confirmButton')`; `codexAccountBusy(dir)` → `showWarningMessage(t('share.busyCodex'))`; `migrateCodexToShared(dir, account.name)` → `t('share.done')` with `describeShareReport` (or `t('share.nothingElse')`); an exception → `showErrorMessage(t('share.failed'))`; then `panel.refresh()`. `rename` → `panel.resolve('codex', dir)` finds the row with `kind === 'named'` (otherwise ignored; the default and external rows cannot be renamed) → `labels.validate(label, account.name, store.all().map(a => ({ name: a.name, label: labelFor(a.name, labels) })))`; on error `post({ type: 'renameResult', mode: 'codex', dir, error })`, otherwise `labels.set(account.name, <trimmed value>)` (entry deleted when it equals `account.name`) → `panel.refresh()` → `post({ type: 'renameResult', mode: 'codex', dir })`. `remove` also calls `labels.remove(name)` besides `store.remove(name)` (the display name for the delete-directory prompt and `isSharedCodexAccount(dir)` are taken before that; the prompt's detail is `t('share.removeDirDetail')` for a shared account, otherwise `t('codex.removeDirDetail')`), and `store.unignore(dir)` after `deleteCodexDir` succeeds. `switch` → 8.1 (after the modal confirmation, a shared target is re-linked with `ensureCodexLinks`; a report or an error only shows `t('share.refreshWarning')`); while a switch is in progress (e.g. its modal is open) further switch requests (panel double click, Command Palette) are ignored. `switch` for a manual kind: the manual method is only shown in the confirmation (`codex.switchConfirmManual`); after writing the state file no further warning is shown. `restartServer` → restartServerInteractive: kind = detectServerKind(); manual kind (`!canAutoRestart(kind)`) → showWarningMessage(t('codex.manualRestartRequired', {hint})) directly, no modal; otherwise modal confirmation `codex.restartConfirm` {editor}, then planRestart/executeRestart; when planRestart throws, showWarningMessage(reason + manualHint(kind)). Editor display name for a kind: `antigravity` → "Antigravity", `vscodium` → "VSCodium", `vscode` → "VS Code" (a `Record<ServerKind, string>`, so a new kind cannot be left out; not localized). `manualHint(kind)`: `antigravity`/`vscodium` → `codex.manualRestartHint` {editor}, `vscode` → `codex.manualRestartHintVscode`, `unknown` → `codex.manualRestartHintUnknown`. `switch` confirmation: auto kind → `codex.switchConfirm` {editor}, manual kind → `codex.switchConfirmManual` {hint}; after writing the state file `restart()` shows `codex.manualRestartRequired` for manual kinds and returns false without signaling anything. `terminal`/`remove` follow the Claude logic but use the codex modules. `tool` → `runTool('codex', msg.tool, tools)`. `reload`/`dismissBanner` are ignored for codex. `planswap.codex.addAccount` → `panel.focusAdd('codex')`.

## src/extension.ts

See docs/interfaces.md: before the Codex store is created, `migrateLegacyCodex()` runs in its own try/catch (an error only shows the localized warning `ext.codexLegacyFailed`, Codex initialization continues). A single `AccountsPanel` whose `sources.codex` is `codexPanelSource(codexStore, codexLabels)`; when Codex initialization fails it degrades to an empty source (`enabled: () => false`), Claude is not affected, and `tool` messages of the Codex page still go through `runTool('codex', …)`; otherwise `registerCodexCommands({ store, panel, labels: codexLabels, tools })`, `ToolDeps.codexRestart` is `restartServerInteractive` and `ToolDeps.codexShareOps` is `{ isShared: isSharedCodexAccount, refresh: ensureCodexLinks }` (undefined when Codex is not initialized).

## package.json

- `viewsContainers.activitybar[0].title` and the view name are both "PlanSwap" (`%key%` placeholders; "PlanSwap" in `package.nls.zh-cn.json`).
- `views.planswap` has a single view `{ type: 'webview', id: 'planswap.accounts', name: <"PlanSwap"> }`; Codex is a tab inside that view and has no view id of its own.
- `commands` contains 7 `planswap.codex.*` entries (category "Codex Account", "Codex 账号" in Chinese; titles from `package.nls*.json`); the refresh button in `view/title` has `when: view == planswap.accounts`, and the existing `planswap.refresh` refreshes both stores and both pages.
