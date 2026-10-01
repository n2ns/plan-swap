import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { realPathInside, samePath, sameRealPath } from '../paths';
import { isWindows, pidAlive, stripBom, unlinkLinks } from '../platform';
import { t } from '../i18n';
// Codex account directories, read-only account info from auth.json, the config.toml seed copy and deletion safety.
// No vscode import. Credential rules (auth.json read-only, identity never displayed, logged, persisted or sent to the
// Webview): AGENTS.md "Account and data safety". samePath / sameRealPath come from ../paths.

export const CODEX_DEFAULT_NAME = 'default';
export const CODEX_DIR_BASENAME_RE = /^\.codex-[A-Za-z0-9_-]+$/;

/** dir is absolute (path.resolve). */
export interface CodexAccount { name: string; dir: string }

// Seed files copied into an independent account (AGENTS.md and the rest are handled by codexShare.copyCodexIndependent)
const SEED_FILES = ['config.toml'];
// Top-level keys in the seed config that must not be carried into a new account dir; with BLOCKED_TABLE they are the
// default `roots` of blockedConfigReason (codexShare passes its own, longer identity list)
const BLOCKED_TOP_KEYS = ['forced_login_method', 'forced_chatgpt_workspace_id', 'sqlite_home', 'log_dir', 'model_provider'];
// Table that must not be carried over in any form ([model_providers], [model_providers.x], dotted keys, inline tables)
const BLOCKED_TABLE = 'model_providers';
const BLOCKED_ROOTS = [...BLOCKED_TOP_KEYS, BLOCKED_TABLE];
const DAEMON_PID_FILES = ['daemon.pid', 'app-server.pid', 'daemon-updater.pid', 'app-server-updater.pid'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The default dir is always path.resolve(~/.codex) regardless of CODEX_HOME or any other environment variable
// (this window's effective dir is codexState.effectiveDir)
export function codexDefaultDir(): string {
  return path.resolve(os.homedir(), '.codex');
}

/** path.resolve(~/.codex-<name>); the name is not validated here (see codexCommands.validateName). */
export function codexAccountDir(name: string): string {
  return path.resolve(os.homedir(), '.codex-' + name);
}

/** Signed in iff <dir>/auth.json exists (existence check only). */
export function codexLoggedIn(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'auth.json'));
}

// identity: opaque comparison key (user + workspace) for detecting duplicate sign-ins and attributing usage results;
// never displayed, logged, persisted or sent to the Webview
export interface CodexAccountInfo { email?: string; plan?: string; loggedIn: boolean; identity?: string }

// Decodes the second JWT segment (base64url) without verifying the signature; any error returns undefined
export function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return undefined;
    const data: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isPlainObject(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

const CODEX_PLAN_NAMES: Record<string, string> = { prolite: 'Pro Lite' };

// chatgpt_plan_type → display text: lower-cased then capitalized (plus → Plus, team → Team, any unknown value likewise),
// except the CODEX_PLAN_NAMES overrides (prolite → "Pro Lite"); empty or missing → undefined
export function formatCodexPlan(planType?: string): string | undefined {
  if (!planType) return undefined;
  const key = planType.toLowerCase();
  return CODEX_PLAN_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The only reader of auth.json content. Account info for display and comparison; never returns or logs the raw
 * access_token / refresh_token / id_token.
 * - auth.json missing → { loggedIn: false }; present → loggedIn: true, even when it is damaged or being written
 *   (then email, plan and identity are unknown).
 * - API key mode (auth_mode 'apikey', or no auth_mode with a non-empty OPENAI_API_KEY and no tokens object) →
 *   plan 'API key', no email, no identity.
 * - Otherwise only the payload of tokens.id_token is decoded (decodeJwtPayload, no signature check): email,
 *   'https://api.openai.com/auth'.chatgpt_plan_type via formatCodexPlan, and identity (see codexIdentity).
 */
export function readCodexAccountInfo(dir: string): CodexAccountInfo {
  const file = path.join(dir, 'auth.json');
  if (!fs.existsSync(file)) return { loggedIn: false };
  let email: string | undefined;
  let plan: string | undefined;
  let identity: string | undefined;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isPlainObject(data)) {
      // auth_mode wins when present; only when missing, non-empty OPENAI_API_KEY without tokens means API key mode
      const apiKeyMode =
        data.auth_mode === 'apikey' ||
        (data.auth_mode === undefined &&
          typeof data.OPENAI_API_KEY === 'string' &&
          data.OPENAI_API_KEY !== '' &&
          !isPlainObject(data.tokens));
      if (apiKeyMode) {
        plan = 'API key';
      } else {
        const tokens = data.tokens;
        const idToken = isPlainObject(tokens) ? tokens.id_token : undefined;
        const payload = typeof idToken === 'string' ? decodeJwtPayload(idToken) : undefined;
        if (payload) {
          if (typeof payload.email === 'string' && payload.email) email = payload.email;
          const auth = payload['https://api.openai.com/auth'];
          const planType = isPlainObject(auth) ? auth.chatgpt_plan_type : undefined;
          plan = formatCodexPlan(typeof planType === 'string' ? planType : undefined);
          identity = codexIdentity(payload);
        }
      }
    }
  } catch {
    // Corrupt JSON or being written: treat as unknown
  }
  return identity ? { email, plan, loggedIn: true, identity } : { email, plan, loggedIn: true };
}

