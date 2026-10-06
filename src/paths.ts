// Claude data layer (no vscode import): account directories, the account info file, scanning and deletion. Paths are
// absolute after path.resolve; compare spellings with samePath and protect the default directory with sameRealPath.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { t } from './i18n';
import { comparablePath, isWindows, renameReplacing, stripBom, unlinkLinks } from './platform';

export const DEFAULT_NAME = 'default';
export const NAME_RE = /^[A-Za-z0-9_-]+$/;
export const DIR_BASENAME_RE = /^\.claude-[A-Za-z0-9_-]+$/;

// dir is always absolute (path.resolve: no '~', no trailing separator)
export interface Account { name: string; dir: string }
// plan: formatted plan text (formatClaudePlan, e.g. "Max 20x"). identity: opaque comparison key (account + organization)
// for detecting duplicate sign-ins; never displayed, logged, persisted or sent to the Webview (panel rows copy only
// email, plan and sign-in state)
export interface AccountInfo { email?: string; plan?: string; loggedIn: boolean; identity?: string }

// settings.json keys that supply or restrict a sign-in, or move where Claude Code keeps an account's configuration and
// credentials (Claude Code research, facts 15-17): a settings.json with one is never linked into another account, and
// copies for another account drop them. The credentials outrank the account's own /login; forceLoginMethod restricts
// how accounts sign in; the two directories, applied from env, would point every account at one location.
// forceLoginOrgUUID is not one: outside managed settings it only pre-selects an organization at login.
export const CLAUDE_IDENTITY_SETTING_KEYS = {
  top: ['apiKeyHelper', 'forceLoginMethod'],
  env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'],
  // Workload Identity Federation outranks /login only with both set
  envTogether: ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID'],
} as const;
// Plugin keys also stay out of an independent account's copy
const STRIP_TOP_KEYS = [...CLAUDE_IDENTITY_SETTING_KEYS.top, 'enabledPlugins', 'extraKnownMarketplaces', 'additionalMarketplaces'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first identity key a parsed settings.json sets (CLAUDE_IDENTITY_SETTING_KEYS), named as written: a top-level key
 *  as is, one under env as `env.<NAME>` (the federation pair as its first variable); undefined when there is none. */
export function claudeIdentitySetting(data: Record<string, unknown>): string | undefined {
  const top = CLAUDE_IDENTITY_SETTING_KEYS.top.find((k) => Object.hasOwn(data, k));
  if (top) return top;
  const env = data.env;
  if (!isPlainObject(env)) return undefined;
  const key = CLAUDE_IDENTITY_SETTING_KEYS.env.find((k) => Object.hasOwn(env, k))
    ?? (CLAUDE_IDENTITY_SETTING_KEYS.envTogether.every((k) => Object.hasOwn(env, k)) ? CLAUDE_IDENTITY_SETTING_KEYS.envTogether[0] : undefined);
  return key && `env.${key}`;
}

/** The default Claude account directory: the extension host's CLAUDE_CONFIG_DIR (see configDirFromEnv), else ~/.claude;
 *  always path.resolve'd. Use this rather than hard-coding ~/.claude. */
export function defaultDir(): string {
  return path.resolve(configDirFromEnv() ?? path.join(os.homedir(), '.claude'));
}

// CLAUDE_CONFIG_DIR of the extension host, used as is like Claude Code does (surrounding spaces included; they are warned
// about at activation); blank counts as unset (Claude Code would resolve it against its own working folder)
function configDirFromEnv(): string | undefined {
  const v = process.env.CLAUDE_CONFIG_DIR;
  return v && v.trim() ? v : undefined;
}

export function accountDir(name: string): string {
  return path.resolve(os.homedir(), '.claude-' + name);
}

// Case-insensitive on Windows
export function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/**
 * Real path after resolving links; path.resolve when the path does not exist. On Windows the native call is used: the
 * JS implementation keeps 8.3 short names (C:\Users\JOHNSM~1), a '\\?\' prefix and the case given, so another spelling
 * of the same folder would compare unequal. Linux keeps the JS implementation (same result as realpath(3)).
 */
export function realPath(p: string): string {
  if (isWindows()) {
    try {
      return fs.realpathSync.native(p);
    } catch {
      // fall through to the JS implementation (it copes with some reparse points the native call refuses)
    }
  }
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The same file-system object: both exist and share device and inode (the NTFS file id needs bigint). Catches every
// remaining alias, e.g. \\localhost\C$\… on Windows or a bind mount on Linux
function sameFileId(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

// Whether both point to the same location after resolving links (or are the same file-system object); used wherever a
// directory must not be mistaken for another, above all the default account's: every default-directory guard (scan,
// deletion, isDefault, name validation, busy check) compares with it, samePath only compares spellings
export function sameRealPath(a: string, b: string): boolean {
  return comparablePath(realPath(a)) === comparablePath(realPath(b)) || sameFileId(a, b);
}

/** Whether `inner` lies strictly below `outer` after resolving links (case-insensitive on Windows); a folder that
 *  contains the default account (e.g. ~/.codex is a link into ~/.codex-foo/…) must never be deleted or listed. */
export function realPathInside(outer: string, inner: string): boolean {
  const rel = path.relative(comparablePath(realPath(outer)), comparablePath(realPath(inner)));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Variables claudeCode.environmentVariables sets (non-empty) or clears (empty) for the Claude Code the editor starts;
// kept here by the host (setClaudeSettingEnv) so this module needs no vscode import
let settingEnv: { set: readonly string[]; cleared: readonly string[] } = { set: [], cleared: [] };

/** The host passes claudeSettings.settingEnvNames() at activation and on every change of the setting. */
export function setClaudeSettingEnv(names: { set: readonly string[]; cleared: readonly string[] }): void {
  settingEnv = names;
}

// Whether Claude Code started by this editor sees a non-empty `name`: the setting first, then the host environment
function claudeSeesSet(name: string): boolean {
  const norm = (n: string): string => (isWindows() ? n.toUpperCase() : n);
  if (settingEnv.set.some((n) => norm(n) === norm(name))) return true;
  if (settingEnv.cleared.some((n) => norm(n) === norm(name))) return false;
  return !!process.env[name];
}

/** File name of the account info file: Claude Code (2.1.284) names it '.claude-custom-oauth.json' while
 *  CLAUDE_CODE_CUSTOM_OAUTH_URL is set, '.claude.json' otherwise (its local / staging variants exist only in
 *  development builds). "Set" as Claude Code started by this editor sees it: the setting's set / cleared names
 *  (setClaudeSettingEnv) first, then process.env. Used by claudeJsonPath, mirrorClaudeJson and syncMcpServers. */
export function claudeJsonName(): string {
  return claudeSeesSet('CLAUDE_CODE_CUSTOM_OAUTH_URL') ? '.claude-custom-oauth.json' : '.claude.json';
}

/** Index of `dir` in `dirs`: an entry with the same spelling first (samePath), otherwise one that is another spelling of
 *  the same folder (sameRealPath: an 8.3 name, '\\?\', a link to it); -1 when none. Marks the current / selected row
 *  so another spelling does not show up as an extra "external" row. */
export function findSameDir(dirs: readonly string[], dir: string): number {
  const exact = dirs.findIndex((d) => samePath(d, dir));
  return exact >= 0 ? exact : dirs.findIndex((d) => sameRealPath(d, dir));
}

// Account info file location: without CLAUDE_CONFIG_DIR, Claude Code uses ~/.claude.json (in the home dir, not inside ~/.claude).
// explicit: CLAUDE_CONFIG_DIR is set to dir for the processes that use it (e.g. by the setting), so <dir>/.claude.json is used.
// So: ~/.claude.json only when explicit is false, the host has no CLAUDE_CONFIG_DIR and dir is ~/.claude; otherwise
// <dir>/<claudeJsonName()>. Every account-info reader and watcher passes explicit = claudeSettings.isExplicitConfigDir(dir)
export function claudeJsonPath(dir: string, explicit = false): string {
  const home = os.homedir();
  if (!explicit && configDirFromEnv() === undefined && samePath(dir, path.join(home, '.claude'))) return path.join(home, claudeJsonName());
  return path.join(dir, claudeJsonName());
}

const CLAUDE_PLAN_NAMES: Record<string, string> = {
  claude_max: 'Max',
  claude_pro: 'Pro',
  claude_team: 'Team',
  team: 'Team',
  claude_enterprise: 'Enterprise',
  enterprise: 'Enterprise',
};

// Formats organizationType / organizationRateLimitTier from .claude.json for display, e.g. "Max 20x"; undefined when both are empty.
// Type: CLAUDE_PLAN_NAMES, else the value without a 'claude_' prefix, first letter capitalized. Tier: a trailing
// '_<n>x' becomes '<n>x'. Both present → '<type> <n>x'; only one → that one
export function formatClaudePlan(orgType?: string, tier?: string): string | undefined {
  let name: string | undefined;
  if (orgType) {
    name = CLAUDE_PLAN_NAMES[orgType];
    if (!name) {
      const raw = orgType.startsWith('claude_') ? orgType.slice('claude_'.length) : orgType;
      name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : undefined;
    }
  }
  const m = tier ? /_(\d+)x$/.exec(tier) : null;
  const suffix = m ? `${m[1]}x` : undefined;
  if (name && suffix) return `${name} ${suffix}`;
  return name ?? suffix;
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Synchronous; reads oauthAccount from claudeJsonPath(dir, explicit) and never throws (a missing or half-written file
 * yields no email / plan). email = emailAddress; plan = formatClaudePlan(organizationType, organizationRateLimitTier);
 * loggedIn = an email, or else <dir>/.credentials.json exists (existence only, never read); identity only when
 * accountUuid and organizationUuid are both non-empty strings.
 */
export function readAccountInfo(dir: string, explicit = false): AccountInfo {
  let email: string | undefined;
  let plan: string | undefined;
  let identity: string | undefined;
  try {
    const data: unknown = JSON.parse(stripBom(fs.readFileSync(claudeJsonPath(dir, explicit), 'utf8')));
    const oauth = isPlainObject(data) ? data.oauthAccount : undefined;
    if (isPlainObject(oauth)) {
      email = optString(oauth.emailAddress);
      plan = formatClaudePlan(optString(oauth.organizationType), optString(oauth.organizationRateLimitTier));
      const account = optString(oauth.accountUuid);
      const org = optString(oauth.organizationUuid);
      if (account && org) identity = `claude:${account}\n${org}`;
    }
  } catch {
    // File missing or being written by the CLI (partial JSON): treat as unknown
  }
  const loggedIn = !!email || fs.existsSync(path.join(dir, '.credentials.json'));
  return identity ? { email, plan, loggedIn, identity } : { email, plan, loggedIn };
}

/** Account directories found on disk: real directories (not links) directly under the home directory whose basename
 *  matches DIR_BASENAME_RE, excluding the default directory and any directory containing it after resolving links;
 *  name = basename without '.claude-'. [] when the home directory cannot be read. */
export function scanAccountDirs(): Account[] {
  const home = os.homedir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const def = defaultDir();
  // Dirent.isDirectory() returns false for symlinks, so symlinks are excluded naturally
  return entries
    .filter((e) => e.isDirectory() && DIR_BASENAME_RE.test(e.name))
    .map((e) => ({ name: e.name.slice('.claude-'.length), dir: path.resolve(home, e.name) }))
    .filter((a) => !sameRealPath(a.dir, def) && !realPathInside(a.dir, def));
}

/** Copies <fromDir>/settings.json to <toDir> (mode 0600, never overwriting) without the identity keys
 *  (CLAUDE_IDENTITY_SETTING_KEYS; the federation pair only when both are set) and the plugin keys. false, writing
 *  nothing, when the source is missing, unparsable or not an object, or the target already exists. Used by
 *  claudeShare.copyClaudeIndependent and for a linked account whose default settings.json cannot be linked. */
export function copySettingsStripped(fromDir: string, toDir: string): boolean {
  const src = path.join(fromDir, 'settings.json');
  const dst = path.join(toDir, 'settings.json');
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  let data: unknown;
  try {
    data = JSON.parse(stripBom(fs.readFileSync(src, 'utf8')));
  } catch {
    return false;
  }
  if (!isPlainObject(data)) return false;
  for (const k of STRIP_TOP_KEYS) delete data[k];
  const env = data.env;
  if (isPlainObject(env)) {
    const federation = CLAUDE_IDENTITY_SETTING_KEYS.envTogether.every((k) => Object.hasOwn(env, k));
    for (const k of [...CLAUDE_IDENTITY_SETTING_KEYS.env, ...(federation ? CLAUDE_IDENTITY_SETTING_KEYS.envTogether : [])]) delete env[k];
  }
  // wx: fail if the target exists; never overwrite
  fs.writeFileSync(dst, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return true;
}

/** Windows: the on-disk name of an existing folder that is `dir` except for letter case (the same folder there, e.g.
 *  '.claude-Work' for '.claude-work'); undefined when there is none or the spelling matches. Always undefined elsewhere. */
export function caseVariantOf(dir: string): string | undefined {
  if (!isWindows()) return undefined;
  const want = path.basename(dir);
  try {
    return fs.readdirSync(path.dirname(dir)).find((n) => n !== want && n.toLowerCase() === want.toLowerCase());
  } catch {
    return undefined;
  }
}

// Creates dir (and parents) with mode 0700; an existing directory is reused as is
export function ensureAccountDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export interface McpSyncResult {
  // Server names written into the account
  added: string[];
  // Server names the account already has with a different definition; left untouched
  kept: string[];
}

/** Whether `file` still has the content `before` (undefined: still missing); the compare step of a
 *  compare-then-rename, so a write the CLI made meanwhile is never overwritten. */
export function unchangedSince(file: string, before: string | undefined): boolean {
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  return now === before;
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const data: unknown = JSON.parse(stripBom(text));
    return isPlainObject(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merges the user-level MCP servers (mcpServers) of the default account's info file fromJson into <dir>/.claude.json:
 * names the account lacks are added, identical ones skipped, differing ones kept (reported in kept); nothing is ever removed.
 * A missing target file is created (0600) with only mcpServers; an existing one keeps every other key and its mode
 * and is replaced atomically (<real>.planswap-<pid>.tmp + rename, symlinks followed). Throws Error(t('mcp.badTarget'))
 * when the target is not a JSON object, Error(t('mcp.changed')) when it changed between read and rename (the CLI
 * rewrites it; the file is then left unchanged). No write when dir is the default dir (sameRealPath), the source has
 * no servers or nothing is added. beforeCommit runs between writing the temporary file and the change check (tests
 * simulate a concurrent CLI write).
 */
export function syncMcpServers(fromJson: string, dir: string, beforeCommit?: () => void): McpSyncResult {
  const result: McpSyncResult = { added: [], kept: [] };
  if (sameRealPath(dir, defaultDir())) return result;
  const source = readJsonObject(fromJson)?.mcpServers;
  if (!isPlainObject(source) || Object.keys(source).length === 0) return result;

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

  const current =isPlainObject(data.mcpServers) ? data.mcpServers : {};
  const merged: Record<string, unknown> = { ...current };
  for (const [name, def] of Object.entries(source)) {
    if (!Object.hasOwn(current, name)) {
      merged[name] = def;
      result.added.push(name);
    } else if (!isDeepStrictEqual(current[name], def)) {
      result.kept.push(name);
    }
  }
  if (result.added.length === 0) return result;

  data.mcpServers = merged;
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
  return result;
}

/**
 * Why dir must not be deleted (localized), or undefined when it may. Checked in order: a direct child of the home
 * directory (del.notHomeChild); basename matches DIR_BASENAME_RE (del.badName); not the default directory after
 * resolving links (del.isDefault); does not contain it (del.containsDefault); exists (del.missing); is not a link
 * (del.symlink); is a directory (del.notDir).
 */
export function checkSafeToDelete(dir: string): string | undefined {
  const home = path.resolve(os.homedir());
  const target = path.resolve(dir);
  // Only direct children of the home directory, so a symlinked parent cannot escape the home directory
  if (!samePath(path.dirname(target), home)) return t('del.notHomeChild', { dir: target });
  if (!DIR_BASENAME_RE.test(path.basename(target))) return t('del.badName', { pattern: '.claude-<name>', dir: target });
  const def = defaultDir();
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
  return undefined;
}

/** The only way to delete a Claude account directory: throws Error(reason) when checkSafeToDelete refuses; otherwise
 *  removes the links inside first (Windows, unlinkLinks) and then fs.promises.rm recursively, never a shell. rm does
 *  not follow links, so the default account's content behind a shared account's links survives. */
export async function deleteAccountDir(dir: string): Promise<void> {
  const reason = checkSafeToDelete(dir);
  if (reason) throw new Error(reason);
  unlinkLinks(path.resolve(dir));
  await fs.promises.rm(path.resolve(dir), { recursive: true, force: true });
}
