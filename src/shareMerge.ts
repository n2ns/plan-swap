// Moving and merging account entries into the default directory when an independent account becomes shared, and the
// recursive copies when a shared one becomes independent; used by both vendors (claudeShare, codexShare). Never
// follows links while moving, never overwrites an existing default entry (sameContent duplicates are dropped, other
// files are kept as '<name>.from-<account>'), and defers links until every entry has its final place (finalizeMerge).
// No vscode import; the design is in docs/design.md 6.7.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { realPath, sameRealPath } from './paths';
import { comparablePath, isOpaqueReparseDir, LinkPrivilegeError, createLink, isWindows, unlinkLinks } from './platform';
import { type MigrateReport, lstatOrUndefined, linksTo, sameContent, realEntryPath, linkTarget } from './shareLinks';

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