// User id (chatgpt_user_id, user_id, then top-level sub) plus workspace id (chatgpt_account_id);
// both are required and email is never used, so one person in two workspaces is not a duplicate
function codexIdentity(payload: Record<string, unknown>): string | undefined {
  const auth = payload['https://api.openai.com/auth'];
  if (!isPlainObject(auth)) return undefined;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const user = str(auth.chatgpt_user_id) ?? str(auth.user_id) ?? str(payload.sub);
  const workspace = str(auth.chatgpt_account_id);
  return user && workspace ? `codex:${user}\n${workspace}` : undefined;
}

/** Real directories ~/.codex-<name> (symlinks excluded), minus any that is or contains the default dir after
 *  resolving links. An unreadable home → []. */
export function scanCodexDirs(): CodexAccount[] {
  const home = os.homedir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const def = codexDefaultDir();
  // Dirent.isDirectory() returns false for symlinks, so symlinks are excluded naturally
  return entries
    .filter((e) => e.isDirectory() && CODEX_DIR_BASENAME_RE.test(e.name))
    .map((e) => ({ name: e.name.slice('.codex-'.length), dir: path.resolve(home, e.name) }))
    .filter((a) => !sameRealPath(a.dir, def) && !realPathInside(a.dir, def));
}

/** mkdir -p with mode 0700. */
export function ensureCodexDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}


export interface CopyResult { copied: string[]; skipped: Array<{ file: string; reason: string }> }

/**
 * Parses a TOML key at the start of s: bare, "basic" or 'literal' segments joined by dots, whitespace allowed
 * around the dots. Returns the unquoted segments and the rest of the line, or undefined when s does not start with a key.
 */
function parseTomlKey(s: string): { segments: string[]; rest: string } | undefined {
  const segments: string[] = [];
  let rest = s;
  for (;;) {
    rest = rest.trimStart();
    let m: RegExpExecArray | null;
    if ((m = /^[A-Za-z0-9_-]+/.exec(rest))) {
      segments.push(m[0]);
    } else if ((m = /^"((?:[^"\\]|\\.)*)"/.exec(rest))) {
      let value = m[1];
      try { value = JSON.parse(m[0]) as string; } catch { /* keep the raw text for TOML-only escapes */ }
      segments.push(value);
    } else if ((m = /^'([^']*)'/.exec(rest))) {
      segments.push(m[1]);
    } else {
      return undefined;
    }
    rest = rest.slice(m[0].length).trimStart();
    if (!rest.startsWith('.')) return { segments, rest };
    rest = rest.slice(1);
  }
}

// State of a value that continues on the next lines: open [ / { nesting and an open """ / ''' string
interface ValueState { depth: number; ml?: string }

