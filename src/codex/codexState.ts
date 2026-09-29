import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codexDefaultDir } from './codexPaths';
import { t } from '../i18n';
import { fsyncDir, isWindows } from '../platform';
import { getUserCodexHome, setUserCodexHome } from './codexWindows';

export const STATE_FILE = () => path.join(os.homedir(), '.config', 'planswap', 'codex-home');

export function readSelectedDir(): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_FILE(), 'utf8');
  } catch {
    return undefined;
  }
  const s = raw.trim();
  return s ? path.resolve(s) : undefined;
}

export function writeSelectedDir(dir: string | undefined): void {
  const file = STATE_FILE();
  const dirName = path.dirname(file);
  fs.mkdirSync(dirName, { recursive: true, mode: 0o700 });
  const tmp = path.join(dirName, `.codex-home.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, dir === undefined ? '' : path.resolve(dir));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  fsyncDir(dirName);
}

/**
 * Writes the selected directory and, on Windows when management is enabled (the state file existed), mirrors it into
 * the user-level CODEX_HOME so a freshly started editor picks it up. Elsewhere the rc blocks read the state file.
 */
export function writeSelection(dir: string | undefined): void {
  const managed = isWindows() && fs.existsSync(STATE_FILE());
  writeSelectedDir(dir);
  if (managed) setUserCodexHome(dir === undefined ? undefined : path.resolve(dir));
}

/** Whether PlanSwap manages CODEX_HOME. Windows: the state file exists; elsewhere: both rc files carry a block. */
export function isEnabled(): boolean {
  if (isWindows()) return fs.existsSync(STATE_FILE());
  return rcStatus().every((s) => s.hasBlock && !s.broken);
}

/** Windows enable: refuses when the user already sets CODEX_HOME (never overwritten), else creates the state file. */
export function enableWindows(): void {
  writeSelectedDir(undefined);
}

/** Windows disable: removes the user-level CODEX_HOME that PlanSwap wrote and the state file. */
export function disableWindows(): void {
  setUserCodexHome(undefined);
  try {
    fs.unlinkSync(STATE_FILE());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function effectiveDir(): string {
  const env = process.env.CODEX_HOME;
  return env ? path.resolve(env) : codexDefaultDir();
}

export const RC_BEGIN = '# >>> planswap codex >>>';
export const RC_END = '# <<< planswap codex <<<';

export function rcBlock(): string {
  return [
    RC_BEGIN,
    'if [ -r "$HOME/.config/planswap/codex-home" ]; then',
    '  _planswap_codex_home="$(cat "$HOME/.config/planswap/codex-home" 2>/dev/null)"',
    '  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then',
    '    export CODEX_HOME="$_planswap_codex_home"',
    '  else',
    '    unset CODEX_HOME',
    '  fi',
    '  unset _planswap_codex_home',
    'fi',
    RC_END,
    '',
  ].join('\n');
}

/** broken: a BEGIN marker exists without a matching END marker */
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

/** Returns lines outside marker blocks; if the last BEGIN has no END, lines from that BEGIN count as outside and broken is set. */
function scanBlocks(text: string): { outside: string[]; broken: boolean } {
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
    outside.push(...lines.slice(blockStart));
    return { outside, broken: true };
  }
  return { outside, broken: false };
}

function statusOf(file: string): RcFileStatus {
  const text = readText(file);
  if (text === undefined) return { file, hasBlock: false, broken: false, hasUserExport: false };
  const hasBlock = text.split('\n').some((l) => l.trim() === RC_BEGIN);
  const { outside, broken } = scanBlocks(text);
  const hasUserExport = outside.some((l) => USER_EXPORT_RE.test(l));
  return { file, hasBlock, broken, hasUserExport };
}

export function rcStatus(): RcFileStatus[] {
  return [statusOf(profilePath()), statusOf(bashrcPath())];
}

export interface PreCheck { ok: boolean; reasons: string[] }

export function preCheck(): PreCheck {
  const reasons: string[] = [];
  if (isWindows()) {
    // An existing state file means PlanSwap already owns the variable
    if (!fs.existsSync(STATE_FILE()) && getUserCodexHome() !== undefined) reasons.push(t('codex.pre.winUserEnv'));
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
  for (const st of rcStatus()) {
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
  const fd = fs.openSync(tmp, 'w', 0o600);
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

function installInto(file: string, beforeGuard: boolean): void {
  const text = readText(file);
  const mode = text === undefined ? undefined : statMode(file);
  if (text !== undefined && text.split('\n').some((l) => l.trim() === RC_BEGIN)) return;
  const block = rcBlock();
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

export function installRcBlocks(): void {
  installInto(bashrcPath(), true);
  installInto(profilePath(), false);
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

/** Checks both files first; if any BEGIN lacks an END, throws (all errors combined) without changing either file. */
export function removeRcBlocks(): void {
  const errors: Error[] = [];
  const writes: Array<{ file: string; content: string }> = [];
  for (const file of [bashrcPath(), profilePath()]) {
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
 * Returns true when something was migrated.
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
    writeSelectedDir(dir ? dir : undefined);
  }
  for (const { file, content } of writes) writeRc(file, content, statMode(file));
  try { fs.unlinkSync(LEGACY_STATE_FILE()); } catch { /* missing or already removed by another window */ }
  try { fs.rmdirSync(path.dirname(LEGACY_STATE_FILE())); } catch { /* not empty or missing */ }
  return true;
}

const STDERR_NOISE = ['cannot set terminal process group', 'no job control in this shell'];

// Windows: writes a sentinel into the user environment, reads it back through the registry, then restores the old value
function selfCheckWindows(): { ok: boolean; detail: string } {
  let tmpDir: string | undefined;
  let previous: string | undefined;
  try {
    previous = getUserCodexHome();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planswap-codex-'));
    setUserCodexHome(tmpDir);
    const out = getUserCodexHome();
    if (out !== undefined && samePathLoose(out, tmpDir)) return { ok: true, detail: `CODEX_HOME=${out}` };
    return { ok: false, detail: t('codex.self.mismatch', { actual: out ?? '', expected: tmpDir, stderr: '' }) };
  } catch (e) {
    return { ok: false, detail: t('codex.self.error', { error: e instanceof Error ? e.message : String(e) }) };
  } finally {
    try { setUserCodexHome(previous); } catch { /* ignore */ }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function samePathLoose(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function selfCheck(): { ok: boolean; detail: string } {
  if (isWindows()) return selfCheckWindows();
  const file = STATE_FILE();
  const backup = readText(file);
  let tmpDir: string | undefined;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planswap-codex-'));
    writeSelectedDir(tmpDir);
    const r = spawnSync('bash', ['-i', '-l', '-c', 'printf %s "$CODEX_HOME"'], {
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) return { ok: false, detail: t('codex.self.bashFailed', { error: r.error.message }) };
    // /etc/profile.d may print a motd etc. to stdout in a login shell; only take the last line
    const lines = (r.stdout ?? '').trimEnd().split('\n');
    const out = (lines[lines.length - 1] ?? '').trim();
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
    try {
      if (backup === undefined) {
        try { fs.unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      } else {
        const s = backup.trim();
        writeSelectedDir(s ? s : undefined);
      }
    } catch { /* ignore */ }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
