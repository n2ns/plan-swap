# Codex Module Interfaces

Purpose: Codex module responsibilities, signatures, state-file and restart contracts, and integration with the shared panel. Implementations must follow these contracts. Shared definitions remain in [Interfaces](interfaces.md); acceptance procedures are in [Manual Verification](manual-verification.md). See [Documentation](README.md) for ownership.

Companion design: docs/codex-design.md (v8). For shared parts (full signatures of `protocol.ts`, `labels.ts`, `accountsPanel.ts`, `i18n.ts`), docs/interfaces.md is authoritative; this document only lists the Codex side. All files: TypeScript strict, ESM imports, Node built-in modules with the `node:` prefix. The host only depends on `vscode` and Node built-ins. User-visible text always goes through `t()` from `src/i18n.ts` (English / Simplified Chinese / Spanish / Japanese, see docs/interfaces.md); where this contract quotes a message it gives the English text. The rc marker block is never localized.

## src/codex/codexPaths.ts (no vscode import)

```ts
export const CODEX_DEFAULT_NAME = 'default';
export const CODEX_DIR_BASENAME_RE = /^\.codex-[A-Za-z0-9_-]+$/;
export interface CodexAccount { name: string; dir: string }        // dir is an absolute path after path.resolve

export function codexDefaultDir(): string;                          // path.resolve(os.homedir(), '.codex'), ignores environment variables
export function codexAccountDir(name: string): string;              // path.resolve(os.homedir(), '.codex-' + name)
export function codexLoggedIn(dir: string): boolean;                // <dir>/auth.json exists
export interface CodexAccountInfo { email?: string; plan?: string; loggedIn: boolean; identity?: string } // identity: opaque comparison key, never displayed, logged, persisted or sent to the Webview
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined; // only decodes the second JWT part (base64url → JSON), no signature check; any exception returns undefined
export function formatCodexPlan(planType?: string): string | undefined; // chatgpt_plan_type → capitalized (plus→Plus, pro→Pro, team→Team…), prolite→"Pro Lite"; empty returns undefined
export function readCodexAccountInfo(dir: string): CodexAccountInfo; // auth.json missing → { loggedIn: false }; present → loggedIn: true, and: auth_mode==='apikey', or auth_mode missing with non-empty OPENAI_API_KEY and no tokens → plan 'API key', no email; otherwise only the tokens.id_token payload is decoded for email and 'https://api.openai.com/auth'.chatgpt_plan_type (via formatCodexPlan); damaged JSON means unknown; identity from the same payload: user ('https://api.openai.com/auth'.chatgpt_user_id, else .user_id, else top-level sub) + workspace (.chatgpt_account_id), only when both exist, never from the email, none in API key mode (design section 6); never returns or logs the raw access_token/refresh_token/id_token
export function scanCodexDirs(): CodexAccount[];                    // real directories ~/.codex-* (not symlinks), excluding sameRealPath(codexDefaultDir())
export function ensureCodexDir(dir: string): void;                  // mkdir recursive 0700
export interface CopyResult { copied: string[]; skipped: Array<{ file: string; reason: string }> }
export function copyCodexSeed(fromDir: string, toDir: string): CopyResult;
//   Only copies config.toml (skipped when the target exists, reason 'Target already exists'; skipped when the source is missing or unreadable); written with 0600 and flag 'wx'.
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
// config.toml is not linked (reported in `refused`) when the default config is unreadable or blockedConfigReason(text, [...KEYS, ...TABLES]) finds one;
// an existing account link to the default config.toml is then removed (no copy; a regular file or a link elsewhere stays)

export function isSharedCodexAccount(dir: string): boolean;   // <dir>/sessions is a symlink and realpath equals realpath(~/.codex/sessions); the default dir → false
export function ensureCodexLinks(dir: string, options?: LinkOptions, procRoot?: string): ShareReport;    // idempotent create/repair like ensureClaudeLinks; in an already shared account a regular history.jsonl / session_index.jsonl is merged back with claudeShare.mergeLines and relinked, unless codexAccountBusy(dir, procRoot) or options.busy?.() reports busy; a regular sqlite db stays a conflict; on win32 the *.sqlite entries are never linked and an existing link to the default db is removed by removeWindowsSqliteLink (reported under refused, or busy when a side file is in use); procRoot defaults to '/proc' and is a test seam; the default dir → empty report
export function removeWindowsSqliteLink(link: string, target: string): 'removed' | 'busy' | 'none'; // linksTo(link, target) → side files (-wal, -shm) renamed to '<file>.windows-link-backup' (freeName), then the link unlinked; a failed rename undoes the others → 'busy'; not such a link → 'none'. Also used first by makeCodexIndependent on win32 ('busy' → Error(t('share.busyCodex'))); migrateCodexToShared keeps the account's databases there instead of backing them up
export function codexAccountBusy(dir: string, procRoot?: string): boolean; // codexDaemonAlive(dir), or a <procRoot>/<pid> whose exe basename is 'codex' (' (deleted)' stripped) and whose environ CODEX_HOME resolves to dir (for the default dir: unset, empty or ~/.codex); unreadable entries skipped; an unreadable procRoot → true; environ alone never matches; procRoot defaults to '/proc'; on win32 with the default procRoot only codexDaemonAlive(dir) (the host adds its own open-terminal check)
export function migrateCodexToShared(dir: string, accountName: string, procRoot?: string, options?: LinkOptions): MigrateReport; // throws Error(t('share.busyCodex', { name: accountName })) when codexAccountBusy reports busy; dirs merged recursively; history.jsonl / session_index.jsonl lines merged; `moved` counts files moved into ~/.codex and jsonl files that contributed at least one line; config.toml / AGENTS.md / hooks.json / .tmp/rollout-maintenance.lock: moved into ~/.codex when it lacks the file (a config.toml with identity keys/tables stays, unlinked), identical dropped, else '<name>.independent-backup' (config.toml stays when the default is refused); sqlite dbs renamed with -wal / -shm to '<name>.independent-backup' (+ suffixes); skills / plugins/cache children merged; nested entries only inside a real account folder; ends with ensureCodexLinks(dir, options, procRoot)
export function makeCodexIndependent(dir: string, accountName: string, procRoot?: string): { removed: string[]; copied: string[]; skipped: Array<{ file: string; reason: string }> }; // throws Error(t('unshare.default', { dir })) for ~/.codex, Error(t('unshare.notShared', { dir })) when not shared and Error(t('share.busyCodex', { name: accountName })) when codexAccountBusy(dir, procRoot) (procRoot defaults to '/proc'); uses claudeShare.unlinkIfLinksTo / unlinkChildLinks (linksTo compares real paths; regular files and links resolving elsewhere stay; link-only links removed even when dangling; nested entries only inside a real folder): first config.toml, AGENTS.md, hooks.json, the INDEPENDENT_COPY_DIRS and the skills/ children, then copyCodexIndependent(dir), then history, session_index, the databases, the sessions marker, the other folders and the plugins/cache children — a failed copy leaves the account shared and ensureCodexLinks re-creates the missing links; auth.json and memories untouched
export function copyCodexIndependent(dir: string): { copied: string[]; skipped: Array<{ file: string; reason: string }> }; // copyCodexSeed(~/.codex, dir) + AGENTS.md, hooks.json (0600) + rules/ hooks/ agents/ themes/ (a linked folder is copied from its real location) + skills children except .system (a linked child likewise from its real location; a dangling child link is skipped); never overwrites; no symlinks followed inside copied folders; skipped comes from copyCodexSeed
```
Never touched by this module: `auth.json` and the other per-account entries listed in codex-design.md 8.6.

