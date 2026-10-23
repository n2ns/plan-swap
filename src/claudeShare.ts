// Shared vs independent Claude accounts: a shared account links the supported configuration and work data to the
// default account's directory while keeping its login identity separate. No vscode import. Design and rationale: docs/design.md 6.7.
// Invariants of every write entry point (ensureClaudeLinks, syncClaudeAccount, migrateClaudeToShared,
// makeClaudeIndependent, copyClaudeIndependent): an account dir that contains the default dir after resolving links
// throws t('account.containsDefaultDir', { dir, default }) before anything is written; existing content of the default
// dir is never overwritten or deleted, except that syncClaudeAccount updates the synced items of the default account's
// info file and the MCP sign-ins of its credentials file; links are absolute; report names use '/' on every platform.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { t } from './i18n';
import { accountInfoTarget, claudeIdentitySetting, claudeJsonName, copySettingsStripped, defaultDir, realPath, realPathInside, samePath, sameRealPath, strippedSettings, syncMcpServers, unchangedSince } from './paths';
import {
  comparablePath, isOpaqueReparseDir, JunctionError, LinkPrivilegeError, createLink, fileLinksAvailable, isWindows, pidAlive, renameReplacing, type StartTimeProbe,
  sleepSync, stripBom, unlinkLinks, windowsStartTimes, isPlainObject,
} from './platform';

// Whole-entry links (kind: file needs an empty-file default, dir needs an empty dir). 'projects' is the marker entry
// that isSharedClaudeAccount checks. Not shared: .credentials.json, .claude.json (mirrored instead) and everything else
export const CLAUDE_SHARED_ENTRIES: ReadonlyArray<{ name: string; kind: 'file' | 'dir' }> = [
  { name: 'settings.json', kind: 'file' },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'history.jsonl', kind: 'file' },
  { name: 'projects', kind: 'dir' }, { name: 'file-history', kind: 'dir' },
  { name: 'session-env', kind: 'dir' }, { name: 'shell-snapshots', kind: 'dir' }, { name: 'sessions', kind: 'dir' },
  { name: 'tasks', kind: 'dir' }, { name: 'uploads', kind: 'dir' }, { name: 'agents', kind: 'dir' },
  { name: 'commands', kind: 'dir' }, { name: 'output-styles', kind: 'dir' }, { name: 'hooks', kind: 'dir' },
  { name: 'rules', kind: 'dir' }, { name: 'ide', kind: 'dir' },
];
// A missing source for these entries affects existing history; all other entries may be absent until first use.
const CORE_SHARED_ENTRIES = new Set(['history.jsonl', 'projects', 'file-history']);
// Retired entries are only detached on unshare; refresh never creates, migrates or deletes their data.
const LEGACY_SHARED_ENTRIES = ['todos'];
// Dirs shared per child: every child of the default dir's folder is linked, except these names
const CLAUDE_CHILD_SHARED_DIRS = ['skills', 'plugins'] as const;
const CLAUDE_CHILD_EXCLUDES = ['synced', '.trash'] as const;   // per-account cloud-synced buckets
// Per-project keys of .claude.json synced between shared accounts, besides the project's MCP servers (one item per
// server) and its .mcp.json enable / disable lists (one item for the pair: they express opposing states)
const PROJECT_KEYS = [
  'allowedTools', 'mcpContextUris', 'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown',
];
// Per-project keys whose lack only makes Claude Code ask once more (trust, external CLAUDE.md includes)
const PROMPT_KEYS = ['hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown'];
// Item name of a project's enabledMcpjsonServers + disabledMcpjsonServers pair
const MCPJSON_PAIR = 'mcpjsonServers';
// Keys of .credentials.json holding the MCP sign-ins (one item per server); the Claude sign-in is never touched
const MCP_AUTH_KEYS = ['mcpOAuth', 'mcpOAuthClientConfig'];
// Per-account file of the last synced state: a SHA-256 hash per item, never a value
const SYNC_BASE = '.planswap-sync.json';
// Top-level onboarding keys of .claude.json added from the default account when a signed-in account lacks them, so the
// CLI does not run its first-start onboarding again; never for a signed-out account, whose onboarding is its sign-in
const ONBOARDING_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion'];
// Folders copied once when an independent account is created
const INDEPENDENT_COPY_DIRS = ['agents', 'commands', 'output-styles', 'hooks', 'rules'];
const EMPTY_CONTENT: Record<string, string> = { 'settings.json': '{}\n' };

export interface ShareReport {
  linked: string[];     // entry names (children as 'skills/<child>') newly linked
  created: string[];    // entries created empty in the default dir
  conflicts: string[];  // entries the account has as a real file/dir or a link elsewhere; left untouched
  refused: string[];    // entries refused for safety ('settings.json' when the default sets an identity key or is not a readable JSON object)
  refusedNotes?: Record<string, string>; // localized explanation per refused entry, shown instead of the plain refusal
  copied?: string[];    // config files copied once instead of linked (Windows without file-link privilege); they no longer follow the default
  noPrivilege?: string[]; // single-file entries that could not be linked because Windows refuses file symlinks (Developer Mode off); left independent
  busy?: string[];      // entries whose repair would move or unlink account files, skipped because the account is busy (own check or LinkOptions.busy)
  failed?: string[];    // folder entries whose junction Windows could not create (not a local NTFS drive); left unlinked
  merged?: string[];    // replaced history files whose lines are merged back into the default file before relinking (also under linked)
  unlinked?: string[];  // links removed as a repair: a refused config link, an earlier whole-folder link, a child link whose default target is gone, a Windows database link
  stripped?: string[];  // 'settings.json' given the account's own copy without identity keys
  elsewhere?: string[]; // conflicts that are links resolving elsewhere (a subset of conflicts)
}

export interface MigrateReport extends ShareReport {
  moved: number;          // files moved into the default dir
  duplicates: number;     // identical files dropped from the account
  keptBoth: string[];     // relative paths ('/'-separated) of account copies moved next to the default file as '<name>.from-<account>'
  backups: string[];      // account-only files replaced by a link, kept as '<entry>.independent-backup' in the account dir
}


export function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

// Whether link is a symlink pointing at target (relative links resolved against the link's folder), or a symlink whose
// real path equals target's (so a link elsewhere that resolves to the default entry counts too)
export function linksTo(link: string, target: string): boolean {
  const st = lstatOrUndefined(link);
  if (!st?.isSymbolicLink()) return false;
  const to = path.resolve(path.dirname(link), fs.readlinkSync(link));
  return comparablePath(to) === comparablePath(target) || (fs.existsSync(link) && sameRealPath(link, target));
}

function isDefault(dir: string): boolean {
  return sameRealPath(dir, defaultDir());
}

function assertNotDefaultAncestor(dir: string): void {
  const def = defaultDir();
  if (realPathInside(dir, def)) throw new Error(t('account.containsDefaultDir', { dir: path.resolve(dir), default: def }));
}

export function emptyReport(): ShareReport {
  return { linked: [], created: [], conflicts: [], refused: [] };
}

// Whether the default settings.json can be shared: missing, or a JSON object without identity keys
// Why the default settings.json cannot be linked: 'unreadable' (not a readable JSON object), the identity key it sets
// (claudeIdentitySetting), or undefined (missing, or a JSON object without one)
function settingsRefusal(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
  }
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    return 'unreadable';
  }
  return isPlainObject(data) ? claudeIdentitySetting(data) : 'unreadable';
}

function settingsShareable(file: string): boolean {
  return settingsRefusal(file) === undefined;
}

// Localized explanation of a settings.json refusal: copied (the account just got the stripped copy) or own (it already
// has a settings.json of its own); undefined when there is nothing more specific than the plain refusal
function settingsRefusalNote(refusal: string, copied: boolean, own: boolean): string | undefined {
  if (refusal === 'unreadable') return own ? undefined : t('share.r.settingsUnreadable');
  if (!copied && !own) return undefined;
  const why = refusal === 'forceLoginMethod' ? 'share.r.why.loginMethod'
    : refusal === 'env.CLAUDE_CONFIG_DIR' || refusal === 'env.CLAUDE_SECURESTORAGE_CONFIG_DIR' ? 'share.r.why.location'
      : 'share.r.why.credential';
  return t('share.r.settingsRefused', {
    key: refusal,
    why: t(why),
    result: copied ? t('share.r.settingsCopied', { key: refusal }) : t('share.r.settingsOwn'),
  });
}

// An existing source must resolve to the expected type. A dangling link is an error, not an absent source.
function sharedSource(target: string, kind: 'file' | 'dir'): fs.Stats | undefined {
  if (!lstatOrUndefined(target)) return undefined;
  const stat = fs.statSync(target);
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) throw new Error(t('share.badEntry', { file: target }));
  fs.accessSync(target, kind === 'dir' ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
  return stat;
}

