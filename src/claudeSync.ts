// Syncing a shared Claude account with the default account: the MCP servers and project keys of the two .claude.json
// info files and the MCP sign-ins of the two .credentials.json files, merged three-way against the account's
// .planswap-sync.json (item hashes only, never values). This is the one place that reads or writes a credentials
// file (AGENTS.md, Claude credentials): both files are parsed in memory, only the mcpOAuth / mcpOAuthClientConfig
// entries are merged, every other key is written back unchanged under Claude Code's storage lock, and nothing of
// them is logged, kept or passed on. No vscode import; the design is in docs/design.md 6.7.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { t } from './i18n';
import { accountInfoTarget, assertNotDefaultClaudeAncestor, claudeJsonName, defaultDir, isDefaultClaudeDir, realPath, unchangedSince, withConfigLock } from './paths';
import { renameReplacing, stripBom, isPlainObject, withLockDir } from './platform';
import { lstatOrUndefined } from './shareLinks';

// Per-project keys of .claude.json synced between shared accounts, besides the project's MCP servers (one item per
// server) and its .mcp.json enable / disable lists (one item for the pair: they express opposing states)
const PROJECT_KEYS = [
  'allowedTools', 'mcpContextUris', 'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown',
];

// Per-project keys whose lack only makes Claude Code ask once more (trust, external CLAUDE.md includes)
const PROMPT_KEYS = ['hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown'];

// Item name of a project's enabledMcpjsonServers + disabledMcpjsonServers pair
const MCPJSON_PAIR = 'mcpjsonServers';

// Keys of .credentials.json holding the MCP sign-ins (one item per server); the Claude sign-in is never touched
const MCP_AUTH_KEYS = ['mcpOAuth', 'mcpOAuthClientConfig'];

// Per-account file of the last synced state: a SHA-256 hash per item, never a value
const SYNC_BASE = '.planswap-sync.json';

// Top-level onboarding keys of .claude.json added from the default account when a signed-in account lacks them, so the
// CLI does not run its first-start onboarding again; never for a signed-out account, whose onboarding is its sign-in
const ONBOARDING_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion'];

// A JSON file read for a sync: its real path, the text the commit compares against (undefined: missing), the parsed
// object (missing = empty) and the mode a rewrite keeps
interface SyncFile { file: string; real: string; before: string | undefined; data: Record<string, unknown>; mode: number }

// Parses a sync file's text; a file that is not a JSON object throws error
function parseSyncFile(text: string | undefined, error: string): Record<string, unknown> {
  if (text === undefined) return {};
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    data = undefined;
  }
  if (!isPlainObject(data)) throw new Error(error);
  return data;
}

// The default account's info file; a dangling link is refused, since the write would replace it by a plain file
function readDefaultInfo(file: string): SyncFile {
  const exists = fs.existsSync(file);
  if (!exists && lstatOrUndefined(file)) throw new Error(t('mcp.unsafeTarget', { file }));
  const real = exists ? realPath(file) : file;
  const before = exists ? fs.readFileSync(real, 'utf8') : undefined;
  return { file, real, before, data: parseSyncFile(before, t('share.badSource', { file })), mode: exists ? fs.statSync(real).mode & 0o777 : 0o600 };
}

// A .credentials.json for its MCP sign-ins; undefined when missing (a signed-out account, which must not gain one).
// Claude Code refuses a linked credentials file, so only a plain file with a single link is accepted
function readCredentials(dir: string): SyncFile | undefined {
  const file = path.join(path.resolve(dir), '.credentials.json');
  const st = lstatOrUndefined(file);
  if (!st) return undefined;
  if (!st.isFile() || st.nlink > 1) throw new Error(t('mcp.unsafeTarget', { file }));
  const before = fs.readFileSync(file, 'utf8');
  return { file, real: file, before, data: parseSyncFile(before, t('mcp.badTarget', { file })), mode: st.mode & 0o777 };
}

type Items = Map<string, unknown>;

// Claude Code reads a missing project key as false / empty (research fact 18), so those values count as absent
function projectValue(value: unknown): unknown {
  return value === false || (Array.isArray(value) && value.length === 0) ? undefined : value;
}

