// PlanSwap-owned Codex provider cards. Native config.toml holds the plaintext DeepSeek key; no auth.json reads,
// runtime vscode import, network calls or provider credentials leave this module. Public status and edit snapshots
// are secret-free. Only the generated TOML subset is editable; unsupported manual changes are never overwritten.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { t } from '../i18n';
import { DEEPSEEK_CATALOG } from './deepseekCatalog';

export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export type DeepSeekModel = typeof DEEPSEEK_MODELS[number];
export const PROVIDER_FILES = ['.planswap-provider.json', 'config.toml', 'models.json'] as const;
export type ProviderErrorCode = 'marker' | 'unmanaged' | 'file' | 'format' | 'model' | 'key' | 'catalog' | 'changed' | 'exists' | 'write';
export class ProviderConfigError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(t(`codex.provider.error.${code}`));
    this.name = 'ProviderConfigError';
  }
}

export interface ProviderInfo {
  provider: 'deepseek';
  configured: boolean;
  model?: DeepSeekModel;
  error?: ProviderErrorCode;
}
interface Config {
  model: DeepSeekModel;
  key: string;
  approval_policy?: string;
  sandbox_mode?: string;
}
interface Snapshot {
  config: Config;
  source: string;
  revision: string;
}
const MARKER = JSON.stringify({ version: 1, provider: 'deepseek' }) + '\n';
const CONFIG_HEADER = '# PlanSwap DeepSeek API card. API key is stored in plaintext.\n';
const POLICY_VALUES = ['never', 'on-request', 'on-failure'];
const SANDBOX_VALUES = ['read-only', 'workspace-write', 'danger-full-access'];

function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ProviderConfigError('file');
  }
}

/** Presence, including malformed files and dangling links, reserves this directory for provider handling. */
export function hasProviderMarker(dir: string): boolean {
  try { return !!stat(path.join(dir, PROVIDER_FILES[0])); } catch { return true; }
}

function localText(dir: string, name: string): string {
  const file = path.join(dir, name);
  const root = stat(dir);
  const entry = stat(file);
  if (!root?.isDirectory() || root.isSymbolicLink() || !entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new ProviderConfigError('file');
  }
  try { return fs.readFileSync(file, 'utf8'); } catch { throw new ProviderConfigError('file'); }
}

function markerText(dir: string): string {
  const source = localText(dir, PROVIDER_FILES[0]);
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || record.provider !== 'deepseek' || Object.keys(record).length !== 2) throw new Error();
  } catch { throw new ProviderConfigError('marker'); }
  return source;
}

// Only top-level selection counts: an unused provider definition or profile must not reclassify a subscription.
// Skip multiline values without interpreting their contents as assignments; this is detection, not TOML editing.
function selectsDeepSeek(source: string): boolean {
  let depth = 0;
  let multiline: string | undefined;
  const advance = (text: string): void => {
    for (let i = 0; i < text.length;) {
      if (multiline) {
        if (multiline === '"""' && text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(multiline, i)) { i += 3; multiline = undefined; } else i++;
      } else if (text[i] === '#') return;
      else if (text.startsWith('"""', i) || text.startsWith("'''", i)) { multiline = text.slice(i, i + 3); i += 3; }
      else if (text[i] === '"') {
        const string = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i));
        i += string ? string[0].length : text.length;
      } else if (text[i] === "'") {
        const end = text.indexOf("'", i + 1);
        i = end < 0 ? text.length : end + 1;
      } else {
        if (text[i] === '[' || text[i] === '{') depth++;
        else if ((text[i] === ']' || text[i] === '}') && depth > 0) depth--;
        i++;
      }
    }
  };
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (depth || multiline) { advance(raw); continue; }
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) return false;
    const assignment = /^([^=]+)=(.*)$/.exec(line);
    if (!assignment) return false;
    const name = assignment[1].trim();
    if (name === 'model_provider' || name === '"model_provider"' || name === "'model_provider'") {
      return stringValue(assignment[2].trim()) === 'deepseek';
    }
    advance(assignment[2]);
  }
  return false;
}