// Creates a missing default entry empty; returns true when created
function ensureDefaultEntry(target: string, kind: 'file' | 'dir'): boolean {
  if (sharedSource(target, kind)) return false;
  if (kind === 'dir') fs.mkdirSync(target, { mode: 0o700 });
  else fs.writeFileSync(target, EMPTY_CONTENT[path.basename(target)] ?? '', { mode: 0o600, flag: 'wx' });
  return true;
}

export type LinkResult = 'linked' | 'ok' | 'conflict' | 'noprivilege' | 'failed';

/** Read-only mode of linkEntry: fileLinks says whether Windows file links work (it cannot be probed without writing);
 *  dir: the target is a folder (a junction) even while it does not exist yet. */
export interface LinkCheck { fileLinks: boolean; dir?: boolean }

/** The result linkEntry would give for a missing link: 'noprivilege' for a Windows file link without file-link
 *  privilege, otherwise 'linked' (a junction that the drive refuses cannot be foreseen). */
export function missingLinkResult(target: string, check: LinkCheck): LinkResult {
  if (!isWindows() || check.fileLinks) return 'linked';
  let isDir = !!check.dir;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    // Missing target: check.dir decides
  }
  return isDir ? 'linked' : 'noprivilege';
}

// Links link → target; 'linked' / 'ok' (already linked) / 'conflict' (real entry or link elsewhere, untouched) /
// 'noprivilege' (Windows refuses a file symlink) / 'failed' (Windows cannot create a junction on this drive).
// With check nothing is written and the result is the one the write would give
export function linkEntry(link: string, target: string, check?: LinkCheck): LinkResult {
  const st = lstatOrUndefined(link);
  if (!st) {
    if (check) return missingLinkResult(target, check);
    try {
      createLink(target, link);
    } catch (e) {
      // Windows without Developer Mode: a file symlink is refused; the entry stays independent and the rest goes on
      if (e instanceof LinkPrivilegeError) return 'noprivilege';
      if (e instanceof JunctionError) return 'failed';
      throw e;
    }
    return 'linked';
  }
  if (linksTo(link, target)) return 'ok';
  // Windows with file-link privilege now available: a copied config file identical to the default is upgraded to a real
  // link (config files only: databases and locks may be open elsewhere). Not when the default entry resolves to this
  // very file: it is the only copy, and the link would point back at itself
  const fileLinks = (): boolean => (check ? check.fileLinks : fileLinksAvailable(path.dirname(link)));
  if (isWindows() && COPYABLE_ON_NO_LINK.includes(path.basename(link)) && st.isFile() && fs.existsSync(target) && !sameRealPath(link, target)
    && sameContent(link, target, st, fs.statSync(target)) && fileLinks()) {
    if (check) return 'linked';
    // The link is made under a temporary name and then renamed over the copy, so a failure leaves the copy in place
    const tmp = `${link}.planswap-${process.pid}.link`;
    fs.rmSync(tmp, { force: true });
    createLink(target, tmp);
    try {
      renameReplacing(tmp, link);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return 'linked';
  }
  // Windows without file-link privilege: a real config file is the expected state (a copy the user agreed to)
  if (isWindows() && COPYABLE_ON_NO_LINK.includes(path.basename(link)) && st.isFile() && !fileLinks()) return 'ok';
  return 'conflict';
}

// Small configuration files that may be copied once when a link is refused. Never history, databases or locks:
// a copy of those would silently diverge or corrupt
export const COPYABLE_ON_NO_LINK: readonly string[] = ['settings.json', 'CLAUDE.md', 'config.toml', 'AGENTS.md', 'hooks.json'];

/** Options of the linking operations. copyConfig: the user agreed to one-time copies where a file link is refused. */
export interface LinkOptions {
  copyConfig?: boolean;
  // Claude repair only: exact whole entries or skills/plugins children. A parent selects all its children.
  // Omitted means normal full initialization; an empty or unrecognized selection changes nothing.
  entries?: readonly string[];
  // Extra busy check of the caller (Windows: the account's own PlanSwap terminal is open); ORed with the module's own
  // busy check before any step that moves, merges or unlinks account files
  busy?: () => boolean;
  // Read-only check: nothing is written and no folder is created; the report lists repairable differences.
  // Claude optional sources absent before first use are omitted, unlike normal initialization.
  check?: boolean;
  // Check only: whether Windows file links work (fileLinksAvailable would write a probe); default true
  fileLinks?: boolean;
}

/** record() plus the Windows fallback: a refused link of a copyable file becomes a one-time copy of the default file. */
export function recordLink(report: ShareReport, name: string, result: ReturnType<typeof linkEntry>, link: string, target: string, allowCopy: boolean): void {
  if (result === 'noprivilege' && allowCopy && COPYABLE_ON_NO_LINK.includes(name) && fs.existsSync(target) && fs.statSync(target).isFile() && !lstatOrUndefined(link)) {
    fs.copyFileSync(target, link, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(link, 0o600);
    (report.copied ??= []).push(name);
    return;
  }
  record(report, name, result);
}

/** Files a linkEntry result under its report list; 'ok' (already linked) is not reported. */
export function record(report: ShareReport, name: string, result: LinkResult): void {
  if (result === 'noprivilege') (report.noPrivilege ??= []).push(name);
  else if (result === 'failed') (report.failed ??= []).push(name);
  else if (result === 'linked') report.linked.push(name);
  else if (result === 'conflict') report.conflicts.push(name);
}

// Appends the lines of src that dst lacks (whole-line comparison, order kept, empty lines and repeats dropped), then
// removes src. latin1 keeps the bytes unchanged; dst is created 0600 when missing. Returns the number of appended lines.
export function mergeLines(src: string, dst: string): number {
  const existing = lstatOrUndefined(dst) ? fs.readFileSync(dst, 'latin1') : undefined;
  const have = new Set((existing ?? '').split('\n'));
  const missing: string[] = [];
  for (const line of fs.readFileSync(src, 'latin1').split('\n')) {
    if (line === '' || have.has(line)) continue;
    have.add(line);
    missing.push(line);
  }
  if (missing.length > 0) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(dst, sep + missing.join('\n') + '\n', { encoding: 'latin1', mode: 0o600 });
  } else if (existing === undefined) {
    fs.writeFileSync(dst, '', { mode: 0o600, flag: 'wx' });
  }
  fs.unlinkSync(src);
  return missing.length;
}

/** Creates/repairs every link of a shared account (idempotent). Never touches the default dir's existing content: a
 *  missing default entry is created empty first unless the account keeps its own entry (folder 0700, file 0600,
 *  settings.json '{}\n'); a missing account entry
 *  becomes a link; a regular entry or a link elsewhere stays and is reported under conflicts (links also under
 *  elsewhere). Exception: in an already shared account a regular history.jsonl (replaced by `claude project purge`) is
 *  merged back with mergeLines and relinked (merged and linked; only while file links work, and not when the default
 *  history.jsonl resolves to it); an independent account's own history.jsonl stays a conflict.
 *  skills/ plugins/: a whole-folder link from an earlier version is replaced by a real folder with per-child links
 *  (except CLAUDE_CHILD_EXCLUDES), and child links whose default child no longer exists are removed (both unlinked).
 *  Those three steps move or unlink account files, so they are skipped and reported under busy while
 *  claudeAccountBusy(dir, procRoot) or options.busy() is true; that check runs lazily (once, only when such a step
 *  comes up) and the other links are still made. When the default settings.json cannot be shared, settings.json is
 *  refused (explained in refusedNotes) and an existing settings.json link (unlinked) or a missing one becomes the
 *  account's own copy without identity keys (copySettingsStripped; stripped).
 *  options.copyConfig enables the one-time Windows copy fallback (recordLink). options.check: read only (no write, no
 *  folder created, Windows file links taken from options.fileLinks). Absent optional sources (all except projects,
 *  history.jsonl and file-history) are not problems; real account entries and links elsewhere remain conflicts.
 *  Existing sources must be accessible and have the expected type. The copy fallback is never offered in checks,
 *  and a junction the drive refuses cannot be foreseen. options.entries restricts repairs to the named entries;
 *  selecting skills/plugins permits its old whole-folder link conversion and selects all its children.
 *  dir === default → empty report. */
export function ensureClaudeLinks(dir: string, procRoot = '/proc', options: LinkOptions = {}): ShareReport {
  const report = emptyReport();
  const entries = options.entries === undefined ? undefined : new Set(options.entries.filter((name) =>
    CLAUDE_SHARED_ENTRIES.some((entry) => entry.name === name) || CLAUDE_CHILD_SHARED_DIRS.some((parent) =>
      name === parent || (name.startsWith(`${parent}/`) && name.split('/').length === 2
        && !['', '.', '..', ...CLAUDE_CHILD_EXCLUDES].includes(name.slice(parent.length + 1))
        && !name.includes('\\')))));
  if (entries?.size === 0 || isDefault(dir)) return report;
  const selected = (name: string): boolean => !entries || entries.has(name) || entries.has(name.split('/')[0]);
  assertNotDefaultAncestor(dir);
  const check = !!options.check;
  const def = defaultDir();
  const acc = path.resolve(dir);
  if (!check) {
    fs.mkdirSync(def, { recursive: true, mode: 0o700 });
    fs.mkdirSync(acc, { recursive: true, mode: 0o700 });
  }

  // Checked only when a destructive step comes up; a running Claude process may still be writing those files
  let busy: boolean | undefined;
  const isBusy = (): boolean => (busy ??= claudeAccountBusy(dir, procRoot) || !!options.busy?.());
  // A missing default entry: created empty, or (check) reported as such
  const missingDefault = (target: string, kind: 'file' | 'dir'): boolean => (check ? !sharedSource(target, kind) : ensureDefaultEntry(target, kind));

  const shared = isSharedClaudeAccount(dir);
  // Merging a file's lines back removes it; without file-link privilege it could not be linked again, so it stays
  const fileLinks = check ? options.fileLinks ?? true : fileLinksAvailable(acc);
  for (const { name, kind } of CLAUDE_SHARED_ENTRIES) {
    if (!selected(name)) continue;
    const target = path.join(def, name);
    const link = path.join(acc, name);
    const source = sharedSource(target, kind);
    if (!source) {
      const own = lstatOrUndefined(link);
      // An intentional independent entry does not need a shared target. History rewritten by Claude is merged back.
      const mergeHistory = shared && name === 'history.jsonl' && own?.isFile() && fileLinks;
      if (own && !linksTo(link, target) && !mergeHistory) {
        report.conflicts.push(name);
        continue;
      }
      if (check && !CORE_SHARED_ENTRIES.has(name)) continue;
    }
    const refusal = name === 'settings.json' ? settingsRefusal(target) : undefined;
    if (refusal) {
      // A link would hand the account the default's sign-in settings: an existing link (made while the default was
      // still shareable) and a missing entry both become the account's own copy with the identity keys stripped
      const wasLinked = linksTo(link, target);
      if (wasLinked) {
        (report.unlinked ??= []).push(name);
        if (!check) fs.unlinkSync(link);
      }
      const own = !wasLinked && !!lstatOrUndefined(link);
      const copied = !own && (check ? strippedSettings(def) !== undefined : copySettingsStripped(def, acc));
      if (copied) (report.stripped ??= []).push(name);
      report.refused.push(name);
      const note = settingsRefusalNote(refusal, copied, own);
      if (note) (report.refusedNotes ??= {})[name] = note;
      continue;
    }
    if (missingDefault(target, kind)) report.created.push(name);
    // `claude project purge` rewrites history.jsonl by rename, replacing the link: merge the lines back and relink
    // (not when the default history links to this very file: merging it into itself would remove the only copy)
    if (shared && name === 'history.jsonl' && lstatOrUndefined(link)?.isFile() && fileLinks && !sameRealPath(link, target)) {
      if (isBusy()) {
        (report.busy ??= []).push(name);
        continue;
      }
      (report.merged ??= []).push(name);
      if (check) {
        // The merged file is removed, so the link is made next
        record(report, name, missingLinkResult(target, { fileLinks }));
        continue;
      }
      mergeLines(link, target);
    }
    recordLink(report, name, linkEntry(link, target, check ? { fileLinks, dir: kind === 'dir' } : undefined), link, target, !check && !!options.copyConfig);
  }

  for (const name of CLAUDE_CHILD_SHARED_DIRS) {
    if (entries && !selected(name) && ![...entries].some((entry) => entry.startsWith(`${name}/`))) continue;
    const defFolder = path.join(def, name);
    const source = sharedSource(defFolder, 'dir');
    const accFolder = path.join(acc, name);
    const st = lstatOrUndefined(accFolder);
    if (!source) {
      if (st && !st.isDirectory() && !linksTo(accFolder, defFolder)) {
        report.conflicts.push(name);
        continue;
      }
      // An unused optional parent is harmless, but an existing account folder can contain broken child links.
      if (check && !st?.isDirectory()) continue;
    }
    if (!check && selected(name) && missingDefault(defFolder, 'dir')) report.created.push(name);
    // Check: the account folder would be created (or re-created) empty, so every child would be linked
    let fresh = false;
    if (st?.isSymbolicLink() && linksTo(accFolder, defFolder)) {
      if (!selected(name)) continue;
      // Whole-folder link from an earlier version: replace it by a real folder with per-child links
      if (isBusy()) {
        (report.busy ??= []).push(name);
        continue;
      }
      (report.unlinked ??= []).push(name);
      if (check) fresh = true;
      else {
        fs.unlinkSync(accFolder);
        fs.mkdirSync(accFolder, { mode: 0o700 });
      }
    } else if (!st) {
      if (check) fresh = true;
      else fs.mkdirSync(accFolder, { mode: 0o700 });
    } else if (!st.isDirectory()) {
      report.conflicts.push(name);
      continue;
    }
    const excluded = new Set<string>(CLAUDE_CHILD_EXCLUDES);
    const children = !lstatOrUndefined(defFolder) ? [] : fs.readdirSync(defFolder);
    for (const child of children) {
      if (excluded.has(child) || !selected(`${name}/${child}`)) continue;
      const target = path.join(defFolder, child);
      // Child entries can be files or folders; broken or inaccessible sources remain errors.
      const childSource = fs.statSync(target);
      if (!childSource.isFile() && !childSource.isDirectory()) throw new Error(t('share.badEntry', { file: target }));
      fs.accessSync(target, childSource.isDirectory() ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
      record(report, `${name}/${child}`, fresh ? missingLinkResult(target, { fileLinks }) : linkEntry(path.join(accFolder, child), target, check ? { fileLinks } : undefined));
    }
    if (fresh) continue;
    // Remove links into the default folder whose target no longer exists
    for (const child of fs.readdirSync(accFolder)) {
      if (!selected(`${name}/${child}`) || excluded.has(child)) continue;
      const link = path.join(accFolder, child);
      if (!lstatOrUndefined(link)?.isSymbolicLink()) continue;
      const to = path.resolve(accFolder, fs.readlinkSync(link));
      if (comparablePath(path.dirname(to)) !== comparablePath(defFolder) || lstatOrUndefined(to)) continue;
      if (isBusy()) (report.busy ??= []).push(`${name}/${child}`);
      else {
        (report.unlinked ??= []).push(`${name}/${child}`);
        if (!check) fs.unlinkSync(link);
      }
    }
  }
  markElsewhere(report, acc);
  return report;
}

/** Lists under elsewhere the conflicts of report that are links (resolving elsewhere, since a link to the default
 *  entry is no conflict); names are relative to the account dir acc. */
export function markElsewhere(report: ShareReport, acc: string): void {
  const isLink = (name: string): boolean => {
    try {
      return fs.lstatSync(path.join(acc, name)).isSymbolicLink();
    } catch {
      // Missing, or below a parent that is not a folder (a nested Codex entry)
      return false;
    }
  };
  const links = report.conflicts.filter(isLink);
  if (links.length) report.elsewhere = links;
}

// A JSON file read for a sync: its real path, the text the commit compares against (undefined: missing), the parsed
// object (missing = empty) and the mode a rewrite keeps
interface SyncFile { file: string; real: string; before: string | undefined; data: Record<string, unknown>; mode: number }

// Parses a sync file's text; a file that is not a JSON object throws error
function parseSyncFile(text: string | undefined, error: string): Record<string, unknown> {
  if (text === undefined) return {};
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    data = undefined;
  }
  if (!isPlainObject(data)) throw new Error(error);
  return data;
}

// The default account's info file; a dangling link is refused, since the write would replace it by a plain file
function readDefaultInfo(file: string): SyncFile {
  const exists = fs.existsSync(file);
  if (!exists && lstatOrUndefined(file)) throw new Error(t('mcp.unsafeTarget', { file }));
  const real = exists ? realPath(file) : file;
  const before = exists ? fs.readFileSync(real, 'utf8') : undefined;
  return { file, real, before, data: parseSyncFile(before, t('share.badSource', { file })), mode: exists ? fs.statSync(real).mode & 0o777 : 0o600 };
}

// A .credentials.json for its MCP sign-ins; undefined when missing (a signed-out account, which must not gain one).
// Claude Code refuses a linked credentials file, so only a plain file with a single link is accepted
function readCredentials(dir: string): SyncFile | undefined {
  const file = path.join(path.resolve(dir), '.credentials.json');
  const st = lstatOrUndefined(file);
  if (!st) return undefined;
  if (!st.isFile() || st.nlink > 1) throw new Error(t('mcp.unsafeTarget', { file }));
  const before = fs.readFileSync(file, 'utf8');
  return { file, real: file, before, data: parseSyncFile(before, t('mcp.badTarget', { file })), mode: st.mode & 0o777 };
}

type Items = Map<string, unknown>;

// Claude Code reads a missing project key as false / empty (research fact 18), so those values count as absent
function projectValue(value: unknown): unknown {
  return value === false || (Array.isArray(value) && value.length === 0) ? undefined : value;
}

// The synced items of an info file, keyed by the JSON of their path: ['mcpServers', name], ['projects', path,
// 'mcpServers', name], ['projects', path, MCPJSON_PAIR] and ['projects', path, key] for PROJECT_KEYS
function infoItems(data: Record<string, unknown>): Items {
  const items: Items = new Map();
  const put = (keyPath: string[], value: unknown): void => {
    if (value !== undefined) items.set(JSON.stringify(keyPath), value);
  };
  if (isPlainObject(data.mcpServers)) for (const [name, value] of Object.entries(data.mcpServers)) put(['mcpServers', name], value);
  if (!isPlainObject(data.projects)) return items;
  for (const [p, proj] of Object.entries(data.projects)) {
    if (!isPlainObject(proj)) continue;
    if (isPlainObject(proj.mcpServers)) for (const [name, value] of Object.entries(proj.mcpServers)) put(['projects', p, 'mcpServers', name], value);
    for (const k of PROJECT_KEYS) put(['projects', p, k], projectValue(proj[k]));
    const enabled = projectValue(proj.enabledMcpjsonServers);
    const disabled = projectValue(proj.disabledMcpjsonServers);
    if (enabled !== undefined || disabled !== undefined) put(['projects', p, MCPJSON_PAIR], { enabled: enabled ?? [], disabled: disabled ?? [] });
  }
  return items;
}

// The MCP sign-ins of a credentials file: [key, server key] for MCP_AUTH_KEYS
function credentialItems(data: Record<string, unknown>): Items {
  const items: Items = new Map();
  for (const k of MCP_AUTH_KEYS) {
    const entries = data[k];
    if (isPlainObject(entries)) for (const [name, value] of Object.entries(entries)) items.set(JSON.stringify([k, name]), value);
  }
  return items;
}

// Sets (value) or removes (undefined) a member of the object data[key], creating the object only for a value
function setMember(data: Record<string, unknown>, key: string, name: string, value: unknown): void {
  if (!isPlainObject(data[key])) {
    if (value === undefined) return;
    data[key] = {};
  }
  const members = data[key] as Record<string, unknown>;
  if (value === undefined) delete members[name];
  else members[name] = value;
}

// Writes one item into a parsed info or credentials file; an absent project key gets Claude Code's own default
function setItem(data: Record<string, unknown>, key: string, value: unknown): void {
  const [top, p, k, name] = JSON.parse(key) as string[];
  if (top !== 'projects') {
    setMember(data, top, p, value);
    return;
  }
  if (!isPlainObject(data.projects)) {
    if (value === undefined) return;
    data.projects = {};
  }
  const projects = data.projects as Record<string, unknown>;
  if (!isPlainObject(projects[p])) {
    if (value === undefined) return;
    projects[p] = {};
  }
  const proj = projects[p] as Record<string, unknown>;
  if (k === 'mcpServers') setMember(proj, 'mcpServers', name, value);
  else if (k === MCPJSON_PAIR) {
    const pair = value as { enabled: unknown[]; disabled: unknown[] } | undefined;
    proj.enabledMcpjsonServers = pair?.enabled ?? [];
    proj.disabledMcpjsonServers = pair?.disabled ?? [];
  } else proj[k] = value ?? (PROMPT_KEYS.includes(k) ? false : []);
}

// JSON with sorted object keys, so equal values hash equally whatever their key order
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function hashOf(value: unknown): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(canonical(value)).digest('hex');
}

