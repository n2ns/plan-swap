// Platform helpers shared by the Claude and Codex modules: Windows path comparison, link creation and process
// probes. No vscode import.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/** A file symlink cannot be created: Windows without Developer Mode or elevation. */
export class LinkPrivilegeError extends Error {}

export const isWindows = (): boolean => process.platform === 'win32';

/** Whether the host OS is supported: Linux/WSL as before, plus native Windows. */
export function isSupportedPlatform(platform: string = process.platform): boolean {
  return platform === 'linux' || platform === 'win32';
}

/** path.resolve, lower-cased on Windows where paths are case-insensitive (only for comparison, never for display). */
export function comparablePath(p: string, platform: string = process.platform): string {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Creates the link `link` → `target`. On Windows directories get a junction (no privilege needed; the target is
 * always absolute here) and files a symlink, which needs Developer Mode or an elevated editor: EPERM is rethrown as
 * an Error whose message explains that. Elsewhere this is fs.symlinkSync.
 */
export function createLink(target: string, link: string, platform: string = process.platform): void {
  if (platform !== 'win32') {
    fs.symlinkSync(target, link);
    return;
  }
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    // Missing target (link-only entries): treated as a file link
  }
  try {
    fs.symlinkSync(target, link, isDir ? 'junction' : 'file');
  } catch (e) {
    // Only a refused file symlink means "no privilege"; a failed junction is an ordinary error
    if (!isDir && (e as NodeJS.ErrnoException).code === 'EPERM') {
      throw new LinkPrivilegeError(`cannot create a file symbolic link (${link}); enable Windows Developer Mode or run the editor as administrator`);
    }
    throw e;
  }
}

/**
 * Whether single-file links can be created in `dir` (probes with a temporary file symlink, removed again). Always
 * true off Windows; on Windows false only when the OS refuses the privilege (EPERM). Directory junctions never need it.
 */
export function fileLinksAvailable(dir: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') return true;
  const stamp = `.planswap-probe-${process.pid}-${Date.now()}`;
  const target = path.join(dir, `${stamp}.target`);
  const link = path.join(dir, `${stamp}.link`);
  try {
    fs.writeFileSync(target, '', { mode: 0o600, flag: 'wx' });
  } catch {
    // Cannot even write the probe: nothing is known about links, so do not claim they are refused
    return true;
  }
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'EPERM';
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(target, { force: true });
  }
}

/** Recreates the link `src` at `dst` (target copied verbatim; on Windows resolved to an absolute path first). */
export function copyLink(src: string, dst: string, platform: string = process.platform): void {
  const raw = fs.readlinkSync(src);
  if (platform === 'win32') createLink(path.resolve(path.dirname(src), raw), dst, platform);
  else fs.symlinkSync(raw, dst);
}

/** Whether a process with this pid exists (signal 0 only probes; it never terminates anything, also on Windows). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Start times of live processes by pid (Windows FILETIME ticks as decimal strings); undefined when the probe fails. */
export type StartTimeProbe = (pids: number[]) => Map<number, string> | undefined;

/** Parses `<pid> <filetime>` lines (the output of windowsStartTimes' PowerShell probe). */
export function parseStartTimes(out: string): Map<number, string> {
  const times = new Map<number, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) times.set(Number(m[1]), m[2]);
  }
  return times;
}

/**
 * Windows: the creation times of the given processes, which Claude Code records as `procStart` in its session files,
 * so a pid reused by an unrelated process is not mistaken for a live session. Exited pids are simply absent. The pids
 * are validated integers, so nothing else reaches the command line.
 */
export function windowsStartTimes(pids: number[], run: (script: string) => string = defaultPowerShell): Map<number, string> | undefined {
  const ids = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (ids.length === 0) return new Map();
  const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() }`;
  try {
    return parseStartTimes(run(script));
  } catch {
    return undefined;
  }
}

function defaultPowerShell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 8000, windowsHide: true });
}

/**
 * Windows only: removes the links (symlinks and junctions) inside `dir`, down to `depth` folder levels, before a
 * recursive delete, so a delete can never descend through a junction into the default account. Real files are left.
 */
export function unlinkLinks(dir: string, depth = 3): void {
  if (!isWindows() || depth <= 0) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) fs.unlinkSync(p);
    else if (st.isDirectory()) unlinkLinks(p, depth - 1);
  }
}

const RENAME_RETRY_CODES = ['EPERM', 'EACCES', 'EBUSY'];

/**
 * fs.renameSync for replacing a file. Windows refuses to replace a file while any handle is open on it (an antivirus
 * or indexer scan, another editor window reading it, the CLI reading its info file): there the rename is retried for
 * about a second before the error is thrown. Elsewhere a single rename.
 */
export function renameReplacing(src: string, dst: string, platform: string = process.platform, rename: (a: string, b: string) => void = fs.renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(src, dst);
      return;
    } catch (e) {
      if (platform !== 'win32' || attempt >= 8 || !RENAME_RETRY_CODES.includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      sleepSync(Math.min(10 * 2 ** attempt, 200));
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Removes a leading UTF-8 byte order mark, which Notepad and Windows PowerShell 5.1 write and JSON.parse rejects. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Flushes a directory entry to disk after a rename; Windows cannot open directories, so this is a no-op there. */
export function fsyncDir(dir: string): void {
  if (isWindows()) return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