// Walks one line of a value (after '=' or a continuation line), updating the nesting and multi-line string state
function scanValue(s: string, st: ValueState): void {
  let i = 0;
  while (i < s.length) {
    if (st.ml) {
      if (st.ml === '"""' && s[i] === '\\') {
        i += 2; // A basic-string escape consumes the next character, including a quote or another backslash.
      } else if (s.startsWith(st.ml, i)) {
        i += 3;
        st.ml = undefined;
      } else {
        i++;
      }
      continue;
    }
    const c = s[i];
    if (c === '#') return;
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
      st.ml = s.slice(i, i + 3);
      i += 3;
    } else if (c === '"') {
      const m = /^"(?:[^"\\]|\\.)*"/.exec(s.slice(i));
      i += m ? m[0].length : s.length;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      i = end < 0 ? s.length : end + 1;
    } else {
      if (c === '[' || c === '{') st.depth++;
      else if ((c === ']' || c === '}') && st.depth > 0) st.depth--;
      i++;
    }
  }
}

/**
 * Returns the localized reason for the first blocked item in a config.toml text, or undefined if none.
 * Line-based scan (a leading BOM is ignored):
 * - a table header ([t] or [[t]]) whose first segment is a root → "[<normalized header>] section", e.g.
 *   [model_providers], [ model_providers.x ], ["model_providers".x];
 * - a top-level key whose first segment is a root → "top-level key <root>": plain, "basic" or 'literal' keys,
 *   dotted keys (model_providers.x.base_url = …) and inline tables (model_providers = { … }).
 * Whitespace around dots and quotes in keys and headers are normalized; leading whitespace is allowed; # comment
 * lines are ignored; keys after any other table header are not top-level. Lines inside a multi-line value (array,
 * inline table, """ or ''' string) are skipped, so they are never read as keys or headers; basic-string escapes are
 * respected when finding the closing delimiter, literal strings have none.
 * roots: the blocked first segments; default BLOCKED_TOP_KEYS + BLOCKED_TABLE (seed copy). codexShare passes
 * CODEX_IDENTITY_CONFIG_KEYS + CODEX_IDENTITY_CONFIG_TABLES.
 */
export function blockedConfigReason(text: string, roots: readonly string[] = BLOCKED_ROOTS): string | undefined {
  let topLevel = true;
  const st: ValueState = { depth: 0 };
  // A byte order mark would hide a blocked key on the first line
  for (const raw of stripBom(text).split(/\r?\n/)) {
    if (st.depth > 0 || st.ml) {
      scanValue(raw, st);
      continue;
    }
    const line = raw.trimStart();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      // [table] or [[array of tables]]
      const header = parseTomlKey(line.slice(line.startsWith('[[') ? 2 : 1));
      if (!header || !header.rest.startsWith(']')) continue;
      if (roots.includes(header.segments[0])) {
        return t('codex.seed.hasSection', { section: `[${header.segments.join('.')}]` });
      }
      // Keys after any table header are not top-level
      topLevel = false;
      continue;
    }
    const key = parseTomlKey(line);
    if (!key || !key.rest.startsWith('=')) continue;
    if (topLevel && roots.includes(key.segments[0])) {
      return t('codex.seed.hasTopKey', { key: key.segments[0] });
    }
    scanValue(key.rest.slice(1), st);
  }
  return undefined;
}

/**
 * Seed copy for a new independent account: only config.toml (the rest is copied by codexShare.copyCodexIndependent;
 * auth.json is never copied). Skipped, with a localized reason, when the source is missing or unreadable, the target
 * already exists, or blockedConfigReason finds a blocked key or table. Written with mode 0600 and flag 'wx'.
 */
export function copyCodexSeed(fromDir: string, toDir: string): CopyResult {
  const result: CopyResult = { copied: [], skipped: [] };
  for (const file of SEED_FILES) {
    const src = path.join(fromDir, file);
    const dst = path.join(toDir, file);
    if (!fs.existsSync(src)) {
      result.skipped.push({ file, reason: t('codex.seed.srcMissing') });
      continue;
    }
    if (fs.existsSync(dst)) {
      result.skipped.push({ file, reason: t('codex.seed.dstExists') });
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(src, 'utf8');
    } catch {
      result.skipped.push({ file, reason: t('codex.seed.readFailed') });
      continue;
    }
    if (file === 'config.toml') {
      const reason = blockedConfigReason(text);
      if (reason) {
        result.skipped.push({ file, reason: t('codex.seed.blocked', { reason }) });
        continue;
      }
    }
    // wx: fail if the target exists; never overwrite
    fs.writeFileSync(dst, text, { mode: 0o600, flag: 'wx' });
    result.copied.push(file);
  }
  return result;
}