// The synced items of an info file, keyed by the JSON of their path: ['mcpServers', name], ['projects', path,
// 'mcpServers', name], ['projects', path, MCPJSON_PAIR] and ['projects', path, key] for PROJECT_KEYS
function infoItems(data: Record<string, unknown>): Items {
  const items: Items = new Map();
  const put = (keyPath: string[], value: unknown): void => {
    if (value !== undefined) items.set(JSON.stringify(keyPath), value);
  };
  if (isPlainObject(data.mcpServers)) for (const [name, value] of Object.entries(data.mcpServers)) put(['mcpServers', name], value);
  if (!isPlainObject(data.projects)) return items;
  for (const [p, proj] of Object.entries(data.projects)) {
    if (!isPlainObject(proj)) continue;
    if (isPlainObject(proj.mcpServers)) for (const [name, value] of Object.entries(proj.mcpServers)) put(['projects', p, 'mcpServers', name], value);
    for (const k of PROJECT_KEYS) put(['projects', p, k], projectValue(proj[k]));
    const enabled = projectValue(proj.enabledMcpjsonServers);
    const disabled = projectValue(proj.disabledMcpjsonServers);
    if (enabled !== undefined || disabled !== undefined) put(['projects', p, MCPJSON_PAIR], { enabled: enabled ?? [], disabled: disabled ?? [] });
  }
  return items;
}

// The MCP sign-ins of a credentials file: [key, server key] for MCP_AUTH_KEYS
function credentialItems(data: Record<string, unknown>): Items {
  const items: Items = new Map();
  for (const k of MCP_AUTH_KEYS) {
    const entries = data[k];
    if (isPlainObject(entries)) for (const [name, value] of Object.entries(entries)) items.set(JSON.stringify([k, name]), value);
  }
  return items;
}

// Sets (value) or removes (undefined) a member of the object data[key], creating the object only for a value
function setMember(data: Record<string, unknown>, key: string, name: string, value: unknown): void {
  if (!isPlainObject(data[key])) {
    if (value === undefined) return;
    data[key] = {};
  }
  const members = data[key] as Record<string, unknown>;
  if (value === undefined) delete members[name];
  else members[name] = value;
}

// Writes one item into a parsed info or credentials file; an absent project key gets Claude Code's own default
function setItem(data: Record<string, unknown>, key: string, value: unknown): void {
  const [top, p, k, name] = JSON.parse(key) as string[];
  if (top !== 'projects') {
    setMember(data, top, p, value);
    return;
  }
  if (!isPlainObject(data.projects)) {
    if (value === undefined) return;
    data.projects = {};
  }
  const projects = data.projects as Record<string, unknown>;
  if (!isPlainObject(projects[p])) {
    if (value === undefined) return;
    projects[p] = {};
  }
  const proj = projects[p] as Record<string, unknown>;
  if (k === 'mcpServers') setMember(proj, 'mcpServers', name, value);
  else if (k === MCPJSON_PAIR) {
    const pair = value as { enabled: unknown[]; disabled: unknown[] } | undefined;
    proj.enabledMcpjsonServers = pair?.enabled ?? [];
    proj.disabledMcpjsonServers = pair?.disabled ?? [];
  } else proj[k] = value ?? (PROMPT_KEYS.includes(k) ? false : []);
}

// JSON with sorted object keys, so equal values hash equally whatever their key order
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function hashOf(value: unknown): string | undefined {
  return value === undefined ? undefined : createHash('sha256').update(canonical(value)).digest('hex');
}

/** Three-way merge of one item: d (default account), y (account) and base (hash of the last synced value, undefined
 *  when unknown). Only one side changed since the base → that side's value (a removal included); both changed → the
 *  account's. Unknown base → nothing is removed: the side that has the item wins, two arrays are united and other
 *  differing values take the side in use since (inUse: the account; otherwise the default, whose copy an account
 *  not in use cannot be newer than). */
export function mergeItem(d: unknown, y: unknown, base: string | undefined, inUse = false): unknown {
  const hd = hashOf(d);
  const hy = hashOf(y);
  if (hd === hy) return d;
  if (base === undefined) {
    if (y === undefined) return d;
    if (d === undefined) return y;
    if (Array.isArray(d) && Array.isArray(y)) return [...y, ...d.filter((v) => !y.some((w) => isDeepStrictEqual(v, w)))];
    return inUse ? y : d;
  }
  return hy === base ? d : y;
}

// The notification group of an item: 'mcpServers', 'projects:<path>' or 'mcpOAuth:<server key>'
function groupOf(key: string): string {
  const [top, name] = JSON.parse(key) as string[];
  if (top === 'mcpServers') return top;
  if (top === 'projects') return `projects:${name}`;
  return `mcpOAuth:${name}`;
}