// A selected unmarked DeepSeek config is preserved, without adopting it as a managed card or exposing its key.
export function preserveProviderConfig(dir: string): boolean {
  if (hasProviderMarker(dir)) return true;
  try {
    const file = path.join(dir, 'config.toml');
    if (!stat(file)?.isFile()) return false;
    const source = fs.readFileSync(file, 'utf8');
    return selectsDeepSeek(source);
  } catch { return true; }
}

/** Sharing may preserve missing/invalid config, but must stop before any writes for an invalid marker or linked
 * provider-owned file. Unmarked DeepSeek configs are preserved without adopting them. */
export function assertProviderFilesLocal(dir: string): void {
  if (!preserveProviderConfig(dir)) return;
  if (hasProviderMarker(dir)) markerText(dir);
  for (const name of PROVIDER_FILES) {
    const entry = stat(path.join(dir, name));
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) throw new ProviderConfigError('file');
  }
}

function model(value: string | undefined): DeepSeekModel {
  if (!(DEEPSEEK_MODELS as readonly string[]).includes(value ?? '')) throw new ProviderConfigError('model');
  return value as DeepSeekModel;
}

function key(value: string | undefined): string {
  if (!value || /\s|[\x00-\x1f\x7f]/u.test(value)) throw new ProviderConfigError('key');
  return value;
}

// Single-line basic/literal strings only. JSON basic strings form the subset this writer emits; unsupported TOML
// escapes or multi-line/dotted/inline forms cause a refusal, never an attempted repair.
function stringValue(text: string): string | undefined {
  const basic = /^("(?:[^"\\\x00-\x1f]|\\(?:["\\bfnrt]|u[\da-fA-F]{4}))*")\s*(?:#.*)?$/.exec(text);
  if (basic) {
    try { return JSON.parse(basic[1]) as string; } catch { return undefined; }
  }
  const literal = /^'([^'\x00-\x1f]*)'\s*(?:#.*)?$/.exec(text);
  return literal?.[1];
}

const ROOT_KEYS = new Set(['model', 'model_provider', 'preferred_auth_method', 'forced_login_method', 'model_reasoning_effort', 'web_search', 'model_catalog_json', 'approval_policy', 'sandbox_mode']);
const PROVIDER_KEYS = new Set(['name', 'base_url', 'wire_api', 'experimental_bearer_token']);
const ROUTING_KEYS = new Set(['profile', 'profiles', 'model_providers', 'forced_chatgpt_workspace_id', 'openai_base_url', 'sqlite_home']);

// A bounded key/header scanner: quoted project paths may contain dots, equals signs or closing brackets.
function keyPath(text: string): { segments: string[]; rest: string } | undefined {
  const segments: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    const token = /^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(rest)?.[0];
    if (!token) return undefined;
    const value = token.startsWith('"') || token.startsWith("'") ? stringValue(token) : token;
    if (value === undefined) return undefined;
    segments.push(value);
    rest = rest.slice(token.length).trimStart();
    if (!rest.startsWith('.')) return { segments, rest };
    rest = rest.slice(1).trimStart();
  }
}

interface ValueState { depth: number; multiline?: string }
function advanceValue(text: string, state: ValueState): void {
  for (let i = 0; i < text.length;) {
    if (state.multiline) {
      if (state.multiline === '"""' && text[i] === '\\') { i += 2; continue; }
      if (text.startsWith(state.multiline, i)) { i += 3; state.multiline = undefined; } else i++;
    } else if (text[i] === '#') return;
    else if (text.startsWith('"""', i) || text.startsWith("'''", i)) { state.multiline = text.slice(i, i + 3); i += 3; }
    else if (text[i] === '"') {
      const token = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i));
      if (!token) throw new ProviderConfigError('format');
      i += token[0].length;
    } else if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new ProviderConfigError('format');
      i = end + 1;
    } else {
      if (text[i] === '[' || text[i] === '{') state.depth++;
      else if (text[i] === ']' || text[i] === '}') {
        if (!state.depth) throw new ProviderConfigError('format');
        state.depth--;
      }
      i++;
    }
  }
}