## src/codex/codexState.ts (no vscode import)

```ts
export const STATE_FILE = () => path.join(os.homedir(), '.config', 'planswap', 'codex-home');
export function readSelectedDir(): string | undefined;             // state file content trimmed; non-empty → path.resolve; missing/empty → undefined
export function writeSelectedDir(dir: string | undefined): void;  // atomic write: directory 0700, temporary file 0600 + fsync + rename + directory fsync; undefined writes an empty file
export function writeSelection(dir: string | undefined, run?: Runner): void; // platform-aware managed selection; Windows writes the user variable first and rolls it back if the state-file write fails
export function effectiveDir(): string;                            // process.env.CODEX_HOME non-empty → path.resolve(it), otherwise codexDefaultDir()

export const RC_BEGIN = '# >>> planswap codex >>>';
export const RC_END = '# <<< planswap codex <<<';
export function rcBlock(): string;                                 // the block from design section 4 (with both markers, trailing newline); never localized
export interface RcFileStatus { file: string; hasBlock: boolean; broken: boolean; hasUserExport: boolean }
export function rcStatus(): RcFileStatus[];                        // checks ~/.profile and ~/.bashrc; hasUserExport = /^\s*export\s+CODEX_HOME=/ outside the marker block; broken = start marker without end marker (block damaged by hand)
export interface PreCheck { ok: boolean; reasons: string[] }
export function preCheck(run?: Runner): PreCheck;                  // pre-checks 1–3 of design section 4 (SHELL is bash; bash_profile/bash_login missing or containing ".bashrc" on a non-comment line; no user export); on Windows uses strict user-variable reads; a broken file is also reported (manual fix required); no modal confirmation; reasons localized via t()
export function installRcBlocks(): void;                           // writes both files: in ~/.bashrc before the interactive guard (/^\s*case\s+\$-\s+in/), appended at the end when not found; appended at the end of ~/.profile (after a blank line when the file ends with a newline, after only the missing newline otherwise); skipped when a block exists; keeps the original mode, missing files created with 0644; atomic write (temporary file + rename) to the symlink target; a dangling symlink is never replaced by a regular file: throws Error(t('codex.rc.danglingLink', { file })) before anything is written (the removal and migration functions read a dangling link as a missing file and leave it alone)
export function removeRcBlocks(): void;                            // removes both blocks by their markers (including marker lines and the blank line, or the missing trailing newline, added on installation, so install + remove restores the original bytes of a file that existed before; a file created by the installation is left empty); does nothing without a block; computes both files first: a start marker without end marker in any file → throw Error (localized reasons of all such files combined) without changing either file; atomic write through the symlink target, mode kept
export function removeRcBlockFrom(file: string): void;             // the same removal for a single file (enable rollback): throws without changing the file when an end marker is missing; same atomic, symlink-following write as installRcBlocks
export function migrateLegacyCodex(): boolean;                     // migrates the pre-rename ai-switcher setup (design section 4): when ~/.bashrc or ~/.profile has a '# >>> ai-switcher codex >>>' block, checks both files first (legacy start marker without end marker → throw Error, localized codex.rc.missingEnd reasons combined, nothing written), copies ~/.config/ai-switcher/codex-home to STATE_FILE when STATE_FILE is missing (writeSelectedDir; empty content → empty file), replaces each legacy block in place by rcBlock() (dropped together with the blank line or newline added before it when the file already has a current block; writeRc: atomic, symlink target, mode kept), deletes the legacy state file and rmdir its folder (errors ignored); returns true when a legacy block was found, false (nothing touched) otherwise
export function selfCheck(): { ok: boolean; detail: string };      // creates a scratch directory beside STATE_FILE under the PlanSwap config directory and temporarily selects it, then runs bash -i -l; cleanup restores/removes the old state only while it still selects that scratch directory, preserving a concurrent selection, and removes the scratch with non-recursive rmdir so unexpected contents are left in place
```
Note: selfCheck first backs up the original state file content (which may not exist). It restores that value through `writeSelectedDir`, or deletes a newly created state file, only if another window has not changed the selection meanwhile.

