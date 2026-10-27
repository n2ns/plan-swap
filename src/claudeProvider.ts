// PlanSwap-owned Claude API cards: a named Claude account whose Claude Code runs against another service's
// Anthropic Messages endpoint instead of a Claude sign-in. The card owns two real files: the marker
// `.planswap-provider.json` ({ version: 1, provider: <service> }) and `settings.json`, whose `env` block carries the
// endpoint (ANTHROPIC_BASE_URL), the plaintext key (ANTHROPIC_AUTH_TOKEN, a placeholder for keyless services),
// ANTHROPIC_API_KEY '' (so an inherited Anthropic key is never sent to the service) and the model for every tier
// (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL / _SONNET_MODEL / _HAIKU_MODEL, CLAUDE_CODE_SUBAGENT_MODEL). Claude Code
// applies that env block from the selected CLAUDE_CONFIG_DIR at startup (Claude Code research, fact 15), so switching
// keeps the ordinary CLAUDE_CONFIG_DIR path. No .credentials.json is read or written. Editing replaces only the owned
// env values and keeps every other key Claude Code or the user wrote. No runtime vscode import and no network calls
// (model lists: providerModels.ts); a saved key leaves this module only through readClaudeProviderKey, for that request.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkBaseUrl, ProviderConfigError, type ProviderErrorCode } from './codex/codexProvider';

export { ProviderConfigError, type ProviderErrorCode };

/** Services a Claude API card can use, in the order the add form lists them: alphabetical by name, custom last. */
export const CLAUDE_API_SERVICES = ['deepseek', 'kimi', 'ollama', 'openrouter', 'zai', 'custom'] as const;
export type ClaudeApiService = typeof CLAUDE_API_SERVICES[number];

/**
 * baseUrl: the Anthropic-format endpoint written as ANTHROPIC_BASE_URL (Claude Code appends /v1/messages); absent for
 * custom. modelsUrl: the OpenAI-list base for the model list (fetchModels appends /models); absent means
 * `<baseUrl>/v1`. models: a fixed list offered instead of a request (DeepSeek). publicModels: listed without a key.
 */
export const CLAUDE_SERVICE_INFO: Record<ClaudeApiService, {
  name: string; baseUrl?: string; modelsUrl?: string; keyRequired: boolean; publicModels?: boolean; models?: readonly string[];
}> = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', keyRequired: true, models: ['deepseek-flash', 'deepseek-v4-pro'] },
  kimi: { name: 'Kimi', baseUrl: 'https://api.moonshot.ai/anthropic', modelsUrl: 'https://api.moonshot.ai/v1', keyRequired: true },
  ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434', keyRequired: false, publicModels: true },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', keyRequired: true, publicModels: true },
  zai: { name: 'Z.ai', baseUrl: 'https://api.z.ai/api/anthropic', modelsUrl: 'https://api.z.ai/api/paas/v4', keyRequired: true },
  custom: { name: 'Custom', keyRequired: false },
};

/** Files a card owns; never linked, copied, moved, replaced or deduplicated by sharing. */
export const CLAUDE_PROVIDER_FILES = ['.planswap-provider.json', 'settings.json'] as const;

/** The value written as ANTHROPIC_AUTH_TOKEN when a keyless service (local server, gateway) has no key: Claude Code
 *  needs some credential to skip its sign-in, and such services ignore it. Read back as "no key saved". */
export const NO_KEY_PLACEHOLDER = 'planswap-no-key';

export interface ClaudeProviderInfo {
  provider: ClaudeApiService;
  configured: boolean;
  model?: string;
  // The endpoint (never containing a secret) and its host
  baseUrl?: string;
  host?: string;
  // Whether a real key is saved (the placeholder does not count)
  hasKey?: boolean;
  error?: ProviderErrorCode;
}

// The env entries a card owns; every other settings.json key and env entry belongs to Claude Code or the user
const MODEL_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'] as const;
const OWNED_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', ...MODEL_VARS] as const;
const LOCK_FILE = '.planswap-provider.lock';

interface Config { service: ClaudeApiService; model: string; key: string; baseUrl: string }
interface Snapshot { config: Config; settings: Record<string, unknown>; revision: string }

const markerFor = (service: ClaudeApiService): string => JSON.stringify({ version: 1, provider: service }) + '\n';

function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ProviderConfigError('file');
  }
}

/** Presence of the marker (including a malformed file or dangling link) reserves the directory for card handling. */
export function hasClaudeProviderMarker(dir: string): boolean {
  try { return !!stat(path.join(dir, CLAUDE_PROVIDER_FILES[0])); } catch { return true; }
}

