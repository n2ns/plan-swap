// Shared vs independent Codex accounts: a shared account links everything except its login identity to the
// default account's directory (~/.codex). No vscode import. Design: codex-design.md 8.6; the per-account entries
// that are never touched (auth.json, memories/ and the rest) are listed there. Reuses the ShareReport / MigrateReport
// types and the link / merge helpers of claudeShare (same semantics). The public entry points that write
// (ensureCodexLinks, migrateCodexToShared, copyCodexIndependent, makeCodexIndependent) throw
// t('account.containsDefaultDir') before any write when the account dir contains ~/.codex after resolving links.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { t } from '../i18n';
import { realPathInside, samePath, sameRealPath } from '../paths';
import { comparablePath, fileLinksAvailable, isWindows } from '../platform';
import {
  type MergeCtx, type MigrateReport, type ShareReport, copyTree, defaultFolder, emptyReport, freeName, linkEntry, recordLink, type LinkOptions,
  finalizeMerge, linksTo, lstatOrUndefined, mergeEntry, mergeLines, moveEntry, record, rememberMove, sameContent, unlinkChildLinks, unlinkIfLinksTo,
} from '../claudeShare';
import { blockedConfigReason, CODEX_IDENTITY_CONFIG_KEYS, codexDaemonAlive, codexDefaultDir, copyCodexSeed } from './codexPaths';

export type { MigrateReport, ShareReport };

// kind 'file': created empty (content below) in the default dir when missing; 'dir': created 0700;
// 'link-only': linked even when the default target is missing (dangling link; never created by us — sqlite creates
// the db at the target; lock/marker files must not be pre-created)
export const CODEX_SHARED_ENTRIES: ReadonlyArray<{ name: string; kind: 'file' | 'dir' | 'link-only' }> = [
  { name: 'config.toml', kind: 'file' },
  { name: 'AGENTS.md', kind: 'file' },
  { name: 'hooks.json', kind: 'file' },
  { name: 'history.jsonl', kind: 'file' },
  { name: 'session_index.jsonl', kind: 'file' },
  { name: 'state_5.sqlite', kind: 'link-only' }, { name: 'thread_history_1.sqlite', kind: 'link-only' },
  { name: 'goals_1.sqlite', kind: 'link-only' }, { name: 'queue_1.sqlite', kind: 'link-only' },
  // The maintenance lock (flock) keeps two accounts from migrating the shared rollouts at once. The compression marker
  // is not shared: Codex creates it with O_EXCL, which fails on a dangling link, so compression would never run
  { name: '.tmp/rollout-maintenance.lock', kind: 'link-only' },
  { name: 'sessions', kind: 'dir' },  // marker
  { name: 'archived_sessions', kind: 'dir' }, { name: 'rules', kind: 'dir' }, { name: 'hooks', kind: 'dir' },
  { name: 'agents', kind: 'dir' }, { name: 'themes', kind: 'dir' }, { name: 'thread-writer-locks', kind: 'dir' },
  { name: 'rollout-migrations', kind: 'dir' }, { name: 'attachments', kind: 'dir' }, { name: 'generated_images', kind: 'dir' },
  { name: 'shell_snapshots', kind: 'dir' }, { name: 'tui-thread-reference-capabilities', kind: 'dir' },
];
// Nested entries ('.tmp/…') need a real parent dir in the account (created 0700); '.tmp' itself is never linked.
export const CODEX_CHILD_SHARED_DIRS: ReadonlyArray<{ dir: string; excludes: readonly string[] }> = [
  { dir: 'skills', excludes: ['.system'] },
  { dir: 'plugins/cache', excludes: ['openai-curated-remote'] },
];
// config.toml is not linked (reported in `refused`, explained in `refusedNotes` when the account is left without one)
// when the default config is unreadable or blockedConfigReason finds one of CODEX_IDENTITY_CONFIG_KEYS. Re-evaluated on
// every link refresh: an existing account link to the default config.toml is then removed (no copy is made); a regular
// file or a link elsewhere stays.
export { CODEX_IDENTITY_CONFIG_KEYS };

