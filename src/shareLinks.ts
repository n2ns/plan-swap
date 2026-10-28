// Link primitives of the shared-account model, used by both vendors (claudeShare, codexShare): the share report, the
// link checks and creation (linkEntry), the Windows copy fallback (recordLink), line merges of replaced history files
// and the helpers that resolve a link's real target. No vscode import, nothing vendor-specific; the design is in
// docs/design.md 6.7.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { realPath, samePath, sameRealPath } from './paths';
import { comparablePath, JunctionError, LinkPrivilegeError, createLink, fileLinksAvailable, isWindows, renameReplacing } from './platform';

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
  unreadable?: string[]; // children of skills / plugins whose default source is broken (dangling or cyclic link, special file) or unreadable; left unlinked
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

export function emptyReport(): ShareReport {
  return { linked: [], created: [], conflicts: [], refused: [] };
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

// Resolve the parent while preserving the final entry, which may be a link or an already-moved file.
export function realEntryPath(entry: string): string {
  return path.join(realPath(path.dirname(entry)), path.basename(entry));
}

export function linkTarget(link: string): string {
  return realEntryPath(path.resolve(realPath(path.dirname(link)), fs.readlinkSync(link)));
}

/** Two links resolving to the same target, or two regular files of equal size and bytes. */
export function sameContent(a: string, b: string, sa: fs.Stats, sb: fs.Stats): boolean {
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    if (!sa.isSymbolicLink() || !sb.isSymbolicLink()) return false;
    return samePath(linkTarget(a), linkTarget(b));
  }
  return sa.isFile() && sb.isFile() && sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
}
