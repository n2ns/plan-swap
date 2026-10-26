// PlanSwap-owned Codex API cards (DeepSeek, the other presets of API_SERVICES and custom Responses endpoints). Native
// config.toml holds the plaintext key; no auth.json reads,
// runtime vscode import or network calls (the model list is providerModels.ts); a saved key leaves this module only
// through readProviderKey, for that request. Public status and edit snapshots
// are secret-free. Editing replaces only the model and key values in place; unrelated native settings are kept as
// they are, and owned fields in unsupported forms are reported, never overwritten.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { t } from '../i18n';
import { DEEPSEEK_CATALOG } from './deepseekCatalog';

export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export type DeepSeekModel = typeof DEEPSEEK_MODELS[number];
/**
 * API services an API card can use. DeepSeek keeps its own provider table, fixed endpoint and bundled model catalog
 * (format of 0.5.0). Every other service writes one `planswap` provider with an editable Responses endpoint
 * (baseUrl prefilled for the presets, entered for custom) and no model catalog, so Codex uses its fallback model
 * metadata; keyRequired false lets local servers and gateways run without a key.
 */
// In the order the add form lists them: alphabetical by name, the custom endpoint last
export const API_SERVICES = ['deepseek', 'kimi', 'lmstudio', 'ollama', 'openrouter', 'xai', 'zai', 'custom'] as const;
export type ApiService = typeof API_SERVICES[number];
// publicModels: the service lists its models without a key, so modelCache.ts refreshes it in the background
export const SERVICE_INFO: Record<ApiService, { name: string; baseUrl?: string; keyRequired: boolean; publicModels?: boolean }> = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/', keyRequired: true },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, publicModels: true },
  zai: { name: 'Z.ai', baseUrl: 'https://api.z.ai/api/v1', keyRequired: true },
  kimi: { name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', keyRequired: true },
  xai: { name: 'xAI', baseUrl: 'https://api.x.ai/v1', keyRequired: true },
  ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyRequired: false, publicModels: true },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyRequired: false, publicModels: true },
  custom: { name: 'Custom', keyRequired: false },
};
// The provider table id of every non-DeepSeek card; Codex reserves openai, ollama and lmstudio
const GENERIC_PROVIDER = 'planswap';
export const PROVIDER_FILES = ['.planswap-provider.json', 'config.toml', 'models.json'] as const;
export type ProviderErrorCode = 'marker' | 'unmanaged' | 'file' | 'format' | 'model' | 'key' | 'url' | 'catalog' | 'changed' | 'exists' | 'write';
export class ProviderConfigError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(t(`codex.provider.error.${code}`));
    this.name = 'ProviderConfigError';
  }
}

export interface ProviderInfo {
  provider: ApiService;
  configured: boolean;
  model?: string;
  // Endpoint of a non-DeepSeek card (no secret: credentials, query and fragment are refused) and its host
  baseUrl?: string;
  host?: string;
  // Whether a key is saved; the key itself never leaves this module except through readProviderKey
  hasKey?: boolean;
  error?: ProviderErrorCode;
}
interface Config {
  service: ApiService;
  model: string;
  key: string;
  baseUrl: string;
  approval_policy?: string;
  sandbox_mode?: string;
}
interface Snapshot {
  config: Config;
  source: string;
  revision: string;
}
const markerFor = (service: ApiService): string => JSON.stringify({ version: 1, provider: service }) + '\n';
const CONFIG_HEADER = '# PlanSwap API card. API key is stored in plaintext.\n';
const DEEPSEEK_HEADER = '# PlanSwap DeepSeek API card. API key is stored in plaintext.\n';
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

function markerText(dir: string): { source: string; service: ApiService } {
  const source = localText(dir, PROVIDER_FILES[0]);
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !(API_SERVICES as readonly unknown[]).includes(record.provider) || Object.keys(record).length !== 2) throw new Error();
    return { source, service: record.provider as ApiService };
  } catch { throw new ProviderConfigError('marker'); }
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

function model(service: ApiService, value: string | undefined): string {
  if (service === 'deepseek') {
    if (!(DEEPSEEK_MODELS as readonly string[]).includes(value ?? '')) throw new ProviderConfigError('model');
  } else if (!value || value.length > 200 || /\s|[\x00-\x1f\x7f]/u.test(value)) throw new ProviderConfigError('model');
  return value!;
}