const MARKER = 'sessions';
// Files Codex may rewrite by rename (the link is replaced by a real file); repaired by merging lines back
const JSONL_FILES = ['history.jsonl', 'session_index.jsonl'];
const EMPTY_CONTENT: Record<string, string> = { 'hooks.json': '{}\n' };
// Folders and files copied once when an independent account is created
const INDEPENDENT_COPY_DIRS = ['rules', 'hooks', 'agents', 'themes'];
const INDEPENDENT_COPY_FILES = ['AGENTS.md', 'hooks.json'];
const SQLITE_SIDE_FILES = ['-wal', '-shm'];

function isDefault(dir: string): boolean {
  return sameRealPath(dir, codexDefaultDir());
}

function assertNotContainingDefault(dir: string): void {
  const def = codexDefaultDir();
  if (realPathInside(dir, def)) throw new Error(t('account.containsDefaultDir', { dir, default: def }));
}

// Why the default config.toml cannot be shared: 'unreadable', the first blocking key, or undefined (missing, or
// readable text without a blocking key)
function configRefusal(file: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
  }
  return CODEX_IDENTITY_CONFIG_KEYS.find((key) => blockedConfigReason(text, [key]) !== undefined);
}

function configShareable(file: string): boolean {
  return configRefusal(file) === undefined;
}

// Localized explanation of a config.toml refusal for an account left without config.toml
function configRefusalNote(refusal: string): string {
  if (refusal === 'unreadable') return t('share.r.configUnreadable');
  return t(refusal === 'sqlite_home' ? 'share.r.configSqliteHome' : 'share.r.configSignsOut', { key: refusal });
}

// Creates a missing default entry empty; returns true when created
function ensureDefaultEntry(target: string, kind: 'file' | 'dir'): boolean {
  if (lstatOrUndefined(target)) return false;
  if (kind === 'dir') fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  else fs.writeFileSync(target, EMPTY_CONTENT[path.basename(target)] ?? '', { mode: 0o600, flag: 'wx' });
  return true;
}

// Ensures <acc>/<rel> and every folder above it (below acc) is a real folder: missing → created 0700, a link to the
// same default folder → replaced by a real folder when replaceLinks. false when some part is a file or a (kept) link.
function ensureAccountFolder(acc: string, def: string, rel: string, replaceLinks: boolean): boolean {
  let a = acc;
  let d = def;
  for (const seg of rel.split('/')) {
    a = path.join(a, seg);
    d = path.join(d, seg);
    const st = lstatOrUndefined(a);
    if (replaceLinks && st?.isSymbolicLink() && linksTo(a, d)) {
      // Whole-folder link from an earlier version
      fs.unlinkSync(a);
      fs.mkdirSync(a, { mode: 0o700 });
    } else if (!st) {
      fs.mkdirSync(a, { mode: 0o700 });
    } else if (!st.isDirectory()) {
      return false;
    }
  }
  return true;
}

// Whether <acc>/<rel> and every folder above it (below acc) is a real folder (no links followed)
function isRealFolder(acc: string, rel: string): boolean {
  let a = acc;
  for (const seg of rel.split('/')) {
    a = path.join(a, seg);
    if (!lstatOrUndefined(a)?.isDirectory()) return false;
  }
  return true;
}

/** Shared iff <dir>/sessions is a symlink to the default dir's sessions: resolving to it, or spelled as it while the
 *  default folder is missing. The default dir → false. */
export function isSharedCodexAccount(dir: string): boolean {
  if (isDefault(dir)) return false;
  // Resolving to the default entry, or spelled as it while that entry is missing (deleted by the user; the next link
  // refresh recreates it): a dangling marker must not turn the account independent
  return linksTo(path.join(path.resolve(dir), MARKER), path.join(codexDefaultDir(), MARKER));
}

