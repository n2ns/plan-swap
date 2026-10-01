# Claude and Shared Module Interfaces

Purpose: module responsibilities, signatures, data types, message contracts and implementation invariants for Claude and the shared host/frontend. Implementations must follow these contracts. Codex-specific contracts live in [Codex interfaces](codex-interfaces.md); design rationale is in [Claude design](design.md). Build/setup belongs in [Development](development.md), acceptance steps in [Manual Verification](manual-verification.md). See [Documentation](README.md) for ownership.

All files live in `src/`, TypeScript strict, ESM-style imports.

- Extension host (`src/*.ts`): bundled by esbuild as cjs; Node built-in modules are imported with the `node:` prefix; may only depend on `vscode` and Node built-ins. Type-checked with the root `tsconfig.json` (which excludes `src/webview`).
- Webview frontend (`src/webview/`): bundled by esbuild as iife (browser); may only depend on `@vscode-elements/elements`, `@vscode/codicons` (CSS/font only) and types from `../protocol.ts`; must not import `vscode` or Node modules. Type-checked with `src/webview/tsconfig.json`.
- `src/protocol.ts` is shared by both sides, contains only types, and imports no runtime module.
- User-visible strings are never hard-coded: the host uses `t()` from `src/i18n.ts`, the Webview uses `t()` from `src/webview/i18n.ts` (see the i18n sections below). Where this contract quotes a message, it gives the English text of the corresponding i18n entry.

## src/i18n.ts (host i18n, no vscode import)

```ts
export type Locale = 'en' | 'zh-cn' | 'es' | 'ja';
export function setLocale(l: Locale): void;
export function getLocale(): Locale;
export function t(key: MessageKey, params?: Record<string, string | number>): string; // `{name}` placeholders are replaced from params; unknown placeholders are left as is
export function translationsOf(key: MessageKey): string[]; // the message in every locale (used to reserve all localized external-directory names)
export const en: { ... };                                 // English table, the source of truth
export type MessageKey = keyof typeof en;
export const zhCn: Record<MessageKey, string>;            // Simplified Chinese, exactly the same keys
export const es: Record<MessageKey, string>;              // Spanish
export const ja: Record<MessageKey, string>;              // Japanese
```
- Contains four tables, `en`, `zhCn` (locale `zh-cn`), `es` and `ja`. Each translated table is typed `Record<MessageKey, string>`, so it must have exactly the same keys as `en` (key-parity rule, enforced by the type checker). Keys are grouped by prefix (`common.*`, `account.*`, `ext.*`, `name.*`, `label.*`, `claude.*`, `codex.*`, `server.*`, `del.*`, `tools.*`, `mcp.*`, `share.*`, `unshare.*`, `sync.*`, `status.*`, `identity.*`).
- Has no `vscode` import, so the pure modules (`paths.ts`, `labels.ts`, `claudeShare.ts`, `shareReport.ts`, `codex/codexPaths.ts`, `codex/codexShare.ts`, `codex/codexState.ts`, `codex/codexServer.ts`) can use it for the reasons and errors they return or throw.
- Every user-visible host string goes through `t()`: messages, errors, warnings, modal text and buttons in `commands.ts`, `codex/codexCommands.ts`, `tools.ts`, `statusBar.ts`, `extension.ts`; reasons returned or thrown by pure modules (`paths.checkSafeToDelete`, the `claudeShare` / `codexShare` errors, `describeShareReport` summaries, `codexPaths.checkCodexSafeToDelete` / `copyCodexSeed` reasons, `codexState.preCheck` reasons and thrown errors, `codexServer.planRestart` errors, `labels.validate` messages); QuickPick labels and placeholders. Terminal names stay `Claude (<label>)` / `Codex (<label>)`.
- Never localized: the rc marker block text in `codexState.rcBlock()` (written to user files, byte-identical), shell commands, file names, setting ids, command ids.

## src/i18nVscode.ts (imports vscode)

```ts
export function resolveLocale(): Locale;                                    // explicit en / zh-cn / es / ja; auto maps VS Code language families zh → zh-cn, es → es, ja → ja, otherwise en
export function watchLocale(onChange: () => void): vscode.Disposable;      // onDidChangeConfiguration affecting 'planswap.language' → setLocale(resolveLocale()), then onChange()
export function migrateLegacyLanguage(state: vscode.Memento): Promise<void>; // once (flag 'legacy.languageMigrated' in state = ctx.globalState): aiSwitcher.language globalValue 'en' / 'zh-cn' and planswap.language globalValue undefined → update('language', value, Global); flag set after success; errors only console.error (retried next activation)
```

## package.json static strings and the language setting

- `displayName`, `description`, command titles and categories, view container and view names, configuration titles and descriptions are `%key%` placeholders resolved from `package.nls.json` (English), `package.nls.zh-cn.json` (Simplified Chinese), `package.nls.es.json` (Spanish) and `package.nls.ja.json` (Japanese), all with the same keys. VS Code resolves these by its own display language, not by `planswap.language` (platform limitation).
- English names: displayName "PlanSwap: Claude Code & Codex Account Switcher" (brand "PlanSwap" is permanent; the part after the colon grows as more AI tools are supported), identifier `planswap`; container and view title "PlanSwap"; command categories "Claude Account" / "Codex Account" / "PlanSwap". The Chinese file keeps the Chinese titles ("PlanSwap", "Claude 账号", "Codex 账号", ...).
- `contributes.configuration`: `planswap.language`, type string, enum `["auto", "en", "zh-cn", "es", "ja"]`, default `"auto"`, scope `application`, enumDescriptions: auto = follow the VS Code display language; en = English; zh-cn = 简体中文; es = Español; ja = 日本語.
- `contributes.configuration`: `planswap.sidebar.showModelLimits`, type boolean, default `false`, scope `application`, description `%config.sidebarModelLimits.description%` (read by `accountsPanel.ts`; filters model-specific windows from Claude rows when disabled). `planswap.sidebar.showEmail` / `showFiveHourLimit` / `showWeeklyLimit`, type boolean, default `true`, scope `application`, descriptions `%config.sidebarEmail.description%` / `%config.sidebarFiveHour.description%` / `%config.sidebarWeekly.description%` (read by `sidebarDisplay()` in `accountsPanel.ts` on every state push and applied to both pages by `applySidebarDisplay`). `extension.ts` refreshes the panel when any `planswap.sidebar` setting changes. `planswap.claude.usageAutoRefresh` / `planswap.codex.usageAutoRefresh`, type boolean, default `true`, and `planswap.claude.usageRefreshMinutes` / `planswap.codex.usageRefreshMinutes`, type number, default `15`, `minimum` 5, `maximum` 1440, all scope `application`, descriptions `%config.<product>UsageAutoRefresh.description%` / `%config.<product>UsageRefreshMinutes.description%`; `planswap.claude.usageRefreshMinutes` has `minimum` 10 instead of 5. Read by `usageSchedule(product)` in `extension.ts` (`{ auto, staleMs }`, minutes clamped to 10-1440 for Claude and 5-1440 for Codex, a non-number gives 15) on every check.

## src/platform.ts (no vscode import)

- `isWindows()`, `isSupportedPlatform(platform?)` (linux, win32), `comparablePath(p, platform?)` (`path.resolve`, lower-cased on win32 for comparison only).
- `createLink(target, link, platform?)`: `fs.symlinkSync`, or on win32 a junction for directories and a file symlink otherwise (`EPERM` → an Error naming Developer Mode). `copyLink(src, dst, platform?)` recreates a link, resolving relative targets on win32.
- `LinkPrivilegeError`, `JunctionError` (a directory junction Windows refuses for a reason other than an existing entry, e.g. a network share or FAT/exFAT volume; `linkEntry` returns `'failed'`, recorded in `ShareReport.failed` and reported as `share.r.junctionFailed`, and the run goes on), `fileLinksAvailable(dir, platform?)` (probe; true off Windows). `ShareReport.noPrivilege` lists file entries left independent for lack of that privilege; `describeShareReport` reports it. `ShareReport.copied` lists configuration files copied once instead. `LinkOptions { copyConfig?: boolean; busy?: () => boolean }` controls the one-time-copy fallback and supplies an additional caller-owned busy check; the sharing-module signatures below define its parameter position. `recordLink(report, name, result, link, target, allowCopy)` applies the copy fallback; `linkPolicy.askCopyFallback(dir, vendor)` (imports vscode) asks the user (buttons Copy files / Open Developer Settings / Skip; dismissing = skip) and `COPYABLE_ON_NO_LINK` is its whitelist; `linkPolicy.openDeveloperSettings()` opens `DEVELOPER_SETTINGS_URI` (`ms-settings:developers`) through `vscode.env.openExternal` and shows `share.noFileLinks.openFailed` (the Settings path for Windows 10 and 11) when that fails.
- `unlinkLinks(dir, platform?)` (win32 only) recursively walks the whole tree without following links and removes symlinks, junctions and opaque reparse folders before recursive deletion; `platform` defaults to `process.platform`. `isOpaqueReparseDir(p, platform?)` detects such folders (false off win32); `mergeEntry` leaves them in place and never merges an entry into itself (`sameRealPath(src, dst)`).
- `pidAlive(pid)` (signal 0), `type StartTimeProbe = (pids: number[]) => Map<number, string> | undefined`, `parseStartTimes(out)` (`<pid> <filetime>` lines), `windowsStartTimes(pids, run?)` (creation times as FILETIME decimal strings through one `Get-Process`; invalid pids dropped, exited pids absent, undefined when the probe fails), `renameReplacing(src, dst, platform?, rename?, stillValid?): boolean` (the rename of every atomic replace; on win32 retried up to 8 times on EPERM / EACCES / EBUSY; `stillValid`, when supplied, runs before every attempt and `false` stops without renaming), `stripBom(text)` (for user-edited `settings.json` / `config.toml` before parsing), `fsyncDir(dir)` (no-op on win32).

## src/paths.ts (data layer, no vscode import)

Paths are absolute after `path.resolve`, without `~` or a trailing slash. Use `samePath` for path equality and `sameRealPath` when protecting the default directory from aliasing through symlinks. Obtain the Claude default through `defaultDir()` rather than hard-coding `~/.claude`. Every account-info reader and watcher uses `claudeJsonPath(dir, isExplicitConfigDir(dir))`; parsing a missing or half-written `.claude.json` must not throw.

