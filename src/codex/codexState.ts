import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CODEX_DIR_BASENAME_RE, codexDefaultDir } from './codexPaths';
import { samePath } from '../paths';
import { t } from '../i18n';
import { fsyncDir, isMac, isWindows, renameReplacing } from '../platform';
import { SELF_CHECK_NAME, type Runner, getUserCodexHome, getUserEnv, setUserCodexHome, setUserEnv } from './codexWindows';
import { type ServerKind, detectServerKind } from './codexServer';
import { currentMacRcFile, macBlockFiles, macLoginShell, macShellKind, macStartupFiles } from './codexMac';
// Codex selection state: the shared state file ~/.config/planswap/codex-home and the per-editor files
// codex-home.<kind> (the selected dir), the rc marker blocks in ~/.profile and ~/.bashrc that export the shared
// selection, the hook block in an editor's server-env-setup that exports its own selection before its WSL server
// starts, the native Windows user variable branch, enable pre-/self-checks and the ai-switcher migration. macOS uses
// the same rc block in the login shell's own startup file (codexMac) and only the shared state file. Design:
// codex-design.md sections 4, 4a and 9a. No vscode import.

/** The shared state file: the selection of terminals outside an editor and of editors without a server-env-setup
 *  hook, and the fallback of a hook editor that has not switched yet (empty or missing = default). */
export const STATE_FILE = () => path.join(os.homedir(), '.config', 'planswap', 'codex-home');

/** Editor kinds whose WSL server sources `~/<data dir>/server-env-setup` before it starts (VS Code: Microsoft's
 *  Remote - WSL; VSCodium: wsl-remote) and therefore keep their own selection in `codex-home.<kind>`
 *  (codex-design.md section 4a). Antigravity's hook support is not verified, so it stays on the shared file. */
export const HOOK_KINDS = ['vscodium', 'vscode'] as const;
export type HookKind = (typeof HOOK_KINDS)[number];
const HOOK_DATA_DIRS: Record<HookKind, string> = { vscodium: '.vscodium-server', vscode: '.vscode-server' };

export function isHookKind(kind: ServerKind): kind is HookKind {
  return (HOOK_KINDS as readonly string[]).includes(kind);
}

/** The state file of an editor kind: `codex-home.<kind>` for HOOK_KINDS, STATE_FILE() otherwise. */
export function stateFileFor(kind: ServerKind): string {
  return isHookKind(kind) ? `${STATE_FILE()}.${kind}` : STATE_FILE();
}

/** `~/<data dir>/server-env-setup` of a hook kind, sourced by that editor's WSL server before it starts. */
export function hookFileFor(kind: HookKind): string {
  return path.join(os.homedir(), HOOK_DATA_DIRS[kind], 'server-env-setup');
}

let cachedKind: ServerKind | undefined;
/** The kind of the WSL server hosting this extension host, detected once (detectServerKind; a process cannot change
 *  its parent): 'unknown' on Windows and macOS (no WSL server, so only the shared state file), outside a WSL server
 *  and in tests. */
export function currentServerKind(): ServerKind {
  cachedKind ??= isWindows() || isMac() ? 'unknown' : detectServerKind();
  return cachedKind;
}

/** The state files whose change means a new selection for an editor kind: its own file and the shared one. */
export function watchedStateFiles(kind: ServerKind = currentServerKind()): string[] {
  return isHookKind(kind) ? [stateFileFor(kind), STATE_FILE()] : [STATE_FILE()];
}

function readStateText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The selection of an editor kind: the content of its own state file when that can be read (empty = default), else
 *  of the shared one. Trimmed and path.resolve'd; missing, unreadable or empty → undefined (the default account). */
export function readSelectedDir(kind: ServerKind = currentServerKind()): string | undefined {
  const raw = readStateText(stateFileFor(kind)) ?? (isHookKind(kind) ? readStateText(STATE_FILE()) : undefined);
  const s = raw?.trim();
  return s ? path.resolve(s) : undefined;
}

/** Atomic write of an editor kind's state file (stateFileFor): folder 0700, exclusive temp file 0600 + fsync + rename
 *  + folder fsync. undefined writes an empty file (the default account). */