/** Creates/repairs every link of a shared account (idempotent). Never touches the default dir's existing content;
 *  missing default entries are created empty ('file' 0600, hooks.json '{}', 'dir' 0700; 'link-only' never).
 *  In a shared account a real history.jsonl / session_index.jsonl is merged back into the default file (mergeLines:
 *  missing lines appended) and relinked (reported under `linked`), except while codexAccountBusy(dir, procRoot) or
 *  options.busy() (checked lazily, only when a merge-back comes up): then the file is left untouched and reported
 *  under `busy`; without file-link privilege it is not merged. A real sqlite db stays a conflict. Nested entries
 *  ('.tmp/…') need a real account folder (created 0700; otherwise a conflict). A whole-folder skills / plugins/cache
 *  link from an earlier version is replaced by per-child links; child links whose default target is gone are removed.
 *  win32: *.sqlite entries are never linked; an existing link is removed by removeWindowsSqliteLink (reported under
 *  `refused`, or `busy` when a side file is in use). dir === default → empty report. procRoot is for tests. */
export function ensureCodexLinks(dir: string, options: LinkOptions = {}, procRoot = '/proc'): ShareReport {
  const report = emptyReport();
  if (isDefault(dir)) return report;
  assertNotContainingDefault(dir);
  const def = codexDefaultDir();
  const acc = path.resolve(dir);
  const shared = isSharedCodexAccount(acc);
  // Checked only when a merge-back comes up; a running Codex may still be writing the file it replaced the link with
  let busy: boolean | undefined;
  const isBusy = (): boolean => (busy ??= codexAccountBusy(dir, procRoot) || !!options.busy?.());
  // Merging a file's lines back removes it; without file-link privilege it could not be linked again, so it stays
  const fileLinks = fileLinksAvailable(acc);
  fs.mkdirSync(def, { recursive: true, mode: 0o700 });
  fs.mkdirSync(acc, { recursive: true, mode: 0o700 });

  for (const { name, kind } of CODEX_SHARED_ENTRIES) {
    const target = path.join(def, name);
    const link = path.join(acc, name);
    const refusal = name === 'config.toml' ? configRefusal(target) : undefined;
    if (refusal) {
      // A link created while the default config was still shareable is removed; no copy is made
      if (linksTo(link, target)) fs.unlinkSync(link);
      report.refused.push(name);
      if (!lstatOrUndefined(link)) (report.refusedNotes ??= {})[name] = configRefusalNote(refusal);
      continue;
    }
    // Windows: databases stay per account (see removeWindowsSqliteLink); a link left from before is removed
    if (isWindows() && name.endsWith('.sqlite')) {
      const r = removeWindowsSqliteLink(link, target);
      if (r === 'removed') report.refused.push(name);
      else if (r === 'busy') (report.busy ??= []).push(name);
      continue;
    }
    const parent = path.dirname(name);
    if (parent !== '.') {
      if (!ensureAccountFolder(acc, def, parent, false)) {
        report.conflicts.push(name);
        continue;
      }
      // The target's folder must exist, otherwise opening the link with O_CREAT fails; the target itself is not created
      if (ensureDefaultEntry(path.join(def, parent), 'dir')) report.created.push(parent);
    }
    if (kind !== 'link-only' && ensureDefaultEntry(target, kind)) report.created.push(name);
    if (shared && fileLinks && JSONL_FILES.includes(name) && lstatOrUndefined(link)?.isFile()) {
      if (isBusy()) {
        (report.busy ??= []).push(name);
        continue;
      }
      mergeLines(link, target);
    }
    recordLink(report, name, linkEntry(link, target), link, target, !!options.copyConfig);
  }

  for (const { dir: rel, excludes } of CODEX_CHILD_SHARED_DIRS) {
    const defFolder = path.join(def, rel);
    if (ensureDefaultEntry(defFolder, 'dir')) report.created.push(rel);
    if (!ensureAccountFolder(acc, def, rel, true)) {
      report.conflicts.push(rel);
      continue;
    }
    const accFolder = path.join(acc, rel);
    const excluded = new Set<string>(excludes);
    for (const child of fs.readdirSync(defFolder)) {
      if (excluded.has(child)) continue;
      record(report, `${rel}/${child}`, linkEntry(path.join(accFolder, child), path.join(defFolder, child)));
    }
    // Remove links into the default folder whose target no longer exists
    for (const child of fs.readdirSync(accFolder)) {
      const link = path.join(accFolder, child);
      if (!lstatOrUndefined(link)?.isSymbolicLink()) continue;
      const to = path.resolve(accFolder, fs.readlinkSync(link));
      if (comparablePath(path.dirname(to)) === comparablePath(defFolder) && !lstatOrUndefined(to)) fs.unlinkSync(link);
    }
  }
  return report;
}