## src/codex/codexWindows.ts (no vscode import)

- `ENV_NAME`, `SELF_CHECK_NAME` (`PLANSWAP_SELF_CHECK`), `Runner`, `decodeEnvOutput(out)`, `getUserEnv(name, run?, strict?)` (PowerShell `GetEnvironmentVariable(name, 'User')` printed as base64 UTF-8, independent of the console code page; ordinary mode maps unset, empty or failure to `undefined`, while strict mode throws on failure), `setUserEnv(name, value | undefined, run?)`, `getUserCodexHome(run?, strict?)` and `setUserCodexHome(value, run?)`. Names and values are passed through child environment variables, never on the command line. `codexState` exports `selfCheckWindows(run?)` and `disableWindows(run?)` (see Codex design 9a).
- `codexState` adds `writeSelection(dir, run?)` (elsewhere the state file only; on Windows it throws `codex.notEnabled` unless the state file exists, strictly reads the previous value, sets the user variable first, then writes the state file and restores the variable if that fails), `isEnabled()`, `enableWindows(run?)` (keeps an existing file; adopts a `~/.codex-<name>` variable), `disableWindows(run?)` (strictly reads first, then removes the managed variable and state file), `removeWindowsState()` (enable rollback: state file only); `preCheck` and `selfCheck` branch on Windows. `codexCommands.manualRestartMessages(kind, remoteName, windows?)` returns the quit-and-relaunch guidance for a local Windows editor.

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

