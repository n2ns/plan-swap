// Shared vs independent Claude accounts: a shared account links everything except its login identity to the
// default account's directory. No vscode import.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { t } from './i18n';
import { claudeJsonName, copySettingsStripped, defaultDir, samePath, sameRealPath, syncMcpServers, unchangedSince } from './paths';
import {
  comparablePath, isOpaqueReparseDir, JunctionError, LinkPrivilegeError, copyLink, createLink, fileLinksAvailable, isWindows, pidAlive, renameReplacing, type StartTimeProbe,
  stripBom, windowsStartTimes,
} from './platform';

// Whole-entry links (kind: file needs an empty-file default, dir needs an empty dir)
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
// Keys that must never be shared through settings.json (identity); linking settings.json is refused when the
// default settings.json has any of them (top-level or inside env)
export const CLAUDE_IDENTITY_SETTING_KEYS = {
  top: ['apiKeyHelper', 'forceLoginMethod', 'forceLoginOrgUUID'],
  env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
};

// Per-project keys of .claude.json mirrored from the default account
const PROJECT_KEYS = [
  'allowedTools', 'mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'mcpContextUris',
  'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown',
];
// Folders copied once when an independent account is created
const INDEPENDENT_COPY_DIRS = ['agents', 'commands', 'output-styles', 'hooks', 'rules'];
const EMPTY_CONTENT: Record<string, string> = { 'settings.json': '{}\n' };

export interface ShareReport {
  linked: string[];     // entry names (children as 'skills/<child>') newly linked
  created: string[];    // entries created empty in the default dir
  conflicts: string[];  // entries the account has as a real file/dir or a link elsewhere; left untouched
  refused: string[];    // entries refused for safety (e.g. 'settings.json' when the default has identity keys)
  copied?: string[];    // config files copied once instead of linked (Windows without file-link privilege); they no longer follow the default
  noPrivilege?: string[]; // single-file entries that could not be linked because Windows refuses file symlinks (Developer Mode off); left independent
  busy?: string[];      // entries whose repair would move or unlink account files, skipped because the account is busy
  failed?: string[];    // folder entries whose junction Windows could not create (not a local NTFS drive); left unlinked
}

export interface MigrateReport extends ShareReport {
  moved: number;          // files moved into the default dir
  duplicates: number;     // identical files dropped from the account
  keptBoth: string[];     // relative paths of account copies moved next to the default file as '<name>.from-<account>'
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

// Whether link is a symlink pointing at target (relative links resolved against the link's folder)
export function linksTo(link: string, target: string): boolean {
  const st = lstatOrUndefined(link);
  if (!st?.isSymbolicLink()) return false;
  const to = path.resolve(path.dirname(link), fs.readlinkSync(link));
  return comparablePath(to) === comparablePath(target) || (fs.existsSync(link) && sameRealPath(link, target));
}

function isDefault(dir: string): boolean {
  return sameRealPath(dir, defaultDir());
}

export function emptyReport(): ShareReport {
  return { linked: [], created: [], conflicts: [], refused: [] };
}

// Whether the default settings.json can be shared: missing, or a JSON object without identity keys
function settingsShareable(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    return false;
  }
  if (!isPlainObject(data)) return false;
  if (CLAUDE_IDENTITY_SETTING_KEYS.top.some((k) => Object.hasOwn(data, k))) return false;
  const env = data.env;
  return !(isPlainObject(env) && CLAUDE_IDENTITY_SETTING_KEYS.env.some((k) => Object.hasOwn(env, k)));
}

// Creates a missing default entry empty; returns true when created
function ensureDefaultEntry(target: string, kind: 'file' | 'dir'): boolean {
  if (lstatOrUndefined(target)) return false;
  if (kind === 'dir') fs.mkdirSync(target, { mode: 0o700 });
  else fs.writeFileSync(target, EMPTY_CONTENT[path.basename(target)] ?? '', { mode: 0o600, flag: 'wx' });
  return true;
}

export type LinkResult = 'linked' | 'ok' | 'conflict' | 'noprivilege' | 'failed';