export function writeSelectedDir(dir: string | undefined, kind: ServerKind = currentServerKind()): void {
  const file = stateFileFor(kind);
  const dirName = path.dirname(file);
  fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
  const tmp = path.join(dirName, `.codex-home.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  // Exclusive create: never write through a file or symlink that already sits at the random temp name
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, dir === undefined ? '' : path.resolve(dir));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameReplacing(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  fsyncDir(dirName);
}

/**
 * The only selection writer the commands use. Linux: a hook kind first gets its hook block into the editor's
 * server-env-setup (installHookBlock; a hook that cannot be written would leave the new selection without effect),
 * then its own state file is written; any other kind writes the shared file, which the rc blocks read. Windows, when
 * management is enabled (the state file existed): mirrors the selection into the user-level CODEX_HOME so a freshly
 * started editor picks it up; throws t('codex.notEnabled') without the state file; reads the previous variable
 * strictly, sets the variable first, then writes the state file and restores the variable if that write fails.
 */
export function writeSelection(dir: string | undefined, run?: Runner, kind: ServerKind = currentServerKind()): void {
  if (!isWindows()) {
    if (isHookKind(kind)) installHookBlock(kind);
    writeSelectedDir(dir, kind);
    return;
  }
  // Windows: the state file marks management; without it nothing is written (a stray file would look like "enabled")
  if (!fs.existsSync(STATE_FILE())) throw new Error(t('codex.notEnabled'));
  // The user variable first: if the state file write then fails, the variable is put back so the two never diverge.
  // The previous value is read strictly: a failed read taken for "unset" would clear the variable on rollback
  const previous = getUserCodexHome(run, true);
  setUserCodexHome(dir === undefined ? undefined : path.resolve(dir), run);
  try {
    writeSelectedDir(dir);
  } catch (e) {
    try { setUserCodexHome(previous, run); } catch { /* keep the original error */ }
    throw e;
  }
}

/** Whether PlanSwap manages CODEX_HOME. Windows: the state file exists; elsewhere: every rc file of rcStatus() carries
 *  a complete block (a start marker without its end marker counts as not enabled; macOS with a login shell other than
 *  zsh or bash has none, so it is not enabled). An unreadable rc file throws. */
export function isEnabled(): boolean {
  if (isWindows()) return fs.existsSync(STATE_FILE());
  const files = rcStatus();
  return files.length > 0 && files.every((s) => s.hasBlock && !s.broken);
}

// A user-level CODEX_HOME that points at a PlanSwap-style account directory (~/.codex-<name>) is adopted, e.g. after the
// state file was deleted; any other value belongs to the user and is never touched
function adoptableUserHome(value: string): boolean {
  const dir = path.resolve(value);
  return CODEX_DIR_BASENAME_RE.test(path.basename(dir)) && samePath(path.dirname(dir), os.homedir());
}

/** Windows enable: creates the state file (after preCheck); an existing file, or an adoptable variable, keeps the
 *  selection. Never changes the user variable. A failed strict read throws before writing. */
export function enableWindows(run?: Runner): void {
  if (fs.existsSync(STATE_FILE())) return;
  // Strict: a failed read must not record "default" while the variable still selects an account directory
  const current = getUserCodexHome(run, true);
  writeSelectedDir(current !== undefined && adoptableUserHome(current) ? current : undefined);
}

/** Windows disable: removes the state file and the user-level CODEX_HOME when it still holds a value PlanSwap sets (an
 *  account directory ~/.codex-<name>); a value the user put there in the meantime is left alone. A failed read throws
 *  before anything is removed, so the variable and the state file never disagree about management. */
export function disableWindows(run?: Runner): void {
  const current = getUserCodexHome(run, true);
  if (current !== undefined && adoptableUserHome(current)) setUserCodexHome(undefined, run);
  removeWindowsState();
}

/** Deletes only the state file (enable rollback: enabling never changes the user variable, so nothing else to undo). */
export function removeWindowsState(): void {
  try {
    fs.unlinkSync(STATE_FILE());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** This window's effective dir: a non-empty process.env.CODEX_HOME of the extension host (path.resolve'd), otherwise
 *  codexDefaultDir(). Never stored elsewhere. */
export function effectiveDir(): string {
  const env = process.env.CODEX_HOME;
  return env ? path.resolve(env) : codexDefaultDir();
}

export const RC_BEGIN = '# >>> planswap codex >>>';
export const RC_END = '# <<< planswap codex <<<';

/** The marker block written to both rc files (both markers, trailing newline). It only fills in CODEX_HOME when the
 *  shell did not inherit one, so a value set before the editor's server started (the server-env-setup hook, section
 *  4a) or by the user survives into the extension host and the integrated terminals. Never localized; byte-stable,
 *  since removal, migration and upgradeRcBlocks match it line by line. */
export function rcBlock(): string {
  return [
    RC_BEGIN,
    'if [ -z "${CODEX_HOME:-}" ] && [ -r "$HOME/.config/planswap/codex-home" ]; then',
    '  _planswap_codex_home="$(cat "$HOME/.config/planswap/codex-home" 2>/dev/null)"',
    '  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then',
    '    export CODEX_HOME="$_planswap_codex_home"',
    '  fi',
    '  unset _planswap_codex_home',
    'fi',
    RC_END,
    '',
  ].join('\n');
}

/** The block installed into a hook kind's server-env-setup (same markers as the rc block): the editor's own state
 *  file selects CODEX_HOME before its WSL server starts. An empty file selects ~/.codex explicitly, so the rc block
 *  does not fall back to the shared selection; a missing file leaves the variable alone (the rc block then applies
 *  the shared selection). Never localized; byte-stable. */
export function hookBlock(kind: HookKind): string {
  const file = `$HOME/.config/planswap/codex-home.${kind}`;
  return [
    RC_BEGIN,
    `if [ -r "${file}" ]; then`,
    `  _planswap_codex_home="$(cat "${file}" 2>/dev/null)"`,
    '  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then',
    '    export CODEX_HOME="$_planswap_codex_home"',
    '  else',
    '    export CODEX_HOME="$HOME/.codex"',
    '  fi',
    '  unset _planswap_codex_home',
    'fi',
    RC_END,
    '',
  ].join('\n');
}

/** hasUserExport: an `export CODEX_HOME=` line outside the marker blocks (the lines of an unterminated block itself
 *  do not count). broken: a BEGIN marker exists without a matching END marker. A missing file has neither. */
export interface RcFileStatus { file: string; hasBlock: boolean; broken: boolean; hasUserExport: boolean }

const USER_EXPORT_RE = /^\s*export\s+CODEX_HOME=/;
const GUARD_RE = /^\s*case\s+\$-\s+in/;

function profilePath(): string { return path.join(os.homedir(), '.profile'); }
function bashrcPath(): string { return path.join(os.homedir(), '.bashrc'); }

/** Returns undefined when the file does not exist; other errors (e.g. permission denied) are thrown. */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Returns lines outside marker blocks; if the last BEGIN has no END, lines from that BEGIN count as outside (except
 *  lines of the block itself, `block`) and broken is set. */
function scanBlocks(text: string, block: string): { outside: string[]; broken: boolean } {
  const lines = text.split('\n');
  const outside: string[] = [];
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blockStart < 0 && line.trim() === RC_BEGIN) { blockStart = i; continue; }
    if (blockStart >= 0) {
      if (line.trim() === RC_END) blockStart = -1;
      continue;
    }
    outside.push(line);
  }
  if (blockStart >= 0) {
    // The unterminated block's own lines (its export among them) are not the user's; anything else after it is
    const own = new Set(block.split('\n').map((l) => l.trim()));
    outside.push(...lines.slice(blockStart).filter((l) => !own.has(l.trim())));
    return { outside, broken: true };
  }
  return { outside, broken: false };
}

function statusOf(file: string, block: string = rcBlock()): RcFileStatus {
  const text = readText(file);
  if (text === undefined) return { file, hasBlock: false, broken: false, hasUserExport: false };
  const hasBlock = text.split('\n').some((l) => l.trim() === RC_BEGIN);
  const { outside, broken } = scanBlocks(text, block);
  const hasUserExport = outside.some((l) => USER_EXPORT_RE.test(l));
  return { file, hasBlock, broken, hasUserExport };
}

/** Status of ~/.profile and ~/.bashrc, in that order; macOS: of the login shell's block file (codexMac.macRcFile),
 *  none for a shell other than zsh or bash. Read errors other than ENOENT are thrown. */
export function rcStatus(): RcFileStatus[] {
  if (isMac()) {
    const file = currentMacRcFile();
    return file ? [statusOf(file)] : [];
  }
  return [statusOf(profilePath()), statusOf(bashrcPath())];
}

// Every file a block may sit in on this platform, for removal and upgrade (Linux: ~/.bashrc and ~/.profile)
function blockFiles(): string[] {
  return isMac() ? macBlockFiles() : [bashrcPath(), profilePath()];
}

export interface PreCheck { ok: boolean; reasons: string[] }

/**
 * Enable pre-checks; reasons are localized, nothing is written and no modal is shown.
 * Linux: SHELL is bash; ~/.bash_profile and ~/.bash_login are missing or mention `.bashrc` on a non-comment line;
 * no rc file, nor the server-env-setup of a hook kind, has a broken block (manual fix required) or a user export of
 * CODEX_HOME.
 * Windows: unless the state file exists, a user-level CODEX_HOME that is not an adoptable ~/.codex-<name> is refused;
 * the read is strict, so a failed read throws instead of passing.
 * macOS: the login shell (codexMac.macLoginShell) is zsh or bash; none of the files that shell reads
 * (codexMac.macStartupFiles) has a broken block or a user export of CODEX_HOME.
 */
export function preCheck(run?: Runner, kind: ServerKind = currentServerKind()): PreCheck {
  const reasons: string[] = [];
  if (isMac()) {
    const shell = macLoginShell();
    const shellKind = macShellKind(shell);
    if (!shellKind) {
      reasons.push(t('codex.pre.notBash', { shell: shell || t('codex.pre.shellUnset') }));
      return { ok: false, reasons };
    }
    for (const st of macStartupFiles(shellKind).map((file) => statusOf(file))) {
      if (st.broken) reasons.push(t('codex.pre.broken', { file: st.file }));
      if (st.hasUserExport) reasons.push(t('codex.pre.userExport', { file: st.file }));
    }
    return { ok: reasons.length === 0, reasons };
  }
  if (isWindows()) {
    // An existing state file means PlanSwap already owns the variable. Strict read: a failure throws (the caller refuses
    // to enable) instead of passing as "unset" over a value the user set
    if (!fs.existsSync(STATE_FILE())) {
      const current = getUserCodexHome(run, true);
      if (current !== undefined && !adoptableUserHome(current)) reasons.push(t('codex.pre.winUserEnv'));
    }
    return { ok: reasons.length === 0, reasons };
  }
  const shell = process.env.SHELL ?? '';
  if (path.basename(shell) !== 'bash') {
    reasons.push(t('codex.pre.notBash', { shell: shell || t('codex.pre.shellUnset') }));
  }
  for (const name of ['.bash_profile', '.bash_login']) {
    const file = path.join(os.homedir(), name);
    const text = readText(file);
    // Comment lines do not source anything
    const sources = (l: string): boolean => !l.trimStart().startsWith('#') && l.includes('.bashrc');
    if (text !== undefined && !text.split('\n').some(sources)) {
      reasons.push(t('codex.pre.bashProfile', { file }));
    }
  }
  const files = rcStatus();
  // The hook file this editor's server sources (section 4a): the same conflicts as in an rc file
  if (isHookKind(kind)) files.push(statusOf(hookFileFor(kind), hookBlock(kind)));
  for (const st of files) {
    if (st.broken) {
      reasons.push(t('codex.pre.broken', { file: st.file }));
    }
    if (st.hasUserExport) {
      reasons.push(t('codex.pre.userExport', { file: st.file }));
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function statMode(file: string): number | undefined {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Atomic write: resolve symlinks to the real target, temp file in the same dir + fsync + chmod + rename.
 *  A dangling symlink is never replaced by a regular file: throws t('codex.rc.danglingLink'). */
function writeRc(file: string, content: string, mode: number | undefined): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(t('codex.rc.danglingLink', { file }));
  }
  const dirName = path.dirname(target);
  const tmp = path.join(dirName, `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode ?? 0o644);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function installInto(file: string, beforeGuard: boolean, block: string = rcBlock()): void {
  const text = readText(file);
  const mode = text === undefined ? undefined : statMode(file);
  if (text !== undefined && text.split('\n').some((l) => l.trim() === RC_BEGIN)) return;
  if (text === undefined) {
    writeRc(file, block, undefined);
    return;
  }
  if (beforeGuard) {
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => GUARD_RE.test(l));
    if (idx >= 0) {
      const before = lines.slice(0, idx).join('\n');
      const after = lines.slice(idx).join('\n');
      // Always add one blank line before the block (removeRcBlocks removes it too, restoring exactly); the block has a trailing newline so the guard stays on its own line
      const prefix = idx === 0 ? '' : before + '\n\n';
      writeRc(file, prefix + block + after, mode);
      return;
    }
  }
  // One newline: a file ending with a newline gets a blank line before the block, one without only gets the
  // missing newline (no blank line), so removal can tell the two apart and restore the original bytes
  const sep = text === '' ? '' : '\n';
  writeRc(file, text + sep + block, mode);
}