/** An https endpoint, or http on this machine only (local servers), without credentials, query or fragment; the key
 *  is sent to it, so a plain-http remote host or a userinfo part is refused. */
export function checkBaseUrl(value: string | undefined): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new ProviderConfigError('url'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // The raw text too: an empty query or fragment ("…/v1?") parses to empty search/hash but would still be written
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || /[?#\s\x00-\x1f\x7f]/u.test(value!)) {
    throw new ProviderConfigError('url');
  }
  return value!;
}

function key(value: string | undefined): string {
  if (!value || /\s|[\x00-\x1f\x7f]/u.test(value)) throw new ProviderConfigError('key');
  return value;
}

// A required key must be valid; an optional one (local servers, gateways) may be empty
function serviceKey(service: ApiService, value: string): string {
  return value || SERVICE_INFO[service].keyRequired ? key(value) : '';
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

// Reads validate routing fields but leave unrelated native settings (complete values, including the tables Codex
// writes itself) to Codex. Editing additionally requires the owned fields in the plain forms it can replace in place.
function parseConfig(source: string, dir: string, service: ApiService, requireKey = true, editable = false): Config {
  const providerId = service === 'deepseek' ? 'deepseek' : GENERIC_PROVIDER;
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
        if (array || section.length !== 2 || section[1] !== providerId) throw new ProviderConfigError('format');
      } else if (ROUTING_KEYS.has(section[0]) || ROOT_KEYS.has(section[0])) throw new ProviderConfigError('format');
      continue;
    }
    const assignment = keyPath(line);
    if (!assignment?.rest.startsWith('=')) throw new ProviderConfigError('format');
    const name = assignment.segments[0];
    const text = assignment.rest.slice(1).trimStart();
    if (!text || text.startsWith('#')) throw new ProviderConfigError('format');
    const own = section.length === 0 ? ROOT_KEYS.has(name) : section[0] === 'model_providers';
    const id = JSON.stringify([...section, ...assignment.segments]);
    if (own) {
      if (assignments.has(id)) throw new ProviderConfigError('format');
      assignments.add(id);
    }
    if (section.length === 0 && ROUTING_KEYS.has(name)) throw new ProviderConfigError('format');
    if (!own) {
      advanceValue(text, valueState);
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
  // DeepSeek: fixed endpoint and the card's own catalog. Others: the card's endpoint and no catalog (Codex falls back
  // to its default model metadata); the provider name is the label Codex shows and stays free text
  const deepseek = service === 'deepseek';
  const fixedRoot: Record<string, string | undefined> = {
    model_provider: providerId, forced_login_method: 'api', web_search: 'disabled',
    model_catalog_json: deepseek ? path.join(path.resolve(dir), 'models.json') : undefined,
  };
  const fixedProvider: Record<string, string> = deepseek ? { name: 'deepseek', base_url: 'https://api.deepseek.com/', wire_api: 'responses' } : { wire_api: 'responses' };
  if (Object.entries(fixedRoot).some(([name, value]) => root[name] !== value)
    || Object.entries(fixedProvider).some(([name, value]) => provider[name] !== value)
    || (!deepseek && !provider.name)) throw new ProviderConfigError('format');
  if (editable && root.approval_policy !== undefined && !POLICY_VALUES.includes(root.approval_policy)) throw new ProviderConfigError('format');
  if (editable && root.sandbox_mode !== undefined && !SANDBOX_VALUES.includes(root.sandbox_mode)) throw new ProviderConfigError('format');
  const result: Config = { service, model: model(service, root.model), key: provider.experimental_bearer_token ?? '',
    baseUrl: deepseek ? provider.base_url : checkBaseUrl(provider.base_url), approval_policy: root.approval_policy, sandbox_mode: root.sandbox_mode };
  if (deepseek) {
    const efforts: readonly { effort: string }[] = DEEPSEEK_CATALOG.models.find((entry) => entry.slug === result.model)!.supported_reasoning_levels;
    if (root.model_reasoning_effort !== undefined && !efforts.some((level) => level.effort === root.model_reasoning_effort)) throw new ProviderConfigError('format');
  }
  if (requireKey) serviceKey(service, result.key);
  return result;
}