## src/codex/codexUsage.ts (no vscode import)

Usage limits through the official CLI (design 8.7, facts 24-26). PlanSwap never reads token values here; it only checks that `auth.json` exists.

```ts
export interface UsageWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number /* unix seconds */ }
export interface CodexUsage { windows: UsageWindow[]; limitReached: boolean; checkedAt: number /* ms epoch */ } // primary then secondary, only those present; usedPercent clamped 0..100
export type UsageFailure = 'notLoggedIn' | 'authExpired' | 'cliMissing' | 'timeout' | 'failed';
export type UsageResult = { ok: true; usage: CodexUsage } | { ok: false; reason: UsageFailure; detail?: string };
export interface UsageOptions { spawn?: UsageSpawn; command?: string; timeoutMs?: number /* 15000 */; now?: () => number; clientVersion?: string; graceMs?: number /* 1000 */; platform?: NodeJS.Platform; killTree?: (pid: number) => void } // test seams; spawn is a fake in tests
export function parseRateLimits(result: unknown, now: number): CodexUsage | undefined; // prefers rateLimitsByLimitId.codex over rateLimits; primary/secondary (usedPercent, windowDurationMins, resetsAt); rateLimitReachedType → limitReached; nothing usable → undefined
export async function readCodexUsage(dir: string, options?: UsageOptions): Promise<UsageResult>;
export function findBundledCodex(extensionPath: string, platform?: NodeJS.Platform, arch?: string): string | undefined; // <ext>/bin/<windows|linux>-<x86_64|aarch64>/codex[.exe] for this OS and architecture only
export async function readCodexUsageWithFallback(dir: string, fallback: () => string | undefined, options?: UsageOptions): Promise<UsageResult>; // PATH first; fallback() is called (lazily) only on cliMissing without an explicit command
```
- No `<dir>/auth.json` → `{ ok: false, reason: 'notLoggedIn' }` without starting anything.
- Starts `codex app-server` (env `CODEX_HOME=<dir>`; on Windows, when `codex` is not found and a PATH entry (quotes around an entry are allowed) holds `codex.cmd`, `codex.cmd` through the shell as the single fixed command line `codex.cmd app-server` with no separate arguments; ENOENT → `cliMissing`), sends `initialize` (`clientInfo` name `planswap`, `clientVersion`) and `initialized`, requires the reported `codexHome` to equal `dir` (case-insensitive on Windows, otherwise `failed`), then `account/rateLimits/read`. A 401 / Unauthorized error → `authExpired` (checked first); otherwise an authentication-required error → `notLoggedIn`; other errors, an unparsable result or an early exit → `failed` with a short `detail` (server message/code or exit code, truncated); `timeoutMs` for the whole operation → `timeout`. Raw protocol lines are never returned or logged.
- Always ends the child it started: closes stdin, then kills only that child after `graceMs` (through the Windows shell fallback `kill()` would reach `cmd.exe` only, so that child's tree is ended with `taskkill /T /F /PID <its pid>`, injectable as `UsageOptions.killTree`).

## src/codex/codexUsageMonitor.ts (no vscode import)

```ts
export interface CodexUsageState { checking: boolean; result?: UsageResult } // the previous result stays while checking
export const USAGE_STALE_MS = 15 * 60_000;
export class CodexUsageMonitor {
  constructor(dirOf: () => string, onChange: (state: CodexUsageState) => void, options?: { read?: (dir: string) => Promise<UsageResult>; now?: () => number; staleMs?: number; authStamp?: (dir: string) => string /* default authFileStamp */ });
  current(): CodexUsageState;
  refresh(): Promise<void>;            // queries dirOf() now; a call while a query runs joins it (one codex process at a time); a thrown error becomes 'failed'
  refreshIfStale(): Promise<void>;     // only when nothing was tried yet or the last attempt (failures included) is older than staleMs
  refreshIfAuthChanged(): Promise<void>; // joins a running query; otherwise refresh() only when a query has ended before and authStamp(dirOf()) differs from the stamp recorded when it ended (sign-in, re-login, sign-out)
}
export function authFileStamp(dir: string): string; // `${mtimeMs}:${size}` of <dir>/auth.json from stat, or 'missing'; the file is never opened
```
The stamp is taken when each query ends, so rewrites Codex makes during the query (token refresh) do not count as a change.
State lives in memory only; it is never persisted.

## src/codex/codexStore.ts (imports vscode only for the Memento type)

Same shape as `AccountStore` in `src/accounts.ts`, with the keys `codex.accounts` and `codex.ignoredDirs`, the default account `{ name: CODEX_DEFAULT_NAME, dir: codexDefaultDir() }`, and scanning via `scanCodexDirs()`. Class name `CodexAccountStore`, methods: `named() all() find(name) findByDir(dir) add(a) remove(name) unignore(dir) syncWithDisk(labels?)`. `unignore(dir: string): Promise<void>` removes `dir` from `codex.ignoredDirs` (called after `deleteCodexDir` succeeds, so a recreated directory is discovered again). `syncWithDisk(labels?: LabelStore): Promise<void>` first prunes named entries whose directory no longer exists (`!fs.existsSync(dir)`; their alias is cleared with `labels?.remove(name)`, and the directory is not added to `codex.ignoredDirs`), then registers scanned directories, skipping names equal (`sameName`, case-insensitive) to `default`, to the name of a remaining registered Codex account or, with `labels`, to its `labelFor(a.name, labels)` (callers pass the Codex `LabelStore`); it saves only when something changed.

## src/protocol.ts

Full definition in docs/interfaces.md. Used on the Codex side: `PanelMode = 'codex'`; `PanelState.codex: TabState` (`enabled` means both rc files have a complete marker block (a start marker without its end marker counts as not enabled); `pendingDir` is the display name when the directory in the state file differs from the directory effective in this window, the path for an unregistered directory; `restart` is `restartInfo()`); `PanelState.locale` (shared by both pages); `AccountView.email` / `plan` are filled by `readCodexAccountInfo` (`plan` is `'API key'` in API key mode), `AccountView.isSelected` compares each directory with the selected directory (default when unset), independently of `isCurrent`; `AccountView.shared` by `isSharedCodexAccount` for named rows; `add` carries `shared`, `share` converts an independent account, `unshare` (with `dir`) converts a shared one back; `enable` / `restartServer` of `FromWebview` only make sense for codex, `reload` / `dismissBanner` are ignored for codex; `rename` (with `dir`, `label`) and `renameResult` (with `dir`, optional `error`) are shared by both pages and dispatched by `mode`.

## src/accountsPanel.ts

Single instance, signatures in docs/interfaces.md. The Codex side only provides a data source:

```ts
// src/codex/codexCommands.ts
export function codexPanelSource(store: CodexAccountStore, labels: LabelStore): PanelSource;
//   accounts(): maps store.all() (kind, name, label via labelFor(a.name, labels), dir, dirLabel, ...readCodexAccountInfo(dir), isCurrent = samePath(dir, effectiveDir()), shared = isSharedCodexAccount(dir) for named rows, undefined for default);
//              when effectiveDir() does not correspond to any account, appends a current row with kind='external' (name EXTERNAL_NAME, label labelFor(EXTERNAL_NAME, labels), also using readCodexAccountInfo).
//   enabled(): rcStatus() reports hasBlock and not broken for both files (errors → false).
//   pendingDir(): when readSelectedDir() ?? codexDefaultDir() differs from effectiveDir(), returns the display name of that directory's account, or the path if unregistered; undefined when equal.
//   watchTargets(): <dir>/auth.json of each row + STATE_FILE().
//   restart(): restartInfo().
```
Messages with `mode === 'codex'` are dispatched to `panel.setHandler('codex', ...)`; `panel.resolve('codex', dir)`, `panel.accounts('codex')`, `panel.focusAdd('codex')`.

## src/webview/main.ts

When the top tab bar switches to Codex, the page is rendered from `state.codex`, with all texts from `src/webview/i18n.ts` in `state.locale`:
- `!enabled`: only the explanation (design section 7) and the "Enable Codex switching" button (sends `{type:'enable', mode:'codex'}`) plus the "Tools" row are rendered; the other blocks are hidden.
- `!enabled` text: the base explanation followed by `disabled.restartLocal` / `disabled.restartWsl` / `disabled.restartRemote` for `restart.context`.
- No reload banner; when `pendingDir` is set, the top shows `pending.titleLocal` (local) or `pending.title` (others); text `pending.textLocalManual` (local), `pending.text` (wsl) or `pending.textRemote` (remote); button `pending.restart` (wsl, auto) or `pending.instructions` with the `info` icon (manual). The button always sends `{type:'restartServer', mode:'codex'}`. The footer restart button's title follows the same state (`footer.restartServer` / `footer.restartManual`) and the footer is rebuilt only when that title or the locale changes. Before the first state arrives the WSL wording is used; the add section's help text uses `~/.codex-<name>`; the sign-in button's title is "Run codex login in a terminal"; the terminal icon's title is "Run codex with this account in a terminal"; the signed-out hint is `Click "Log in" to log in from a terminal, or switch and log in from the Codex panel`.
- Current and other rows: email and `plan` when there is an `email`; "Logged in" when `loggedIn` without `email`; "Not logged in" when signed out.
- Pencil renaming of named account rows (not the default or external row) works as on the Claude page (`rename` with `dir`, `label`, edit state keyed by `dir`), with messages carrying `mode:'codex'`.
- The "Tools" row shows `AGENTS.md`, the Codex extension settings, "Re-link" (only while a linked Codex account exists) and "Update CLI" (`tool` messages with `mode:'codex'`; syncing sends `tool:'sync'`, updating `tool:'updateCli'`).
- The add section's shared checkbox, the shared badge, the "Link to the default account: …" row button and the unlink action of shared rows work as on the Claude page (`add` with `shared`, `share` / `unshare` with `dir`, `mode:'codex'`).
- Claude page behavior is unchanged.

## src/codex/codexCommands.ts (imports vscode)

```ts
export interface CodexDeps { store: CodexAccountStore; panel: AccountsPanel; labels: LabelStore; tools: ToolDeps; provideTerminalCheck?: (check: TerminalCheck) => void } // labels is codex.labels; tools is passed to runTool for Codex page tool messages; the optional callback publishes this module's account-terminal busy check
export function registerCodexCommands(deps: CodexDeps): vscode.Disposable[];
export function validateName(name: string, store: CodexAccountStore, labels: LabelStore): string | undefined; // exported so it can be unit-tested
export function manualRestartMessages(kind: ServerKind, remoteName: string | undefined, windows?: boolean): { hint: string; required: string; switchConfirm: string }; // pure localized guidance selector; callers pass vscode.env.remoteName; windows defaults to isWindows() and is a test seam
export function restartInfo(kind?: ServerKind): RestartInfo; // userEnv: true on win32; local/other remote: auto false; WSL: canAutoRestart(kind ?? detectServerKind()); callers that already detected the kind pass it, so one flow calls detectServerKind() once.
export function codexPanelSource(store: CodexAccountStore, labels: LabelStore): PanelSource;
export async function restartServerInteractive(): Promise<void>; // restart with modal confirmation, shared by the panel banner button, the Command Palette and the footer toolbar (ToolDeps.codexRestart)
export function codexRunsInWsl(windows?: boolean): boolean; // windows defaults to isWindows(); true only on native Windows with chatgpt.runCodexInWindowsSubsystemForLinux === true (design 9a)
```
Command ids and restart behavior are defined in design section 8. `enable` and `switchTo` first refuse with `codex.win.runsInWsl` when `codexRunsInWsl()`; switching also requires `isEnabled()`. QuickPick items, messages and terminal names use `labelFor`, while directory matching for effective and selected accounts accepts alternate spellings. `validateName` compares the reserved name, account names and display labels case-insensitively and refuses a directory that resolves to the default or is a link/junction.

Panel account messages resolve their directory through `panel.resolve`. Shared add asks for the Windows copy fallback and calls `ensureCodexLinks(dir, { ...linkOptions, busy: linkBusy(account) })`; independent add calls `copyCodexIndependent`. Add and rename catch thrown errors and always post `addResult` / `renameResult`. Share and unshare reject effective or selected accounts before their primary modal, re-check those states after it, then call the host `busy(account)` guard; share passes copy and terminal-busy options to `migrateCodexToShared`, whose options apply to its final link-repair step. Removal uses one `blocked()` guard for effective, selected and busy state before the flow and after every modal, including immediately before `deleteCodexDir`; successful deletion calls `store.unignore`. Switching serializes concurrent requests, re-links a shared target with the terminal-busy callback, writes the selection and performs an automatic restart only for supported WSL editors. A non-default Linux terminal is refused when its directory contains a C0 or DEL control character; opening a sign-in terminal shows the account login tip. Tool messages go through `runTool('codex', msg.tool, tools)`.

The Codex panel source computes current and selected registered-row indices with `findSameDir`; the external row and `pendingDir` use the same alternate-spelling-aware comparison. `AccountView.isSelected` remains independent of `isCurrent`, and `pendingDir` remains display text only.

## src/extension.ts

See docs/interfaces.md: before the Codex store is created, `migrateLegacyCodex()` runs in its own try/catch (an error only shows the localized warning `ext.codexLegacyFailed`, Codex initialization continues). A single `AccountsPanel` whose `sources.codex` is `codexPanelSource(codexStore, codexLabels)`; when Codex initialization fails it degrades to an empty source (`enabled: () => false`), Claude is not affected, and `tool` messages of the Codex page still go through `runTool('codex', …)`. Otherwise, `extension.ts` owns per-vendor `terminalChecks`; `ToolDeps.accountBusy` reads them, `codexShareOps.refresh` forwards `LinkOptions`, and `registerCodexCommands(... provideTerminalCheck ...)` publishes the Codex terminal check so toolbar Re-link obeys the same Windows terminal-busy rule as add and switch.

Usage limits (design 8.7), only when Codex is initialized: `usage = new CodexUsageMonitor(effectiveDir, (s) => statusBar.setCodexUsage(s), { read: (dir) => readCodexAccountInfo(dir).plan === 'API key' ? { ok: false, reason: 'notLoggedIn' } /* nothing started */ : readCodexUsageWithFallback(dir, () => findBundledCodex(<extensionPath of openai.chatgpt>), { clientVersion: <extension version> }) })`; `checkUsage()` = `refreshIfStale()` when `vscode.window.state.focused` and not `codexRunsInWsl()`, run 5 s after activation, every 60 s and on regaining focus (the 15-minute stale interval limits the actual queries); `panel.onDidChange` (account-info changes) → `refreshIfAuthChanged()` unless `codexRunsInWsl()`; `planswap.codex.refreshUsage` → the `codex.win.runsInWsl` warning when `codexRunsInWsl()`, otherwise `refresh()`. A change of `chatgpt.runCodexInWindowsSubsystemForLinux` re-renders the status bar. The timers are cleared on dispose.

## package.json

- `viewsContainers.activitybar[0].title` and the view name are both "PlanSwap" (`%key%` placeholders; "PlanSwap" in `package.nls.zh-cn.json`).
- `views.planswap` has a single view `{ type: 'webview', id: 'planswap.accounts', name: <"PlanSwap"> }`; Codex is a tab inside that view and has no view id of its own.
- `commands` contains 8 `planswap.codex.*` entries (including `planswap.codex.refreshUsage`, "Refresh Codex Usage Limits") (category "Codex Account", "Codex 账号" in Chinese; titles from `package.nls*.json`); the refresh button in `view/title` has `when: view == planswap.accounts`, and the existing `planswap.refresh` refreshes both stores and both pages.