/** Three-way merge of one item: d (default account), y (account) and base (hash of the last synced value, undefined
 *  when unknown). Only one side changed since the base → that side's value (a removal included); both changed → the
 *  account's. Unknown base → nothing is removed: the side that has the item wins, two arrays are united and other
 *  differing values take the account's. */
export function mergeItem(d: unknown, y: unknown, base: string | undefined): unknown {
  const hd = hashOf(d);
  const hy = hashOf(y);
  if (hd === hy) return d;
  if (base === undefined) {
    if (y === undefined) return d;
    if (d === undefined) return y;
    if (Array.isArray(d) && Array.isArray(y)) return [...y, ...d.filter((v) => !y.some((w) => isDeepStrictEqual(v, w)))];
    return y;
  }
  return hy === base ? d : y;
}

// The notification group of an item: 'mcpServers', 'projects:<path>' or 'mcpOAuth:<server key>'
function groupOf(key: string): string {
  const [top, name] = JSON.parse(key) as string[];
  if (top === 'mcpServers') return top;
  if (top === 'projects') return `projects:${name}`;
  return `mcpOAuth:${name}`;
}

// What a base belongs to: the default dir, and the info files by their firstStartTime, which Claude Code writes once
// when it creates the file, so a deleted and recreated info file (whose missing items are no removals) is told apart
interface BaseOrigin { defaultDir: string; info: string }