// What a base belongs to: the default dir, and the info files by the hash of their firstStartTime (null when absent),
// which Claude Code writes at a start that finds it missing (research fact 20), so a deleted and recreated info file
// (whose missing items are no removals) is told apart; a file that had none at the last sync may have gained one since
interface BaseOrigin { defaultDir: string; starts: [string | null, string | null] }

// The last synced item hashes of an account, keeping only those that still apply to origin: none for another default
// dir, none of the info file items after either info file was recreated; unreadable or invalid = all unknown
function readBase(dir: string, origin: BaseOrigin): { items: Map<string, string>; stale: boolean } {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, SYNC_BASE), 'utf8'));
  } catch {
    return { items: new Map(), stale: false };
  }
  const stored = isPlainObject(data) && isPlainObject(data.items) ? data.items : {};
  const items = new Map(Object.entries(stored).filter((e): e is [string, string] => typeof e[1] === 'string'));
  if (!isPlainObject(data) || data.defaultDir !== origin.defaultDir) return { items: new Map(), stale: true };
  const starts: unknown[] = Array.isArray(data.starts) ? data.starts : [];
  if (origin.starts.some((start, i) => starts[i] !== null && starts[i] !== start)) {
    for (const key of items.keys()) if (!MCP_AUTH_KEYS.includes((JSON.parse(key) as string[])[0])) items.delete(key);
    return { items, stale: true };
  }
  return { items, stale: false };
}

/** Forgets the last synced state of an account dir, when it stops or starts being shared: what changed meanwhile on
 *  either side is no removal. */
export function removeSyncBase(dir: string): void {
  fs.rmSync(path.join(path.resolve(dir), SYNC_BASE), { force: true });
}