// Called only after editable-format validation. Replace the known scalar values in-place (model, key and, for
// non-DeepSeek cards, the endpoint), preserving native settings, reasoning effort (including absence), comments and
// line endings instead of regenerating the file. Lines inside multiline values of unrelated settings are never read as
// headers or assignments. An empty key is not written (optional keys of local servers and gateways).
function editConfigSource(source: string, service: ApiService, next: { model: string; key: string; baseUrl?: string }): string {
  const providerTable = `model_providers.${service === 'deepseek' ? 'deepseek' : GENERIC_PROVIDER}`;
  let section: string[] = [];
  let keyWritten = false;
  // The real provider header, for a missing key line; never a look-alike inside a multiline value
  let header = -1;
  const valueState: ValueState = { depth: 0 };
  const lines = source.split(/(?<=\n)/);
  const replace = (line: string, value: string): string => line.replace(
    /^(\s*(?:[A-Za-z_]+|"[A-Za-z_]+"|'[A-Za-z_]+')\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/,
    (_match, prefix: string) => prefix + JSON.stringify(value),
  );
  const result = lines.map((line, index) => {
    if (valueState.depth || valueState.multiline) {
      advanceValue(line, valueState);
      return line;
    }
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    if (trimmed.startsWith('[')) {
      section = keyPath(trimmed.slice(trimmed.startsWith('[[') ? 2 : 1))!.segments;
      if (section.join('.') === providerTable) header = index;
      return line;
    }
    const assignment = keyPath(trimmed);
    if (!assignment?.rest.startsWith('=')) return line;
    if (section.length === 0 && assignment.segments[0] === 'model') return replace(line, next.model);
    if (section[0] === 'model_providers' && assignment.segments[0] === 'experimental_bearer_token') {
      keyWritten = true;
      return replace(line, next.key);
    }
    if (next.baseUrl !== undefined && section[0] === 'model_providers' && assignment.segments[0] === 'base_url') return replace(line, next.baseUrl);
    advanceValue(assignment.rest.slice(1), valueState);
    return line;
  });
  if (!keyWritten && next.key) {
    if (header < 0) throw new ProviderConfigError('format');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    if (!result[header].endsWith('\n')) result[header] += newline;
    result.splice(header + 1, 0, `experimental_bearer_token = ${JSON.stringify(next.key)}${newline}`);
  }
  return result.join('');
}

function renderConfig(dir: string, config: Config): string {
  const deepseek = config.service === 'deepseek';
  const fields: Record<string, string> = deepseek
    ? {
      model: config.model, model_provider: 'deepseek', forced_login_method: 'api',
      model_reasoning_effort: 'high', web_search: 'disabled', model_catalog_json: path.join(path.resolve(dir), 'models.json'),
    }
    : { model: config.model, model_provider: GENERIC_PROVIDER, forced_login_method: 'api', web_search: 'disabled' };
  if (config.approval_policy !== undefined) fields.approval_policy = config.approval_policy;
  if (config.sandbox_mode !== undefined) fields.sandbox_mode = config.sandbox_mode;
  const lines = Object.entries(fields).map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
  if (deepseek) {
    lines.push('', '[model_providers.deepseek]', 'name = "deepseek"', 'base_url = "https://api.deepseek.com/"',
      'wire_api = "responses"', `experimental_bearer_token = ${JSON.stringify(config.key)}`);
    return DEEPSEEK_HEADER + lines.join('\n') + '\n';
  }
  lines.push('', `[model_providers.${GENERIC_PROVIDER}]`, `name = ${JSON.stringify(SERVICE_INFO[config.service].name)}`,
    `base_url = ${JSON.stringify(config.baseUrl)}`, 'wire_api = "responses"');
  if (config.key) lines.push(`experimental_bearer_token = ${JSON.stringify(config.key)}`);
  return CONFIG_HEADER + lines.join('\n') + '\n';
}

// DeepSeek cards only; other cards have no catalog (a models.json there is left alone and not read)
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
  const config = parseConfig(source, dir, marker.service, requireKey, editable);
  const catalog = marker.service === 'deepseek' ? catalogText(dir) : '';
  return { config, source, revision: createHash('sha256').update(JSON.stringify([marker.source, source, catalog])).digest('hex') };
}

// The service of a readable marker, for status display while the rest of the card is broken
function markedService(dir: string): ApiService | undefined {
  try { return markerText(dir).service; } catch { return undefined; }
}