// The last synced item hashes of an account, keeping only those that still apply to origin: none for another default
// dir, none of the info file items after either info file was recreated; unreadable or invalid = all unknown
function readBase(dir: string, origin: BaseOrigin): { items: Map<string, string>; stale: boolean } {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, SYNC_BASE), 'utf8'));
  } catch {
    return { items: new Map(), stale: false };
  }
  const stored = isPlainObject(data) && isPlainObject(data.items) ? data.items : {};
  const items = new Map(Object.entries(stored).filter((e): e is [string, string] => typeof e[1] === 'string'));
  if (!isPlainObject(data) || data.defaultDir !== origin.defaultDir) return { items: new Map(), stale: true };
  if (data.info !== origin.info) {
    for (const key of items.keys()) if (!MCP_AUTH_KEYS.includes((JSON.parse(key) as string[])[0])) items.delete(key);
    return { items, stale: true };
  }
  return { items, stale: false };
}

/** Forgets the last synced state of an account dir, when it stops or starts being shared: what changed meanwhile on
 *  either side is no removal. */
function removeSyncBase(dir: string): void {
  fs.rmSync(path.join(path.resolve(dir), SYNC_BASE), { force: true });
}

// Writes a JSON file through a temporary file and a rename, refusing when it changed since it was read (or when
// valid() fails before a rename attempt); beforeCommit runs between the two (tests simulate a concurrent CLI write)
function commitJson(target: SyncFile, text: string, beforeCommit?: () => void, valid: () => boolean = () => true): void {
  const tmp = `${target.real}.planswap-${process.pid}.tmp`;
  // A temporary file left by an interrupted run is replaced
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, text, { mode: target.mode, flag: 'wx' });
    beforeCommit?.();
    if (!renameReplacing(tmp, target.real, undefined, undefined, () => valid() && unchangedSince(target.real, target.before))) {
      throw new Error(t('mcp.changed', { file: target.real }));
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Claude Code serializes its credential writes with a lock folder <config dir>/.storage-write.lock (proper-lockfile,
// stale after 15 s; research fact 19). The commit of a credentials file holds the same lock, so a token refresh
// cannot land between its compare and rename; a lock held longer than about a second throws t('mcp.changed')
function withStorageLock(target: SyncFile, commit: () => void): void {
  const lock = path.join(path.dirname(target.real), '.storage-write.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const st = lstatOrUndefined(lock);
      if (st && Date.now() - st.mtimeMs > 15_000) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (attempt >= 10) throw new Error(t('mcp.changed', { file: target.real }));
      sleepSync(100);
    }
  }
  try {
    commit();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

export type SyncMode = 'full' | 'pull' | 'check';

export interface SyncResult {
  changed: string[];         // groups of the account that change (check: would change): 'mcpServers', 'projects:<path>', 'mcpOAuth:<server key>', onboarding keys
  defaultChanged?: string[]; // full: groups changed in the default account
  quiet?: string[];          // check: changed groups that only differ in PROMPT_KEYS, or only in sign-ins the account already has (token refreshes)
}

/**
 * Syncs a shared account dir with the default account: the MCP servers and PROJECT_KEYS of the info files (fromJson =
 * the default's, <dir>/.claude.json) and the MCP sign-ins (MCP_AUTH_KEYS) of both .credentials.json files. Each item
 * (a server, a project key, a sign-in) is merged three-way (mergeItem) against <dir>/SYNC_BASE, the item hashes of the
 * last sync, so a change made on either side since then survives, a removal included; both sides changed → the account
 * wins. The base applies only to the same default dir and, for the info file items, to the same info files (BaseOrigin).
 * A sign-in removed on one side is not removed on the other: a new Claude sign-in writes a fresh credentials file
 * without them, which is no removal. Sign-ins are synced only when both credentials files exist; the Claude sign-in and
 * every other key stay.
 * ONBOARDING_KEYS are added to a signed-in account lacking them. Modes:
 * - full (switching to or away from the account, adding or converting it): writes the merge into both accounts and
 *   records the new base;
 * - pull (Repair): writes into the account only what it lacks of the default (the changes a full sync would make
 *   there), limited to the given groups; the default stays as it is;
 * - check: read only; lists what pull would change, with the quiet groups.
 * Writes replace atomically, keep the mode, follow an info file's symlink (validated like accountInfoTarget) and refuse
 * with t('mcp.changed') a file changed since it was read; credentials commits hold Claude Code's storage lock. A
 * missing account info file is created 0600; a credentials file is never created. Order: default info, default
 * credentials, account info, account credentials, base, so an interrupted sync converges on the next one. Errors:
 * t('share.badSource') (default info not a JSON object), t('mcp.badTarget'), t('mcp.unsafeTarget') (before any
 * account info content is read, check mode included). The default dir, or groups = [], → no-op without reading.
 */
export function syncClaudeAccount(fromJson: string, dir: string, mode: SyncMode = 'full', groups?: readonly string[], beforeCommit?: () => void): SyncResult {
  const result: SyncResult = { changed: [] };
  if (groups?.length === 0 || isDefault(dir)) return result;
  assertNotDefaultAncestor(dir);
  const selected = (group: string): boolean => !groups || groups.includes(group);
  const infoFile = path.join(path.resolve(dir), claudeJsonName());
  const target = accountInfoTarget(infoFile, dir, fromJson);
  const accountBefore = fs.existsSync(infoFile) ? fs.readFileSync(target.real, 'utf8') : undefined;
  const account: SyncFile = { file: infoFile, real: target.real, before: accountBefore, data: parseSyncFile(accountBefore, t('mcp.badTarget', { file: target.real })), mode: target.mode };
  const def = readDefaultInfo(fromJson);
  const defCred = readCredentials(defaultDir());
  const accCred = defCred && readCredentials(dir);
  const startOf = (data: Record<string, unknown>): unknown => data.firstStartTime ?? null;
  const origin: BaseOrigin = { defaultDir: realPath(defaultDir()), info: hashOf([startOf(def.data), startOf(account.data)])! };
  const { items: base, stale } = readBase(dir, origin);

  // Every item key of both sides and the base, merged; credentials only when both files exist
  const sources: Array<{ d: SyncFile; y: SyncFile; dItems: Items; yItems: Items; credentials: boolean }> = [
    { d: def, y: account, dItems: infoItems(def.data), yItems: infoItems(account.data), credentials: false },
  ];
  if (defCred && accCred) sources.push({ d: defCred, y: accCred, dItems: credentialItems(defCred.data), yItems: credentialItems(accCred.data), credentials: true });
  const newBase = new Map(base);
  const changed = new Set<string>();
  const defaultChanged = new Set<string>();
  const loud = new Set<string>();
  const dirty = new Set<SyncFile>();
  for (const { d, y, dItems, yItems, credentials } of sources) {
    const isCredential = (key: string): boolean => MCP_AUTH_KEYS.includes((JSON.parse(key) as string[])[0]);
    const keys = new Set([...dItems.keys(), ...yItems.keys(), ...[...base.keys()].filter((key) => isCredential(key) === credentials)]);
    for (const key of keys) {
      const dv = dItems.get(key);
      const yv = yItems.get(key);
      // A sign-in missing on one side is kept from the other (the file may have been rewritten by a new sign-in)
      const merged = mergeItem(dv, yv, base.get(key)) ?? (credentials ? yv ?? dv : undefined);
      const group = groupOf(key);
      const intoAccount = hashOf(merged) !== hashOf(yv);
      if (intoAccount && selected(group)) {
        changed.add(group);
        const [, , k] = JSON.parse(key) as string[];
        if (credentials ? yv === undefined : !PROMPT_KEYS.includes(k)) loud.add(group);
        if (mode !== 'check') {
          setItem(y.data, key, merged);
          dirty.add(y);
        }
      }
      if (mode === 'full' && hashOf(merged) !== hashOf(dv)) {
        defaultChanged.add(group);
        setItem(d.data, key, merged);
        dirty.add(d);
      }
      // Pull leaves the base unknown where the default still differs from what the account now has
      if (mode === 'full' || (mode === 'pull' && intoAccount && selected(group))) {
        const settled = mode === 'full' || hashOf(merged) === hashOf(dv);
        if (merged !== undefined && settled) newBase.set(key, hashOf(merged)!);
        else newBase.delete(key);
      }
    }
  }

  // Signed in as readAccountInfo decides it: an email in the file, or only the existence of the credentials file
  const oauth = account.data.oauthAccount;
  const signedIn = (isPlainObject(oauth) && typeof oauth.emailAddress === 'string' && oauth.emailAddress !== '')
    || fs.existsSync(path.join(path.resolve(dir), '.credentials.json'));
  if (signedIn) {
    for (const k of ONBOARDING_KEYS) {
      if (!selected(k) || !Object.hasOwn(def.data, k) || Object.hasOwn(account.data, k)) continue;
      changed.add(k);
      loud.add(k);
      if (mode !== 'check') {
        account.data[k] = def.data[k];
        dirty.add(account);
      }
    }
  }
  result.changed = [...changed];
  if (mode === 'check') {
    result.quiet = result.changed.filter((group) => !loud.has(group));
    return result;
  }
  if (mode === 'full') result.defaultChanged = [...defaultChanged];

  const write = (file: SyncFile, text: string, valid?: () => boolean): void => {
    if (!dirty.has(file)) return;
    if (file === defCred || file === accCred) withStorageLock(file, () => commitJson(file, text, beforeCommit, valid));
    else commitJson(file, text, beforeCommit, valid);
  };
  write(def, JSON.stringify(def.data, null, 2) + '\n');
  if (defCred) write(defCred, JSON.stringify(defCred.data));
  write(account, JSON.stringify(account.data, null, 2) + '\n', () => target.validate());
  if (accCred) write(accCred, JSON.stringify(accCred.data));
  if (stale || !isDeepStrictEqual(newBase, base)) {
    const baseFile = path.join(path.resolve(dir), SYNC_BASE);
    const tmp = `${baseFile}.planswap-${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...origin, items: Object.fromEntries(newBase) }) + '\n', { mode: 0o600, flag: 'wx' });
      renameReplacing(tmp, baseFile);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return result;
}

// A session file's live process: pid and the recorded start time (procStart); undefined when unreadable, invalid or not running
function liveSession(file: string): { pid: number; start?: string } | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(data)) return undefined;
    const { pid, procStart } = data;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return undefined;
    return typeof procStart === 'string' && /^\d+$/.test(procStart) ? { pid, start: procStart } : { pid };
  } catch {
    return undefined;
  }
}

/**
 * Windows busy check (no /proc, and another process's environment cannot be read). A shared account's sessions folder
 * is a link to the default one, whose records belong to every account sharing it and cannot be told apart: false (the
 * callers also refuse while the account's own terminal is open). Otherwise a record whose pid is alive and, when it
 * carries procStart, whose process started at that time; a failed start-time probe counts as busy.
 */
export function windowsSessionsBusy(sessions: string, startTimes: StartTimeProbe = windowsStartTimes): boolean {
  if (lstatOrUndefined(sessions)?.isSymbolicLink()) return false;
  let files: string[];
  try {
    files = fs.readdirSync(sessions).filter((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
  const live = files.map((f) => liveSession(path.join(sessions, f))).filter((s) => s !== undefined);
  if (live.some((s) => s.start === undefined)) return true;
  if (live.length === 0) return false;
  const times = startTimes(live.map((s) => s.pid));
  return !times || live.some((s) => times.get(s.pid) === s.start);
}

/** true when a Claude process is running with this config dir: a <dir>/sessions/*.json whose pid is alive and whose
 *  /proc/<pid>/environ has CLAUDE_CONFIG_DIR=<dir> (samePath or sameRealPath; for the default dir: unset or the
 *  default). Unreadable records, invalid pids and unreadable environ files (not running, another user's process) are
 *  skipped; no sessions folder → false. Without procRoot (e.g. no /proc) any session file counts as busy.
 *  Windows with the default procRoot: windowsSessionsBusy. procRoot is for tests. */
export function claudeAccountBusy(dir: string, procRoot = '/proc'): boolean {
  const sessions = path.join(path.resolve(dir), 'sessions');
  if (isWindows() && procRoot === '/proc') return windowsSessionsBusy(sessions);
  let files: string[];
  try {
    files = fs.readdirSync(sessions).filter((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
  // A live session cannot be ruled out without procRoot
  if (files.length > 0 && !fs.existsSync(procRoot)) return true;
  const def = defaultDir();
  const forDefault = sameRealPath(dir, def);
  for (const f of files) {
    let pid: unknown;
    try {
      const data: unknown = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8'));
      pid = isPlainObject(data) ? data.pid : undefined;
    } catch {
      continue;
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    let environ: string;
    try {
      environ = fs.readFileSync(path.join(procRoot, String(pid), 'environ'), 'utf8');
    } catch {
      // Not running, or another user's process
      continue;
    }
    const entry = environ.split('\0').find((e) => e.startsWith('CLAUDE_CONFIG_DIR='));
    const value = entry?.slice('CLAUDE_CONFIG_DIR='.length);
    if (forDefault ? !value || samePath(value, def) || sameRealPath(value, def) : !!value && (samePath(value, dir) || sameRealPath(value, dir))) {
      return true;
    }
  }
  return false;
}

// Resolve the parent while preserving the final entry, which may be a link or an already-moved file.
function realEntryPath(entry: string): string {
  return path.join(realPath(path.dirname(entry)), path.basename(entry));
}

function linkTarget(link: string): string {
  return realEntryPath(path.resolve(realPath(path.dirname(link)), fs.readlinkSync(link)));
}

// A moved link is created successfully before its original is removed. A rename can keep the original link on
// Windows without file-link privilege when its target spelling still means the same thing at the destination.
function moveLink(src: string, dst: string, target: string): boolean {
  const raw = fs.readlinkSync(src);
  if (sameRealPath(path.resolve(realPath(path.dirname(dst)), raw), target)) {
    try {
      fs.renameSync(src, dst);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    }
  }
  try {
    createLink(target, dst);
  } catch (e) {
    if (e instanceof LinkPrivilegeError) return false;
    throw e;
  }
  fs.unlinkSync(src);
  return true;
}

function pathBelow(root: string, entry: string): string | undefined {
  const rel = path.relative(comparablePath(root), comparablePath(entry));
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) ? path.relative(root, entry) : undefined;
}

// Unlike independent copying, a failed link copy must never fall back to a regular file or skip a dangling link:
// the whole source tree is only removed once every entry has a copy with the same meaning.
function copyMovedTree(src: string, dst: string, root: string, targetRoot: string): void {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { mode: st.mode & 0o777 });
    for (const child of fs.readdirSync(src)) copyMovedTree(path.join(src, child), path.join(dst, child), root, targetRoot);
    fs.utimesSync(dst, st.atime, st.mtime);
  } else if (st.isSymbolicLink()) {
    const raw = fs.readlinkSync(src);
    const target = linkTarget(src);
    const inside = !path.isAbsolute(raw) ? pathBelow(root, target) : undefined;
    if (inside !== undefined && !isWindows()) fs.symlinkSync(raw, dst);
    else createLink(inside === undefined ? target : path.join(targetRoot, inside), dst);
  } else if (st.isFile()) {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, st.mode & 0o777);
    fs.utimesSync(dst, st.atime, st.mtime);
  } else {
    throw Object.assign(new Error(`EOPNOTSUPP: cannot move special file '${src}'`), { code: 'EOPNOTSUPP' });
  }
}

function hasExternalRelativeLink(dir: string, root = dir): boolean {
  for (const child of fs.readdirSync(dir)) {
    const file = path.join(dir, child);
    const st = fs.lstatSync(file);
    if (st.isDirectory() && hasExternalRelativeLink(file, root)) return true;
    if (!st.isSymbolicLink()) continue;
    const raw = fs.readlinkSync(file);
    if (!path.isAbsolute(raw) && pathBelow(root, linkTarget(file)) === undefined) return true;
  }
  return false;
}

// Moves a file, link or folder without following symlinks: rename, or copy + delete across file systems (also for a
// folder holding relative links that point outside it). Relative links keep their targets; links inside a whole moved
// tree still point into that tree. An existing destination folder throws EEXIST, a special file EOPNOTSUPP. false
// means link privilege was refused and the original entry is kept (callers then count nothing as moved).
export function moveEntry(src: string, dst: string): boolean {
  src = realEntryPath(src);
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return moveLink(src, dst, linkTarget(src));
  try {
    if (!st.isDirectory() || !hasExternalRelativeLink(src)) {
      fs.renameSync(src, dst);
      return true;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  if (st.isDirectory()) {
    // Refuse an existing destination before cleanup can own it.
    if (lstatOrUndefined(dst)) existsError(dst, 'throw');
    try {
      copyMovedTree(src, dst, src, dst);
    } catch (e) {
      unlinkLinks(dst);
      fs.rmSync(dst, { recursive: true, force: true });
      if (e instanceof LinkPrivilegeError) return false;
      throw e;
    }
    unlinkLinks(src);
    fs.rmSync(src, { recursive: true });
  } else {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, st.mode & 0o777);
    fs.utimesSync(dst, st.atime, st.mtime);
    fs.unlinkSync(src);
  }
  return true;
}

// First free name among base, base-2, base-3 …
export function freeName(base: string): string {
  if (!lstatOrUndefined(base)) return base;
  for (let i = 2; ; i++) if (!lstatOrUndefined(`${base}-${i}`)) return `${base}-${i}`;
}

/** Two links resolving to the same target, or two regular files of equal size and bytes. */
export function sameContent(a: string, b: string, sa: fs.Stats, sb: fs.Stats): boolean {
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    if (!sa.isSymbolicLink() || !sb.isSymbolicLink()) return false;
    return samePath(linkTarget(a), linkTarget(b));
  }
  return sa.isFile() && sb.isFile() && sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
}

interface PendingLink { src: string; dst: string; rel: string; target: string; count: boolean; kept: boolean; duplicate?: boolean }
export interface MergeCtx {
  report: MigrateReport;
  account: string;
  movedPaths?: Map<string, string>;
  pendingLinks?: PendingLink[];
  sourceDirs?: string[];
}

/** Records where a moved, backed-up or retained entry now is, so deferred links follow their migrated targets. */
export function rememberMove(ctx: MergeCtx, src: string, dst: string): void {
  (ctx.movedPaths ??= new Map()).set(realEntryPath(src), dst);
}

function movedTarget(ctx: MergeCtx, target: string): string {
  let best = '';
  let result = target;
  for (const [src, dst] of ctx.movedPaths ?? []) {
    const rel = pathBelow(src, target);
    if (rel === undefined || src.length <= best.length) continue;
    best = src;
    result = path.join(dst, rel);
  }
  return result;
}

// Merges the account entry src into the default entry dst (rel: dst relative to the default dir, for the report).
// Folders recurse; a missing dst → moved (moved++); identical file → src deleted (duplicates++); different → moved to
// '<dst>.from-<account>' ('-2', '-3' … when taken; keptBoth, whose content is not counted again). Links are deferred to
// finalizeMerge. Sockets, FIFOs and opaque Windows reparse folders stay in place (their folder then stays a conflict);
// an entry is never merged into itself (same real path).
export function mergeEntry(src: string, dst: string, rel: string, ctx: MergeCtx, count = true): void {
  src = realEntryPath(src);
  const ss = fs.lstatSync(src);
  const ds = lstatOrUndefined(dst);
  if (!ss.isDirectory() && !ss.isFile() && !ss.isSymbolicLink()) {
    rememberMove(ctx, src, src);   // sockets, fifos: left in place
    return;
  }
  if (ss.isSymbolicLink()) {
    (ctx.pendingLinks ??= []).push({ src, dst, rel, target: linkTarget(src), count, kept: false });
    return;
  }
  // Never merge an entry into itself (another spelling of the same folder): the "identical copy" would be the only one
  if (ds && sameRealPath(src, dst)) {
    rememberMove(ctx, src, dst);
    return;
  }
  // Windows reparse points that lstat reports as plain folders (a junction to \\?\Volume{…}, a mount point): moving out
  // of them would take files from another location; left in place like sockets
  if (ss.isDirectory() && isOpaqueReparseDir(src)) {
    rememberMove(ctx, src, src);
    return;
  }
  if (ss.isDirectory()) {
    if (!ds) fs.mkdirSync(dst, { mode: ss.mode & 0o777 });
    if (!ds || ds.isDirectory()) {
      rememberMove(ctx, src, dst);
      (ctx.sourceDirs ??= []).push(src);
      for (const child of fs.readdirSync(src)) mergeEntry(path.join(src, child), path.join(dst, child), `${rel}/${child}`, ctx, count);
      return;
    }
  } else if (!ds) {
    if (moveEntry(src, dst)) {
      rememberMove(ctx, src, dst);
      if (count) ctx.report.moved++;
    }
    return;
  } else if (sameContent(src, dst, ss, ds)) {
    fs.unlinkSync(src);
    rememberMove(ctx, src, dst);
    if (count) ctx.report.duplicates++;
    return;
  }
  const kept = freeName(`${dst}.from-${ctx.account}`);
  if (ss.isDirectory()) mergeEntry(src, kept, rel, ctx, false);
  else {
    if (!moveEntry(src, kept)) return;
    rememberMove(ctx, src, kept);
  }
  // Report names use / on every platform, like the other entries of a report
  if (count) ctx.report.keptBoth.push(path.posix.join(path.posix.dirname(rel), path.basename(kept)));
}

/** Completes one account's directory merges after every shared entry has its final location, before re-linking.
 *  Deferred links use those locations, including conflict suffixes, so they survive deletion of the old account;
 *  external targets keep their original location. A dst link already resolving to the same moved target counts as a
 *  duplicate; a link that cannot be recreated (no file-link privilege, or a link it depends on stayed) stays in the
 *  account and is reported under noPrivilege. Emptied source folders are removed afterwards. */
export function finalizeMerge(ctx: MergeCtx): void {
  const pending = ctx.pendingLinks ?? [];
  const reserved = new Set<string>();
  for (const link of pending) {
    const targetDependsOnLink = pending.some((other) => pathBelow(other.src, link.target) !== undefined);
    if (!targetDependsOnLink && lstatOrUndefined(link.dst)?.isSymbolicLink()
      && sameRealPath(movedTarget(ctx, link.target), linkTarget(link.dst))) {
      link.duplicate = true;
      rememberMove(ctx, link.src, link.dst);
      continue;
    }
    if (lstatOrUndefined(link.dst) || reserved.has(comparablePath(link.dst))) {
      const base = `${link.dst}.from-${ctx.account}`;
      let candidate = base;
      for (let n = 2; lstatOrUndefined(candidate) || reserved.has(comparablePath(candidate)); n++) candidate = `${base}-${n}`;
      link.kept = true;
      link.dst = candidate;
    }
    reserved.add(comparablePath(link.dst));
    rememberMove(ctx, link.src, link.dst);
  }
  const finished = new Map<PendingLink, boolean>();
  const visiting = new Set<PendingLink>();
  const finishLink = (link: PendingLink): boolean => {
    const done = finished.get(link);
    if (done !== undefined) return done;
    if (visiting.has(link)) return true;   // preserve an existing link cycle without recursing forever
    visiting.add(link);
    const dependency = pending.filter((other) => other !== link && pathBelow(other.src, link.target) !== undefined)
      .sort((a, b) => b.src.length - a.src.length)[0];
    const dependencyMoved = !dependency || finishLink(dependency);
    if (link.duplicate) {
      fs.unlinkSync(link.src);
      if (link.count) ctx.report.duplicates++;
    } else if (!dependencyMoved || !moveLink(link.src, link.dst, movedTarget(ctx, link.target))) {
      (ctx.report.noPrivilege ??= []).push(link.rel);
      rememberMove(ctx, link.src, link.src);
      visiting.delete(link);
      finished.set(link, false);
      return false;
    } else if (link.count) {
      if (link.kept) ctx.report.keptBoth.push(path.posix.join(path.posix.dirname(link.rel), path.basename(link.dst)));
      else ctx.report.moved++;
    }
    visiting.delete(link);
    finished.set(link, true);
    return true;
  };
  for (const link of pending) finishLink(link);
  for (const dir of [...(ctx.sourceDirs ?? [])].reverse()) removeIfEmpty(dir);
}

// The default folder to merge into (a link to a folder is followed; created 0700 when missing); undefined when not a folder
export function defaultFolder(p: string): string | undefined {
  if (!lstatOrUndefined(p)) {
    fs.mkdirSync(p, { mode: 0o700 });
    return p;
  }
  return fs.existsSync(p) && fs.statSync(p).isDirectory() ? fs.realpathSync(p) : undefined;
}

function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch (e) {
    // Something could not be merged (e.g. a socket): leave the folder, ensureClaudeLinks reports a conflict
    if ((e as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && (e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

// Appends the whole of src to dst (no line comparison; a newline is inserted where needed), creating dst 0600 when
// missing, then removes src
function appendHistory(src: string, dst: string): void {
  const add = fs.readFileSync(src);
  if (add.length > 0) {
    const existing = lstatOrUndefined(dst) ? fs.readFileSync(dst) : Buffer.alloc(0);
    const parts: Buffer[] = [];
    if (existing.length > 0 && existing[existing.length - 1] !== 0x0a) parts.push(Buffer.from('\n'));
    parts.push(add);
    if (add[add.length - 1] !== 0x0a) parts.push(Buffer.from('\n'));
    fs.appendFileSync(dst, Buffer.concat(parts), { mode: 0o600 });
  } else if (!lstatOrUndefined(dst)) {
    fs.writeFileSync(dst, '', { mode: 0o600, flag: 'wx' });
  }
  fs.unlinkSync(src);
}

/** Converts an independent account into a shared one. Throws t('share.busy') with the display name label (defaults to
 *  accountName; accountName names '<name>.from-<account>') before writing when claudeAccountBusy(dir, procRoot) or
 *  options.busy() (the caller's check, e.g. a PlanSwap terminal opened while the copy-fallback prompt was shown).
 *  Moves the account's real shared entries into the default dir, never overwriting there and never following links:
 *  folders and the non-excluded skills/ plugins/ children through mergeEntry; history.jsonl appended whole
 *  (appendHistory); settings.json / CLAUDE.md moved when the default lacks them (a settings.json with identity keys
 *  stays, unlinked), dropped when identical, otherwise renamed to '<name>.independent-backup' (backups); settings.json
 *  also stays when the default one cannot be shared. Without file-link privilege single files stay (noPrivilege).
 *  An account file is deleted only when an identical default copy exists; a file the default entry resolves to stays
 *  (a conflict of ensureClaudeLinks). A sync base (SYNC_BASE) left from an earlier shared period is removed first. Ends with finalizeMerge and
 *  ensureClaudeLinks(dir, procRoot, options), whose report is merged in. The default dir → empty report. */
export function migrateClaudeToShared(dir: string, accountName: string, procRoot = '/proc', label = accountName, options: LinkOptions = {}): MigrateReport {
  const report: MigrateReport = { ...emptyReport(), moved: 0, duplicates: 0, keptBoth: [], backups: [] };
  if (isDefault(dir)) return report;
  assertNotDefaultAncestor(dir);
  if (claudeAccountBusy(dir, procRoot) || options.busy?.()) throw new Error(t('share.busy', { name: label }));
  const def = defaultDir();
  const acc = path.resolve(dir);
  fs.mkdirSync(def, { recursive: true, mode: 0o700 });
  removeSyncBase(dir);
  const ctx: MergeCtx = { report, account: accountName };
  // Without file-link privilege (Windows, Developer Mode off) single files are never moved into the default account:
  // they could not be linked back, so the account keeps them
  const fileLinks = fileLinksAvailable(acc);

  for (const { name, kind } of CLAUDE_SHARED_ENTRIES) {
    const src = path.join(acc, name);
    const st = lstatOrUndefined(src);
    if (!st || st.isSymbolicLink()) continue;   // missing or already a link (a link elsewhere stays a conflict)
    const dst = path.join(def, name);
    if (kind === 'dir') {
      if (!st.isDirectory()) continue;
      const into = defaultFolder(dst);
      if (into) mergeEntry(src, into, name, ctx);
    } else if (st.isFile()) {
      if (!fileLinks) {
        (report.noPrivilege ??= []).push(name);
        continue;
      }
      // The default entry links to this very file: its "identical copy" would be the only one, so the file stays
      // (ensureClaudeLinks reports it as a conflict)
      if (lstatOrUndefined(dst) && sameRealPath(src, dst)) continue;
      if (name === 'history.jsonl') {
        appendHistory(src, dst);
        rememberMove(ctx, src, dst);
        report.moved++;
      } else {
        // settings.json stays when it cannot be linked (default has identity keys), so the account keeps its settings
        if (name === 'settings.json' && !settingsShareable(dst)) continue;
        const ds = lstatOrUndefined(dst);
        if (!ds) {
          // The default has none: the account's file becomes the shared one, unless it carries identity keys
          if (name === 'settings.json' && !settingsShareable(src)) continue;
          if (moveEntry(src, dst)) {
            rememberMove(ctx, src, dst);
            report.moved++;
          }
        } else if (fs.existsSync(dst) && sameContent(src, dst, st, fs.statSync(dst))) {
          fs.unlinkSync(src);
          rememberMove(ctx, src, dst);
          report.duplicates++;
        } else {
          const backup = freeName(`${src}.independent-backup`);
          fs.renameSync(src, backup);
          rememberMove(ctx, src, backup);
          report.backups.push(path.basename(backup));
        }
      }
    }
  }

  const excluded = new Set<string>(CLAUDE_CHILD_EXCLUDES);
  for (const name of CLAUDE_CHILD_SHARED_DIRS) {
    const accFolder = path.join(acc, name);
    if (!lstatOrUndefined(accFolder)?.isDirectory()) continue;
    const defFolder = path.join(def, name);
    const into = defaultFolder(defFolder);
    if (!into) continue;
    for (const child of fs.readdirSync(accFolder)) {
      if (excluded.has(child)) continue;
      const src = path.join(accFolder, child);
      if (linksTo(src, path.join(defFolder, child))) continue;
      if (!fileLinks && lstatOrUndefined(src)?.isFile()) {
        (report.noPrivilege ??= []).push(`${name}/${child}`);
        continue;
      }
      mergeEntry(src, path.join(into, child), `${name}/${child}`, ctx);
    }
  }

  finalizeMerge(ctx);
  const links = ensureClaudeLinks(dir, procRoot, options);
  report.linked.push(...links.linked);
  report.created.push(...links.created);
  report.conflicts.push(...links.conflicts);
  report.refused.push(...links.refused);
  if (links.refusedNotes) report.refusedNotes = { ...links.refusedNotes };
  if (links.busy) report.busy = [...links.busy];
  if (links.failed) report.failed = [...links.failed];
  if (links.copied) report.copied = [...links.copied];
  if (links.noPrivilege) report.noPrivilege = [...new Set([...(report.noPrivilege ?? []), ...links.noPrivilege])];
  return report;
}

/** Recursive copy of the folder src to dst: links are recreated, never followed (a relative link into the copied tree
 *  stays relative so it points into the copy; any other relative link becomes absolute so it still reaches its target
 *  from the new place), files with their mode and timestamps, sockets and FIFOs skipped. Nothing is overwritten: an
 *  entry that already exists at the target is skipped ('skip') or fails with EEXIST ('throw'). Written without
 *  fs.cpSync, which aborts the whole process instead of throwing when a directory cannot be read; here every problem
 *  surfaces as an ordinary error. root: the top folder of the copy (set by the recursion). */
export function copyTree(src: string, dst: string, existing: 'skip' | 'throw' = 'skip', root = src): void {
  const st = fs.lstatSync(src);
  const ds = lstatOrUndefined(dst);
  if (st.isDirectory()) {
    if (!ds) fs.mkdirSync(dst, { mode: st.mode & 0o777 });
    else if (!ds.isDirectory() || existing === 'throw') return existsError(dst, existing);
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name), existing, root);
    fs.utimesSync(dst, st.atime, st.mtime);
  } else if (ds) {
    existsError(dst, existing);
  } else if (st.isSymbolicLink()) {
    try {
      copyTreeLink(src, dst, root);
    } catch (e) {
      // Windows without file-link privilege: a link to a file is copied as that file; a dangling one is skipped
      if (!(e instanceof LinkPrivilegeError)) throw e;
      if (fs.existsSync(src) && fs.statSync(src).isFile()) fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    }
  } else if (st.isFile()) {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, st.mode & 0o777);
    fs.utimesSync(dst, st.atime, st.mtime);
  }
}

// The link src recreated at dst for copyTree (see there); root is the top of the copied tree
function copyTreeLink(src: string, dst: string, root: string): void {
  const raw = fs.readlinkSync(src);
  const resolved = path.resolve(path.dirname(src), raw);
  const rel = path.relative(root, resolved);
  const inside = !path.isAbsolute(raw) && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!isWindows()) {
    fs.symlinkSync(inside ? raw : resolved, dst);
    return;
  }
  // Windows links are created with absolute targets (junctions require them): an inside link points into the copy
  createLink(inside ? path.resolve(path.dirname(dst), raw) : resolved, dst);
}

function existsError(dst: string, existing: 'skip' | 'throw'): void {
  if (existing === 'throw') throw Object.assign(new Error(`EEXIST: file already exists, copy '${dst}'`), { code: 'EEXIST' });
}

/** Independent creation: copies settings.json without the identity keys (copySettingsStripped), CLAUDE.md, the
 *  INDEPENDENT_COPY_DIRS folders (a folder that is a link is copied from its real location) and the skills/ children
 *  except CLAUDE_CHILD_EXCLUDES from the default dir (copyTree), then adds missing MCP servers (syncMcpServers;
 *  'mcpServers' listed in copied when any was added). plugins/, history and sessions are not copied. Never overwrites
 *  an existing account entry. The default dir → no-op. */
export function copyClaudeIndependent(fromJson: string, dir: string): { copied: string[] } {
  const copied: string[] = [];
  if (isDefault(dir)) return { copied };
  assertNotDefaultAncestor(dir);
  const def = defaultDir();
  const acc = path.resolve(dir);
  fs.mkdirSync(acc, { recursive: true, mode: 0o700 });

  if (copySettingsStripped(def, acc)) copied.push('settings.json');
  const rules = path.join(def, 'CLAUDE.md');
  if (fs.existsSync(rules) && fs.statSync(rules).isFile() && !lstatOrUndefined(path.join(acc, 'CLAUDE.md'))) {
    fs.copyFileSync(rules, path.join(acc, 'CLAUDE.md'), fs.constants.COPYFILE_EXCL);
    copied.push('CLAUDE.md');
  }
  for (const name of INDEPENDENT_COPY_DIRS) {
    const src = path.join(def, name);
    // A top-level folder that is itself a link (e.g. into dotfiles) is copied from its real location
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory() || lstatOrUndefined(path.join(acc, name))) continue;
    copyTree(fs.realpathSync(src), path.join(acc, name));
    copied.push(name);
  }
  const skills = path.join(def, 'skills');
  if (fs.existsSync(skills) && fs.statSync(skills).isDirectory()) {
    const excluded = new Set<string>(CLAUDE_CHILD_EXCLUDES);
    for (const child of fs.readdirSync(skills)) {
      if (excluded.has(child)) continue;
      const to = path.join(acc, 'skills', child);
      if (lstatOrUndefined(to)) continue;
      fs.mkdirSync(path.join(acc, 'skills'), { recursive: true, mode: 0o700 });
      copyTree(path.join(skills, child), to);
      copied.push(`skills/${child}`);
    }
  }
  if (syncMcpServers(fromJson, acc).added.length > 0) copied.push('mcpServers');
  return { copied };
}

/** Unlinks `link` when it is a symlink resolving to the default entry `target` (linksTo: real paths compared);
 *  records `name` in `removed`. Regular files and links resolving elsewhere are left alone. */
export function unlinkIfLinksTo(link: string, target: string, name: string, removed: string[]): boolean {
  if (!linksTo(link, target)) return false;
  fs.unlinkSync(link);
  removed.push(name);
  return true;
}

/** Per-child folder (skills/ …): a whole-folder link from an earlier version is removed as one entry `rel`; a real
 *  folder (realFolder) keeps its non-link children and loses the children linked to the default folder. */
export function unlinkChildLinks(accFolder: string, defFolder: string, rel: string, realFolder: boolean, removed: string[]): void {
  if (unlinkIfLinksTo(accFolder, defFolder, rel, removed) || !realFolder) return;
  for (const child of fs.readdirSync(accFolder)) {
    unlinkIfLinksTo(path.join(accFolder, child), path.join(defFolder, child), `${rel}/${child}`, removed);
  }
}

// Entries that get an own copy when the account becomes independent; unlinked before the copy, the rest after it
const INDEPENDENT_CONFIG_ENTRIES = new Set(['settings.json', 'CLAUDE.md', ...INDEPENDENT_COPY_DIRS]);

/** Converts a shared account back into an independent one. Removes only links that resolve to the default entry
 *  (unlinkIfLinksTo / unlinkChildLinks; anything else is left untouched), in this order: settings.json, CLAUDE.md, the
 *  INDEPENDENT_COPY_DIRS and the skills/ children; then copyClaudeIndependent; then history.jsonl, the session folders,
 *  the projects marker and the plugins/ children. A failed copy therefore leaves the account shared, and
 *  ensureClaudeLinks re-creates the missing links. History and sessions are neither copied nor moved; the default dir is
 *  never written. Throws t('unshare.default') for the default dir and t('unshare.notShared') for an account that is not
 *  shared. The account's sync base (SYNC_BASE) is removed last. Returns the removed link names (children as
 *  'skills/<child>') and the copied entries. */
export function makeClaudeIndependent(fromJson: string, dir: string): { removed: string[]; copied: string[] } {
  if (isDefault(dir)) throw new Error(t('unshare.default', { dir }));
  assertNotDefaultAncestor(dir);
  if (!isSharedClaudeAccount(dir)) throw new Error(t('unshare.notShared', { dir }));
  const def = defaultDir();
  const acc = path.resolve(dir);
  const removed: string[] = [];
  const unlinkEntries = (config: boolean): void => {
    for (const { name } of CLAUDE_SHARED_ENTRIES) {
      if (INDEPENDENT_CONFIG_ENTRIES.has(name) === config) unlinkIfLinksTo(path.join(acc, name), path.join(def, name), name, removed);
    }
  };
  const unlinkChildren = (name: string): void =>
    unlinkChildLinks(path.join(acc, name), path.join(def, name), name, !!lstatOrUndefined(path.join(acc, name))?.isDirectory(), removed);
  // The configuration is unlinked and copied first; history, sessions and the projects marker only afterwards, so a
  // failed copy leaves the account shared (missing links are re-created by ensureClaudeLinks)
  unlinkEntries(true);
  unlinkChildren('skills');
  const { copied } = copyClaudeIndependent(fromJson, dir);
  unlinkEntries(false);
  for (const name of LEGACY_SHARED_ENTRIES) unlinkIfLinksTo(path.join(acc, name), path.join(def, name), name, removed);
  unlinkChildren('plugins');
  removeSyncBase(dir);
  return { removed, copied };
}

/** Shared iff <dir>/projects is a symlink to the default dir's projects: resolving to it, or spelled as it while the
 *  default folder is missing (deleted to reclaim space; the next link refresh recreates it). The default dir → false. */
export function isSharedClaudeAccount(dir: string): boolean {
  if (isDefault(dir)) return false;
  return linksTo(path.join(path.resolve(dir), 'projects'), path.join(defaultDir(), 'projects'));
}