// Operational reads validate routing fields but leave unrelated native tables to Codex. Editing additionally
// accepts only the generated fields and native project trust tables, so it cannot reinterpret arbitrary TOML.
function parseConfig(source: string, dir: string, requireKey = true, editable = false): Config {
  const root: Record<string, string> = {};
  const provider: Record<string, string> = {};
  const tables = new Set<string>();
  const assignments = new Set<string>();
  const valueState: ValueState = { depth: 0 };
  let section: string[] = [];
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (valueState.depth || valueState.multiline) { advanceValue(raw, valueState); continue; }
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const array = line.startsWith('[[');
      const header = keyPath(line.slice(array ? 2 : 1));
      if (!header || !(array ? /^\]\]\s*(?:#.*)?$/ : /^\]\s*(?:#.*)?$/).test(header.rest)) throw new ProviderConfigError('format');
      section = header.segments;
      const id = JSON.stringify(section);
      if (!array && tables.has(id)) throw new ProviderConfigError('format');
      tables.add(id);
      if (section[0] === 'model_providers') {
        if (array || section.length !== 2 || section[1] !== 'deepseek') throw new ProviderConfigError('format');
      } else if (ROUTING_KEYS.has(section[0]) || ROOT_KEYS.has(section[0])) throw new ProviderConfigError('format');
      else if (editable && (array || section.length !== 2 || section[0] !== 'projects')) throw new ProviderConfigError('format');
      continue;
    }
    const assignment = keyPath(line);
    if (!assignment?.rest.startsWith('=')) throw new ProviderConfigError('format');
    const name = assignment.segments[0];
    const text = assignment.rest.slice(1).trimStart();
    if (!text || text.startsWith('#')) throw new ProviderConfigError('format');
    const own = section.length === 0 ? ROOT_KEYS.has(name) : section[0] === 'model_providers';
    const id = JSON.stringify([...section, ...assignment.segments]);
    if (own || editable) {
      if (assignments.has(id)) throw new ProviderConfigError('format');
      assignments.add(id);
    }
    if (section.length === 0 && ROUTING_KEYS.has(name)) throw new ProviderConfigError('format');
    if (!own) {
      if (editable) {
        if (section[0] !== 'projects' || assignment.segments.length !== 1 || name !== 'trust_level'
          || !['trusted', 'untrusted'].includes(stringValue(text) ?? '')) throw new ProviderConfigError('format');
      } else advanceValue(text, valueState);
      continue;
    }
    const target = section.length ? provider : root;
    if (assignment.segments.length !== 1 || !(section.length ? PROVIDER_KEYS : ROOT_KEYS).has(name)) throw new ProviderConfigError('format');
    const value = stringValue(text);
    if (value === undefined) {
      if (!editable && section.length === 0 && (name === 'approval_policy' || name === 'sandbox_mode')) {
        advanceValue(text, valueState);
        continue;
      }
      throw new ProviderConfigError('format');
    }
    target[name] = value;
  }
  if (valueState.depth || valueState.multiline) throw new ProviderConfigError('format');
  const fixedRoot: Record<string, string> = {
    model_provider: 'deepseek', preferred_auth_method: 'apikey', forced_login_method: 'api',
    web_search: 'disabled', model_catalog_json: path.join(path.resolve(dir), 'models.json'),
  };
  const fixedProvider: Record<string, string> = { name: 'deepseek', base_url: 'https://api.deepseek.com/', wire_api: 'responses' };
  if (Object.entries(fixedRoot).some(([name, value]) => root[name] !== value)
    || Object.entries(fixedProvider).some(([name, value]) => provider[name] !== value)) throw new ProviderConfigError('format');
  if (editable && root.approval_policy !== undefined && !POLICY_VALUES.includes(root.approval_policy)) throw new ProviderConfigError('format');
  if (editable && root.sandbox_mode !== undefined && !SANDBOX_VALUES.includes(root.sandbox_mode)) throw new ProviderConfigError('format');
  const result: Config = { model: model(root.model), key: provider.experimental_bearer_token ?? '',
    approval_policy: root.approval_policy, sandbox_mode: root.sandbox_mode };
  const efforts: readonly { effort: string }[] = DEEPSEEK_CATALOG.models.find((entry) => entry.slug === result.model)!.supported_reasoning_levels;
  if (root.model_reasoning_effort !== undefined && !efforts.some((level) => level.effort === root.model_reasoning_effort)) throw new ProviderConfigError('format');
  if (requireKey) key(result.key);
  return result;
}