// An account-local regular file: the directory is not a link, the file is no link and has no other hard link
function localText(dir: string, name: string): string {
  const root = stat(dir);
  const entry = stat(path.join(dir, name));
  if (!root?.isDirectory() || root.isSymbolicLink() || !entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new ProviderConfigError('file');
  }
  try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { throw new ProviderConfigError('file'); }
}

function markerText(dir: string): { source: string; service: ClaudeApiService } {
  const source = localText(dir, CLAUDE_PROVIDER_FILES[0]);
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !(CLAUDE_API_SERVICES as readonly unknown[]).includes(record.provider) || Object.keys(record).length !== 2) throw new Error();
    return { source, service: record.provider as ClaudeApiService };
  } catch { throw new ProviderConfigError('marker'); }
}

// Any model ID up to 200 characters without whitespace or control characters (DeepSeek too: its list is a suggestion)
function model(value: string | undefined): string {
  if (!value || value.length > 200 || /\s|[\x00-\x1f\x7f]/u.test(value)) throw new ProviderConfigError('model');
  return value;
}

function key(value: string | undefined): string {
  if (!value || /\s|[\x00-\x1f\x7f]/u.test(value)) throw new ProviderConfigError('key');
  return value;
}

// A required key must be valid; an optional one (local servers, gateways) may be empty
function serviceKey(service: ClaudeApiService, value: string): string {
  return value || CLAUDE_SERVICE_INFO[service].keyRequired ? key(value) : '';
}

