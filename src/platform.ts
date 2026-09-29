// Platform helpers shared by the Claude and Codex modules: Windows path comparison, link creation and process
// probes. No vscode import.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

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
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`cannot create a file symbolic link (${link}); enable Windows Developer Mode or run the editor as administrator`);
    }
    throw e;
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

/** Parses `tasklist /FO CSV /NH` output into the image names it lists. */
export function parseTasklistCsv(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.push(m[1].toLowerCase());
  }
  return names;
}

/** Whether a process image (e.g. 'codex.exe') is running on Windows. A failing probe counts as running. */
export function imageRunning(image: string, run: (image: string) => string = defaultTasklist): boolean {
  try {
    return parseTasklistCsv(run(image)).includes(image.toLowerCase());
  } catch {
    return true;
  }
}

function defaultTasklist(image: string): string {
  return execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
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