// Links link → target; 'linked' / 'ok' (already linked) / 'conflict' (real entry or link elsewhere, untouched) /
// 'noprivilege' (Windows refuses a file symlink) / 'failed' (Windows cannot create a junction on this drive)
export function linkEntry(link: string, target: string): LinkResult {
  const st = lstatOrUndefined(link);
  if (!st) {
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
  if (isWindows() && COPYABLE_ON_NO_LINK.includes(path.basename(link)) && st.isFile() && fs.existsSync(target) && sameContent(link, target, st, fs.statSync(target)) && fileLinksAvailable(path.dirname(link))) {
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
  if (isWindows() && COPYABLE_ON_NO_LINK.includes(path.basename(link)) && st.isFile() && !fileLinksAvailable(path.dirname(link))) return 'ok';
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

export function record(report: ShareReport, name: string, result: LinkResult): void {
  if (result === 'noprivilege') (report.noPrivilege ??= []).push(name);
  else if (result === 'failed') (report.failed ??= []).push(name);
  else if (result === 'linked') report.linked.push(name);
  else if (result === 'conflict') report.conflicts.push(name);
}

// Appends the lines of src that dst lacks (whole-line comparison, order kept), then removes src. latin1 keeps the
// bytes unchanged. Returns the number of appended lines.
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

/** Creates/repairs every link of a shared account (idempotent). Never touches the default dir's existing content;
 *  in a shared account a real history.jsonl (replaced by `claude project purge`) is merged back and relinked.
 *  Also removes links in skills/ or plugins/ whose default child no longer exists. Steps that move or unlink account
 *  files are skipped and reported under busy while claudeAccountBusy(dir, procRoot) or options.busy(). When the default
 *  settings.json cannot be shared, a settings.json link is replaced by the account's own copy without identity keys.
 *  dir === default → empty report. */
export function ensureClaudeLinks(dir: string, procRoot = '/proc', options: LinkOptions = {}): ShareReport {
  const report = emptyReport();
  if (isDefault(dir)) return report;
  const def = defaultDir();
  const acc = path.resolve(dir);
  fs.mkdirSync(def, { recursive: true, mode: 0o700 });
  fs.mkdirSync(acc, { recursive: true, mode: 0o700 });

  // Checked only when a destructive step comes up; a running Claude process may still be writing those files
  let busy: boolean | undefined;
  const isBusy = (): boolean => (busy ??= claudeAccountBusy(dir, procRoot) || !!options.busy?.());

  const shared = isSharedClaudeAccount(dir);
  // Merging a file's lines back removes it; without file-link privilege it could not be linked again, so it stays
  const fileLinks = fileLinksAvailable(acc);
  for (const { name, kind } of CLAUDE_SHARED_ENTRIES) {
    const target = path.join(def, name);
    const link = path.join(acc, name);
    if (name === 'settings.json' && !settingsShareable(target)) {
      // A link created while the default settings were still shareable would hand the account the default's login
      // identity: it is replaced by the account's own copy with the identity keys stripped
      if (linksTo(link, target)) {
        fs.unlinkSync(link);
        copySettingsStripped(def, acc);
      }
      report.refused.push(name);
      continue;
    }
    if (ensureDefaultEntry(target, kind)) report.created.push(name);
    // `claude project purge` rewrites history.jsonl by rename, replacing the link: merge the lines back and relink
    if (shared && name === 'history.jsonl' && lstatOrUndefined(link)?.isFile() && fileLinks) {
      if (isBusy()) {
        (report.busy ??= []).push(name);
        continue;
      }
      mergeLines(link, target);
    }
    recordLink(report, name, linkEntry(link, target), link, target, !!options.copyConfig);
  }

  for (const name of CLAUDE_CHILD_SHARED_DIRS) {
    const defFolder = path.join(def, name);
    if (ensureDefaultEntry(defFolder, 'dir')) report.created.push(name);
    const accFolder = path.join(acc, name);
    const st = lstatOrUndefined(accFolder);
    if (st?.isSymbolicLink() && linksTo(accFolder, defFolder)) {
      // Whole-folder link from an earlier version: replace it by a real folder with per-child links
      if (isBusy()) {
        (report.busy ??= []).push(name);
        continue;
      }
      fs.unlinkSync(accFolder);
      fs.mkdirSync(accFolder, { mode: 0o700 });
    } else if (!st) {
      fs.mkdirSync(accFolder, { mode: 0o700 });
    } else if (!st.isDirectory()) {
      report.conflicts.push(name);
      continue;
    }
    const excluded = new Set<string>(CLAUDE_CHILD_EXCLUDES);
    for (const child of fs.readdirSync(defFolder)) {
      if (excluded.has(child)) continue;
      record(report, `${name}/${child}`, linkEntry(path.join(accFolder, child), path.join(defFolder, child)));
    }
    // Remove links into the default folder whose target no longer exists
    for (const child of fs.readdirSync(accFolder)) {
      const link = path.join(accFolder, child);
      if (!lstatOrUndefined(link)?.isSymbolicLink()) continue;
      const to = path.resolve(accFolder, fs.readlinkSync(link));
      if (comparablePath(path.dirname(to)) !== comparablePath(defFolder) || lstatOrUndefined(to)) continue;
      if (isBusy()) (report.busy ??= []).push(`${name}/${child}`);
      else fs.unlinkSync(link);
    }
  }
  return report;
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

/** Mirrors shareable keys of the default account's info file into <dir>/.claude.json (see the contract).
 *  beforeCommit runs between writing the temporary file and the change check (tests simulate a concurrent CLI write). */
export function mirrorClaudeJson(fromJson: string, dir: string, beforeCommit?: () => void): { changed: string[] } {
  const changed: string[] = [];
  if (isDefault(dir)) return { changed };
  const source = readSourceJson(fromJson);

  const file = path.join(path.resolve(dir), claudeJsonName());
  let real = file;
  let before: string | undefined;
  let mode = 0o600;
  if (fs.existsSync(file)) {
    real = fs.realpathSync(file);
    before = fs.readFileSync(real, 'utf8');
    mode = fs.statSync(real).mode & 0o777;
  }
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
  if (!isDeepStrictEqual(currentMcp, mcp)) {
    data.mcpServers = mcp;
    changed.push('mcpServers');
  }

  const srcProjects = isPlainObject(source.projects) ? source.projects : {};
  for (const [p, srcProj] of Object.entries(srcProjects)) {
    if (!isPlainObject(srcProj)) continue;
    if (!isPlainObject(data.projects)) data.projects = {};
    const projects = data.projects as Record<string, unknown>;
    const proj = isPlainObject(projects[p]) ? (projects[p] as Record<string, unknown>) : {};
    let differs = !isPlainObject(projects[p]);
    for (const k of PROJECT_KEYS) {
      if (!Object.hasOwn(srcProj, k) || isDeepStrictEqual(proj[k], srcProj[k])) continue;
      proj[k] = srcProj[k];
      differs = true;
    }
    if (differs) {
      projects[p] = proj;
      changed.push(`projects:${p}`);
    }
  }
  if (changed.length === 0) return { changed };

  const tmp = `${real}.planswap-${process.pid}.tmp`;
  // A temporary file left by an interrupted run is replaced
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode, flag: 'wx' });
    beforeCommit?.();
    // Refuse to overwrite a write the CLI made in the meantime, checked again before every rename attempt
    if (!renameReplacing(tmp, real, undefined, undefined, () => unchangedSince(real, before))) throw new Error(t('mcp.changed', { file: real }));
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
 *  /proc/<pid>/environ has CLAUDE_CONFIG_DIR=<dir> (for the default dir: unset or the default). Without procRoot
 *  (e.g. no /proc) a session file counts as busy. Windows: windowsSessionsBusy. procRoot is for tests. */
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

// Moves a file, link or folder without following symlinks; falls back to copy + delete across file systems
// false: a link that cannot be recreated on the other volume (Windows refuses the file link a dangling link becomes
// without Developer Mode) stays where it is; the caller reports nothing as moved
export function moveEntry(src: string, dst: string): boolean {
  try {
    fs.renameSync(src, dst);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    try {
      copyLink(src, dst);
    } catch (e) {
      if (e instanceof LinkPrivilegeError) return false;
      throw e;
    }
    fs.unlinkSync(src);
  } else if (st.isDirectory()) {
    copyTree(src, dst, 'throw');
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

export function sameContent(a: string, b: string, sa: fs.Stats, sb: fs.Stats): boolean {
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    if (!sa.isSymbolicLink() || !sb.isSymbolicLink()) return false;
    const ra = fs.readlinkSync(a);
    const rb = fs.readlinkSync(b);
    return ra === rb || (isWindows() && comparablePath(ra) === comparablePath(rb));
  }
  return sa.isFile() && sb.isFile() && sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
}

export interface MergeCtx { report: MigrateReport; account: string }

// Merges the account entry src into the default entry dst (rel: dst relative to the default dir, for the report)
export function mergeEntry(src: string, dst: string, rel: string, ctx: MergeCtx): void {
  const ss = fs.lstatSync(src);
  const ds = lstatOrUndefined(dst);
  if (!ss.isDirectory() && !ss.isFile() && !ss.isSymbolicLink()) return;   // sockets, fifos: left in place
  // Never merge an entry into itself (another spelling of the same folder): the "identical copy" would be the only one
  if (ds && sameRealPath(src, dst)) return;
  // Windows reparse points that lstat reports as plain folders (a junction to \\?\Volume{…}, a mount point): moving out
  // of them would take files from another location; left in place like sockets
  if (ss.isDirectory() && isOpaqueReparseDir(src)) return;
  if (ss.isDirectory()) {
    if (!ds) fs.mkdirSync(dst, { mode: ss.mode & 0o777 });
    if (!ds || ds.isDirectory()) {
      for (const child of fs.readdirSync(src)) mergeEntry(path.join(src, child), path.join(dst, child), `${rel}/${child}`, ctx);
      removeIfEmpty(src);
      return;
    }
  } else if (!ds) {
    if (moveEntry(src, dst)) ctx.report.moved++;
    return;
  } else if (sameContent(src, dst, ss, ds)) {
    fs.unlinkSync(src);
    ctx.report.duplicates++;
    return;
  }
  const kept = freeName(`${dst}.from-${ctx.account}`);
  if (!moveEntry(src, kept)) return;
  // Report names use / on every platform, like the other entries of a report
  ctx.report.keptBoth.push(path.posix.join(path.posix.dirname(rel), path.basename(kept)));
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

/** Converts an independent account into a shared one (see the contract); ends with ensureClaudeLinks(dir, procRoot).
 *  Throws t('share.busy') with the display name label (defaults to accountName) when claudeAccountBusy(dir, procRoot). */
export function migrateClaudeToShared(dir: string, accountName: string, procRoot = '/proc', label = accountName, options: LinkOptions = {}): MigrateReport {
  const report: MigrateReport = { ...emptyReport(), moved: 0, duplicates: 0, keptBoth: [], backups: [] };
  if (isDefault(dir)) return report;
  if (claudeAccountBusy(dir, procRoot)) throw new Error(t('share.busy', { name: label }));
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
        report.moved++;
      } else {
        // settings.json stays when it cannot be linked (default has identity keys), so the account keeps its settings
        if (name === 'settings.json' && !settingsShareable(dst)) continue;
        const ds = lstatOrUndefined(dst);
        if (!ds) {
          // The default has none: the account's file becomes the shared one, unless it carries identity keys
          if (name === 'settings.json' && !settingsShareable(src)) continue;
          if (moveEntry(src, dst)) report.moved++;
        } else if (fs.existsSync(dst) && sameContent(src, dst, st, fs.statSync(dst))) {
          fs.unlinkSync(src);
          report.duplicates++;
        } else {
          const backup = freeName(`${src}.independent-backup`);
          fs.renameSync(src, backup);
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

  const links = ensureClaudeLinks(dir, procRoot, options);
  report.linked.push(...links.linked);
  report.created.push(...links.created);
  report.conflicts.push(...links.conflicts);
  report.refused.push(...links.refused);
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
  const inside = !path.isAbsolute(raw) && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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

/** Independent creation: copies settings.json (stripped), CLAUDE.md, the config folders and the non-excluded
 *  skills/ children from the default dir, and merges MCP servers. Never overwrites. */
export function copyClaudeIndependent(fromJson: string, dir: string): { copied: string[] } {
  const copied: string[] = [];
  if (isDefault(dir)) return { copied };
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

/** Converts a shared account back into an independent one: removes every link into the default directory
 *  (the CLAUDE_SHARED_ENTRIES entries and the skills/ plugins/ children whose link resolves into the default
 *  directory; anything else is left untouched), then copies the default configuration as copyClaudeIndependent
 *  does. History and sessions stay in the default directory. Throws for the default directory and for an
 *  account that is not shared. Returns the removed link names (children as 'skills/<child>') and the copied entries. */
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

export function makeClaudeIndependent(fromJson: string, dir: string): { removed: string[]; copied: string[] } {
  if (isDefault(dir)) throw new Error(t('unshare.default', { dir }));
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

/** Shared iff <dir>/projects is a symlink resolving to the default dir's projects. The default dir → false. */
export function isSharedClaudeAccount(dir: string): boolean {
  if (isDefault(dir)) return false;
  const link = path.join(path.resolve(dir), 'projects');
  if (!lstatOrUndefined(link)?.isSymbolicLink()) return false;
  const target = path.join(defaultDir(), 'projects');
  return fs.existsSync(link) && fs.existsSync(target) && sameRealPath(link, target);
}