// Called only after editable-format validation. Replace two known scalar values in-place, preserving native
// project trust, reasoning effort (including absence), comments and line endings instead of regenerating the file.
function editConfigSource(source: string, selectedModel: DeepSeekModel, apiKey: string): string {
  let section: string[] = [];
  let keyWritten = false;
  const lines = source.split(/(?<=\n)/);
  const replace = (line: string, value: string): string => line.replace(
    /^(\s*(?:[A-Za-z_]+|"[A-Za-z_]+"|'[A-Za-z_]+')\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/,
    (_match, prefix: string) => prefix + JSON.stringify(value),
  );
  const result = lines.map((line) => {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    if (trimmed.startsWith('[')) {
      section = keyPath(trimmed.slice(1))!.segments;
      return line;
    }
    const assignment = keyPath(trimmed);
    if (!assignment?.rest.startsWith('=')) return line;
    if (section.length === 0 && assignment.segments[0] === 'model') return replace(line, selectedModel);
    if (section[0] === 'model_providers' && assignment.segments[0] === 'experimental_bearer_token') {
      keyWritten = true;
      return replace(line, apiKey);
    }
    return line;
  });
  if (!keyWritten) {
    const header = result.findIndex((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('[') && keyPath(trimmed.slice(1))?.segments.join('.') === 'model_providers.deepseek';
    });
    if (header < 0) throw new ProviderConfigError('format');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    if (!result[header].endsWith('\n')) result[header] += newline;
    result.splice(header + 1, 0, `experimental_bearer_token = ${JSON.stringify(apiKey)}${newline}`);
  }
  return result.join('');
}

function renderConfig(dir: string, config: Config): string {
  const fields: Record<string, string> = {
    model: config.model, model_provider: 'deepseek', preferred_auth_method: 'apikey', forced_login_method: 'api',
    model_reasoning_effort: 'high', web_search: 'disabled', model_catalog_json: path.join(path.resolve(dir), 'models.json'),
  };
  if (config.approval_policy !== undefined) fields.approval_policy = config.approval_policy;
  if (config.sandbox_mode !== undefined) fields.sandbox_mode = config.sandbox_mode;
  const lines = Object.entries(fields).map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
  lines.push('', '[model_providers.deepseek]', 'name = "deepseek"', 'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"', `experimental_bearer_token = ${JSON.stringify(config.key)}`);
  return CONFIG_HEADER + lines.join('\n') + '\n';
}

function catalogText(dir: string): string {
  let source: string;
  try { source = localText(dir, 'models.json'); } catch { throw new ProviderConfigError('catalog'); }
  try {
    // Only the bundled schema is supported in this first version; custom metadata is left untouched for manual use.
    const value: unknown = JSON.parse(source);
    if (JSON.stringify(value) !== JSON.stringify(DEEPSEEK_CATALOG)) throw new Error();
  } catch { throw new ProviderConfigError('catalog'); }
  return source;
}

function snapshot(dir: string, requireKey = true, editable = false): Snapshot {
  if (!hasProviderMarker(dir)) throw new ProviderConfigError('unmanaged');
  const marker = markerText(dir);
  const source = localText(dir, 'config.toml');
  const config = parseConfig(source, dir, requireKey, editable);
  const catalog = catalogText(dir);
  return { config, source, revision: createHash('sha256').update(JSON.stringify([marker, source, catalog])).digest('hex') };
}

/** Secret-free status. Invalid/unmanaged provider cards must never fall back to subscription credential reads. */
export function readProviderInfo(dir: string): ProviderInfo | undefined {
  if (!preserveProviderConfig(dir)) return undefined;
  try {
    const { config } = snapshot(dir, false);
    return { provider: 'deepseek', model: config.model, configured: !!config.key && !/\s|[\x00-\x1f\x7f]/u.test(config.key),
      error: !config.key || /\s|[\x00-\x1f\x7f]/u.test(config.key) ? 'key' : undefined };
  } catch (error) {
    return { provider: 'deepseek', configured: false, error: error instanceof ProviderConfigError ? error.code : 'file' };
  }
}

/** Local configuration validation only; no authentication request or client startup. */
export function validateProviderConfig(dir: string): void { snapshot(dir); }

function seed(defaultDir: string): { values: Pick<Config, 'approval_policy' | 'sandbox_mode'>; skipped: string[] } {
  const values: Pick<Config, 'approval_policy' | 'sandbox_mode'> = {};
  const skipped: string[] = [];
  let source: string;
  try { source = fs.readFileSync(path.join(defaultDir, 'config.toml'), 'utf8'); } catch (error) {
    return { values, skipped: (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['config.toml'] };
  }
  const seen = new Set<string>();
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const match = /^(\w+)\s*=\s*(.*)$/.exec(line);
    if (!match) return { values: {}, skipped: ['config.toml'] };
    const [, name, text] = match;
    const value = stringValue(text);
    // Do not mistake assignments inside an unsupported multi-line value for top-level settings.
    if (value === undefined && !/^(?:true|false|[+-]?\d+(?:\.\d+)?)\s*(?:#.*)?$/.test(text)) return { values: {}, skipped: ['config.toml'] };
    if (name !== 'approval_policy' && name !== 'sandbox_mode') continue;
    if (seen.has(name)) return { values: {}, skipped: ['config.toml'] };
    seen.add(name);
    const allowed = name === 'approval_policy' ? POLICY_VALUES : SANDBOX_VALUES;
    if (value !== undefined && allowed.includes(value)) values[name] = value;
    else skipped.push(name);
  }
  return { values, skipped };
}

/** Host creates a NEW account directory first. All provider files are exclusive writes; auth.json is untouched.
 * The marker is written first so an interrupted creation cannot later inherit the default provider config. */
export function createDeepSeekConfig(dir: string, selectedModel: string, apiKey: string, defaultDir: string): { skipped: string[] } {
  const root = stat(dir);
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new ProviderConfigError('file');
  const realDir = fs.realpathSync(dir);
  let realDefault = path.resolve(defaultDir);
  try { realDefault = fs.realpathSync(defaultDir); } catch { /* default home may not exist yet */ }
  const relative = path.relative(realDir, realDefault);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new ProviderConfigError('file');
  }
  if (PROVIDER_FILES.some((name) => stat(path.join(dir, name)))) throw new ProviderConfigError('exists');
  const copied = seed(defaultDir);
  const config = renderConfig(dir, { ...copied.values, model: model(selectedModel), key: key(apiKey) });
  parseConfig(config, dir);
  try {
    fs.writeFileSync(path.join(dir, PROVIDER_FILES[0]), MARKER, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'config.toml'), config, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(DEEPSEEK_CATALOG, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch { throw new ProviderConfigError('write'); }
  return { skipped: copied.skipped };
}

/** Capture before prompts. The revision covers config, marker and catalog but contains no raw key. */
export function readDeepSeekEditState(dir: string): { model: DeepSeekModel; revision: string } {
  const state = snapshot(dir, false, true);
  return { model: state.config.model, revision: state.revision };
}

/** Empty replacement preserves the current key. Unsupported edits and competing PlanSwap edits are refused. */
export function editDeepSeekConfig(dir: string, selectedModel: string, replacementKey: string, revision: string): void {
  // Establish that the root and owned files are local before creating the per-card edit lock.
  snapshot(dir, false, true);
  const lock = path.join(dir, '.planswap-provider.lock');
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { throw new ProviderConfigError('changed'); }
  let temporary: string | undefined;
  try {
    const current = snapshot(dir, false, true);
    if (current.revision !== revision) throw new ProviderConfigError('changed');
    const nextModel = model(selectedModel);
    const nextKey = key(replacementKey || current.config.key);
    const config = editConfigSource(current.source, nextModel, nextKey);
    const edited = parseConfig(config, dir, true, true);
    // Accepted TOML spellings may be outside the narrow scalar replacement syntax. Never report a successful
    // edit unless the re-parsed values match both requested changes.
    if (edited.model !== nextModel || edited.key !== nextKey) throw new ProviderConfigError('format');
    temporary = path.join(dir, `.planswap-provider-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, config, { mode: 0o600, flag: 'wx' });
    if (snapshot(dir, false, true).revision !== revision) throw new ProviderConfigError('changed');
    fs.renameSync(temporary, path.join(dir, 'config.toml'));
    temporary = undefined;
  } catch (error) {
    if (error instanceof ProviderConfigError) throw error;
    throw new ProviderConfigError('write');
  } finally {
    if (temporary) try { fs.unlinkSync(temporary); } catch { /* failed write may not have created it */ }
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
