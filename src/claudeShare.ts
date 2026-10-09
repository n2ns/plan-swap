// Shared vs independent Claude accounts: a shared account links everything except its login identity to the
// default account's directory. No vscode import. Design and rationale: docs/design.md 6.7.
// Invariants of every write entry point (ensureClaudeLinks, mirrorClaudeJson, migrateClaudeToShared,
// makeClaudeIndependent, copyClaudeIndependent): an account dir that contains the default dir after resolving links
// throws t('account.containsDefaultDir', { dir, default }) before anything is written; existing content of the default
// dir is never overwritten or deleted; links are absolute; report names use '/' on every platform.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { t } from './i18n';
import { accountInfoTarget, claudeIdentitySetting, claudeJsonName, copySettingsStripped, defaultDir, realPath, realPathInside, samePath, sameRealPath, strippedSettings, syncMcpServers, unchangedSince } from './paths';
import {
  comparablePath, isOpaqueReparseDir, JunctionError, LinkPrivilegeError, createLink, fileLinksAvailable, isWindows, pidAlive, renameReplacing, type StartTimeProbe,
  stripBom, unlinkLinks, windowsStartTimes,
} from './platform';

// Whole-entry links (kind: file needs an empty-file default, dir needs an empty dir). 'projects' is the marker entry
// that isSharedClaudeAccount checks. Not shared: .credentials.json, .claude.json (mirrored instead) and everything else
export const CLAUDE_SHARED_ENTRIES: ReadonlyArray<{ name: string; kind: 'file' | 'dir' }> = [
  { name: 'settings.json', kind: 'file' },
  { name: 'CLAUDE.md', kind: 'file' },
  { name: 'history.jsonl', kind: 'file' },
  { name: 'projects', kind: 'dir' }, { name: 'file-history', kind: 'dir' }, { name: 'todos', kind: 'dir' },
  { name: 'session-env', kind: 'dir' }, { name: 'shell-snapshots', kind: 'dir' }, { name: 'sessions', kind: 'dir' },
  { name: 'tasks', kind: 'dir' }, { name: 'uploads', kind: 'dir' }, { name: 'agents', kind: 'dir' },
  { name: 'commands', kind: 'dir' }, { name: 'output-styles', kind: 'dir' }, { name: 'hooks', kind: 'dir' },
  { name: 'rules', kind: 'dir' }, { name: 'ide', kind: 'dir' },
];
// Dirs shared per child: every child of the default dir's folder is linked, except these names
export const CLAUDE_CHILD_SHARED_DIRS = ['skills', 'plugins'] as const;
export const CLAUDE_CHILD_EXCLUDES = ['synced', '.trash'] as const;   // per-account cloud-synced buckets
// Per-project keys of .claude.json mirrored from the default account
const PROJECT_KEYS = [
  'allowedTools', 'mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpContextUris',
  'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown',
];
// Read-only mirror check: whether the account value acc already holds everything of the default value src. true needs
// true; false is held by anything; every array element and object key (deep) of src must be in acc. A missing account
// value holds only empty / false values, which is what Claude Code reads for a missing project key (research fact 18).
// What the account has beyond the default (its own MCP server, a project it trusted) is not a difference here
function holds(acc: unknown, src: unknown): boolean {
  if (src === false || src === undefined) return true;
  if (Array.isArray(src)) {
    const have = Array.isArray(acc) ? acc : [];
    return src.every((x) => have.some((y) => isDeepStrictEqual(x, y)));
  }
  if (isPlainObject(src)) {
    const have = isPlainObject(acc) ? acc : {};
    return Object.entries(src).every(([k, v]) => isDeepStrictEqual(have[k], v));
  }
  return isDeepStrictEqual(acc, src);
}

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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