```ts
export const DEFAULT_NAME = 'default';
export const NAME_RE = /^[A-Za-z0-9_-]+$/;
export const DIR_BASENAME_RE = /^\.claude-[A-Za-z0-9_-]+$/;

export interface Account { name: string; dir: string }          // dir is always an absolute path after path.resolve
export interface AccountInfo { email?: string; plan?: string; loggedIn: boolean; identity?: string } // plan is the formatted plan text (e.g. "Max 20x"); identity is an opaque comparison key, never displayed, logged, persisted or sent to the Webview (rows are built through viewInfo)

export function defaultDir(): string;                 // path.resolve(process.env.CLAUDE_CONFIG_DIR || ~/.claude): the value is used as is, as Claude Code does (surrounding spaces kept, warned about at activation); a blank value counts as unset
export function claudeJsonName(): string;             // '.claude-custom-oauth.json' while Claude Code sees CLAUDE_CODE_CUSTOM_OAUTH_URL (the setting's set / cleared names first, then process.env), else '.claude.json' (CLI 2.1.284; its local / staging variants exist only in development builds); used by claudeJsonPath, mirrorClaudeJson and syncMcpServers
export function setClaudeSettingEnv(names: { set: readonly string[]; cleared: readonly string[] }): void; // the host passes claudeSettings.settingEnvNames() at activation and on each change of the setting
export function findSameDir(dirs: readonly string[], dir: string): number; // index of dir: same spelling first (samePath), else another spelling of the folder (sameRealPath); -1 when none. Marks the current / selected panel rows and the pending state
export function accountDir(name: string): string;     // path.resolve(os.homedir(), '.claude-' + name)
export function samePath(a: string, b: string): boolean; // strictly equal after path.resolve
export function caseVariantOf(dir: string): string | undefined; // win32: the on-disk name of an existing sibling that is dir except for letter case (the same folder there); validateName (both vendors) refuses such a name with name.dirCaseDiffers; undefined elsewhere
export function realPath(p: string): string;              // links resolved; win32: fs.realpathSync.native first (expands 8.3 short names, drops \?\, fixes case), then the JS realpath; path.resolve when missing
export function sameRealPath(a: string, b: string): boolean; // comparablePath(realPath(a)) === comparablePath(realPath(b)), or both exist with the same device and inode (bigint stat; catches \localhostC$… and, on Linux, bind mounts). Every default-directory guard uses it (scan, deletion, isDefault, name validation, busy check)
export function realPathInside(outer: string, inner: string): boolean; // true when inner lies strictly below outer after resolving links; used to reject an account folder that contains the default directory
export function claudeJsonPath(dir: string, explicit?: boolean): string;  // account info file (name from claudeJsonName()): ~/.claude.json when explicit is false (default), process.env.CLAUDE_CONFIG_DIR is not set and dir is ~/.claude, otherwise <dir>/.claude.json; callers pass explicit = claudeSettings.isExplicitConfigDir(dir)
export function formatClaudePlan(orgType?: string, tier?: string): string | undefined; // organizationType → name (claude_max→Max, claude_pro→Pro, claude_team/team→Team, claude_enterprise/enterprise→Enterprise, others lose the claude_ prefix and are capitalized); a trailing /_(\d+)x$/ of tier → "<n>x"; both combined as "Max 20x", only one → only that one, both empty → undefined
export function readAccountInfo(dir: string, explicit?: boolean): AccountInfo; // synchronous; reads oauthAccount from claudeJsonPath(dir, explicit): email = emailAddress, plan = formatClaudePlan(organizationType, organizationRateLimitTier); never throws on parse failure / missing file; loggedIn = has email || <dir>/.credentials.json exists (email is the primary criterion); identity only when oauthAccount.accountUuid and organizationUuid are both non-empty strings (design.md 6.8)
export function scanAccountDirs(): Account[];          // scans real directories (not symlinks) under os.homedir() whose basename matches DIR_BASENAME_RE, excluding the default directory and directories that contain it after resolving links; name = basename without '.claude-'
export function copySettingsStripped(fromDir: string, toDir: string): boolean; // used by claudeShare.copyClaudeIndependent; stripped keys in design.md 6.2 step 5; returns false when the source is missing or the target already has settings.json; writes with mode 0o600
export function ensureAccountDir(dir: string): void;   // mkdir recursive, mode 0o700
export interface McpSyncResult { added: string[]; kept: string[] } // added: server names written into the account; kept: names the account already has with a different definition, left untouched
export function syncMcpServers(fromJson: string, dir: string, beforeCommit?: () => void): McpSyncResult; // used by claudeShare.copyClaudeIndependent; merges mcpServers of fromJson (the default account's info file) into <dir>/.claude.json: missing names added, identical skipped, differing kept; never removes. sameRealPath(dir, defaultDir()), source without servers or nothing to add → no write. Missing target → created 0600 with only mcpServers; existing → every other key and its mode kept, replaced atomically (<real>.planswap-<pid>.tmp + rename, symlinks followed). Throws Error(t('mcp.badTarget')) when the target is not a JSON object, Error(t('mcp.changed')) when the file changed between read and rename (left unchanged); beforeCommit runs between writing the temporary file and that check (a test seam to simulate a concurrent CLI write)
export function unchangedSince(file: string, before: string | undefined): boolean; // true only when the file still has the content previously read, or is still missing; checked before every atomic rename attempt
export function checkSafeToDelete(dir: string): string | undefined; // returns the refusal reason (localized via t()), undefined when safe; rules in design.md 6.3 step 6
export async function deleteAccountDir(dir: string): Promise<void>; // checkSafeToDelete first, throw Error(reason) when unsafe; fs.promises.rm recursive force
```

## src/identity.ts (pure, no vscode import)

```ts
export function sameIdentityGroups<T extends { identity?: string }>(entries: readonly T[]): T[][]; // groups of ≥ 2 entries sharing an identity; entries without one ignored; members in input order, groups ordered by their first member
export function identityGroupsKey(groups: ReadonlyArray<ReadonlyArray<{ dir: string }>>): string; // order-insensitive key built from the sorted directories only (never identity values)
```

## src/environmentWarnings.ts (no vscode import)

```ts
export const CLAUDE_OVERRIDE_VARS: readonly string[]; // Claude Code credential sources that outrank /login (authentication docs, precedence)
export function claudeCredentialOverrides(env: NodeJS.ProcessEnv, setting: { set: readonly string[]; cleared?: readonly string[] }, platform?: string): string[]; // names set non-empty in env (unless cleared by the setting) or passed by the setting (claudeSettings.settingEnvNames); both federation variables → ANTHROPIC_FEDERATION_RULE_ID; case-insensitive on win32
export function pathVarsWithSpaces(env: NodeJS.ProcessEnv): string[]; // CLAUDE_CONFIG_DIR / CODEX_HOME whose non-blank value has surrounding spaces (warn.pathSpaces)
export function oneDriveHome(home: string, env: NodeJS.ProcessEnv, platform?: string): string | undefined; // win32: the OneDrive / OneDriveCommercial / OneDriveConsumer root containing home (Windows path rules), else undefined
```

`extension.ts` shows `warn.claudeEnvOverride` / `warn.oneDriveHome` / `warn.pathSpaces` (id `pathSpaces:<names>`) at activation with a `common.dontShowAgain` button; dismissed ids live in `state.json` under `warnings.dismissed` (`claudeEnv:<names>`, `oneDriveHome`).

## src/identityWarnings.ts (imports vscode)

```ts
export type Vendor = 'Claude' | 'Codex';
export interface IdentitySource { vendor: Vendor; accounts(): Array<{ dir: string; label: string }>; identityOf(dir: string): string | undefined } // registered accounts (default + named), label via labelFor
export const claudeIdentity: (dir: string) => string | undefined; // readAccountInfo(dir, isExplicitConfigDir(dir)).identity
export const codexIdentity: (dir: string) => string | undefined;  // readCodexAccountInfo(dir).identity
export class IdentityWarnings {
  constructor(sources: IdentitySource[], warn?: (message: string) => void); // warn defaults to showWarningMessage
  check(): void;
}
```
- `check()` groups each source's accounts with `sameIdentityGroups` and warns `t('identity.duplicate', { vendor, labels })` (labels joined with `common.nameSep`) for every group whose `identityGroupsKey([group])` was not present at the previous check; the warned set is replaced by the current groups, so a resolved group that recurs is warned again. A throwing source is skipped. State is in memory only; identity values never leave the process. Called at activation and on every account-info change. Design in design.md 6.8.

## src/claudeShare.ts (shared vs independent Claude accounts, no vscode import)

Design in design.md 6.7. Every file-system test runs under `makeTempHome`.

```ts
export const CLAUDE_SHARED_ENTRIES: ReadonlyArray<{ name: string; kind: 'file' | 'dir' }>; // settings.json, CLAUDE.md, history.jsonl (files); projects (marker), file-history, todos, session-env, shell-snapshots, sessions, tasks, uploads, agents, commands, output-styles, hooks, rules, ide (dirs)
export const CLAUDE_CHILD_SHARED_DIRS: readonly ['skills', 'plugins'];   // real folders in the account; every child of the default folder is linked
export const CLAUDE_CHILD_EXCLUDES: readonly ['synced', '.trash'];      // per-account cloud-synced buckets, never linked or copied
export const CLAUDE_IDENTITY_SETTING_KEYS: { top: string[]; env: string[] }; // top: apiKeyHelper, forceLoginMethod, forceLoginOrgUUID; env: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR

export interface ShareReport {
  linked: string[];     // entry names newly linked (children as 'skills/<child>')
  created: string[];    // entries created empty in the default dir
  conflicts: string[];  // entries the account has as a real file/dir or a link elsewhere; left untouched
  refused: string[];    // entries refused for safety ('settings.json' when the default has identity keys or is not a JSON object)
  busy?: string[];      // entries whose repair would move, merge or unlink account files, skipped because the vendor process check or caller-supplied busy check is true
  failed?: string[];    // Windows: folder entries whose junction could not be created (JunctionError: not a local NTFS drive); left unlinked; absent when none
}
export interface MigrateReport extends ShareReport {
  moved: number;        // files moved into the default dir
  duplicates: number;   // identical files dropped from the account
  keptBoth: string[];   // relative paths ('/'-separated on every platform, like all report names) of account copies moved next to the default file as '<name>.from-<account>'
  backups: string[];    // account files replaced by a link, kept as '<entry>.independent-backup' in the account dir
}
export interface LinkOptions {
  copyConfig?: boolean; // user accepted one-time copies when Windows refuses a file link
  busy?: () => boolean; // extra caller-owned busy signal used by destructive repair steps
}

export function isSharedClaudeAccount(dir: string): boolean;   // <dir>/projects is a symlink and realpath equals realpath(<defaultDir()>/projects); the default dir → false
export function ensureClaudeLinks(dir: string, procRoot?: string, options?: LinkOptions): ShareReport;    // idempotent create/repair (design.md 6.7); in an already shared account a regular history.jsonl is merged back with mergeLines and relinked (reported under linked), an independent account's own one stays a conflict; the steps that move or unlink account files (that merge, replacing a whole-folder skills/plugins link, removing dangling child links) are skipped and reported under busy while claudeAccountBusy(dir, procRoot) or options.busy?.() (checked lazily, only when such a step comes up; procRoot defaults to '/proc'); options.copyConfig enables the approved one-time Windows config copy fallback; missing default entries created empty (dir 0700, file 0600, settings.json '{}\n'); never touches existing default content; replaces a whole-folder skills/plugins link by per-child links; removes child links whose default target is gone; the default dir → empty report
export function mirrorClaudeJson(fromJson: string, dir: string, beforeCommit?: () => void): { changed: string[] }; // fromJson = claudeJsonPath(defaultDir(), isExplicitConfigDir(defaultDir())); mcpServers exact copy, per-project key subset, hasCompletedOnboarding / lastOnboardingVersion added when missing and the account is signed in (email in its file or .credentials.json exists); changed lists 'mcpServers', the added onboarding keys and 'projects:<path>'; missing source → {}; source not an object → Error(t('share.badSource')); target not an object → Error(t('mcp.badTarget')); changed during write → Error(t('mcp.changed')) (beforeCommit, a test seam, runs between writing the temporary file and that check); no write when nothing changes; the default dir → no-op
export function claudeAccountBusy(dir: string, procRoot?: string): boolean; // a <dir>/sessions/*.json with a live pid whose <procRoot>/<pid>/environ CLAUDE_CONFIG_DIR matches dir (for the default dir: unset or the default); a missing procRoot with any session file → true; procRoot defaults to '/proc' (tests pass a fake); on win32 with the default procRoot → windowsSessionsBusy(<dir>/sessions)
export function windowsSessionsBusy(sessions: string, startTimes?: StartTimeProbe): boolean; // a linked sessions folder (shared account) → false; otherwise a record with a live pid whose start time (startTimes, default windowsStartTimes) equals its procStart; a live record without procStart, or a probe returning undefined → true
export function migrateClaudeToShared(dir: string, accountName: string, procRoot?: string, label?: string, options?: LinkOptions): MigrateReport; // throws Error(t('share.busy', { name: label ?? accountName })) before writing when claudeAccountBusy or options.busy() reports busy (the host's terminal check, re-read after the copy-fallback prompt; the host passes the display name; accountName stays the internal name used for '<name>.from-<account>'); merge rules in design.md 6.7; ends with ensureClaudeLinks(dir, procRoot, options) (its report merged in); a settings.json / CLAUDE.md the default dir lacks is moved there (a settings.json with identity keys stays, unlinked); never overwrites a default file, never deletes an account file without an identical copy in the default dir, never follows symlinks while moving
export function makeClaudeIndependent(fromJson: string, dir: string): { removed: string[]; copied: string[] }; // throws Error(t('unshare.default', { dir })) for the default dir and Error(t('unshare.notShared', { dir })) when not shared; unlinks (unlinkIfLinksTo: fs.unlinkSync when linksTo, i.e. real paths compared, so a link elsewhere that resolves to the default entry is removed too; regular files and links resolving elsewhere stay; a whole-folder skills/ plugins/ link is removed as one entry) first settings.json, CLAUDE.md, the INDEPENDENT_COPY_DIRS and the skills/ children, then copyClaudeIndependent(fromJson, dir), then history.jsonl, the session folders, the projects marker and the plugins/ children — a failed copy therefore leaves the account shared and ensureClaudeLinks re-creates the missing links; removed lists the link names (children as 'skills/<child>')
export function copyClaudeIndependent(fromJson: string, dir: string): { copied: string[] }; // copySettingsStripped + CLAUDE.md + agents/commands/output-styles/hooks/rules + skills children (except the excludes) + syncMcpServers; never overwrites; copied lists the entries ('mcpServers' when servers were added)
```

