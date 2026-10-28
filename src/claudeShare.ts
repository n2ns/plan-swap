// Shared vs independent Claude accounts: a shared account links the supported configuration and work data to the
// default account's directory while keeping its login identity separate. No vscode import. Design and rationale: docs/design.md 6.7.
// Invariants of every write entry point (ensureClaudeLinks, syncClaudeAccount in claudeSync.ts, migrateClaudeToShared,
// makeClaudeIndependent, copyClaudeIndependent): an account dir that contains the default dir after resolving links
// throws t('account.containsDefaultDir', { dir, default }) before anything is written; existing content of the default
// dir is never overwritten or deleted, except that syncClaudeAccount updates the synced items of the default account's
// info file and the MCP sign-ins of its credentials file; links are absolute; report names use '/' on every platform.
// A Claude API card's own files (cardFiles) are skipped by every entry point, and ensureClaudeLinks (except in check
// mode), migrateClaudeToShared, makeClaudeIndependent and copyClaudeIndependent throw t('claude.provider.notLocal')
// before writing when one of them is a link or not a regular file (assertClaudeProviderFilesLocal).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { t } from './i18n';
import { assertNotDefaultClaudeAncestor, claudeIdentitySetting, copySettingsStripped, defaultDir, isDefaultClaudeDir, samePath, sameRealPath, strippedSettings, syncMcpServers } from './paths';
import { comparablePath, fileLinksAvailable, lacksProcfs, normalizeStartTime, pidAlive, platformStartTimes, type StartTimeProbe, stripBom, isPlainObject } from './platform';
import { CLAUDE_PROVIDER_FILES, ProviderConfigError, assertClaudeProviderFilesLocal, hasClaudeProviderMarker } from './claudeProvider';
import { type ShareReport, type MigrateReport, lstatOrUndefined, linksTo, emptyReport, missingLinkResult, linkEntry, type LinkOptions, recordLink, record, mergeLines, markElsewhere, sameContent } from './shareLinks';
import { moveEntry, freeName, type MergeCtx, rememberMove, mergeEntry, finalizeMerge, defaultFolder, copyTree, unlinkIfLinksTo, unlinkChildLinks } from './shareMerge';
import { removeSyncBase } from './claudeSync';

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

// Folders copied once when an independent account is created
const INDEPENDENT_COPY_DIRS = ['agents', 'commands', 'output-styles', 'hooks', 'rules'];

const EMPTY_CONTENT: Record<string, string> = { 'settings.json': '{}\n' };