/** true when a Codex process uses this dir: codexDaemonAlive(dir), or a <procRoot>/<pid> whose exe basename is
 *  'codex' (a ' (deleted)' suffix ignored) and whose environ CODEX_HOME resolves to dir (for the default dir: unset,
 *  empty or ~/.codex). Environment alone never matches, since shells and MCP servers inherit CODEX_HOME.
 *  Unreadable /proc entries are skipped; an unreadable procRoot counts as busy. Windows with the default procRoot:
 *  codexDaemonAlive only (the host adds its own open-terminal check). procRoot is for tests. */
export function codexAccountBusy(dir: string, procRoot = '/proc'): boolean {
  if (codexDaemonAlive(path.resolve(dir))) return true;
  // Windows cannot read another process's environment, and a codex.exe is nearly always running (the Codex extension's
  // app server, which serves the effective account the callers already refuse); they also refuse while the account's
  // own terminal is open
  if (isWindows() && procRoot === '/proc') return false;
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((p) => /^\d+$/.test(p));
  } catch {
    // A running Codex cannot be ruled out
    return true;
  }
  const def = codexDefaultDir();
  const forDefault = isDefault(dir);
  for (const pid of pids) {
    let exe: string;
    let environ: string;
    try {
      // A binary replaced by an upgrade while running reads as '<path> (deleted)'
      exe = fs.readlinkSync(path.join(procRoot, pid, 'exe')).replace(/ \(deleted\)$/, '');
      if (path.basename(exe) !== 'codex') continue;
      environ = fs.readFileSync(path.join(procRoot, pid, 'environ'), 'utf8');
    } catch {
      // Exited, or another user's process
      continue;
    }
    const entry = environ.split('\0').find((e) => e.startsWith('CODEX_HOME='));
    const value = entry?.slice('CODEX_HOME='.length);
    if (forDefault ? !value || samePath(value, def) || sameRealPath(value, def) : !!value && (samePath(value, dir) || sameRealPath(value, dir))) {
      return true;
    }
  }
  return false;
}

/**
 * Windows: SQLite derives a database's -wal / -shm names from the path it opened, not from a link's target, so a
 * database opened through a link gets its own WAL beside the link and writes through it are lost (verified on the
 * GitHub Windows runner, 2026-09-30; Linux follows the link). Databases are therefore never linked there, and an
 * existing link is removed: its side files are kept as '<file>.windows-link-backup' so a database Codex creates at
 * that path later never replays them (freeName picks a free backup name). 'busy' when a side file is in use (renames
 * are undone, nothing changes). 'none' when link is not a link to target. Also used first by makeCodexIndependent
 * on win32 ('busy' → t('share.busyCodex')); migrateCodexToShared keeps the account's databases there instead of
 * backing them up.
 */
export function removeWindowsSqliteLink(link: string, target: string): 'removed' | 'busy' | 'none' {
  if (!linksTo(link, target)) return 'none';
  const moved: Array<[string, string]> = [];
  try {
    for (const suffix of SQLITE_SIDE_FILES) {
      const side = link + suffix;
      if (!lstatOrUndefined(side)) continue;
      const backup = freeName(`${side}.windows-link-backup`);
      fs.renameSync(side, backup);
      moved.push([backup, side]);
    }
  } catch {
    for (const [backup, side] of moved.reverse()) {
      try { fs.renameSync(backup, side); } catch { /* keep the backup name */ }
    }
    return 'busy';
  }
  fs.unlinkSync(link);
  return 'removed';
}