The five write entry points `ensureClaudeLinks`, `mirrorClaudeJson`, `migrateClaudeToShared`, `makeClaudeIndependent` and `copyClaudeIndependent` throw `account.containsDefaultDir` with `{ dir, default }` before writing when `realPathInside(dir, defaultDir())`. Their existing behavior for the default directory itself is unchanged. `commands.validateName` rejects the same ancestor relationship before account creation.
Helpers exported for `codex/codexShare.ts` (same semantics on both sides): `lstatOrUndefined`, `linksTo(link, target)`, `unlinkIfLinksTo(link, target, name, removed): boolean` (`fs.unlinkSync(link)` and push `name` when `linksTo`; regular files and links resolving elsewhere untouched), `unlinkChildLinks(accFolder, defFolder, rel, realFolder, removed)` (a whole-folder link is removed as `rel`; otherwise, when `realFolder`, every child that `linksTo` the default child is removed as `rel/<child>`), `emptyReport()`, `linkEntry(link, target): 'linked' | 'ok' | 'conflict'`, `record(report, name, result)`, `freeName(base)` (first free of `base`, `base-2`, …), `copyTree(src, dst, existing = 'skip')` (recursive copy without `fs.cpSync`, which aborts the process on an unreadable directory: links recreated, never followed; a relative link into the copied tree stays relative, any other becomes absolute so it still reaches its target (a file link Windows refuses to create, `LinkPrivilegeError`, becomes a copy of its target file; a dangling one is skipped), file modes and timestamps kept, sockets / FIFOs skipped, never overwrites; an existing target entry is skipped or, with `'throw'`, fails with `EEXIST`; used by `copyClaudeIndependent` and `copyCodexIndependent`), `sameContent(a, b, sa: fs.Stats, sb: fs.Stats): boolean` (two links resolving to the same target, or two regular files of equal size and bytes), `MergeCtx`, `rememberMove(ctx, src, dst)` (records the actual location of a moved, backed-up or retained entry), `mergeEntry(src, dst, rel, ctx)` and `finalizeMerge(ctx)` (defer links until ordinary entries have moved, then recreate them against the actual destination of migrated targets, including conflict names; external targets keep their original location; finalize before repairing account links), `moveEntry(src, dst): boolean` (rename, or copy + delete across file systems, preserving link targets without following them; false when a link cannot be recreated, the source then stays and callers count nothing as moved), `mergeLines(src, dst): number` (appends the lines of src that dst lacks, whole-line comparison, order kept, bytes preserved via latin1; creates dst 0600 when missing; removes src; returns the number of appended lines), `defaultFolder(p)`.

## src/shareReport.ts (no vscode import)

```ts
export interface ShareReportLike { conflicts: string[]; refused: string[]; moved?: number; duplicates?: number; keptBoth?: string[]; backups?: string[]; busy?: string[] }
export function describeShareReport(r: ShareReportLike): string; // localized one line joined with t('common.listSep'): share.r.moved / duplicates / keptBoth / backups / conflicts / refused / busy; linked and created entries are not reported; '' when nothing needs attention
```

## src/claudeSettings.ts (imports vscode)

```ts

export function currentDir(): string;                         // CLAUDE_CONFIG_DIR from the setting (array and object forms accepted; the rule below) ?? defaultDir()
export function isExplicitConfigDir(dir: string): boolean;   // true when the setting has a non-empty CLAUDE_CONFIG_DIR and it is samePath(dir); passed as `explicit` to claudeJsonPath / readAccountInfo by every caller that reads or watches account info (panel rows and watchers, status bar, QuickPick, terminal close)
export async function setConfigDir(dir: string | undefined): Promise<void>; // builds a new array (never mutates the get() result), keeps other entries, removes all CLAUDE_CONFIG_DIR entries; appends {name, value: path.resolve(dir)} when dir is defined and not samePath(defaultDir()); object form converted to an array; await update(..., ConfigurationTarget.Global). Errors are rethrown as is
export function affectsSetting(e: vscode.ConfigurationChangeEvent): boolean; // e.affectsConfiguration('claudeCode.environmentVariables')
export function settingEnv(): Record<string, string>; // every variable of the setting except CLAUDE_CONFIG_DIR, last entry winning, an empty or missing value as '' (as the extension passes it); applied to the claude usage query
export function settingEnvNames(): { set: string[]; cleared: string[] }; // for the environment warnings: names whose last entry has a non-empty value, and names whose last entry is empty (the extension then passes '' instead of the inherited value)
```

As the Claude extension (2.1.284) reads it: the last entry whose name is `CLAUDE_CONFIG_DIR` (case-insensitive on win32) and whose value is an absolute path string (on win32 with a drive letter or UNC) wins; empty, relative and non-string values are skipped. `setConfigDir` removes every spelling.

## src/claudeUsage.ts (no vscode import)