// Creates a missing default entry empty; returns true when created
function ensureDefaultEntry(target: string, kind: 'file' | 'dir'): boolean {
  if (lstatOrUndefined(target)) return false;
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
  // link (config files only: databases and locks may be open elsewhere)
  const fileLinks = (): boolean => (check ? check.fileLinks : fileLinksAvailable(path.dirname(link)));
  if (isWindows() && COPYABLE_ON_NO_LINK.includes(path.basename(link)) && st.isFile() && fs.existsSync(target) && sameContent(link, target, st, fs.statSync(target)) && fileLinks()) {
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
  // Extra busy check of the caller (Windows: the account's own PlanSwap terminal is open); ORed with the module's own
  // busy check before any step that moves, merges or unlinks account files
  busy?: () => boolean;
  // Read-only check: nothing is written and no folder is created; the report lists what a repair would do, in the same
  // lists and order as the repair's own report
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
 *  missing default entry is created empty first (folder 0700, file 0600, settings.json '{}\n'); a missing account entry
 *  becomes a link; a regular entry or a link elsewhere stays and is reported under conflicts (links also under
 *  elsewhere). Exception: in an already shared account a regular history.jsonl (replaced by `claude project purge`) is
 *  merged back with mergeLines and relinked (merged and linked; only while file links work); an independent account's
 *  own history.jsonl stays a conflict.
 *  skills/ plugins/: a whole-folder link from an earlier version is replaced by a real folder with per-child links
 *  (except CLAUDE_CHILD_EXCLUDES), and child links whose default child no longer exists are removed (both unlinked).
 *  Those three steps move or unlink account files, so they are skipped and reported under busy while
 *  claudeAccountBusy(dir, procRoot) or options.busy() is true; that check runs lazily (once, only when such a step
 *  comes up) and the other links are still made. When the default settings.json cannot be shared, settings.json is
 *  refused (explained in refusedNotes) and an existing settings.json link (unlinked) or a missing one becomes the
 *  account's own copy without identity keys (copySettingsStripped; stripped).
 *  options.copyConfig enables the one-time Windows copy fallback (recordLink). options.check: read only (no write, no
 *  folder created, Windows file links taken from options.fileLinks); the report is the one the repair would return
 *  except that the copy fallback is never offered and a junction the drive refuses cannot be foreseen.
 *  dir === default → empty report. */
export function ensureClaudeLinks(dir: string, procRoot = '/proc', options: LinkOptions = {}): ShareReport {
  const report = emptyReport();
  if (isDefault(dir)) return report;
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
  const missingDefault = (target: string, kind: 'file' | 'dir'): boolean => (check ? !lstatOrUndefined(target) : ensureDefaultEntry(target, kind));

  const shared = isSharedClaudeAccount(dir);
  // Merging a file's lines back removes it; without file-link privilege it could not be linked again, so it stays
  const fileLinks = check ? options.fileLinks ?? true : fileLinksAvailable(acc);
  for (const { name, kind } of CLAUDE_SHARED_ENTRIES) {
    const target = path.join(def, name);
    const link = path.join(acc, name);
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
    if (shared && name === 'history.jsonl' && lstatOrUndefined(link)?.isFile() && fileLinks) {
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
    const defFolder = path.join(def, name);
    if (missingDefault(defFolder, 'dir')) report.created.push(name);
    const accFolder = path.join(acc, name);
    const st = lstatOrUndefined(accFolder);
    // Check: the account folder would be created (or re-created) empty, so every child would be linked
    let fresh = false;
    if (st?.isSymbolicLink() && linksTo(accFolder, defFolder)) {
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
    const children = check && !lstatOrUndefined(defFolder) ? [] : fs.readdirSync(defFolder);
    for (const child of children) {
      if (excluded.has(child)) continue;
      const target = path.join(defFolder, child);
      record(report, `${name}/${child}`, fresh ? missingLinkResult(target, { fileLinks }) : linkEntry(path.join(accFolder, child), target, check ? { fileLinks } : undefined));
    }
    if (fresh) continue;
    // Remove links into the default folder whose target no longer exists
    for (const child of fs.readdirSync(accFolder)) {
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

// Reads a JSON object; undefined when missing; throws when present but not a JSON object
function readSourceJson(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    data = undefined;
  }
  if (!isPlainObject(data)) throw new Error(t('share.badSource', { file }));
  return data;
}

/** Mirrors shareable keys of the default account's info file (fromJson, read only; missing = empty; not a JSON object →
 *  throws t('share.badSource')) into <dir>/.claude.json:
 *  - mcpServers becomes an exact copy of the default's (an absent default list empties it);
 *  - for every project of the default's `projects`, the PROJECT_KEYS present there are copied (the entry is created
 *    when missing); other project keys stay;
 *  - ONBOARDING_KEYS are added only when the account lacks them and is signed in;
 *  - every other key (e.g. githubRepoPaths, oauthAccount) stays as is.
 *  changed lists 'mcpServers', the added onboarding keys and 'projects:<path>'. No write when nothing changes. A missing
 *  file is created 0600; otherwise the write follows a symlink, keeps the mode and replaces atomically (temporary file +
 *  renameReplacing), refusing with t('mcp.changed') when the file changed since it was read. A target that is not a
 *  JSON object throws t('mcp.badTarget'). Protected/ambiguous info targets throw t('mcp.unsafeTarget') before any
 *  target content read, including check mode; legal external links remain supported. The default dir → no-op.
 *  beforeCommit runs between writing the temporary file and the change check (tests simulate a concurrent CLI write).
 *  check: read only, nothing is written (the same errors are thrown); changed lists only what the account lacks of the
 *  default (holds): a server or project setting the default adds or changes, a project it trusts. A key the account
 *  lacks counts as empty / false (research fact 18), and what the account has beyond the default (its own MCP server,
 *  a project only it trusts) is not listed, although the mirror itself would replace or remove it. */
export function mirrorClaudeJson(fromJson: string, dir: string, beforeCommit?: () => void, check = false): { changed: string[] } {
  const changed: string[] = [];
  if (isDefault(dir)) return { changed };
  assertNotDefaultAncestor(dir);
  const file = path.join(path.resolve(dir), claudeJsonName());
  const target = accountInfoTarget(file, dir, fromJson);
  const source = readSourceJson(fromJson);

  const { real, mode } = target;
  let before: string | undefined;
  if (fs.existsSync(file)) before = fs.readFileSync(real, 'utf8');
  let data: unknown = {};
  if (before !== undefined) {
    try {
      data = JSON.parse(stripBom(before));
    } catch {
      data = undefined;
    }
  }
  if (!isPlainObject(data)) throw new Error(t('mcp.badTarget', { file: real }));

  const mcp =isPlainObject(source.mcpServers) ? source.mcpServers : {};
  const currentMcp = data.mcpServers === undefined ? {} : data.mcpServers;
  if (check ? !holds(currentMcp, mcp) : !isDeepStrictEqual(currentMcp, mcp)) {
    data.mcpServers = mcp;
    changed.push('mcpServers');
  }

  // Signed in as readAccountInfo decides it: an email in the file, or only the existence of the credentials file
  const oauth = data.oauthAccount;
  const signedIn = (isPlainObject(oauth) && typeof oauth.emailAddress === 'string' && oauth.emailAddress !== '')
    || fs.existsSync(path.join(path.resolve(dir), '.credentials.json'));
  if (signedIn) {
    for (const k of ONBOARDING_KEYS) {
      if (!Object.hasOwn(source, k) || Object.hasOwn(data, k)) continue;
      data[k] = source[k];
      changed.push(k);
    }
  }

  const srcProjects = isPlainObject(source.projects) ? source.projects : {};
  for (const [p, srcProj] of Object.entries(srcProjects)) {
    if (!isPlainObject(srcProj)) continue;
    if (!isPlainObject(data.projects)) data.projects = {};
    const projects = data.projects as Record<string, unknown>;
    const proj = isPlainObject(projects[p]) ? (projects[p] as Record<string, unknown>) : {};
    let differs = !check && !isPlainObject(projects[p]);
    for (const k of PROJECT_KEYS) {
      if (!Object.hasOwn(srcProj, k) || isDeepStrictEqual(proj[k], srcProj[k])) continue;
      if (check && holds(proj[k], srcProj[k])) continue;
      proj[k] = srcProj[k];
      differs = true;
    }
    if (differs) {
      projects[p] = proj;
      changed.push(`projects:${p}`);
    }
  }
  if (changed.length === 0 || check) return { changed };

  const tmp = `${real}.planswap-${process.pid}.tmp`;
  // A temporary file left by an interrupted run is replaced
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode, flag: 'wx' });
    beforeCommit?.();
    // Refuse to overwrite a write the CLI made in the meantime, checked again before every rename attempt
    if (!renameReplacing(tmp, real, undefined, undefined, () => target.validate() && unchangedSince(real, before))) throw new Error(t('mcp.changed', { file: real }));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { changed };
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
 *  An account file is deleted only when an identical default copy exists. Ends with finalizeMerge and
 *  ensureClaudeLinks(dir, procRoot, options), whose report is merged in. The default dir → empty report. */
export function migrateClaudeToShared(dir: string, accountName: string, procRoot = '/proc', label = accountName, options: LinkOptions = {}): MigrateReport {
  const report: MigrateReport = { ...emptyReport(), moved: 0, duplicates: 0, keptBoth: [], backups: [] };
  if (isDefault(dir)) return report;
  assertNotDefaultAncestor(dir);
  if (claudeAccountBusy(dir, procRoot) || options.busy?.()) throw new Error(t('share.busy', { name: label }));
  const def = defaultDir();
  const acc = path.resolve(dir);
  fs.mkdirSync(def, { recursive: true, mode: 0o700 });
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
 *  shared. Returns the removed link names (children as 'skills/<child>') and the copied entries. */
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
  unlinkChildren('plugins');
  return { removed, copied };
}

/** Shared iff <dir>/projects is a symlink to the default dir's projects: resolving to it, or spelled as it while the
 *  default folder is missing (deleted to reclaim space; the next link refresh recreates it). The default dir → false. */
export function isSharedClaudeAccount(dir: string): boolean {
  if (isDefault(dir)) return false;
  return linksTo(path.join(path.resolve(dir), 'projects'), path.join(defaultDir(), 'projects'));
}