// settings.json as parsed, with the owned env values checked: strings, a valid endpoint and one model for every tier
function parseSettings(source: string, service: ClaudeApiService, requireKey: boolean): { config: Config; settings: Record<string, unknown> } {
  let settings: unknown;
  try { settings = JSON.parse(source.replace(/^﻿/, '')); } catch { throw new ProviderConfigError('format'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new ProviderConfigError('format');
  const env = (settings as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new ProviderConfigError('format');
  const values = env as Record<string, unknown>;
  if (OWNED_VARS.some((name) => typeof values[name] !== 'string')) throw new ProviderConfigError('format');
  const models = MODEL_VARS.map((name) => values[name] as string);
  if (models.some((value) => value !== models[0])) throw new ProviderConfigError('format');
  const token = values.ANTHROPIC_AUTH_TOKEN as string;
  const config: Config = {
    service, model: model(models[0]), key: token === NO_KEY_PLACEHOLDER ? '' : token,
    baseUrl: checkBaseUrl(values.ANTHROPIC_BASE_URL as string),
  };
  if (requireKey) serviceKey(service, config.key);
  return { config, settings: settings as Record<string, unknown> };
}

// Sets the owned env values (an existing entry keeps its position) and leaves everything else as parsed
function renderSettings(settings: Record<string, unknown>, config: Pick<Config, 'model' | 'key' | 'baseUrl'>): string {
  const env = (settings.env ??= {}) as Record<string, unknown>;
  env.ANTHROPIC_BASE_URL = config.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = config.key || NO_KEY_PLACEHOLDER;
  env.ANTHROPIC_API_KEY = '';
  for (const name of MODEL_VARS) env[name] = config.model;
  return JSON.stringify(settings, null, 2) + '\n';
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function snapshot(dir: string, requireKey = true): Snapshot {
  if (!hasClaudeProviderMarker(dir)) throw new ProviderConfigError('unmanaged');
  const marker = markerText(dir);
  const source = localText(dir, 'settings.json');
  const { config, settings } = parseSettings(source, marker.service, requireKey);
  // The hash input carries the key only as its digest, so a changed key still changes the revision
  const token = (settings.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN;
  const masked = token ? source.split(token).join('\u0000') : source;
  return { config, settings, revision: sha256(JSON.stringify([marker.source, masked, sha256(token)])) };
}

// The service of a readable marker, for status display while the rest of the card is broken
function markedService(dir: string): ClaudeApiService | undefined {
  try { return markerText(dir).service; } catch { return undefined; }
}

const hostOf = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };

/** Secret-free status of a marked card, or undefined for an unmarked directory (an ordinary Claude account). An
 *  unreadable marker shows as a custom card with its error. */
export function readClaudeProviderInfo(dir: string): ClaudeProviderInfo | undefined {
  if (!hasClaudeProviderMarker(dir)) return undefined;
  try {
    const { config } = snapshot(dir, false);
    let error: ProviderErrorCode | undefined;
    try { serviceKey(config.service, config.key); } catch { error = 'key'; }
    return { provider: config.service, model: config.model, baseUrl: config.baseUrl, host: hostOf(config.baseUrl),
      hasKey: !!config.key, configured: !error, error };
  } catch (error) {
    return { provider: markedService(dir) ?? 'custom', configured: false, error: error instanceof ProviderConfigError ? error.code : 'file' };
  }
}

/** The saved key of a valid card ('' without one or with the placeholder), for the host's model-list request to that
 *  card's own endpoint only. */
export function readClaudeProviderKey(dir: string): string {
  return snapshot(dir, false).config.key;
}

/** Local validation only (marker, settings.json shape, owned env values); throws ProviderConfigError. */
export function validateClaudeProviderConfig(dir: string): void { snapshot(dir); }

/** Refuses (ProviderConfigError 'file') when a provider-owned file of a marked card is a link, hard link or not a
 *  regular file; sharing calls it before any write. No-op for an unmarked directory. A malformed marker refuses with
 *  'marker'. */
export function assertClaudeProviderFilesLocal(dir: string): void {
  if (!hasClaudeProviderMarker(dir)) return;
  markerText(dir);
  for (const name of CLAUDE_PROVIDER_FILES) {
    const entry = stat(path.join(dir, name));
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) throw new ProviderConfigError('file');
  }
}

/** The label of a card's service: "<service> API", or the given custom label (localized by the caller). */
export function claudeProviderLabel(service: ClaudeApiService, customLabel: string): string {
  return service === 'custom' ? customLabel : `${CLAUDE_SERVICE_INFO[service].name} API`;
}

/** The model-list base for a form request: modelsUrl of a preset at its own preset endpoint, else `<baseUrl>/v1`
 *  (trailing slashes trimmed), so a card moved to another endpoint never sends its key to the preset's host. */
export function claudeModelsUrl(service: ClaudeApiService, baseUrl: string): string {
  const info = CLAUDE_SERVICE_INFO[service];
  const trimmed = baseUrl.replace(/\/+$/, '');
  return info.modelsUrl && trimmed === info.baseUrl ? info.modelsUrl : trimmed + '/v1';
}

/**
 * The host has just created dir as a NEW, empty account directory (not the default directory). Writes the marker
 * first, then settings.json, both exclusively (0600); baseUrl is checked with checkBaseUrl (the preset's when omitted;
 * required for custom); the key is required for keyRequired services. Nothing is copied from the default account.
 */
export function createClaudeProviderConfig(dir: string, service: ClaudeApiService, input: { model: string; key: string; baseUrl?: string }): void {
  const root = stat(dir);
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new ProviderConfigError('file');
  if (CLAUDE_PROVIDER_FILES.some((name) => stat(path.join(dir, name)))) throw new ProviderConfigError('exists');
  const settings = renderSettings({}, {
    model: model(input.model), key: serviceKey(service, input.key), baseUrl: checkBaseUrl(input.baseUrl ?? CLAUDE_SERVICE_INFO[service].baseUrl),
  });
  try {
    fs.writeFileSync(path.join(dir, CLAUDE_PROVIDER_FILES[0]), markerFor(service), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'settings.json'), settings, { mode: 0o600, flag: 'wx' });
  } catch { throw new ProviderConfigError('write'); }
}

/** Secret-free edit snapshot; revision is a hash over marker and settings.json without the raw key. */
export function readClaudeProviderEditState(dir: string): { service: ClaudeApiService; model: string; baseUrl: string; hasKey: boolean; revision: string } {
  const { config, revision } = snapshot(dir, false);
  return { service: config.service, model: config.model, baseUrl: config.baseUrl, hasKey: !!config.key, revision };
}

/** Empty key keeps the saved one. Replaces only the owned env values, keeps every other settings.json key as parsed,
 *  writes a temporary file and renames it over settings.json; refuses a changed revision ('changed'). */
export function editClaudeProviderConfig(dir: string, next: { model: string; key: string; baseUrl?: string }, revision: string): void {
  // Establish that the root and owned files are local before creating the per-card edit lock
  snapshot(dir, false);
  const lock = path.join(dir, LOCK_FILE);
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { throw new ProviderConfigError('changed'); }
  let temporary: string | undefined;
  try {
    const current = snapshot(dir, false);
    if (current.revision !== revision) throw new ProviderConfigError('changed');
    const service = current.config.service;
    const source = renderSettings(current.settings, {
      model: model(next.model), key: serviceKey(service, next.key || current.config.key),
      baseUrl: checkBaseUrl(next.baseUrl ?? current.config.baseUrl),
    });
    parseSettings(source, service, true);
    temporary = path.join(dir, `.planswap-provider-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, source, { mode: 0o600, flag: 'wx' });
    if (snapshot(dir, false).revision !== revision) throw new ProviderConfigError('changed');
    fs.renameSync(temporary, path.join(dir, 'settings.json'));
    temporary = undefined;
  } catch (error) {
    if (error instanceof ProviderConfigError) throw error;
    throw new ProviderConfigError('write');
  } finally {
    if (temporary) try { fs.unlinkSync(temporary); } catch { /* a failed write may not have created it */ }
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