Usage limits of a Claude account through the official CLI and the usage cache it writes ([Claude design 6.9](design.md#69-claude-usage-limits)). Reads only the account's own info file (`claudeJsonPath(dir, explicit)`); never touches `.credentials.json`.

```ts
export interface ClaudeUsageWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number /* unix seconds */; scope?: string }
export interface ClaudeUsage { windows: ClaudeUsageWindow[]; checkedAt: number /* ms epoch, the cache's fetchedAtMs */ }
export type ClaudeUsageFailure = 'cliMissing' | 'timeout' | 'notRefreshed' | 'noUsage' | 'failed';
export type ClaudeQueryResult = { ok: true } | { ok: false; reason: ClaudeUsageFailure; detail?: string };
export interface ClaudeUsageChild extends EventEmitter { stdout: Readable | null; exitCode: number | null; signalCode: NodeJS.Signals | null; pid?: number; kill(signal?: NodeJS.Signals): boolean }
export type ClaudeUsageSpawn = (command: string, args: string[], options: childProcess.SpawnOptions) => ClaudeUsageChild;
export interface ClaudeQueryOptions { spawn?: ClaudeUsageSpawn; env?: Record<string, string> /* settingEnv() */; signal?: AbortSignal /* ends the child; result failed / detail 'cancelled' */; timeoutMs?: number /* 30000 */; now?: () => number; platform?: NodeJS.Platform; killTree?: (pid: number) => void }
export const CLAUDE_USAGE_MAX_AGE_MS: number; // 24 hours
export function parseUsageCache(data: unknown, now: number): ClaudeUsage | undefined; // pure
export function readUsageFetchedAt(dir: string, explicit?: boolean): number | undefined; // fetchedAtMs of the cache attributable to the signed-in account (same accountUuid rule), any age
export function readClaudeUsage(dir: string, explicit?: boolean, now?: number): ClaudeUsage | undefined; // synchronous; undefined when the file is missing, unreadable or half-written
export function usageEnv(dir: string, explicit: boolean, base?: NodeJS.ProcessEnv, setting?: Record<string, string>): NodeJS.ProcessEnv;
export function queryClaudeUsage(dir: string, explicit: boolean, options?: ClaudeQueryOptions): Promise<ClaudeQueryResult>;
export interface UsageTarget { dir: string; label: string }
export function oneAtATime(): <T>(task: () => Promise<T>) => Promise<T>; // a queue: tasks run one after another in call order; a failed task does not block the next
export function queryEach<R = ClaudeQueryResult>(targets: UsageTarget[], query: (dir: string) => Promise<R>, onStep?: (target: UsageTarget, index: number) => void, cancelled?: () => boolean): Promise<Array<{ target: UsageTarget; result: R | { ok: false; reason: 'failed'; detail: string } }>>; // also used for Codex with R = UsageResult
```

- `queryEach`: queries the targets strictly one after another (never two `claude` or `codex` processes at once). Before each target it checks `cancelled()` (default never) and stops without querying further targets once true; otherwise it calls `onStep(target, index)`, then `query(target.dir)`. A rejected `query` becomes `{ ok: false, reason: 'failed', detail: <error message> }` and the loop continues. Returns the results of the targets actually queried, in order (fewer than `targets` when cancelled).

- `parseUsageCache`: `data.cachedUsageUtilization` is used only when `oauthAccount.accountUuid` is a non-empty string equal to `cachedUsageUtilization.accountUuid` (compared here only; neither value is returned). `fetchedAtMs` must be finite, at most `CLAUDE_USAGE_MAX_AGE_MS` old and not more than 2 minutes in the future. Windows come from `utilization.limits[]` (`kind` `session` → 300 minutes, `weekly*` → 10080, otherwise no `windowMinutes`; `scope.model.display_name` → `scope`; `percent` clamped to 0-100; `resets_at` ISO text → `resetsAt` in unix seconds) or, when `limits` is missing or empty, `five_hour` / `seven_day` (`utilization`, `resets_at`); an entry without a finite percentage is skipped, and windows whose `resetsAt` has passed are dropped. No window left → `undefined`, never a 0% window.
- `usageEnv`: a copy of `base` (default `process.env`) with the `setting` variables applied (each value, `''` included, overrides the inherited one), then `CLAUDE_CONFIG_DIR` set to the resolved `dir` when `dirname(claudeJsonPath(dir, explicit))` is `dir`, and deleted otherwise (the default `~/.claude` whose info file is `~/.claude.json`).
- `queryClaudeUsage`: spawns `claude` with `-p /usage --output-format json --no-session-persistence --setting-sources user` (only user settings, so the working directory's project settings do not apply, and no session transcript is written), env `usageEnv(dir, explicit, process.env, options.env)`, cwd the home directory, `windowsHide`, stdio `['ignore', 'pipe', 'ignore']`. On `ENOENT`, when `platform === 'win32'` and a `claude.cmd` file exists in a PATH directory, it retries once with the command line `claude.cmd -p /usage --output-format json --no-session-persistence --setting-sources user` through the shell (the line is a fixed literal; the process tree of that child ends through `killTree`, default `taskkill /T /F /PID`). Still `ENOENT` → `cliMissing`. The run is limited to `timeoutMs` in total (`timeout`); only the child it started is killed, and only while it is still running. Stdout is limited to 1 MiB and parsed as the JSON result: `is_error === true` or a `subtype` other than `success` → `failed` with the (trimmed, 200-character) `result` text as `detail`; unparsable output or a non-zero exit without output → `failed` with a short detail; the text of a successful result is never returned. After a successful run it reads the info file: no cache attributable to the signed-in account (same `accountUuid` rule as `parseUsageCache`, any age) → `noUsage`; its `fetchedAtMs` earlier than the run start minus 2 minutes → `notRefreshed` (also when that cache is too old to show); otherwise `{ ok: true }`. Raw stdout is never logged.

## src/claudeUsageMonitor.ts (no vscode import)

```ts
export interface ClaudeUsageState { checking: boolean; failure?: { dir: string; reason: ClaudeUsageFailure; detail?: string } }
export interface ClaudeUsageMonitorOptions { query: (dir: string) => Promise<ClaudeQueryResult>; eligible?: (dir: string) => boolean /* default: always */; cachedAt?: (dir: string) => number | undefined /* default: unknown */; now?: () => number; staleMs?: number | (() => number) /* CLAUDE_USAGE_STALE_MS; a function is read on every check */ }
export const CLAUDE_USAGE_STALE_MS: number; // 15 minutes
export class ClaudeUsageMonitor {
  constructor(dirOf: () => string, onChange: (state: ClaudeUsageState) => void, options: ClaudeUsageMonitorOptions);
  current(): ClaudeUsageState;
  refresh(): Promise<void>;        // queries now; a call while a query runs joins it (one claude process at a time)
  record(dir: string, result: ClaudeQueryResult): void; // a query of dir run elsewhere (refresh all) counts as this monitor's attempt; ignored unless dir is current
  refreshIfStale(): Promise<void>; // refresh() unless a query runs, the directory is not eligible, the last attempt was for the same directory (samePath) less than staleMs ago, or cachedAt(dir) is less than staleMs old and not more than 2 minutes in the future (a clock moved back does not suppress queries); skipping for such a cache newer than this window's failed attempt for the directory clears that failure
}
```

- It holds no usage values: those are read from the info file (`readClaudeUsage`) when the status bar or the panel renders. `onChange` fires when a query starts (`checking: true`, keeping the previous `failure`) and when it ends.
- A run records `{ dir, at }` of the current directory before querying, so failures count as attempts (no retry loop) and a different current directory is queried at once. A directory that is not `eligible` (extension: no subscription identity, i.e. signed out) is never queried and records no attempt, so a later sign-in is queried on the next check; a run for it only clears a stale `checking`/`failure` state (notifying once). A returned failure is stored with its directory, and a rejected promise becomes `failed` with the error message. A success clears the failure. When the current directory changed while a query ran, the run queries the new directory once more.

## src/usageCooldown.ts (no vscode import)

```ts
export const USAGE_COOLDOWN_MS = 60_000;
export class UsageCooldown {
  constructor(now?: () => number, ms?: number /* USAGE_COOLDOWN_MS */);
  mark(dir: string): void;                              // a query of dir starts now; directories compared with samePath
  remaining(dir: string, elsewhere?: number): number;   // ms until dir may be queried manually again (0 = now), from the newer of the last mark and `elsewhere` (ignored when in the future)
}
```

In memory only, one instance per product in `extension.ts`. Every query marks its directory: the Claude monitor's `query` and refresh-all go through `claudeQuery(dir, signal?)` = `claudeQueue(() => { claudeCooldown.mark(dir); return queryClaudeUsage(...) })`; the Codex monitor's `read` and refresh-all's non-effective reads call `codexCooldown.mark(dir)`. Claude's remaining time also counts `readUsageFetchedAt(dir, explicit)` as `elsewhere`. `planswap.claude.refreshUsage` / `planswap.codex.refreshUsage`: unless the monitor is checking (then joined), a remaining time > 0 shows `usage.cooldown` (`{ seconds }`, rounded up) and starts nothing. Both refresh-all commands split their targets with `splitCooldown`: none due → `usage.allCooldown` with the shortest wait; otherwise only the due targets are queried (the counts in the messages are of those) and `usage.allSkipped` (`{ n }`) is appended to the final message (not to a failure warning that follows a cancellation).

## src/terminalShell.ts (imports vscode)

```ts
export function isWslProfile(name: string, profiles?: TerminalProfiles): boolean; // a detected '<distro> (WSL)' profile, or a profile whose path is wsl.exe or the System32/Sysnative bash.exe launcher
export function accountTerminalShell(): string | undefined; // win32 only: 'powershell.exe' when terminal.integrated.defaultProfile.windows is a WSL profile (a WSL shell does not receive the terminal environment that carries the account), otherwise undefined (the default profile); passed as shellPath by the Claude / Codex account terminals and the update-CLI terminal
```

## src/fileState.ts (depends only on the vscode Memento type)

```ts
export const STATE_JSON: () => string;   // path.join(os.homedir(), '.config', 'planswap', 'state.json')
export const STATE_KEYS: readonly ['accounts', 'ignoredDirs', 'claude.labels', 'codex.accounts', 'codex.ignoredDirs', 'codex.labels'];
// read() strips a UTF-8 byte order mark before parsing (a file saved by Notepad / Windows PowerShell 5.1 must not read as empty)
export class FileMemento implements vscode.Memento {
  constructor(file?: string);            // default STATE_JSON()
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T; // reads the file on every call (missing / half-written / non-object → empty); own properties only (Object.hasOwn)
  update(key: string, value: unknown): Promise<void>; // undefined deletes the key; re-reads the file inside the call (never a cached state) and rewrites the whole object atomically (temp file 0600 + rename, directory 0700, pretty JSON); no cross-process lock, so two hosts writing at the same moment can still lose one write
  exists(): boolean;                      // fs.existsSync(file)
  importOnce(source: vscode.Memento): Promise<void>; // when !exists(): copies every STATE_KEYS entry that source has (undefined skipped) and writes the file (empty object when nothing); otherwise no-op
}
```
The stores below receive this Memento instead of `ctx.globalState` (design.md section 4).

## src/accounts.ts (imports vscode only for the Memento type)

```ts
import type { Account } from './paths';
export class AccountStore {
  constructor(state: vscode.Memento);
  named(): Account[];                 // non-default accounts in state key 'accounts', sorted by name
  all(): Account[];                   // [{name: DEFAULT_NAME, dir: defaultDir()}, ...named()]
  find(name: string): Account | undefined;   // searches all()
  findByDir(dir: string): Account | undefined; // samePath match in all()
  add(account: Account): Promise<void>;       // replaces an entry with the sameName (case-insensitive); also removes the directory from state key 'ignoredDirs'
  remove(name: string): Promise<void>;        // also records the directory in 'ignoredDirs'
  unignore(dir: string): Promise<void>;       // removes the directory from 'ignoredDirs'; called after deleteAccountDir succeeds
  syncWithDisk(labels?: LabelStore): Promise<void>; // first prunes named entries whose dir does not exist (!fs.existsSync; labels?.remove(name); not added to 'ignoredDirs'),
  //   then adds entries of scanAccountDirs() that are not in 'ignoredDirs', not registered by dir (samePath), and whose name is not sameName (case-insensitive) as 'default',
  //   a remaining account's name or, with labels, its labelFor(a.name, labels) (until that conflict is gone); a scanned name also reserves itself against later scanned names; saves only when something changed
}
```

## src/labels.ts (depends only on the vscode Memento type)

```ts
export const EXTERNAL_NAME = '<external>'; // internal sentinel name of the external-directory row; never displayed; '<' cannot pass NAME_RE

export class LabelStore {
  constructor(state: vscode.Memento, key: 'claude.labels' | 'codex.labels');
  // storage: state[key] (the FileMemento) is Record<string /*name*/, string /*label*/>, keyed by account name
  get(name: string): string | undefined;                       // undefined when not set; own properties only (Object.hasOwn), so names such as constructor / toString / __proto__ are safe
  // set rebuilds the record with Object.fromEntries so a __proto__ name is stored as an ordinary own key (survives the JSON round-trip)
  set(name: string, label: string | undefined): Promise<void>; // undefined / empty / equal to name → delete the entry
  remove(name: string): Promise<void>;                         // called when an account is removed, equivalent to set(name, undefined)
  validate(label: string, name: string, existing: Array<{ name: string; label: string }>): string | undefined;
  //   returns a localized error message or undefined: empty after trim 'Enter a display name'; > 32 grapheme clusters (Intl.Segmenter; UTF-16 code units when the host Node lacks it) 'Display name can be at most 32 characters'; contains a line break 'Display name cannot contain line breaks';
  //   equals EXTERNAL_NAME or any of translationsOf('account.external') (in every supported language) 'Cannot use the reserved name <value>';
  //   after excluding name itself (exact match) from existing: sameName as another account's name 'Same as an existing account name', sameName as another account's label 'Same as an existing account's display name'.
  //   existing only contains accounts of the same vendor (same key); the same name is allowed across Claude and Codex; entering the account's own name passes (set deletes the entry, i.e. clears the alias)
}
export function sameName(a: string, b: string): boolean; // case-insensitive equality; used for every duplicate check of account names and aliases
export function labelFor(name: string, labels: LabelStore): string; // name === EXTERNAL_NAME → t('account.external'); name === 'default' → 'default' (a stored alias is ignored); otherwise labels.get(name) ?? name
```
External-directory rows never have an alias; their `name` is `EXTERNAL_NAME` and their `label` is `labelFor(EXTERNAL_NAME, labels)`, i.e. `t('account.external')` (in every supported language).

## src/protocol.ts (shared by both sides, types only)

```ts
export type AccountKind = 'default' | 'named' | 'external';
export type PanelMode = 'claude' | 'codex';
export type ToolId = 'openGlobalMd' | 'openSettings' | 'reloadWindow' | 'restartExtHost' | 'restartServer' | 'cliVersions' | 'sync' | 'updateCli' | 'openHelp' | 'openStar' | 'refreshUsage' | 'refreshAllUsage';

export interface AccountView {
  kind: AccountKind;
  name: string;        // internal name (default / name derived from the directory / EXTERNAL_NAME), used for logic
  label: string;       // display name: labelFor(name, labels), equal to name when no alias is set; the localized external-directory name for the external row
  dir: string;         // absolute path, used as the account identifier in messages
  dirLabel: string;    // for display, home directory replaced by ~
  email?: string;
  plan?: string;       // formatted plan (e.g. "Max 20x", "Plus", "API key")
  loggedIn: boolean;
  usageEligible?: boolean; // the row's usage limits can be queried: Claude = subscription sign-in (readAccountInfo().identity); Codex = signed in with ChatGPT, not API key, Codex not run inside WSL; drives the usage refresh buttons
  isCurrent: boolean;
  isSelected?: boolean; // Codex only: selection for next start, separate from effective account
  usage?: { windows: Array<{ usedPercent: number; windowMinutes?: number; resetsAt?: number; scope?: string }>; checkedAt: number }; // historical observation, not live: Codex = last query result, Claude = the usage cache in the account's own info file; scope names a model-specific Claude limit (e.g. "Fable"), rendered via textContent as "{limit} · {scope}" (`usage.scoped`)
  shared?: boolean;    // named rows only: true = shared with the default account (links), false = independent; undefined for default / external
}

export type EditorContext = 'local' | 'wsl' | 'remote';     // from vscode.env.remoteName: undefined → local (including WSLg desktop), 'wsl' → wsl, anything else → remote
export interface RestartInfo { context: EditorContext; auto: boolean; userEnv?: boolean } // auto = the restart action restarts something; false = it only shows manual instructions; userEnv (native Windows only) = the selection is the per-user CODEX_HOME, so the disabled page uses disabled.textWin instead of the rc-file text

export interface TabState {
  enabled: boolean;          // false when codex is not enabled; always true for claude
  accounts: AccountView[];
  switchedTo?: string;       // claude only: shows the reload banner, value is the display name
  hideEmail?: boolean;       // true while planswap.sidebar.showEmail is off: the rows carry no email and the frontend renders no email / "Logged in" line
  dirPrefix?: string;        // prefix of a new account folder for the add help in the platform spelling (tildify: ~/.claude- or ~\.claude-); the frontend falls back to its fixed ~/ prefix before the first state
  pendingDir?: string;       // codex only: selected but not restarted, value is the display name (path for an unregistered directory)
  restart?: RestartInfo;     // codex only: host-owned wording input for the disabled text and pending banner
}

export interface PanelState { active: PanelMode; locale: Locale; claude: TabState; codex: TabState } // locale: 'en' | 'zh-cn' | 'es' | 'ja', filled by the host from getLocale()

export type ToWebview =
  | { type: 'state'; state: PanelState }
  | { type: 'addResult'; mode: PanelMode; error?: string }     // error undefined means success
  | { type: 'renameResult'; mode: PanelMode; dir: string; error?: string } // dir is the renamed row's directory; error undefined means success
  | { type: 'focusAdd'; mode: PanelMode }                     // the frontend switches to that tab and focuses the input
  | { type: 'versions'; items: Array<{ label: string; value: string }> }; // CLI and extension versions, shown by the frontend as a card above the footer toolbar

export type FromWebview =
  | { type: 'ready' }
  | { type: 'setTab'; mode: PanelMode }                       // the user clicked a tab; the host remembers it
  | { type: 'switch'; mode: PanelMode; dir: string }
  | { type: 'terminal'; mode: PanelMode; dir: string }
  | { type: 'remove'; mode: PanelMode; dir: string }          // the frontend has completed the inline confirmation
  | { type: 'add'; mode: PanelMode; name: string; shared: boolean } // shared: the add section's checkbox (the host treats a missing value as true)
  | { type: 'share'; mode: PanelMode; dir: string }          // convert that independent named account into a shared one (the host confirms with a modal)
  | { type: 'unshare'; mode: PanelMode; dir: string }        // convert that shared named account back into an independent one (the host confirms with a modal)
  | { type: 'rename'; mode: PanelMode; dir: string; label: string } // renames that row's account; only sent for named rows (never the default or external row)
  | { type: 'reload'; mode: PanelMode }
  | { type: 'dismissBanner'; mode: PanelMode }
  | { type: 'enable'; mode: PanelMode }
  | { type: 'restartServer'; mode: PanelMode }
  | { type: 'tool'; mode: PanelMode; tool: ToolId };          // toolbar / per-page "Tools" section buttons and the usage refresh buttons; for the footer toolbar mode is the current tab
```
`Locale` is imported with `import type { Locale } from './i18n'` (a type-only import, erased at build time), so `protocol.ts` still imports no runtime module.

## src/accountsPanel.ts

`accountsPanel.ts` exports `SHOW_MODEL_LIMITS_SETTING = 'sidebar.showModelLimits'` and reads it when building Claude rows; disabled by default, it filters out scoped windows before sending usage to the Webview. `extension.ts` calls `panel.refresh()` when that setting changes.

```ts
export const VIEW_ID = 'planswap.accounts';

export interface PanelSource {
  accounts(): AccountView[];      // each implementation handles the external-directory row itself; label / email / plan already filled in
  enabled(): boolean;
  pendingDir(): string | undefined;   // display name
  watchTargets(): string[];       // absolute paths of the files to watch (claude: claudeJsonPath(dir, isExplicitConfigDir(dir)) of each directory; codex: auth.json of each directory + the state file)
  restart?(): RestartInfo;        // codex only; copied into TabState.restart on every push
}
export function claudePanelSource(store: AccountStore, labels: LabelStore): PanelSource; // maps store.all() (label via labelFor(name, labels), email/plan via readAccountInfo and, for rows with a subscription identity, `usage` via `readClaudeUsage` (both through the private `claudeRowInfo(dir)`), shared via isSharedClaudeAccount for named rows); when currentDir() does not correspond to any account, appends a current row with kind='external' (name EXTERNAL_NAME, label labelFor(EXTERNAL_NAME, labels)); enabled always true; pendingDir always undefined
export function sidebarDisplay(): SidebarDisplay; // { email, fiveHour, weekly } from planswap.sidebar.showEmail / showFiveHourLimit / showWeeklyLimit, each default true
export function applySidebarDisplay(rows: AccountView[], display: SidebarDisplay): AccountView[]; // pure: drops `email` when hidden, and the general (unscoped) windows of 300 / 10080 minutes when hidden; a row left with no window gets no `usage`; the input rows are not changed
export function tildify(dir: string): string;  // replaces the home directory with ~ (case-insensitive on win32); file watchers are keyed by comparablePath, so two spellings of one file share a watcher
export function viewInfo(info: { email?: string; plan?: string; loggedIn: boolean }): Pick<AccountView, 'email' | 'plan' | 'loggedIn'>; // picks only these fields; the Codex source builds rows with ...viewInfo(readCodexAccountInfo(dir)) and the Claude source with ...claudeRowInfo(dir) (viewInfo of readAccountInfo plus `usage`), so the host-only identity key never reaches the Webview

export class AccountsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  constructor(extensionUri: vscode.Uri, sources: { claude: PanelSource; codex: PanelSource }, memento: vscode.Memento); // single instance; syncs file watchers immediately in the constructor
  readonly onDidChange: vscode.Event<void>;  // fires on every panel state push (including file watcher events), so the status bar can sync
  setHandler(mode: PanelMode, handler: (msg: FromWebview) => void | Promise<void>): void; // every message except ready / setTab is dispatched by msg.mode
  get visible(): boolean;                    // the panel is resolved and currently visible
  get activeTab(): PanelMode;                // memento key 'panel.activeTab', default 'claude'
  accounts(mode: PanelMode): AccountView[];  // sources[mode].accounts()
  resolve(mode: PanelMode, dir: string): (Account & { kind: AccountKind }) | undefined; // only searches accounts(mode) with samePath
  setSwitchedTo(label: string | undefined): void; // claude only: sets/clears the banner state and calls refresh()
  refresh(): void;                           // both pages: sync file watchers + push the full PanelState
  post(msg: ToWebview): void;                // silently dropped when the panel is not resolved
  focusAdd(mode: PanelMode): void;           // after executeCommand(`${VIEW_ID}.focus`): if ready, post({ type: 'focusAdd', mode }), otherwise queue it until ready
  resolveWebviewView(view: vscode.WebviewView): void;
  dispose(): void;
}
```
- `resolveWebviewView`: set `webview.html` (including CSP) before `webview.options`; the reverse order loads an empty page and logs "created a webview without a content security policy". `enableScripts: true`, `localResourceRoots: [<extension>/dist/media]`; the HTML references `codicon.css` (the `<link>` id must be `vscode-codicon-stylesheet`), `panel-style.css` and `panel.js` (with nonce). Incoming Webview messages are structurally checked before dispatch; malformed values are logged and ignored, and handler failures are logged and shown as `panel.actionFailed` instead of becoming unhandled rejections. On `ready` it pushes the state and handles a queued focusAdd; `setTab` only writes the memento, without pushing; it pushes the state when the panel becomes visible; when hidden it clears the ready flag so a replacement document must send `ready` before queued focus requests are delivered; when disposed it also clears the view reference. The initial HTML includes a localized loading status.
- CSP: `default-src 'none'; font-src <cspSource>; style-src <cspSource> 'unsafe-inline'; script-src 'nonce-<nonce>'`; the nonce is the base64 of `randomBytes(16)`, created anew each time the HTML is generated. `'unsafe-inline'` is needed because Lit components fall back to inline `<style>` when adoptedStyleSheets is not supported.
- File watchers: the watcher set = union of both `watchTargets()`, one `createFileSystemWatcher(new RelativePattern(Uri.file(dirname), basename))` per file; added/removed on refresh; watcher callbacks only push the state and do not resync the watchers, to avoid loops.
- State push: `post({ type: 'state', state: { active: activeTab, locale: getLocale(), claude: tabState('claude'), codex: tabState('codex') } })`, then fire `onDidChange`. A locale change triggers `refresh()` (see extension.ts).

## src/webview/i18n.ts (frontend i18n)

```ts
export type Locale = PanelState['locale'];
export const en: { ... };                                  // English table, the source of truth
export type MessageKey = keyof typeof en;
export const zhCn: Record<MessageKey, string>;             // same keys as en (key-parity rule)
export const es: Record<MessageKey, string>;
export const ja: Record<MessageKey, string>;
export function getLocale(): Locale;
export function setLocale(locale: Locale): void;           // unknown locale falls back to 'en'
export function t(key: MessageKey, params?: Record<string, string | number>): string; // `{name}` placeholders
```
- The HTML `lang` attribute matches the current locale at startup and after language changes.
- `main.ts` calls `setLocale(state.locale)` when a `state` message arrives, so `t()` always uses the locale of the most recent state.
- Keys added with the usage refresh buttons: `usage.refreshTitle`, `usage.refreshAllTitle`.
- All Webview strings go through it: tabs, section titles, banners, buttons, titles/tooltips, aria-labels, placeholders, help text, validation messages, version card, disabled Codex page, tools.

## src/webview/main.ts (frontend, no exports)

- Imports `index.js` of `vscode-button`, `vscode-checkbox`, `vscode-textfield`, `vscode-toolbar-button` and `vscode-icon` under `@vscode-elements/elements/dist/` (registers only the needed components, not the whole package; the count badge is a plain `span`, not `vscode-badge`).
- Sends `FromWebview` through `acquireVsCodeApi().postMessage`; receives `ToWebview` via the `window` `message` event. Every message to the host (except `ready`) carries `mode`.
- Top tab bar: two tab buttons Claude / Codex, the selected one highlighted; a click → sends `setTab` and switches rendering; the current tab is remembered in the Webview state with `vscode.setState({ tab })`, and `state.active` is only adopted when there is no local record; on `focusAdd` it switches to its `mode` (also sending `setTab` if needed) and focuses that page's input.
- On startup it uses the host-provided HTML language and renders a loading status (without an account count, disabled-Codex message or add form) until the first state arrives; it sends `ready` immediately after its initial render. On `state`, a page keeps its existing DOM when neither its state nor the locale changed; a rebuild remembers the focused row/action and restores focus, preserving keyboard navigation, screen-reader alerts and IME composition across ordinary state pushes. An open rename field regains focus only if it held focus before the rebuild; an invalid rename left open must not steal focus from the add input or another control. The add section and the "Tools" section exist once per page and keep independent input state. When `state.locale` changes, every static text (including the add-section help text, the "Tools" section, the footer toolbar titles and the version card) is re-rendered in the new language.
- Page structure: `#app` (scrollable) contains the tab bar + two `.page` elements (each with `.page-top`: banner / disabled card / loading line; the list section, created once so the add form keeps its focus: heading with the `.count` badge and the `.add-toggle` "+ Add" button (`aria-expanded`, `aria-controls` the form, `aria-label` `t('add.title')`), the `.add` form (collapsed by default; `focusAdd` expands and focuses it, Escape and a successful add collapse it, an add error expands it) and the `ul.list`; `details.page-tools`: the "Tools" section, collapsed by default and re-created with its open state on a locale change); outside `#app` follow the version card `.versions` (hidden by default), the pinned footer toolbar `.tools`, and the extension version line `.extension-version`.
- Per-page "Tools" section: four `vscode-button`s on each page (secondary, icon and text): `symbol-ruler` + `CLAUDE.md`/`AGENTS.md` (title "Open global CLAUDE.md"/"Open global AGENTS.md") → `tool: 'openGlobalMd'`; `settings-gear` + "Settings" (title "Open Claude Code extension settings"/"Open Codex extension settings") → `'openSettings'`; `sync` + "Re-link" (title `claude.syncTitle` "Re-link every linked account to the default account's settings, rules, skills, history and sessions, and mirror its MCP servers" / `codex.syncTitle` "Re-link every linked account to the default account's settings, rules, skills, history, sessions and thread databases") → `'sync'`; `cloud-download` + "Update CLI" (title "Update CLI in a terminal") → `'updateCli'`. Messages carry the page's `mode`; shown on the Codex page even while it is not enabled.
- Pinned footer toolbar: five `vscode-toolbar-button`s in three groups divided by `.tools-sep` separators (`role="separator"`), left to right `info` "Show CLI and extension versions" → 'cliVersions', `book` "User guide" → 'openHelp' | `refresh` "Reload Window" → 'reloadWindow', `debug-restart` "Restart Extension Host" → 'restartExtHost' | `star-empty` "Star" → 'openStar'; `mode` is the current tab. No Codex restart control is rendered.
- Below the footer toolbar, `.extension-version` shows `t('footer.version', { version: __PLANSWAP_VERSION__ })` as a centered small-text line. `esbuild.mjs` defines `__PLANSWAP_VERSION__` from the manifest version at build time; the frontend imports no manifest or Node modules.
- Version card: on `versions`, if the card is expanded it collapses, otherwise it is filled with the title "CLI and extension versions" + close button and the `items` (each `.version-item`: `.version-label` on one line, `.version-value` on the next) and shown; the close button hides the card. Item labels come from the host (localized there); when `state.locale` changes while the card is expanded, the frontend sends `tool: 'cliVersions'` again and replaces the items with the next `versions` instead of collapsing.
- Account row rendering: the current row is always first; 20px flat avatar (the default row shows a `home` icon instead of the letter, title "Default account"); right after the name a shared row (`kind === 'named' && shared === true`) has a 16px `link` badge (`shared-icon`, title "Linked to the default account's settings, rules, skills, history and sessions", not in edit state); the current row has no badge or text tag (`aria-current="true"` on its `li`); email line with the email ("Logged in" when there is no email but `loggedIn`, nothing when signed out); `.row-foot` holds the tag group (plan pill + "Not logged in" pill; CSS places it at the right end of the name line) and the button group (non-current rows start it with a `vscode-toolbar-button.icon-btn` with the `arrow-swap` icon (no visible text, title and label `row.switch`, `data-action="switch"`, ignores the second click of a double-click), then "Log in" for signed-out rows, then the icon buttons); the `li` has `data-plan` (the frontend maps the `plan` text and `mode` to `none` / `apikey` / `team` / `enterprise` / `tier0` / `tier1` / `tier2` / `tier3`); the `li` has `title` = `dirLabel` (omitted in edit state); emails and plan pills have no `title`. Non-current rows that are not in edit state get `tabindex=0`; double-click or Enter sends `switch`.
- It only renders and exchanges messages; business logic and validation are authoritative on the extension side; frontend validation (`NAME_RE`, the reserved name `default`, clashes with `name` or `label` of the page's `accounts`, and the 32-grapheme label limit) is only an immediate hint.
- All text is written through `textContent`, never by concatenating HTML. Rows show `label` (not `name`), `email` and `plan`.
- Usage refresh buttons: in each page's list heading, before the "+ Add" toggle, icon buttons (`vscode-toolbar-button`, title and `aria-label` from the same key; they wrap below the heading when narrow): `refresh` (`usage.refreshTitle`, both pages) → `tool: 'refreshUsage'`, and `layers` (`usage.refreshAllTitle`, both pages) → `tool: 'refreshAllUsage'`. `refresh` is hidden unless the current row has `usageEligible`; `layers` is hidden unless some non-external row has it; both are hidden while the page is disabled. They have no pending state (the host joins concurrent queries).
- Usage card (`usageHistory`): rendered on both pages from `AccountView.usage` (remaining percentage = `100 - usedPercent`, progress bar, collection time on hover; each window (`data-level` set on it and its track) is a label line with the duration and, at its right, a `clock` icon plus the short duration from a local copy of `relativeReset` (title `t('usage.resetsIn', { time, date })`), then the progress bar with `${remaining}%` (title `t('usage.remaining')`) at its right; the track's `aria-valuetext` joins `t('usage.remaining')`, `t('usage.exhausted')` at 0% and the reset sentence; a window at 0% remaining gets `data-level="empty"`, a red bold reset time and no visible tag); a window with `scope` is labelled `t('usage.scoped', { limit, scope })`, and such windows (sent only when `planswap.sidebar.showModelLimits` is enabled) are rendered after the general ones as ordinary windows, never folded.
- Every row with `kind === 'named'` has a 16px pencil button right after the name (`rename-btn`, title "Rename", inside the nowrap `name-tail` span with the last grapheme of the label and the shared badge; transparent until the row is hovered or focused; not in the button group): a click turns the name into an input (prefilled with the current `label`); the edit state is keyed by the row's `dir` (`renamingDir`); Enter, the save button after the input (`rename-save`, `check` icon, title "Save (Enter)") and blur all call `commitRename`: unchanged value → leave edit mode without a message, invalid → stay with the reason, otherwise send `rename` (with `dir` and `label`); Esc cancels; the edit line keeps the name line's pre-edit height (`renameTitleHeight` → `--rename-h`) and the button group stays hidden in place so the card height does not change; on `renameResult` only the one whose `dir` matches the row being edited is handled: with `error` it is shown in red inline, without `error` edit state ends. When that directory disappears from the state, the edit state is cleared. The default row and the external-directory row have no pencil button.
- A named row with `shared === false` that is not current has a `link` toolbar button (title "Link to the default account: its settings, rules, skills, history and sessions move into the default account and are linked from then on; the login stays separate") that sends `{ type: 'share', dir }`; the host confirms, so the frontend has no confirmation of its own.
- A named row with `shared === true` that is not current has a `debug-disconnect` toolbar button (title "Unlink from the default account: the links are removed and the account gets its own copy of the default configuration; history and sessions stay in the default account") that sends `{ type: 'unshare', mode, dir }`.
- Add section: under the input a `vscode-checkbox` (`add-shared`, label "Link to the default account's settings and history", checked by default, created once per page so its state survives re-renders); the help line for a valid name is `claude.addHelpShared` / `codex.addHelpShared` (per page; the Codex text says memories stay per account) or `add.help.independent` depending on it; submitting sends `{ type: 'add', name, shared: checkbox.checked }`.
- Local UI state: `confirmingDir` (directory of the account being confirmed for removal inline; cleared when it disappears from the state; Cancel or Escape restores focus to that row's remove button), `adding` (an add was submitted, waiting for `addResult`), `renamingDir` and rename-pending/error state (directory of the account being renamed inline; a new edit does not inherit an earlier pending submission), all per page.
- On `addResult`: success clears that page's input; failure shows `error` in the help line.

## src/statusBar.ts

```ts
export class StatusBar implements vscode.Disposable {
  constructor(store: AccountStore, labels: LabelStore, codex?: { store: CodexAccountStore; labels: LabelStore });
  update(): void;   // right-aligned; shows configured vendors only, with a per-vendor usage table tooltip; Codex reports a pending selection only while switching is enabled; click opens PlanSwap
  setCodexUsage(state: CodexUsageState | undefined): void; // stores the CodexUsageMonitor state and re-renders; undefined hides the usage lines
  setClaudeUsage(state: ClaudeUsageState | undefined): void; // stores the ClaudeUsageMonitor state and re-renders; undefined hides the checking and failure lines (the cached values are re-read from the info file on every update)
  dispose(): void;
}
export const REFRESH_USAGE_COMMAND = 'planswap.codex.refreshUsage';
export const CLAUDE_REFRESH_USAGE_COMMAND = 'planswap.claude.refreshUsage';
export const CLAUDE_REFRESH_ALL_USAGE_COMMAND = 'planswap.claude.refreshAllUsage';
export const CODEX_REFRESH_ALL_USAGE_COMMAND = 'planswap.codex.refreshAllUsage';
// Pure helpers (no I/O; localized through t())
export function escapeMarkdown(text: string): string; // escapes markdown and theme-icon metacharacters (including `$`, `&`, `<`, `>`) and flattens line breaks: the only way outside text enters the tooltip
export function remainingOf(w: { usedPercent: number }): number; // clamp(floor(100 - usedPercent), 0, 100)
export function usageBar(remaining: number): string; // always 10 cells of █/░ (one Unicode block, so both glyphs share a width); at least one █ while remaining > 0
export function shortWindow<W extends { usedPercent: number; windowMinutes?: number; scope?: string }>(windows: readonly W[]): W | undefined; // general (no scope) window with the smallest windowMinutes; else the first general one; undefined without one
export function backgroundIdFor(lowest: number | undefined): 'statusBarItem.errorBackground' | 'statusBarItem.warningBackground' | undefined; // <= 10 error, <= 30 warning
export function relativeReset(epochSeconds: number, now?: number): string; // short duration until the reset in the UI locale (Intl.DurationFormat, narrow; short for Japanese): days + hours from a day, hours + minutes from an hour, else minutes; a zero unit left out, rounded up to the minute, at least one minute; NumberFormat units as fallback. The Webview keeps a copy
export function statusText(parts: ReadonlyArray<{ product: string; remaining?: number }>): string; // "Claude 97% · Codex 82%" via status.textUsage; a product without remaining shows its name only
export function statusAccessibilityLabel(parts: ReadonlyArray<{ product: string; remaining?: number }>): string; // "PlanSwap: Claude 97% left, Codex" (status.remainingShort)
export function windowRow(w: UsageWindow | ClaudeUsageWindow, index: number, now?: number): string; // one table row `| name | bar | remaining% | relative reset |` (the percentage cell gets ` $(warning) ` + status.exhausted at 0%): name `5h`, `#n` without a duration, "{window} · {scope}" for a scoped one; reset cell `$(clock) ` + relativeReset, empty without a reset time
export interface TableBlock { identity: string; plan?: string; refresh?: string; rows: readonly string[]; notes: readonly string[] }
export function usageTable(blocks: readonly TableBlock[]): string; // all products as one table so columns align: per block a header row `| identity | | | plan refresh |` (identity escaped here, plan escaped here, refresh = refreshLink, last cell right-aligned), bold (`**…**`) for every block after the first; the alignment row `|:--|:--|--:|--:|` after the first header; then the block's window rows and its notes as rows `| note | | | |`
export function liveCodexUsage(usage: CodexUsage, now?: number): CodexUsage | undefined; // undefined when older than 24 h (or dated more than 2 minutes ahead); windows past their reset removed
export interface UsageParts { rows: string[]; notes: string[] } // table rows and the italic status lines below the table
export function codexUsageParts(state: CodexUsageState | undefined, now?: number): UsageParts; // rows: windows (liveCodexUsage) sorted by duration; notes: `$(warning)` + status.usageReached, status.usageFailedShort (any failure except notLoggedIn), status.usageChecking while checking; empty for a signed-out result
export function claudeUsageParts(usage: ClaudeUsage | undefined, state: ClaudeUsageState | undefined, dir: string, now?: number): UsageParts; // rows: the general windows sorted by duration, without scoped windows; notes: status.usageChecking, else status.usageFailedShort for a failure recorded for `dir` only
export function claudeUsageFailureText(failure: { reason: ClaudeUsageFailure; detail?: string }, hasUsage: boolean): string; // the localized plain text of one failed query, used by the refresh-all warning; hasUsage: older values are still shown (a `notRefreshed` failure without values says it could not be refreshed, without pointing at shown values; `failed` without detail gives the unknown-error text)
export function codexUsageFailureText(failure: { reason: UsageFailure; detail?: string }): string; // the localized plain text of one failed Codex query, used by its refresh-all warning: notLoggedIn / authExpired / cliMissing / timeout have their own text, `failed` with detail 'discarded' says the sign-in changed during the check; others give status.usageFailed with the detail (or the reason), `failed` without detail the unknown-error text
```

The status bar shows a vendor when its effective configuration directory or a registered account directory exists. Claude also recognizes its resolved `.claude.json` file. It does not require network access or a signed-in account. When neither vendor is present, the item is hidden. Codex initialization failure omits Codex without affecting Claude. Registered rows are matched with `findSameDir`, so alternate spellings retain their registered label; a signed-in account without an email shows "Logged in". Codex identity comes from `effectiveDir()`, never from the pending selection. The pending line is added only when switching is enabled and the selected and effective directories differ by `findSameDir`; an unreadable or disabled switching configuration shows no pending line. `update()` sets `item.text` to `$(dashboard) ` + `statusText(parts)` (no account label), `item.name = 'PlanSwap'`, `item.accessibilityInformation = { label: statusAccessibilityLabel(parts), role: 'button' }` and `item.backgroundColor` to `new vscode.ThemeColor(backgroundIdFor(lowest))` or `undefined`. A product's `remaining` is `remainingOf(shortWindow(windows))` of the Claude cache (subscription sign-in only, `readClaudeUsage`) or of `liveCodexUsage` windows (signed-in, not API key, not `codexRunsInWsl()`, successful result); `lowest` is the minimum `remainingOf` over all general windows of both products (never model-specific ones). The tooltip is a `MarkdownString` (`supportThemeIcons`) trusting only `planswap.claude.refreshUsage` and `planswap.codex.refreshUsage` (`isTrusted.enabledCommands`), built with `appendMarkdown` from strings that were escaped when the block was assembled: emails, plans, labels and model names go through `escapeMarkdown`, and only our own markup (the table, italics, bars, `$(warning)`, `refreshLink(command)` = `[$(refresh)](command:<id> "<status.refreshUsage>")`) is unescaped. Each vendor forms one block of a single `usageTable(blocks)` (the refresh link follows the plan in the header's last cell; notes are italic rows after the window rows), so the columns of both vendors line up. `identity` is the email; without one, a Codex API key account gets "API key" (and no plan), another signed-in account its label, a signed-out one `common.notLoggedIn`. The Codex block takes rows and notes from `codexUsageParts` only for a signed-in, non-API-key account and not when `codexRunsInWsl()` (then the `status.codexRunsInWsl` note instead); a pending selection adds `status.codexPending` first; behavior in [Codex design 8.7](codex-design.md#87-usage-limits). The Claude block takes `claudeUsageParts(readClaudeUsage(dir, explicit), claudeState, dir)` only when `readAccountInfo(dir, explicit).identity` exists (a subscription sign-in). The Claude block gets the Claude refresh link when it shows usage and the usage monitor is set; the Codex block gets the Codex refresh link when it shows usage and its usage state is set. The background color no longer adds a line to the tooltip. Behavior in [Claude design 5.4 / 6.9](design.md#54-status-bar).

## src/commands.ts

The extension is authoritative for business logic and validation. Validate panel account directories through `panel.resolve` and account names through `validateName`; frontend validation is only immediate feedback. Catch setting-update failures (`config.update` / `setConfigDir`) and show an actionable reason; preserve the other environment entries as specified by `claudeSettings.ts`.

```ts
export interface Deps {
  store: AccountStore;
  panel: AccountsPanel;
  statusBar: StatusBar;
  labels: LabelStore;                    // claude.labels
  codex?: { store: CodexAccountStore; labels: LabelStore };  // the refresh command acts on both pages; labels is codex.labels (for syncWithDisk)
  tools: ToolDeps;                       // panel tool messages are passed to runTool('claude', tool, tools)
  procRoot?: string;                     // root of the process tree for the busy checks (claudeAccountBusy / ensureClaudeLinks / migrateClaudeToShared); tests pass a fake, product code leaves the default '/proc'
  provideTerminalCheck?: (check: TerminalCheck) => void; // receives this module's account-terminal-open check for toolbar Re-link busy protection
}
export function registerCommands(deps: Deps): vscode.Disposable[];
export function validateName(name: string, store: AccountStore, labels: LabelStore): string | undefined;
export function shQuote(s: string): string;
export function hasControlChars(s: string): boolean; // C0 or DEL; a directory containing one is never typed into a Linux shell command
```
- Command ids: `planswap.switchAccount`, `planswap.addAccount`, `planswap.shareAccount`, `planswap.removeAccount`, `planswap.openTerminal`, `planswap.refresh`. None of the commands take arguments:
  - `switchAccount`: QuickPick of the non-current `store.all()` accounts, then switch;
  - `addAccount`: only calls `panel.focusAdd('claude')`;
  - `shareAccount`: QuickPick of independent `store.named()` accounts excluding `inUse` directories, then the existing `shareAccount` confirmation/conversion flow;
  - `removeAccount`: QuickPick of `store.named()` without the current account, then remove (with modal confirmation);
  - `openTerminal`: QuickPick of `store.all()`, plus the directory when the current one is external;
  - `refresh`: `await store.syncWithDisk(labels)` (and `codex.store.syncWithDisk(codex.labels)`), then `panel.refresh()` + `statusBar.update()`.
- QuickPick items, messages and terminal names always use `labelFor(account.name, labels)`; logic still uses name / dir. Without an email, a QuickPick item uses the account's `loggedIn` flag to choose "Logged in" or "Not logged in". All QuickPick texts and messages come from `t()`.
- `validateName` (exported so it can be unit-tested): empty / does not match `NAME_RE` / `sameName` as `default` / `sameName` as the name of any account in `store.all()` ("An account with this name already exists") / `sameName` as `labelFor(a.name, labels)` of any account in `store.all()` ("Same as an existing account's display name") / `sameRealPath(accountDir(name), defaultDir())` / `realPathInside(accountDir(name), defaultDir())` / `accountDir(name)` exists as a symbolic link (`lstat`; "This account directory is a symbolic link", consistent with `scanAccountDirs` skipping symlinks). Only checks Claude accounts. Messages come from `t()`.
- Calls `panel.setHandler('claude', ...)` to handle panel messages: `switch`/`terminal`/`remove`/`rename` are first verified with `panel.resolve('claude', dir)`; `switch` (ignored for the current row) asks the modal `t('claude.switchConfirm', { label })` with the button `t('claude.switchButton')` before `switchTo` (the Command Palette pick has no extra confirmation); `remove` only handles `kind === 'named'` and counts as confirmed (no first modal); `add` runs the add flow on the trimmed name with `shared = msg.shared !== false` and `panel.post({ type: 'addResult', mode: 'claude', error })`; `share` and `unshare` are verified with `panel.resolve('claude', dir)` and only handle `kind === 'named'` (conversions below); `rename` only handles rows with `kind === 'named'` → `labels.validate(label, account.name, store.all().map(a => ({ name: a.name, label: labelFor(a.name, labels) })))`; on error `post({ type: 'renameResult', mode, dir, error })`, otherwise `labels.set(account.name, <trimmed value>)` (deletes the entry when it equals `account.name`) → refresh the panel and the status bar → `post({ type: 'renameResult', mode, dir })`; `reload` runs `workbench.action.reloadWindow`; `dismissBanner` calls `panel.setSwitchedTo(undefined)`; `tool` calls `runTool('claude', msg.tool, tools)`.
- Adding an account: `validateName` → `ensureAccountDir` (on failure returns "Failed to create account directory: <reason>") → shared: ask once for the Windows copy fallback, then `ensureClaudeLinks(account.dir, '/proc', { ...linkOptions, busy: linkBusy(account) })` + `mirrorClaudeJsonInto(defaultJson(), account.dir)` (exact mirroring only when the directory is truly shared; otherwise additive `syncMcpServers`, so an existing folder's own servers are preserved); a non-empty `describeShareReport` → `showWarningMessage(t('share.addNotes'))` (a neutral result message, not a claim that every link succeeded); independent: `copyClaudeIndependent(defaultJson(), account.dir)`; an exception of this step only warns and does not block `store.add`; the handler always posts `addResult`. `defaultJson()` is `claudeJsonPath(defaultDir(), isExplicitConfigDir(defaultDir()))`.
- Switching: after the "already current" check, a non-`default` target whose directory does not exist (`!fs.existsSync(dir)`) → `showErrorMessage(t('account.dirMissing', { dir }))` and return false; when the target is not `default` and `isSharedClaudeAccount(dir)`, first `ensureClaudeLinks(dir, procRoot, { busy: linkBusy(account) })` + `mirrorClaudeJsonInto`; a non-empty report (including entries left under `busy`) or an exception → `showWarningMessage(t('share.refreshWarning'))`; then `setConfigDir`.
- Conversion (`share`): ignored for `default` or an already shared account; the current account → `showWarningMessage(t('share.current'))`; modal `t('share.confirm', { label, dir })` with button `t('share.confirmButton')`; after the modal, re-check current-account and busy state (including the account terminal), ask for the Windows copy fallback, then `migrateClaudeToShared(..., options)` + `mirrorClaudeJsonInto` → `showInformationMessage(t(isSharedClaudeAccount(dir) ? 'share.done' : 'share.incomplete', { label, summary: describeShareReport(report) || t('share.nothingElse') }))`; an exception → `showErrorMessage(t('share.failed'))`; then refresh.
- Conversion back (`unshare` → `unshareAccount`): ignored for `default` or an account that is not shared; the current account → `showWarningMessage(t('unshare.current'))`; modal `t('unshare.confirm', { label, dir })` with button `t('unshare.confirmButton')`; after the modal, re-check current-account and busy state (including the account terminal); `makeClaudeIndependent(defaultJson, dir)` → `showInformationMessage(t('unshare.done', { label, removed: <count>, copied: <list or t('unshare.nothingCopied')> }))`; an exception → `showErrorMessage(t('unshare.failed'))`; then refresh.
- Removing an account also calls `labels.remove(name)` besides `store.remove(name)`; the display name for the delete-directory prompt and whether the account is shared (`isSharedClaudeAccount`) are captured before the alias is cleared; the prompt's detail is `t('claude.removeDirDetailShared')` for a shared account, otherwise `t('claude.removeDirDetail')`. After `deleteAccountDir` succeeds, `store.unignore(dir)` is called (a failed deletion keeps the directory in `ignoredDirs` and shows `t('account.deleteDirFailed')`).
- After a successful switch, call `panel.setSwitchedTo(label)` and `statusBar.update()`; when `!panel.visible`, also show a notification with a "Reload Window" button.
- The current account cannot be removed (another spelling of the current directory counts, `sameRealPath`), nor can a busy account (a matching Claude process or, on Windows, its PlanSwap terminal). These guards run before the first confirmation, after the Command Palette confirmation and again after the directory-deletion confirmation; deletion only goes through `deleteAccountDir`.
- Behavior details in design.md section 6.
- This module keeps its own set of "terminals created by this extension" and registers `onDidCloseTerminal`: on a match it calls `panel.refresh()` and `statusBar.update()`; the login-not-landed warning is shown only while the named account is still registered, its directory exists and `readAccountInfo(dir, isExplicitConfigDir(dir)).loggedIn` is false. Opening a terminal for a signed-out account shows `showInformationMessage(t('account.loginTip', { vendor: 'Claude' }))`. A non-default Linux terminal is refused when its directory contains a C0 or DEL control character.

## src/extension.ts

```ts
export async function activate(ctx: vscode.ExtensionContext): Promise<void>;
export function deactivate(): void; // no deferred restart work
```
`await migrateLegacyLanguage(ctx.globalState)` → `setLocale(resolveLocale())` first, so every string below is localized → platform guard (`!isSupportedPlatform()`, i.e. not linux / win32: `showWarningMessage` once with the localized "PlanSwap only supports WSL/Linux and Windows.", then return) → `state = new FileMemento()` → `await state.importOnce(ctx.globalState)` → `new AccountStore(state)` → `claudeLabels = new LabelStore(state, 'claude.labels')` → `await store.syncWithDisk(claudeLabels)` → `codexLabels = new LabelStore(state, 'codex.labels')` → `migrateLegacyCodex()` in its own try/catch (on error: `showWarningMessage(t('ext.codexLegacyFailed', { error }))`, continue) → Codex initialization (`new CodexAccountStore(state)` + `syncWithDisk(codexLabels)` + `codexPanelSource(codexStore, codexLabels, usageHistory)`, `codex = { store: codexStore, labels: codexLabels }`; on failure only `console.error`, remember `codexInitError`, and the Codex page degrades to `{ accounts: () => [], enabled: () => false, pendingDir: () => undefined, watchTargets: () => [] }`) → `new StatusBar(store, claudeLabels, codex)` → assemble `tools: ToolDeps = { codexRestart: codex ? restartServerInteractive : undefined, postVersions: (items) => panel.post({ type: 'versions', items }), claudeDirs: () => store.named().map(a => a.dir), codexDirs: codex ? () => codex.store.named().map(a => a.dir) : undefined, codexShareOps: codex ? { isShared: isSharedCodexAccount, refresh: ensureCodexLinks } : undefined, labelOf: (mode, dir) => labelFor of store.findByDir(dir) / codex.store.findByDir(dir) with claudeLabels / codexLabels, else path.basename(dir) }` → `new AccountsPanel(ctx.extensionUri, { claude: claudePanelSource(store, claudeLabels), codex: codexSource }, ctx.globalState)`, `registerWebviewViewProvider(VIEW_ID, panel)` → if `codexInitError`: `panel.setHandler('codex', msg => msg.type === 'tool' ? runTool('codex', msg.tool, tools) : showErrorMessage("Codex account switching is unavailable: <reason>"))`, and the 10 `planswap.codex.*` commands are registered to show the same error → `registerCommands({ store, panel, statusBar, labels: claudeLabels, codex, tools })`, (when Codex is healthy) `registerCodexCommands({ store, panel, labels: codexLabels, tools })`, `registerToolCommands(tools)` → `panel.onDidChange` → `statusBar.update()` + `identityWarnings.check()` (+ the Codex usage re-check below) → `onDidChangeConfiguration(affectsSetting)` → `setClaudeSettingEnv(settingEnvNames())` + `panel.refresh()` + `statusBar.update()` + `checkUsage()` → `watchLocale(() => { panel.refresh(); statusBar.update(); })` → `new IdentityWarnings(sources)` (Claude, plus Codex when initialized) and `check()` → when Codex is initialized, the `CodexUsageMonitor` wiring of [Codex interfaces](codex-interfaces.md#srcextensionts) → everything pushed to `ctx.subscriptions`.

Claude usage limits ([Claude design 6.9](design.md#69-claude-usage-limits)), always wired: `claudeUsage = new ClaudeUsageMonitor(currentDir, (s) => { statusBar.setClaudeUsage(s); if (!s.checking) panel.refresh(); }, { query: (dir) => claudeQueue(() => queryClaudeUsage(dir, isExplicitConfigDir(dir), { env: settingEnv() })), eligible: (dir) => readAccountInfo(dir, isExplicitConfigDir(dir)).identity !== undefined /* signed-out: nothing started */, cachedAt: (dir) => readUsageFetchedAt(dir, isExplicitConfigDir(dir)) })`, `statusBar.setClaudeUsage(claudeUsage.current())`. The monitor's `staleMs` is `() => usageSchedule('claude').staleMs`. The shared `checkUsage()` returns unless `vscode.window.state.focused`, then calls `claudeUsage.refreshIfStale()` when `usageSchedule('claude').auto` and, when Codex usage is wired, not `codexRunsInWsl()` and `usageSchedule('codex').auto`, the Codex monitor's `refreshIfStale()`; a change of any `planswap.<product>.usageAutoRefresh` / `usageRefreshMinutes` setting also runs `checkUsage()`; it runs 5 s after activation, every 60 s, on regaining focus and after a `claudeCode.environmentVariables` change (so a switch is checked at once). `panel.onDidChange` (account-info changes, e.g. a sign-in) also calls `claudeUsage.refreshIfStale()` when focused and `usageSchedule('claude').auto`, but only once `checkUsage()` has run (not during start-up). `planswap.claude.refreshUsage` (`CLAUDE_REFRESH_USAGE_COMMAND`) → `claudeUsage.refresh()`. `planswap.claude.refreshAllUsage` (`CLAUDE_REFRESH_ALL_USAGE_COMMAND`) → `refreshAllClaudeUsage()`, manual only: a re-entrancy flag ignores a second call while one runs; targets are `store.all()` accounts whose `readAccountInfo(...).identity` exists, as `{ dir, label: labelFor(name, claudeLabels) }` (the unregistered external directory is excluded); with none, `claude.usageAllNone` is shown. `vscode.window.withProgress` (notification, cancellable, message `claude.usageAllProgress`) runs `queryEach`; cancellation aborts an `AbortController` whose signal is passed to each query (ending the running child) and is `queryEach`'s `cancelled`. Every directory goes through `claudeQueue(() => queryClaudeUsage(dir, isExplicitConfigDir(dir), { env: settingEnv(), signal }))`, where `claudeQueue = oneAtATime()` is also used by the monitor's `query`, so the window never runs two `claude` usage processes at once; an un-aborted result is passed to `claudeUsage.record(dir, result)`. Afterwards `panel.refresh()` + `statusBar.update()`; results ended by the cancellation are dropped; then `claude.usageAllCancelled` (when cancelled) or `claude.usageAllDone` (no failure), and the warning `claude.usageAllFailed` when any account failed, naming at most three as `label (claudeUsageFailureText(result, readClaudeUsage(dir, explicit) !== undefined))` joined with "; " plus `claude.usageAllMore`. The existing 60-second `panel.refresh()` timer also re-renders Claude windows at their reset time. The timers are cleared on dispose.

## src/tools.ts (tools: footer toolbar and per-page "Tools" section, 2026-09-26)

Shared tools live in the footer toolbar pinned to the bottom of the panel, tab-specific tools in each page's "Tools" section; both pages share one host implementation; `openGlobalMd`, `openSettings`, `sync` and `updateCli` depend on the mode, the others do not.

```ts
export interface ToolDeps {
  codexRestart?: () => Promise<void>;   // provided by codexCommands.restartServerInteractive (modal confirmation + planRestart checks for Antigravity / VSCodium; manual-restart warning only for VS Code / unknown editors); undefined when Codex is not initialized
  postVersions?: (items: Array<{ label: string; value: string }>) => void; // panel entry: pushes the version info to the sidebar; the Command Palette entry passes undefined and uses a QuickPick instead
  claudeDirs?: () => string[];          // directories of store.named() on the Claude side (for sync)
  codexDirs?: () => string[];           // directories of store.named() on the Codex side; undefined when not initialized
  codexShareOps?: ShareOps;             // { isShared: isSharedCodexAccount, refresh: ensureCodexLinks }; undefined when Codex is not initialized
  labelOf?: (mode: PanelMode, dir: string) => string; // display name for notifications: labelFor of the registered account of that vendor, falling back to path.basename(dir)
  accountBusy?: (mode: PanelMode, dir: string) => boolean; // extra per-account busy guard passed to Re-link (Windows account terminal)
}
export interface ShareOps {
  isShared(dir: string): boolean;
  refresh(dir: string, options?: LinkOptions): ShareReportLike; // re-links the account and mirrors what the vendor mirrors; returns the link report
}
export type TerminalCheck = (dir: string) => boolean;
export function mirrorClaudeJsonInto(fromJson: string, dir: string): void; // exact mirror only for a truly shared account; otherwise additive syncMcpServers
export function runTool(mode: PanelMode, tool: ToolId, deps: ToolDeps): Promise<void>; // shared entry for panel tool messages and the Command Palette; 'refreshUsage' runs planswap.claude.refreshUsage (mode claude) or planswap.codex.refreshUsage (codex); 'refreshAllUsage' runs planswap.claude.refreshAllUsage (mode claude) or planswap.codex.refreshAllUsage (codex)
export function registerToolCommands(deps: ToolDeps): vscode.Disposable[];
//   planswap.openSettings → workbench.action.openSettings('@ext:n2ns.planswap') (view title bar and Command Palette);
//   planswap.tools.openClaudeMd → runTool('claude','openGlobalMd'); openAgentsMd → runTool('codex','openGlobalMd');
//   openSettings → QuickPick (Claude Code / Codex), then runTool(mode,'openSettings'); reloadWindow / restartExtHost → runTool('claude', …);
//   cliVersions → runTool('claude','cliVersions', { ...deps, postVersions: undefined }) (read-only QuickPick list);
//   sync → QuickPick (Claude Code / Codex, placeHolder t('tools.pick.sync')), then runTool(mode,'sync').
//   Restarting the WSL server reuses planswap.codex.restartServer and is not registered here
```

Tool behavior (all texts via `t()`):
- `openHelp` / `openStar`: footer-only actions; call `vscode.env.openExternal` with `https://github.com/n2ns/planswap#readme` / `https://github.com/n2ns/planswap`. Both only open the corresponding GitHub page; no GitHub account action is performed.
- `updateCli`: panel-only action; creates and shows a terminal named with `t('tools.updateCli', { vendor: 'Claude' | 'Codex' })`, sends `claude update` for Claude or `env -u CODEX_HOME codex update` for Codex. No pre-check, account-state write or process-environment mutation; update progress and interaction stay in the terminal. Available even when Codex switching is disabled or uninitialized.
- `openGlobalMd`: claude → `<currentDir()>/CLAUDE.md`; codex → `<effectiveDir()>/AGENTS.md`. When the file does not exist, a modal asks "File does not exist. Create it?\n<target>" (button "Create"); on confirmation `writeFileSync(target, '', { mode: 0o600, flag: 'wx' })`, where `target` is the link target (resolved against the real path of the link's directory) when `file` is a dangling symlink to a file of the same name, otherwise `file`, and then `showTextDocument`; create / open failures → `showErrorMessage`.
- `openSettings`: `workbench.action.openSettings` with the argument `claudeCode.` (claude) or `chatgpt.` (codex).
- `reloadWindow`: `workbench.action.reloadWindow`, no confirmation.
- `restartExtHost`: `workbench.action.restartExtensionHost`, no confirmation.
- `restartServer`: calls `deps.codexRestart`; when undefined, `showWarningMessage("The Codex part is not initialized; cannot restart.")`.
- `cliVersions`: `collectVersions()` runs `execFile('claude', ['--version'], { timeout: 8000 })` and `execFile('codex', …)` in parallel (no shell, PATH inherited from the extension host; on win32 `where.exe <cmd>` first (exit code 1 → "Not found"), then `<cmd> --version` as one command line with `shell: true` so npm `.cmd` shims resolve; ENOENT → "Not found", killed by the timeout → "Timed out", other → "Failed: <first line>", no output → "(no output)"), then reads `vscode.extensions.getExtension('anthropic.claude-code')?.packageJSON.version` and `getExtension('openai.chatgpt')?.packageJSON.version` (non-string → "Not found"). Returns four items: `Claude Code CLI`, "Claude Code extension", `Codex CLI`, "Codex extension" (the two extension labels are localized). With `deps.postVersions` it pushes `{ type: 'versions', items }` (shown by the frontend as the version card), otherwise `showQuickPick` (`label` / `description`, placeHolder "CLI and extension versions (display only)", selecting does nothing). No network access, no update check.
- `sync`: Claude uses the built-in `ShareOps` (`isSharedClaudeAccount`; refresh = `ensureClaudeLinks` + `mirrorClaudeJson(claudeJsonPath(defaultDir(), isExplicitConfigDir(defaultDir())), dir)`), Codex uses `deps.codexShareOps`; without the directory list or the ops, `showWarningMessage(t('tools.syncNotInit', { vendor }))` ("The <Claude|Codex> part is not initialized; cannot re-link linked accounts."). Only the shared directories are processed (independent ones are not touched); none → `showInformationMessage(t('sync.none', { vendor }))`. Each refresh report goes through `describeShareReport`; a non-empty result or an exception is collected as `t('sync.item', { name, notes })` (name = `deps.labelOf(mode, dir)` when provided, otherwise the directory basename without `.claude-` / `.codex-`) and the next account continues. Result: `t('sync.done', { count, vendor })` as information when all reports are empty; otherwise `t('sync.attempted', { count, vendor })` as a warning followed by `t('sync.issues', { list })`, without claiming all accounts were successfully re-linked.

### Frontend

- **Footer toolbar pinned to the bottom of the panel** (outside the tab pages, always visible, the content area scrolls): 6 shared icon buttons, left to right: Show CLI and extension versions (`info`), Reload Window (`refresh`), Restart Extension Host (`debug-restart`), the Codex restart action (`server-process`, title follows `state.codex.restart`), User guide (`book`), Star (`star-empty`). The message's `mode` is the current tab; the host does not distinguish modes for these 6 tools. A separate centered small-text line below the toolbar displays `v<version>`, injected from `package.json` at build time.
- **Version card**: on `versions`, it expands above the toolbar (collapses if already expanded): title "CLI and extension versions" + close button; each item on two vertical lines (label, value).
- **Per-page "Tools" section** (below the account list, a collapsed `details` titled "Tools"): labeled secondary buttons on each page: `CLAUDE.md` (claude page) / `AGENTS.md` (codex page), icon `symbol-ruler` (a ruler, standing for the rules file) → `openGlobalMd`; "Settings", icon `settings-gear` → `openSettings`; "Re-link", icon `sync` → `sync`, hidden (`hidden`) unless some `AccountView` of the page has `kind: 'named'` and `shared: true`; "Update CLI", icon `cloud-download` (title "Update CLI in a terminal") → `updateCli`.
- Every click sends `{ type: 'tool', mode, tool }`. The "Tools" section is shown on the Codex page even while it is not enabled.

### package.json

Commands (category "PlanSwap", 7 in total): `planswap.tools.openClaudeMd` (Open Global CLAUDE.md, `$(symbol-ruler)`), `planswap.tools.openAgentsMd` (Open Global AGENTS.md, `$(symbol-ruler)`), `planswap.tools.openSettings` (Open Extension Settings, `$(settings-gear)`), `planswap.tools.reloadWindow` (Reload Window, `$(refresh)`), `planswap.tools.restartExtHost` (Restart Extension Host, `$(debug-restart)`), `planswap.tools.cliVersions` (Show CLI and Extension Versions, `$(info)`), `planswap.tools.sync` (Re-link Accounts to the Default Account, `$(sync)`). Together with the 5 "Claude Account" and 8 "Codex Account" commands, `contributes.commands` has 20 entries. Titles and categories are `%key%` placeholders in `package.json`.

## Shared and independent accounts (2026-09-26)

- Claude: `src/claudeShare.ts` (above), design in design.md 6.7. Codex: `src/codex/codexShare.ts` (codex-interfaces.md), design in codex-design.md 8.6. Both return `ShareReport` / `MigrateReport` (types from `claudeShare.ts`) and the host formats them with `describeShareReport`.
- The mode is detected from disk (`isSharedClaudeAccount` / `isSharedCodexAccount`) and exposed as `AccountView.shared`; it is never stored.
- Messages: `add` carries `shared`; `share` converts an independent account; `tool: 'sync'` re-links every shared account of the page. Command Palette: `planswap.shareAccount` / `planswap.codex.shareAccount` pick an eligible independent account before conversion; `planswap.tools.sync` re-links existing shared accounts (first pick Claude Code / Codex).
- Deleting a shared account's directory (`deleteAccountDir` / `deleteCodexDir`, `fs.rm` recursive) removes its links only; the default content is not affected (regression tests in `test/claudeShare.test.ts` / `test/codexShare.test.ts`).

## src/webview/panel.css

Panel colors come only from `--vscode-*` theme variables (directly, or through `color-mix` / relative color syntax; `var()` fallbacks are other theme variables, never literal colors). The card layout has no width breakpoint: the tag group wraps under the name only when it does not fit beside it. Required width/language checks and preview resource cleanup are defined in [Manual Verification](manual-verification.md#preview-verification).

## Diagnostics modules

`src/diagnostics.ts` has no runtime VS Code import. `buildDiagnosticsReport(snapshot: DiagnosticSnapshot): string` formats a localized Markdown report from an explicit whitelist: versions, platform/connection enums, anonymous account kind/number, named-account counts, known credential-override variable names, and Codex selection/pre-check/restart states. Windows run-in-WSL reports omit local Codex account and switching-state lines. Unknown version output is discarded; raw errors, directory names, account names/aliases and identity data are not report inputs. `DiagnosticAccount` is `{ kind: 'default' | 'named' | 'external'; number?: number }`.

`src/diagnosticsCommand.ts` owns read-only collection and the `planswap.tools.diagnostics` command. `DiagnosticsDeps` supplies the existing stores' `named()` methods, the extension version, and optional version/pre-check/restart probes for isolated tests. `collectDiagnostics(deps)` maps directories to anonymous references using `samePath`, inspects Claude setting/environment names and Codex effective/selected configuration, and discards pre-check exception details. A differing Codex selection is pending only when switching is enabled or the selection file exists (including an empty file selecting default); an unmanaged external `CODEX_HOME` alone does not request a restart. Version collection reuses the exported `tools.collectVersions()` (`--version` only). No account-info or credential contents are read. `registerDiagnosticsCommand(deps)` opens an untitled Markdown document, then offers to copy its generated contents; only choosing that action writes the clipboard. Errors produce a generic localized notification. Activation registers the returned disposable.