// Renames an account sqlite db and its -wal / -shm files to '<name>.independent-backup' (+ the same suffixes)
function backupSqlite(src: string, rel: string, ctx: MergeCtx): void {
  let base = `${src}.independent-backup`;
  const taken = (b: string): boolean => ['', ...SQLITE_SIDE_FILES].some((s) => lstatOrUndefined(b + s));
  for (let i = 2; taken(base); i++) base = `${src}.independent-backup-${i}`;
  for (const suffix of ['', ...SQLITE_SIDE_FILES]) {
    if (!lstatOrUndefined(src + suffix)) continue;
    fs.renameSync(src + suffix, base + suffix);
    rememberMove(ctx, src + suffix, base + suffix);
    ctx.report.backups.push(path.posix.join(path.posix.dirname(rel), path.basename(base + suffix)));
  }
}

/** Converts an independent account into a shared one; ends with ensureCodexLinks(dir, options, procRoot) and merges
 *  its report. Throws t('share.busyCodex') before writing when codexAccountBusy(dir, procRoot) or options.busy() (the
 *  host's terminal check, read after its copy-fallback prompt; see migrateClaudeToShared). The default dir → empty report.
 *  - dirs: merged recursively into the default folder (mergeEntry);
 *  - history.jsonl / session_index.jsonl: missing lines merged into the default file;
 *  - config.toml / AGENTS.md / hooks.json / .tmp/rollout-maintenance.lock: moved into ~/.codex when it lacks the file
 *    (a config.toml with identity keys/tables stays, unlinked), dropped when identical, else renamed to
 *    '<name>.independent-backup'; config.toml also stays when the default config is refused;
 *  - sqlite dbs: renamed with -wal / -shm to '<db>.independent-backup' (-2, -3… when taken); kept on win32;
 *  - skills / plugins/cache children merged (excludes kept); nested entries only inside a real account folder;
 *  - without file-link privilege single files stay and are reported under noPrivilege.
 *  `moved` counts files moved into ~/.codex and jsonl files that contributed at least one line. */