/**
 * Writes the block into both files, skipping a file that already has one. ~/.bashrc: before the interactive guard
 * (`case $- in`) with one blank line before the block, or appended when there is no guard; ~/.profile: appended
 * (after a blank line when the file ends with a newline, after only the missing newline otherwise). A missing file is
 * created with 0644, an existing one keeps its mode. Written by writeRc (atomic, through a symlink to its target);
 * a dangling symlink throws t('codex.rc.danglingLink') before that file is written. Install then removeRcBlocks
 * restores the original bytes of a file that existed before.
 * macOS: only the login shell's block file (codexMac.macRcFile), appended like ~/.profile; a shell other than zsh or
 * bash throws t('codex.pre.notBash') without writing.
 */
export function installRcBlocks(): void {
  if (isMac()) {
    const file = currentMacRcFile();
    if (!file) throw new Error(t('codex.pre.notBash', { shell: macLoginShell() || t('codex.pre.shellUnset') }));
    installInto(file, false);
    return;
  }
  installInto(bashrcPath(), true);
  installInto(profilePath(), false);
}

/** Writes hookBlock(kind) into the editor's server-env-setup unless the file already has a block: appended like the
 *  ~/.profile block, a missing file created with 0644 (and its folder when needed), written by writeRc. */
export function installHookBlock(kind: HookKind): void {
  const file = hookFileFor(kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  installInto(file, false, hookBlock(kind));
}

/**
 * Returns the content with all marker blocks removed, or undefined when the file is missing or has no block;
 * throws when a BEGIN lacks an END. Does not write.
 */
function withoutBlocks(file: string): string | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  let removed = false;
  for (;;) {
    const begin = lines.findIndex((l) => l.trim() === RC_BEGIN);
    if (begin < 0) break;
    const end = lines.findIndex((l, i) => i > begin && l.trim() === RC_END);
    if (end < 0) throw new Error(t('codex.rc.missingEnd', { file }));
    lines.splice(begin, end - begin + 1);
    if (begin > 0 && (lines[begin - 1] === '' || lines[begin - 1] === '\r')) {
      // Also remove the blank line added before the block at install time ('\r' after a CRLF conversion)
      lines.splice(begin - 1, 1);
    } else if (begin > 0 && begin === lines.length - 1 && lines[begin] === '') {
      // Block appended at the end of a file without a trailing newline: drop the newline added at install time
      lines.pop();
    }
    removed = true;
  }
  return removed ? lines.join('\n') : undefined;
}