// Writes a JSON file through a temporary file and a rename, refusing when it changed since it was read (or when
// valid() fails before a rename attempt); beforeCommit runs between the two (tests simulate a concurrent CLI write)
function commitJson(target: SyncFile, text: string, beforeCommit?: () => void, valid: () => boolean = () => true): void {
  const tmp = `${target.real}.planswap-${process.pid}.tmp`;
  // A temporary file left by an interrupted run is replaced
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, text, { mode: target.mode, flag: 'wx' });
    beforeCommit?.();
    if (!renameReplacing(tmp, target.real, undefined, undefined, () => valid() && unchangedSince(target.real, target.before))) {
      throw new Error(t('mcp.changed', { file: target.real }));
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Claude Code serializes its credential writes with a lock folder <config dir>/.storage-write.lock (proper-lockfile,
// stale after 15 s; research fact 19). The commit of a credentials file holds the same lock, so a token refresh
// cannot land between its compare and rename; a lock held longer than about a second throws t('mcp.changed')
function withStorageLock(target: SyncFile, commit: () => void): void {
  withLockDir(path.join(path.dirname(target.real), '.storage-write.lock'), 15_000, () => new Error(t('mcp.changed', { file: target.real })), commit);
}

export type SyncMode = 'full' | 'pull' | 'check' | 'fill';

export interface SyncOptions {
  groups?: readonly string[];  // limits what is written into the account (and listed) to these groups; [] → no-op without reading
  inUse?: boolean;             // the account, not the default, has been in use since the last sync (the current account): an item without a recorded hash that differs on both sides takes its value instead of the default's
  beforeCommit?: () => void;   // runs between writing each temporary file and the change check (tests simulate a concurrent CLI write)
}

export interface SyncResult {
  changed: string[];         // groups of the account that change (check: would change): 'mcpServers', 'projects:<path>', 'mcpOAuth:<server key>', onboarding keys
  defaultChanged?: string[]; // full: groups changed in the default account
  quiet?: string[];          // check: changed groups that only differ in PROMPT_KEYS, or only in sign-ins the account already has (token refreshes)
  added?: string[];          // fill: names of the user-level MCP servers added to the account
  baseError?: string;        // fill: the base write failed after the servers in added were written (not thrown)
}

/**
 * Syncs a shared account dir with the default account: the MCP servers and PROJECT_KEYS of the info files (fromJson =
 * the default's, <dir>/.claude.json) and the MCP sign-ins (MCP_AUTH_KEYS) of both .credentials.json files. Each item
 * (a server, a project key, a sign-in) is merged three-way (mergeItem) against <dir>/SYNC_BASE, the item hashes of the
 * last sync, so a change made on either side since then survives, a removal included; both sides changed → the account
 * wins; no hash yet → nothing is removed and a value differing on both sides takes the side in use (options.inUse).
 * The base applies only to the same default dir and, for the info file items, to the same info files (BaseOrigin).
 * A sign-in removed on one side is not removed on the other: a new Claude sign-in writes a fresh credentials file
 * without them, which is no removal. Sign-ins are synced only when both credentials files exist; the Claude sign-in and
 * every other key stay. On macOS Claude Code keeps the MCP sign-ins in the Keychain and writes a credentials file only
 * when the Keychain write fails, so normally only the info file items sync there.
 * ONBOARDING_KEYS are added to a signed-in account lacking them. Modes:
 * - full (switching to or away from the account, adding or converting it): writes the merge into both accounts and
 *   records the new base;
 * - pull (Repair): writes into the account only what it lacks of the default (the changes a full sync would make
 *   there), limited to options.groups; the default stays as it is;
 * - check: read only; lists what pull would change, with the quiet groups;
 * - fill (the background link check): add only. Adds to the account each user-level MCP server (mcpServers) that the
 *   default account has, the account lacks and the base has no recorded hash for, so mergeItem gives it to the
 *   account; records its hash. A server with a recorded hash that the account lacks was removed from the account
 *   since that sync (or removed there and changed in the default, where the account wins), so it is not re-added;
 *   the next full sync carries the removal to the default as usual. Never removes or changes a server the account
 *   has, never touches project servers, project keys, onboarding keys or credentials (not even read), never writes
 *   the default account; options.inUse is ignored, and so are options.groups except []. result.added names the servers
 *   added; a base write failing after they were written is returned as result.baseError instead of thrown (unrecorded
 *   hashes only make the next sync treat the servers as present on both sides).
 * Writes replace atomically, keep the mode, follow an info file's symlink (validated like accountInfoTarget) and refuse
 * with t('mcp.changed') a file changed since it was read; credentials commits hold Claude Code's storage lock, info
 * file commits its config lock (withConfigLock). A missing account info file is created 0600; a credentials file is
 * never created. Order: default info, default credentials, account info, account credentials, base, so an interrupted
 * sync converges on the next one. Errors:
 * t('share.badSource') (default info not a JSON object), t('mcp.badTarget'), t('mcp.unsafeTarget') (before any
 * account info content is read, check mode included). The default dir, or groups = [], → no-op without reading.
 */
export function syncClaudeAccount(fromJson: string, dir: string, mode: SyncMode = 'full', { groups, inUse = false, beforeCommit }: SyncOptions = {}): SyncResult {
  const result: SyncResult = { changed: [] };
  if (groups?.length === 0 || isDefaultClaudeDir(dir)) return result;
  assertNotDefaultClaudeAncestor(dir);
  const selected = (group: string): boolean => !groups || groups.includes(group);
  const infoFile = path.join(path.resolve(dir), claudeJsonName());
  const target = accountInfoTarget(infoFile, dir, fromJson);
  const accountBefore = fs.existsSync(infoFile) ? fs.readFileSync(target.real, 'utf8') : undefined;
  const account: SyncFile = { file: infoFile, real: target.real, before: accountBefore, data: parseSyncFile(accountBefore, t('mcp.badTarget', { file: target.real })), mode: target.mode };
  const def = readDefaultInfo(fromJson);
  const defCred = mode === 'fill' ? undefined : readCredentials(defaultDir());
  const accCred = defCred && readCredentials(dir);
  const startOf = (data: Record<string, unknown>): string | null => hashOf(data.firstStartTime) ?? null;
  const origin: BaseOrigin = { defaultDir: realPath(defaultDir()), starts: [startOf(def.data), startOf(account.data)] };
  const { items: base, stale } = readBase(dir, origin);

  // Every item key of both sides and the base, merged; credentials only when both files exist
  const sources: Array<{ d: SyncFile; y: SyncFile; dItems: Items; yItems: Items; credentials: boolean }> = [
    { d: def, y: account, dItems: infoItems(def.data), yItems: infoItems(account.data), credentials: false },
  ];
  if (defCred && accCred) sources.push({ d: defCred, y: accCred, dItems: credentialItems(defCred.data), yItems: credentialItems(accCred.data), credentials: true });
  const newBase = new Map(base);
  const changed = new Set<string>();
  const defaultChanged = new Set<string>();
  const loud = new Set<string>();
  const dirty = new Set<SyncFile>();
  if (mode === 'fill') {
    const added: string[] = [];
    const yItems = infoItems(account.data);
    for (const [key, dv] of infoItems(def.data)) {
      const [top, name] = JSON.parse(key) as string[];
      if (top !== 'mcpServers' || yItems.has(key) || mergeItem(dv, undefined, base.get(key)) === undefined) continue;
      setItem(account.data, key, dv);
      dirty.add(account);
      newBase.set(key, hashOf(dv)!);
      added.push(name);
    }
    result.added = added;
    if (added.length) changed.add('mcpServers');
  }
  for (const { d, y, dItems, yItems, credentials } of mode === 'fill' ? [] : sources) {
    const isCredential = (key: string): boolean => MCP_AUTH_KEYS.includes((JSON.parse(key) as string[])[0]);
    const keys = new Set([...dItems.keys(), ...yItems.keys(), ...[...base.keys()].filter((key) => isCredential(key) === credentials)]);
    for (const key of keys) {
      const dv = dItems.get(key);
      const yv = yItems.get(key);
      // A sign-in missing on one side is kept from the other (the file may have been rewritten by a new sign-in)
      const merged = mergeItem(dv, yv, base.get(key), inUse) ?? (credentials ? yv ?? dv : undefined);
      const group = groupOf(key);
      const intoAccount = hashOf(merged) !== hashOf(yv);
      if (intoAccount && selected(group)) {
        changed.add(group);
        const [, , k] = JSON.parse(key) as string[];
        if (credentials ? yv === undefined : !PROMPT_KEYS.includes(k)) loud.add(group);
        if (mode !== 'check') {
          setItem(y.data, key, merged);
          dirty.add(y);
        }
      }
      if (mode === 'full' && hashOf(merged) !== hashOf(dv)) {
        defaultChanged.add(group);
        setItem(d.data, key, merged);
        dirty.add(d);
      }
      // Pull leaves the base unknown where the default still differs from what the account now has
      if (mode === 'full' || (mode === 'pull' && intoAccount && selected(group))) {
        const settled = mode === 'full' || hashOf(merged) === hashOf(dv);
        if (merged !== undefined && settled) newBase.set(key, hashOf(merged)!);
        else newBase.delete(key);
      }
    }
  }

  // Signed in as readAccountInfo decides it: an email in the file, or only the existence of the credentials file
  const oauth = account.data.oauthAccount;
  const signedIn = (isPlainObject(oauth) && typeof oauth.emailAddress === 'string' && oauth.emailAddress !== '')
    || fs.existsSync(path.join(path.resolve(dir), '.credentials.json'));
  if (signedIn && mode !== 'fill') {
    for (const k of ONBOARDING_KEYS) {
      if (!selected(k) || !Object.hasOwn(def.data, k) || Object.hasOwn(account.data, k)) continue;
      changed.add(k);
      loud.add(k);
      if (mode !== 'check') {
        account.data[k] = def.data[k];
        dirty.add(account);
      }
    }
  }
  result.changed = [...changed];
  if (mode === 'check') {
    result.quiet = result.changed.filter((group) => !loud.has(group));
    return result;
  }
  if (mode === 'full') result.defaultChanged = [...defaultChanged];

  const write = (file: SyncFile, text: string, valid?: () => boolean): void => {
    if (!dirty.has(file)) return;
    if (file === defCred || file === accCred) withStorageLock(file, () => commitJson(file, text, beforeCommit, valid));
    else withConfigLock(file.file, file.real, () => commitJson(file, text, beforeCommit, valid));
  };
  write(def, JSON.stringify(def.data, null, 2) + '\n');
  if (defCred) write(defCred, JSON.stringify(defCred.data));
  write(account, JSON.stringify(account.data, null, 2) + '\n', () => target.validate());
  if (accCred) write(accCred, JSON.stringify(accCred.data));
  if (stale || !isDeepStrictEqual(newBase, base)) {
    const baseFile = path.join(path.resolve(dir), SYNC_BASE);
    const tmp = `${baseFile}.planswap-${process.pid}.tmp`;
    try {
      fs.rmSync(tmp, { force: true });
      try {
        fs.writeFileSync(tmp, JSON.stringify({ ...origin, items: Object.fromEntries(newBase) }) + '\n', { mode: 0o600, flag: 'wx' });
        renameReplacing(tmp, baseFile);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    } catch (err) {
      // fill: the servers are in the account already, so the caller still names them
      if (mode !== 'fill' || !dirty.has(account)) throw err;
      result.baseError = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}