// starttime (field 22) of /proc/<pid>/stat; comm may contain spaces and parentheses, so parse after the last ')'
function procStartTime(pid: number, procRoot: string): number | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return undefined;
  }
  const end = stat.lastIndexOf(')');
  if (end < 0) return undefined;
  // The first field after ')' is field 3 (state), so field 22 is index 19
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  const v = Number(fields[19]);
  return Number.isFinite(v) ? v : undefined;
}

function toTicks(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function pidFileAlive(file: string, procRoot: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!isPlainObject(data)) return false;
  const pid = data.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  // Windows: no start ticks to compare, so a live pid counts, with or without them
  if (isWindows() && procRoot === '/proc') return pidAlive(pid);
  const identity = data.processIdentity;
  const ticks = toTicks(isPlainObject(identity) ? identity.startTicks : undefined) ?? toTicks(data.processStartTime);
  if (ticks === undefined) return false;
  // Without procRoot (e.g. no /proc) the daemon cannot be ruled out
  if (!fs.existsSync(procRoot)) return true;
  return procStartTime(pid, procRoot) === ticks;
}

/**
 * Whether a Codex daemon owns dir: any of DAEMON_PID_FILES under <dir>/app-server-daemon/ whose JSON pid and start
 * ticks (processIdentity.startTicks, else processStartTime) match the start time in <procRoot>/<pid>/stat.
 * A missing file, unparsable JSON or a missing pid / start ticks → not alive. A valid pid file while procRoot itself
 * is missing → alive (cannot be ruled out). Windows with the default procRoot: a live pid alone counts.
 * Depends on Codex's pid-file format; re-verify after Codex upgrades. procRoot is for tests.
 */
export function codexDaemonAlive(dir: string, procRoot = '/proc'): boolean {
  const base = path.join(dir, 'app-server-daemon');
  return DAEMON_PID_FILES.some((f) => pidFileAlive(path.join(base, f), procRoot));
}

/**
 * Localized refusal reason, or undefined when dir may be deleted. In order: a direct child of the home directory
 * (del.notHomeChild); basename matches CODEX_DIR_BASENAME_RE (del.badName); not the default dir by real path
 * (del.isDefault); does not contain the default dir after resolving links (del.containsDefault); exists
 * (del.missing); not a symlink (del.symlink); a directory (del.notDir); no live daemon (del.daemonAlive).
 */
export function checkCodexSafeToDelete(dir: string): string | undefined {
  const home = path.resolve(os.homedir());
  const target = path.resolve(dir);
  // Only direct children of the home directory, so a symlinked parent cannot escape the home directory
  if (!samePath(path.dirname(target), home)) return t('del.notHomeChild', { dir: target });
  if (!CODEX_DIR_BASENAME_RE.test(path.basename(target))) return t('del.badName', { pattern: '.codex-<name>', dir: target });
  const def = codexDefaultDir();
  if (sameRealPath(target, def)) return t('del.isDefault', { dir: target });
  if (realPathInside(target, def)) return t('del.containsDefault', { default: def, dir: target });
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return t('del.missing', { dir: target });
  }
  if (st.isSymbolicLink()) return t('del.symlink', { dir: target });
  if (!st.isDirectory()) return t('del.notDir', { dir: target });
  if (codexDaemonAlive(target)) return t('del.daemonAlive', { dir: target });
  return undefined;
}

/** The only Codex deletion path: throws checkCodexSafeToDelete's reason; otherwise removes links inside the tree
 *  first (unlinkLinks, Windows only, so no junction is followed) and then fs.promises.rm recursive + force, which
 *  does not follow symlinks, so a shared account loses only its own files and links. */
export async function deleteCodexDir(dir: string): Promise<void> {
  const reason = checkCodexSafeToDelete(dir);
  if (reason) throw new Error(reason);
  unlinkLinks(path.resolve(dir));
  await fs.promises.rm(path.resolve(dir), { recursive: true, force: true });
}