export function migrateCodexToShared(dir: string, accountName: string, procRoot = '/proc', options: LinkOptions = {}): MigrateReport {
  const report: MigrateReport = { ...emptyReport(), moved: 0, duplicates: 0, keptBoth: [], backups: [] };
  if (isDefault(dir)) return report;
  assertNotContainingDefault(dir);
  if (codexAccountBusy(dir, procRoot) || options.busy?.()) throw new Error(t('share.busyCodex', { name: accountName }));
  const def = codexDefaultDir();
  const acc = path.resolve(dir);
  fs.mkdirSync(def, { recursive: true, mode: 0o700 });
  const ctx: MergeCtx = { report, account: accountName };
  // Without file-link privilege (Windows, Developer Mode off) single files stay in the account, see migrateClaudeToShared
  const fileLinks = fileLinksAvailable(acc);

  for (const { name, kind } of CODEX_SHARED_ENTRIES) {
    const parent = path.dirname(name);
    // Nested entries only inside a real account folder (a linked '.tmp' is never followed)
    if (parent !== '.' && !isRealFolder(acc, parent)) continue;
    const src = path.join(acc, name);
    const st = lstatOrUndefined(src);
    if (!st || st.isSymbolicLink()) continue;   // missing or already a link (a link elsewhere stays a conflict)
    const dst = path.join(def, name);
    if (kind === 'dir') {
      if (!st.isDirectory()) continue;
      const into = defaultFolder(dst);
      if (into) mergeEntry(src, into, name, ctx);
    } else if (!st.isFile()) {
      continue;
    } else if (!fileLinks) {
      (report.noPrivilege ??= []).push(name);
    } else if (JSONL_FILES.includes(name)) {
      if (mergeLines(src, dst) > 0) report.moved++;
      rememberMove(ctx, src, dst);
    } else if (name.endsWith('.sqlite')) {
      // Windows: the account keeps its own databases, which are never linked there
      if (!isWindows()) backupSqlite(src, name, ctx);
    } else {
      // config.toml stays when it cannot be linked (default has identity keys), so the account keeps its config
      if (name === 'config.toml' && !configShareable(dst)) continue;
      const ds = lstatOrUndefined(dst);
      if (!ds) {
        // The default has none: the account's file becomes the shared one, unless it carries identity keys
        if (name === 'config.toml' && !configShareable(src)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
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
        report.backups.push(path.posix.join(parent, path.basename(backup)));
      }
    }
  }

  for (const { dir: rel, excludes } of CODEX_CHILD_SHARED_DIRS) {
    if (!isRealFolder(acc, rel)) continue;
    const accFolder = path.join(acc, rel);
    const defFolder = path.join(def, rel);
    if (!lstatOrUndefined(defFolder)) fs.mkdirSync(defFolder, { recursive: true, mode: 0o700 });
    const into = defaultFolder(defFolder);
    if (!into) continue;
    const excluded = new Set<string>(excludes);
    for (const child of fs.readdirSync(accFolder)) {
      if (excluded.has(child)) continue;
      const src = path.join(accFolder, child);
      if (linksTo(src, path.join(defFolder, child))) continue;
      if (!fileLinks && lstatOrUndefined(src)?.isFile()) {
        (report.noPrivilege ??= []).push(`${rel}/${child}`);
        continue;
      }
      mergeEntry(src, path.join(into, child), `${rel}/${child}`, ctx);
    }
  }

  finalizeMerge(ctx);
  const links = ensureCodexLinks(dir, options, procRoot);
  report.linked.push(...links.linked);
  report.created.push(...links.created);
  report.conflicts.push(...links.conflicts);
  report.refused.push(...links.refused);
  if (links.refusedNotes) report.refusedNotes = { ...links.refusedNotes };
  if (links.busy) report.busy = [...links.busy];
  if (links.copied) report.copied = [...links.copied];
  if (links.failed) report.failed = [...links.failed];
  if (links.noPrivilege) report.noPrivilege = [...new Set([...(report.noPrivilege ?? []), ...links.noPrivilege])];
  return report;
}

/** Independent creation: copyCodexSeed (config.toml without identity keys), then copies AGENTS.md, hooks.json
 *  (0600), rules/ hooks/ agents/ themes/ and the skills/ children except .system from the default dir. A linked
 *  folder or skills child is copied from its real location; a dangling child link is skipped. Never overwrites; no
 *  symlinks followed inside copied folders; `skipped` comes from copyCodexSeed. The default dir → nothing copied. */
export function copyCodexIndependent(dir: string): { copied: string[]; skipped: Array<{ file: string; reason: string }> } {
  const copied: string[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  if (isDefault(dir)) return { copied, skipped };
  assertNotContainingDefault(dir);
  const def = codexDefaultDir();
  const acc = path.resolve(dir);
  fs.mkdirSync(acc, { recursive: true, mode: 0o700 });

  const seed = copyCodexSeed(def, acc);
  copied.push(...seed.copied);
  skipped.push(...seed.skipped);
  for (const name of INDEPENDENT_COPY_FILES) {
    const src = path.join(def, name);
    const dst = path.join(acc, name);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile() || lstatOrUndefined(dst)) continue;
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, 0o600);
    copied.push(name);
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
    for (const child of fs.readdirSync(skills)) {
      if (child === '.system') continue;
      const to = path.join(acc, 'skills', child);
      if (lstatOrUndefined(to)) continue;
      const from = path.join(skills, child);
      if (!fs.existsSync(from)) continue;   // dangling link
      fs.mkdirSync(path.join(acc, 'skills'), { recursive: true, mode: 0o700 });
      // A child that is itself a link (e.g. into dotfiles) is copied from its real location
      copyTree(fs.realpathSync(from), to);
      copied.push(`skills/${child}`);
    }
  }
  return { copied, skipped };
}