/**
 * Removes all marker blocks from a single rc file (used by the enable rollback); written through writeRc, so
 * symlinks are followed and the mode is kept. If a BEGIN lacks an END, leaves the file untouched and throws.
 */
export function removeRcBlockFrom(file: string): void {
  const content = withoutBlocks(file);
  if (content !== undefined) writeRc(file, content, statMode(file));
}

/** Removes every block from both rc files and from the server-env-setup of every hook kind, including the blank line
 *  or missing newline added on installation (a file created by the installation is left empty); no block → no write.
 *  macOS: from every file codexMac.macBlockFiles lists instead (either shell's, so a block survives no shell change).
 *  Checks all files first; if any BEGIN lacks an END, throws (all localized reasons combined) without changing any
 *  file. Written like removeRcBlockFrom. */
export function removeRcBlocks(): void {
  const errors: Error[] = [];
  const writes: Array<{ file: string; content: string }> = [];
  for (const file of isMac() ? macBlockFiles() : [bashrcPath(), profilePath(), ...HOOK_KINDS.map(hookFileFor)]) {
    try {
      const content = withoutBlocks(file);
      if (content !== undefined) writes.push({ file, content });
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new Error(errors.map((e) => e.message).join(t('common.listSep')));
  for (const { file, content } of writes) writeRc(file, content, statMode(file));
}

/** Deletes the shared state file and every per-editor one (disable); a missing file is fine. */
export function removeLinuxState(): void {
  for (const file of [STATE_FILE(), ...HOOK_KINDS.map(stateFileFor)]) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

/**
 * Brings the marker blocks of both rc files to the current rcBlock() content: a block whose lines differ (written
 * by an earlier version, e.g. the one that unset an inherited CODEX_HOME) is replaced in place; lines outside the
 * blocks are kept byte for byte. Both files are checked first; a BEGIN without its END throws and nothing is written.
 * Returns true when a file was rewritten. Runs on every activation after migrateLegacyCodex. macOS: the files of
 * codexMac.macBlockFiles instead of ~/.bashrc and ~/.profile.
 */
export function upgradeRcBlocks(): boolean {
  const current = rcBlock().split('\n').slice(0, -1);
  const errors: Error[] = [];
  const writes: Array<{ file: string; content: string }> = [];
  for (const file of blockFiles()) {
    const text = readText(file);
    if (text === undefined) continue;
    const lines = text.split('\n');
    let changed = false;
    let from = 0;
    for (;;) {
      const begin = lines.findIndex((l, i) => i >= from && l.trim() === RC_BEGIN);
      if (begin < 0) break;
      const end = lines.findIndex((l, i) => i > begin && l.trim() === RC_END);
      if (end < 0) {
        errors.push(new Error(t('codex.rc.missingEnd', { file })));
        break;
      }
      if (lines.slice(begin, end + 1).join('\n') !== current.join('\n')) {
        lines.splice(begin, end - begin + 1, ...current);
        changed = true;
      }
      from = begin + current.length;
    }
    if (changed) writes.push({ file, content: lines.join('\n') });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new Error(errors.map((e) => e.message).join(t('common.listSep')));
  for (const { file, content } of writes) writeRc(file, content, statMode(file));
  return writes.length > 0;
}

// Before the rename to PlanSwap (0.1.0 - 0.1.3) the state file and the rc marker block used the name "ai-switcher".
// These strings must stay byte-identical to what those versions wrote
const LEGACY_STATE_FILE = () => path.join(os.homedir(), '.config', 'ai-switcher', 'codex-home');
const LEGACY_BEGIN = '# >>> ai-switcher codex >>>';
const LEGACY_END = '# <<< ai-switcher codex <<<';

/**
 * Returns the content with every legacy block replaced by the current block (the first one; later ones and legacy
 * blocks in a file that already has a current block are dropped together with the blank line added before them), or undefined when the file is missing or has no
 * legacy block. Lines outside the blocks, including the blank line before them, are kept. Throws when a legacy
 * BEGIN lacks its END. Does not write.
 */
function withLegacyReplaced(file: string): string | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  let hasCurrent = lines.some((l) => l.trim() === RC_BEGIN);
  let changed = false;
  for (;;) {
    const begin = lines.findIndex((l) => l.trim() === LEGACY_BEGIN);
    if (begin < 0) break;
    const end = lines.findIndex((l, i) => i > begin && l.trim() === LEGACY_END);
    if (end < 0) throw new Error(t('codex.rc.missingEnd', { file }));
    if (hasCurrent) {
      // Dropped: also remove the blank line (or the newline) the old version added before it, as withoutBlocks does
      lines.splice(begin, end - begin + 1);
      if (begin > 0 && (lines[begin - 1] === '' || lines[begin - 1] === '\r')) lines.splice(begin - 1, 1);
      else if (begin > 0 && begin === lines.length - 1 && lines[begin] === '') lines.pop();
    } else {
      // Replaced in place: rcBlock() ends with a newline; its last empty element is dropped because the END line keeps its own line break
      lines.splice(begin, end - begin + 1, ...rcBlock().split('\n').slice(0, -1));
    }
    hasCurrent = true;
    changed = true;
  }
  return changed ? lines.join('\n') : undefined;
}

/**
 * Migrates the Codex setup written before the rename, so an upgraded installation stays enabled with the same
 * selected account: when either rc file has a legacy block, the legacy state file's content is copied to
 * STATE_FILE (only when that does not exist yet), the legacy blocks are replaced in place by the current block
 * (atomic, symlinks followed, mode kept), and the legacy state file is deleted (its folder too when empty).
 * Both rc files are checked before anything is written; a legacy block without its END marker throws and nothing
 * changes. The selected directory stays the same, so the server environment does not need to be resolved again.
 * An empty legacy state file becomes an empty STATE_FILE; legacy-file removal errors are ignored. Without a legacy
 * block nothing is touched (a leftover legacy state file stays) and false is returned. Returns true when something
 * was migrated. Runs on every activation before the Codex store is created.
 */
export function migrateLegacyCodex(): boolean {
  const errors: Error[] = [];
  const writes: Array<{ file: string; content: string }> = [];
  for (const file of [bashrcPath(), profilePath()]) {
    try {
      const content = withLegacyReplaced(file);
      if (content !== undefined) writes.push({ file, content });
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new Error(errors.map((e) => e.message).join(t('common.listSep')));
  if (writes.length === 0) return false;
  const legacy = readText(LEGACY_STATE_FILE());
  if (legacy !== undefined && readText(STATE_FILE()) === undefined) {
    const dir = legacy.trim();
    writeSelectedDir(dir ? dir : undefined, 'unknown');
  }
  for (const { file, content } of writes) writeRc(file, content, statMode(file));
  try { fs.unlinkSync(LEGACY_STATE_FILE()); } catch { /* missing or already removed by another window */ }
  try { fs.rmdirSync(path.dirname(LEGACY_STATE_FILE())); } catch { /* not empty or missing */ }
  return true;
}

const STDERR_NOISE = ['cannot set terminal process group', 'no job control in this shell'];
// Prefix of the self-check's output line, so nothing else a login shell prints is taken for the value
const SELF_CHECK_MARK = '__PLANSWAP_CODEX_HOME__=';
/** Name prefix of the Linux self-check's scratch directory inside ~/.config/planswap. */
export const SELF_CHECK_DIR_PREFIX = '.selfcheck-';

// Windows (selfCheck delegates here): writes a marker into a scratch user variable (never CODEX_HOME itself), reads it back through the registry, then
// removes it. A failed removal is reported; it only leaves that harmless scratch variable behind
export function selfCheckWindows(run?: Runner): { ok: boolean; detail: string } {
  const marker = `planswap-${process.pid}-${Date.now()}`;
  let result: { ok: boolean; detail: string };
  try {
    setUserEnv(SELF_CHECK_NAME, marker, run);
    const out = getUserEnv(SELF_CHECK_NAME, run);
    result = out === marker
      ? { ok: true, detail: `${SELF_CHECK_NAME}=${out}` }
      : { ok: false, detail: t('codex.self.mismatch', { actual: out ?? '', expected: marker, stderr: '' }) };
  } catch (e) {
    result = { ok: false, detail: t('codex.self.error', { error: e instanceof Error ? e.message : String(e) }) };
  }
  try {
    setUserEnv(SELF_CHECK_NAME, undefined, run);
  } catch (e) {
    result = { ok: false, detail: t('codex.self.error', { error: e instanceof Error ? e.message : String(e) }) };
  }
  return result;
}

/** What the self-check needs from a finished shell run (spawnSync's result fits). */
export interface ShellResult { error?: Error; stdout?: string | null; stderr?: string | null }
/** Runs shell with args and env, synchronously (self-check seam; tests pass a fake, never a real login shell of theirs). */
export type ShellRunner = (shell: string, args: string[], env: NodeJS.ProcessEnv) => ShellResult;

const runShell: ShellRunner = (shell, args, env) =>
  spawnSync(shell, args, { env, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Enable self-check. Linux: creates a scratch dir (SELF_CHECK_DIR_PREFIX) beside STATE_FILE, temporarily selects it
 * in the shared state file (the one the rc blocks read), runs `bash -i -l -c` without this host's own CODEX_HOME
 * (the block only fills in an unset one) printing SELF_CHECK_MARK + $CODEX_HOME and compares only that marked line.
 * macOS: the same with the login shell itself (codexMac.macLoginShell, zsh or bash; another shell fails with
 * t('codex.pre.notBash')), which is how the editor resolves its environment.
 * Cleanup restores the previous state (or deletes a newly created state file) only while the state file still selects
 * the scratch dir, so a concurrent switch by another window is kept, and removes the scratch with non-recursive rmdir
 * so unexpected contents stay. Never throws; failures are returned as a localized detail. Windows: selfCheckWindows().
 * run: the shell runner (default spawnSync with a 10 s timeout).
 */
export function selfCheck(run: ShellRunner = runShell): { ok: boolean; detail: string } {
  if (isWindows()) return selfCheckWindows();
  let shell = 'bash';
  if (isMac()) {
    const login = macLoginShell();
    if (!login || !macShellKind(login)) return { ok: false, detail: t('codex.pre.notBash', { shell: login || t('codex.pre.shellUnset') }) };
    shell = login;
  }
  const file = STATE_FILE();
  let backup: string | undefined;
  let tmpDir: string | undefined;
  try {
    backup = readText(file);
    // The scratch directory lives next to the state file (user-owned, 0700), not in the world-writable temp directory
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    tmpDir = fs.mkdtempSync(path.join(path.dirname(file), SELF_CHECK_DIR_PREFIX));
    writeSelectedDir(tmpDir, 'unknown');
    const env = { ...process.env };
    delete env.CODEX_HOME;
    const r = run(shell, ['-i', '-l', '-c', `printf '\\n${SELF_CHECK_MARK}%s\\n' "$CODEX_HOME"`], env);
    if (r.error) return { ok: false, detail: t('codex.self.bashFailed', { error: r.error.message }) };
    // A login shell may print a motd or hints (Ubuntu's "sudo_root" note) to stdout; only the marked line is the value
    const marked = (r.stdout ?? '').split('\n').filter((l) => l.startsWith(SELF_CHECK_MARK)).pop();
    const out = marked === undefined ? '' : marked.slice(SELF_CHECK_MARK.length).trim();
    let real = tmpDir;
    try { real = fs.realpathSync(tmpDir); } catch { /* ignore */ }
    if (out === tmpDir || out === real) return { ok: true, detail: `CODEX_HOME=${out}` };
    const stderr = (r.stderr ?? '')
      .split('\n')
      .filter((l) => !STDERR_NOISE.some((noise) => l.includes(noise)))
      .join('\n')
      .trim();
    return {
      ok: false,
      detail: t('codex.self.mismatch', { actual: out, expected: tmpDir, stderr: stderr ? t('codex.self.stderr', { stderr }) : '' }),
    };
  } catch (e) {
    return { ok: false, detail: t('codex.self.error', { error: e instanceof Error ? e.message : String(e) }) };
  } finally {
    // Compare and restore: only while the state file still names the scratch directory, so a switch another window
    // made in the meantime is kept
    if (tmpDir !== undefined && readSelectedDir('unknown') === path.resolve(tmpDir)) {
      try {
        if (backup === undefined) {
          try { fs.unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        } else {
          const s = backup.trim();
          writeSelectedDir(s ? s : undefined, 'unknown');
        }
      } catch { /* ignore */ }
    }
    // Never recursive: if something wrote into the scratch directory it is left alone
    if (tmpDir) {
      try { fs.rmdirSync(tmpDir); } catch { /* not empty or already gone */ }
    }
  }
}