/** Label of a card's service: "<service> API", or the localized custom label */
export function providerLabel(service: ApiService): string {
  return service === 'custom' ? t('codex.provider.customLabel') : `${SERVICE_INFO[service].name} API`;
}

const hostOf = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };

/** Secret-free status. Invalid/unmanaged provider cards must never fall back to subscription credential reads. An
 *  unreadable marker shows as a custom card with its error; an unmarked config (only a DeepSeek one is preserved) as
 *  DeepSeek. */
export function readProviderInfo(dir: string): ProviderInfo | undefined {
  if (!preserveProviderConfig(dir)) return undefined;
  try {
    const { config } = snapshot(dir, false);
    let error: ProviderErrorCode | undefined;
    try { serviceKey(config.service, config.key); } catch { error = 'key'; }
    const deepseek = config.service === 'deepseek';
    return { provider: config.service, model: config.model, baseUrl: deepseek ? undefined : config.baseUrl, host: deepseek ? undefined : hostOf(config.baseUrl),
      hasKey: !!config.key, configured: !error, error };
  } catch (error) {
    return { provider: markedService(dir) ?? (hasProviderMarker(dir) ? 'custom' : 'deepseek'), configured: false, error: error instanceof ProviderConfigError ? error.code : 'file' };
  }
}

/** The saved key of a valid card, for the host's model-list request to that card's endpoint only ('' without one). */
export function readProviderKey(dir: string): string {
  return snapshot(dir, false).config.key;
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
 * The marker is written first so an interrupted creation cannot later inherit the default provider config. DeepSeek
 * cards also get the bundled model catalog; other services take input.baseUrl (the preset's when omitted). */
export function createProviderConfig(dir: string, service: ApiService, input: { model: string; key: string; baseUrl?: string }, defaultDir: string): { skipped: string[] } {
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
  const baseUrl = service === 'deepseek' ? SERVICE_INFO.deepseek.baseUrl! : checkBaseUrl(input.baseUrl ?? SERVICE_INFO[service].baseUrl);
  const config = renderConfig(dir, { ...copied.values, service, model: model(service, input.model), key: serviceKey(service, input.key), baseUrl });
  parseConfig(config, dir, service);
  try {
    fs.writeFileSync(path.join(dir, PROVIDER_FILES[0]), markerFor(service), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'config.toml'), config, { mode: 0o600, flag: 'wx' });
    if (service === 'deepseek') fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(DEEPSEEK_CATALOG, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch { throw new ProviderConfigError('write'); }
  return { skipped: copied.skipped };
}

/** Capture before prompts. The revision covers config, marker and catalog but contains no raw key; hasKey says
 *  whether a key is saved, so an optional key can be offered as "keep". */
export function readProviderEditState(dir: string): { service: ApiService; model: string; baseUrl: string; hasKey: boolean; revision: string } {
  const state = snapshot(dir, false, true);
  return { service: state.config.service, model: state.config.model, baseUrl: state.config.baseUrl, hasKey: !!state.config.key, revision: state.revision };
}

/** Empty replacement preserves the current key; baseUrl applies to non-DeepSeek cards only. Unsupported edits and
 *  competing PlanSwap edits are refused. */
export function editProviderConfig(dir: string, next: { model: string; key: string; baseUrl?: string }, revision: string): void {
  // Establish that the root and owned files are local before creating the per-card edit lock.
  snapshot(dir, false, true);
  const lock = path.join(dir, '.planswap-provider.lock');
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { throw new ProviderConfigError('changed'); }
  let temporary: string | undefined;
  try {
    const current = snapshot(dir, false, true);
    if (current.revision !== revision) throw new ProviderConfigError('changed');
    const service = current.config.service;
    const nextModel = model(service, next.model);
    const nextKey = serviceKey(service, next.key || current.config.key);
    const nextUrl = service === 'deepseek' ? undefined : checkBaseUrl(next.baseUrl ?? current.config.baseUrl);
    const config = editConfigSource(current.source, service, { model: nextModel, key: nextKey, baseUrl: nextUrl });
    const edited = parseConfig(config, dir, service, true, true);
    // Accepted TOML spellings may be outside the narrow scalar replacement syntax. Never report a successful
    // edit unless the re-parsed values match every requested change.
    if (edited.model !== nextModel || edited.key !== nextKey || (nextUrl !== undefined && edited.baseUrl !== nextUrl)) throw new ProviderConfigError('format');
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