// Entries that get an own copy when the account becomes independent; unlinked before the copy, the rest after it
const INDEPENDENT_CONFIG_ENTRIES = new Set(['config.toml', ...INDEPENDENT_COPY_FILES, ...INDEPENDENT_COPY_DIRS]);

/** Converts a shared account back into an independent one: removes every link into the default directory (the
 *  CODEX_SHARED_ENTRIES entries, including dangling link-only links, and the skills/ plugins/cache children whose
 *  link resolves into the default directory, compared by real path; regular files, links elsewhere and anything
 *  else, including auth.json and memories/, are left untouched), then copies the default configuration as
 *  copyCodexIndependent does. Order: win32 database links first (removeWindowsSqliteLink; 'busy' throws
 *  t('share.busyCodex') before anything else changes), then config.toml, AGENTS.md, hooks.json, the
 *  INDEPENDENT_COPY_DIRS and the skills/ children, then copyCodexIndependent, then history, session_index, the
 *  databases, the sessions marker, the other folders and the plugins/cache children — so a failed copy leaves the
 *  account shared and ensureCodexLinks re-creates the missing links. Sessions, history and thread databases stay in
 *  the default directory. Throws t('unshare.default') for the default directory, t('unshare.notShared') for an
 *  account that is not shared and, as migrateCodexToShared, t('share.busyCodex') when codexAccountBusy(dir, procRoot). */
export function makeCodexIndependent(dir: string, accountName: string, procRoot = '/proc'): { removed: string[]; copied: string[]; skipped: Array<{ file: string; reason: string }> } {
  if (isDefault(dir)) throw new Error(t('unshare.default', { dir }));
  assertNotContainingDefault(dir);
  if (!isSharedCodexAccount(dir)) throw new Error(t('unshare.notShared', { dir }));
  if (codexAccountBusy(dir, procRoot)) throw new Error(t('share.busyCodex', { name: accountName }));
  const def = codexDefaultDir();
  const acc = path.resolve(dir);
  const removed: string[] = [];
  // Windows: database links (from before they were refused there) go first, with their side files kept aside; one
  // in use stops the conversion before anything else changes
  if (isWindows()) {
    for (const { name } of CODEX_SHARED_ENTRIES) {
      if (!name.endsWith('.sqlite')) continue;
      const r = removeWindowsSqliteLink(path.join(acc, name), path.join(def, name));
      if (r === 'busy') throw new Error(t('share.busyCodex', { name: accountName }));
      if (r === 'removed') removed.push(name);
    }
  }
  const unlinkEntries = (config: boolean): void => {
    for (const { name } of CODEX_SHARED_ENTRIES) {
      if (INDEPENDENT_CONFIG_ENTRIES.has(name) !== config) continue;
      const parent = path.dirname(name);
      // Nested entries only inside a real account folder (a linked '.tmp' is never followed)
      if (parent !== '.' && !isRealFolder(acc, parent)) continue;
      unlinkIfLinksTo(path.join(acc, name), path.join(def, name), name, removed);
    }
  };
  const unlinkChildren = (rel: string): void => unlinkChildLinks(path.join(acc, rel), path.join(def, rel), rel, isRealFolder(acc, rel), removed);
  // The configuration is unlinked and copied first; sessions, history, the databases and the sessions marker only
  // afterwards, so a failed copy leaves the account shared (missing links are re-created by ensureCodexLinks)
  unlinkEntries(true);
  unlinkChildren('skills');
  const copy = copyCodexIndependent(dir);
  unlinkEntries(false);
  unlinkChildren('plugins/cache');
  return { removed, ...copy };
}