// Whether a child entry of a shared folder is a readable file or a readable, searchable folder (links followed)
function readableChild(target: string): boolean {
  try {
    const st = fs.statSync(target);
    if (!st.isFile() && !st.isDirectory()) return false;
    fs.accessSync(target, st.isDirectory() ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** The entries a Claude API card owns (claudeProvider CLAUDE_PROVIDER_FILES): sharing never links, copies, strips,
 *  moves, replaces or deduplicates them, so a card keeps its own settings.json and the default account never gets the
 *  card's env. Empty for an ordinary account. */
function cardFiles(dir: string): ReadonlySet<string> {
  return new Set<string>(hasClaudeProviderMarker(dir) ? CLAUDE_PROVIDER_FILES : []);
}

// Before a sharing write: a card's own files must still be regular files in its folder, else nothing is written
function assertCardFilesLocal(dir: string): void {
  try {
    assertClaudeProviderFilesLocal(dir);
  } catch (err) {
    if (err instanceof ProviderConfigError) throw new Error(t('claude.provider.notLocal', { dir: path.resolve(dir) }));
    throw err;
  }
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
  if (entries?.size === 0 || isDefaultClaudeDir(dir)) return report;
  const selected = (name: string): boolean => !entries || entries.has(name) || entries.has(name.split('/')[0]);
  assertNotDefaultClaudeAncestor(dir);
  const check = !!options.check;
  const own = cardFiles(dir);
  if (!check) assertCardFilesLocal(dir);
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
    if (!selected(name) || own.has(name)) continue;
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
      // Child entries can be files or folders. A broken or inaccessible source (a dangling or cyclic link, a special
      // file, no read permission) is reported for that child and left unlinked; the other children are still linked
      if (!readableChild(target)) {
        (report.unreadable ??= []).push(`${name}/${child}`);
        continue;
      }
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

// The procStart format Claude Code records: FILETIME ticks on Windows, `ps` lstart in the C locale and UTC on macOS
// (e.g. "Mon Oct 26 20:00:10 2026", whitespace collapsed); a value in another format counts as absent
const PROC_START_FORMAT: Record<string, RegExp> = {
  win32: /^\d+$/,
  darwin: /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
};

// A session file's live process: pid and the recorded start time (procStart; on macOS with its whitespace collapsed);
// undefined when unreadable, invalid or not running
function liveSession(file: string, platform: string): { pid: number; start?: string } | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(data)) return undefined;
    const { pid, procStart } = data;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return undefined;
    if (typeof procStart !== 'string') return { pid };
    const start = platform === 'darwin' ? normalizeStartTime(procStart) : procStart;
    return PROC_START_FORMAT[platform]?.test(start) ? { pid, start } : { pid };
  } catch {
    return undefined;
  }
}

/**
 * Busy check of the platforms without /proc (Windows and macOS, see lacksProcfs), where another process's environment
 * cannot be read. A shared account's sessions folder is a link to the default one, whose records belong to every
 * account sharing it and cannot be told apart: false (the callers also refuse while the account's own terminal is
 * open). Otherwise a record whose pid is alive and, when it carries procStart in the platform's format
 * (PROC_START_FORMAT), whose process started at that time (both sides compared through normalizeStartTime); a live
 * record without such a procStart, or a failed start-time probe, counts as busy. startTimes and platform are for tests.
 */
export function sessionRecordsBusy(sessions: string, startTimes: StartTimeProbe = platformStartTimes, platform: string = process.platform): boolean {
  if (lstatOrUndefined(sessions)?.isSymbolicLink()) return false;
  let files: string[];
  try {
    files = fs.readdirSync(sessions).filter((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
  const live = files.map((f) => liveSession(path.join(sessions, f), platform)).filter((s) => s !== undefined);
  if (live.some((s) => s.start === undefined)) return true;
  if (live.length === 0) return false;
  const times = startTimes(live.map((s) => s.pid));
  return !times || live.some((s) => {
    const time = times.get(s.pid);
    return time !== undefined && normalizeStartTime(time) === normalizeStartTime(s.start!);
  });
}

/** true when a Claude process is running with this config dir: a <dir>/sessions/*.json whose pid is alive and whose
 *  /proc/<pid>/environ has CLAUDE_CONFIG_DIR=<dir> (samePath or sameRealPath; for the default dir: unset or the
 *  default). Unreadable records, invalid pids and unreadable environ files (not running, another user's process) are
 *  skipped; no sessions folder → false. Without procRoot (e.g. no /proc) any session file counts as busy.
 *  Windows and macOS with the default procRoot: sessionRecordsBusy. procRoot is for tests. */
export function claudeAccountBusy(dir: string, procRoot = '/proc'): boolean {
  const sessions = path.join(path.resolve(dir), 'sessions');
  if (lacksProcfs() && procRoot === '/proc') return sessionRecordsBusy(sessions);
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
  if (isDefaultClaudeDir(dir)) return report;
  assertNotDefaultClaudeAncestor(dir);
  if (claudeAccountBusy(dir, procRoot) || options.busy?.()) throw new Error(t('share.busy', { name: label }));
  assertCardFilesLocal(dir);
  const own = cardFiles(dir);
  const def = defaultDir();
  const acc = path.resolve(dir);
  fs.mkdirSync(def, { recursive: true, mode: 0o700 });
  removeSyncBase(dir);
  const ctx: MergeCtx = { report, account: accountName };
  // Without file-link privilege (Windows, Developer Mode off) single files are never moved into the default account:
  // they could not be linked back, so the account keeps them
  const fileLinks = fileLinksAvailable(acc);

  for (const { name, kind } of CLAUDE_SHARED_ENTRIES) {
    if (own.has(name)) continue;
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

/** Independent creation: copies settings.json without the identity keys (copySettingsStripped), CLAUDE.md, the
 *  INDEPENDENT_COPY_DIRS folders (a folder that is a link is copied from its real location) and the skills/ children
 *  except CLAUDE_CHILD_EXCLUDES from the default dir (copyTree), then adds missing MCP servers (syncMcpServers;
 *  'mcpServers' listed in copied when any was added). plugins/, history and sessions are not copied. Never overwrites
 *  an existing account entry. The default dir → no-op. */
export function copyClaudeIndependent(fromJson: string, dir: string): { copied: string[] } {
  const copied: string[] = [];
  if (isDefaultClaudeDir(dir)) return { copied };
  assertNotDefaultClaudeAncestor(dir);
  assertCardFilesLocal(dir);
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
  if (isDefaultClaudeDir(dir)) throw new Error(t('unshare.default', { dir }));
  assertNotDefaultClaudeAncestor(dir);
  if (!isSharedClaudeAccount(dir)) throw new Error(t('unshare.notShared', { dir }));
  assertCardFilesLocal(dir);
  const own = cardFiles(dir);
  const def = defaultDir();
  const acc = path.resolve(dir);
  const removed: string[] = [];
  const unlinkEntries = (config: boolean): void => {
    for (const { name } of CLAUDE_SHARED_ENTRIES) {
      if (!own.has(name) && INDEPENDENT_CONFIG_ENTRIES.has(name) === config) unlinkIfLinksTo(path.join(acc, name), path.join(def, name), name, removed);
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
  if (isDefaultClaudeDir(dir)) return false;
  return linksTo(path.join(path.resolve(dir), 'projects'), path.join(defaultDir(), 'projects'));
}
