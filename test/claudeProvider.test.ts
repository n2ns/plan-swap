import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLAUDE_API_SERVICES, CLAUDE_PROVIDER_FILES, CLAUDE_SERVICE_INFO, NO_KEY_PLACEHOLDER, ProviderConfigError, assertClaudeProviderFilesLocal,
  claudeModelsUrl, claudeProviderLabel, createClaudeProviderConfig, editClaudeProviderConfig, hasClaudeProviderMarker,
  readClaudeProviderEditState, readClaudeProviderInfo, readClaudeProviderKey, validateClaudeProviderConfig, type ClaudeApiService,
} from '../src/claudeProvider';
import { fetchModels } from '../src/codex/providerModels';
import { FILE_SYMLINKS, makeTempHome, snapshot, type TempHome } from './helpers';

let temp: TempHome;
let def: string;
let dir: string;
beforeEach(() => {
  temp = makeTempHome('claude-provider');
  def = path.join(temp.home, '.claude');
  dir = path.join(temp.home, '.claude-api');
  for (const folder of [def, dir]) fs.mkdirSync(folder, { mode: 0o700 });
});
afterEach(() => temp.restore());

const settingsFile = (): string => path.join(dir, 'settings.json');
const markerFile = (): string => path.join(dir, CLAUDE_PROVIDER_FILES[0]);
const settings = (): { env: Record<string, string>; [key: string]: unknown } => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
const writeSettings = (value: unknown): void => fs.writeFileSync(settingsFile(), JSON.stringify(value, null, 2) + '\n');
const fails = (code: ProviderConfigError['code']) => (error: unknown): boolean => error instanceof ProviderConfigError && error.code === code;
const create = (service: ClaudeApiService = 'kimi', input: { model?: string; key?: string; baseUrl?: string } = {}): void => {
  createClaudeProviderConfig(dir, service, { model: input.model ?? 'kimi-k2', key: input.key ?? 'sk-test-key', baseUrl: input.baseUrl });
};
const MODEL_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

describe('creating and reading a card', () => {
  for (const service of CLAUDE_API_SERVICES) {
    test(`${service}: create, read and edit round trip`, () => {
      const baseUrl = service === 'custom' ? 'https://gw.example.test/anthropic' : undefined;
      createClaudeProviderConfig(dir, service, { model: 'model-a', key: 'sk-one', baseUrl });
      const expectedUrl = baseUrl ?? CLAUDE_SERVICE_INFO[service].baseUrl!;
      assert.equal(fs.readFileSync(markerFile(), 'utf8'), JSON.stringify({ version: 1, provider: service }) + '\n');
      const env = settings().env;
      assert.equal(env.ANTHROPIC_BASE_URL, expectedUrl);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-one');
      assert.equal(env.ANTHROPIC_API_KEY, '');
      for (const name of MODEL_VARS) assert.equal(env[name], 'model-a');
      assert.ok(fs.readFileSync(settingsFile(), 'utf8').endsWith('}\n'));
      validateClaudeProviderConfig(dir);
      const info = readClaudeProviderInfo(dir);
      assert.deepEqual(info, { provider: service, model: 'model-a', baseUrl: expectedUrl, host: new URL(expectedUrl).host, hasKey: true, configured: true, error: undefined });
      assert.equal(JSON.stringify(info).includes('sk-one'), false);
      assert.equal(readClaudeProviderKey(dir), 'sk-one');
      const state = readClaudeProviderEditState(dir);
      assert.equal(JSON.stringify(state).includes('sk-one'), false);
      assert.deepEqual({ ...state, revision: '' }, { service, model: 'model-a', baseUrl: expectedUrl, hasKey: true, revision: '' });
      editClaudeProviderConfig(dir, { model: 'model-b', key: '', baseUrl: 'https://other.example.test/anthropic' }, state.revision);
      const edited = settings().env;
      assert.equal(edited.ANTHROPIC_AUTH_TOKEN, 'sk-one', 'an empty key keeps the saved one');
      assert.equal(edited.ANTHROPIC_BASE_URL, 'https://other.example.test/anthropic');
      for (const name of MODEL_VARS) assert.equal(edited[name], 'model-b');
      assert.equal(fs.existsSync(path.join(dir, '.planswap-provider.lock')), false);
      assert.deepEqual(fs.readdirSync(dir).sort(), [...CLAUDE_PROVIDER_FILES].sort());
    });
  }

  test('DeepSeek accepts any model ID, not only its listed ones', () => {
    create('deepseek', { model: 'deepseek-new-model' });
    assert.equal(readClaudeProviderInfo(dir)?.model, 'deepseek-new-model');
  });

  test('keyless services write the placeholder and read it back as no key', () => {
    create('ollama', { key: '', model: 'qwen3' });
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, NO_KEY_PLACEHOLDER);
    assert.equal(readClaudeProviderKey(dir), '');
    assert.equal(readClaudeProviderInfo(dir)?.hasKey, false);
    assert.equal(readClaudeProviderInfo(dir)?.configured, true);
    const state = readClaudeProviderEditState(dir);
    assert.equal(state.hasKey, false);
    editClaudeProviderConfig(dir, { model: 'qwen3', key: 'sk-local' }, state.revision);
    assert.equal(readClaudeProviderKey(dir), 'sk-local');
    editClaudeProviderConfig(dir, { model: 'llama', key: '' }, readClaudeProviderEditState(dir).revision);
    assert.equal(readClaudeProviderKey(dir), 'sk-local', 'an empty key keeps a saved real key');
  });

  test('a required service with the placeholder is reported as missing its key', () => {
    create('kimi');
    const value = settings();
    value.env.ANTHROPIC_AUTH_TOKEN = NO_KEY_PLACEHOLDER;
    writeSettings(value);
    assert.equal(readClaudeProviderInfo(dir)?.error, 'key');
    assert.equal(readClaudeProviderInfo(dir)?.hasKey, false);
    assert.throws(() => validateClaudeProviderConfig(dir), fails('key'));
    assert.throws(() => editClaudeProviderConfig(dir, { model: 'm', key: '' }, readClaudeProviderEditState(dir).revision), fails('key'));
  });

  test('files are written with mode 0600', { skip: process.platform === 'win32' && 'no POSIX permissions' }, () => {
    create();
    for (const name of CLAUDE_PROVIDER_FILES) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  });
});

describe('refusals', () => {
  test('existing provider files are never overwritten', () => {
    fs.writeFileSync(settingsFile(), '{"model":"opus"}\n');
    assert.throws(() => create(), fails('exists'));
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{"model":"opus"}\n');
    assert.equal(fs.existsSync(markerFile()), false);
    fs.rmSync(settingsFile());
    fs.writeFileSync(markerFile(), 'x');
    assert.throws(() => create(), fails('exists'));
  });

  test('a missing directory or a file in its place is refused', () => {
    fs.rmSync(dir, { recursive: true });
    assert.throws(() => create(), fails('file'));
    fs.writeFileSync(dir, '');
    assert.throws(() => create(), fails('file'));
  });

  test('a linked account directory is refused', () => {
    const link = path.join(temp.home, '.claude-link');
    fs.symlinkSync(dir, link, 'junction');
    assert.throws(() => createClaudeProviderConfig(link, 'kimi', { model: 'm', key: 'k' }), fails('file'));
    create();
    assert.throws(() => readClaudeProviderEditState(link), fails('file'));
  });

  test('bad input is refused before anything is written', () => {
    const cases: Array<[ClaudeApiService, { model: string; key: string; baseUrl?: string }, ProviderConfigError['code']]> = [
      ['kimi', { model: '', key: 'k' }, 'model'],
      ['kimi', { model: 'a b', key: 'k' }, 'model'],
      ['kimi', { model: 'x'.repeat(201), key: 'k' }, 'model'],
      ['kimi', { model: 'm\u0001', key: 'k' }, 'model'],
      ['kimi', { model: 'm', key: '' }, 'key'],
      ['deepseek', { model: 'm', key: 'with space' }, 'key'],
      ['ollama', { model: 'm', key: 'bad\nkey' }, 'key'],
      ['custom', { model: 'm', key: '' }, 'url'],
      ['custom', { model: 'm', key: '', baseUrl: 'http://remote.example.test/anthropic' }, 'url'],
      ['custom', { model: 'm', key: '', baseUrl: 'https://user:pw@gw.example.test' }, 'url'],
      ['custom', { model: 'm', key: '', baseUrl: 'https://gw.example.test/?q' }, 'url'],
      ['kimi', { model: 'm', key: 'k', baseUrl: 'not a url' }, 'url'],
    ];
    for (const [service, input, code] of cases) {
      assert.throws(() => createClaudeProviderConfig(dir, service, input), fails(code), JSON.stringify(input));
      assert.deepEqual(fs.readdirSync(dir), []);
    }
    createClaudeProviderConfig(dir, 'custom', { model: 'm', key: '', baseUrl: 'http://127.0.0.1:4000' });
    assert.equal(readClaudeProviderInfo(dir)?.configured, true);
  });

  test('bad edits are refused and leave the file as it was', () => {
    create();
    const before = fs.readFileSync(settingsFile(), 'utf8');
    const { revision } = readClaudeProviderEditState(dir);
    assert.throws(() => editClaudeProviderConfig(dir, { model: 'a b', key: '' }, revision), fails('model'));
    assert.throws(() => editClaudeProviderConfig(dir, { model: 'm', key: 'a b' }, revision), fails('key'));
    assert.throws(() => editClaudeProviderConfig(dir, { model: 'm', key: '', baseUrl: 'http://remote.example.test' }, revision), fails('url'));
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...CLAUDE_PROVIDER_FILES].sort());
  });

  test('a changed revision is refused, also for a changed key', () => {
    create();
    const { revision } = readClaudeProviderEditState(dir);
    const value = settings();
    value.env.ANTHROPIC_AUTH_TOKEN = 'sk-other-key';
    writeSettings(value);
    assert.notEqual(readClaudeProviderEditState(dir).revision, revision);
    assert.throws(() => editClaudeProviderConfig(dir, { model: 'm', key: '' }, revision), fails('changed'));
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, 'sk-other-key');
  });

  test('a held edit lock refuses a competing edit and is left alone', () => {
    create();
    const { revision } = readClaudeProviderEditState(dir);
    fs.writeFileSync(path.join(dir, '.planswap-provider.lock'), '');
    assert.throws(() => editClaudeProviderConfig(dir, { model: 'm', key: '' }, revision), fails('changed'));
    assert.equal(fs.existsSync(path.join(dir, '.planswap-provider.lock')), true);
  });

  test('a lock file left by a crashed edit is taken over once it is a minute old', () => {
    create();
    const { revision } = readClaudeProviderEditState(dir);
    const lock = path.join(dir, '.planswap-provider.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 2 * 60_000);
    fs.utimesSync(lock, old, old);
    editClaudeProviderConfig(dir, { model: 'm2', key: '' }, revision);
    assert.equal(settings().env.ANTHROPIC_MODEL, 'm2');
    assert.equal(fs.existsSync(lock), false, 'the edit released its own lock');
  });

  test('malformed settings.json values are refused', () => {
    create();
    const good = settings();
    const variants: Array<[string, unknown, ProviderConfigError['code']]> = [
      ['not json', '{', 'format'],
      ['array', [], 'format'],
      ['no env', { model: 'x' }, 'format'],
      ['missing owned value', { env: { ...good.env, ANTHROPIC_API_KEY: undefined } }, 'format'],
      ['number value', { env: { ...good.env, ANTHROPIC_MODEL: 5 } }, 'format'],
      ['models disagree', { env: { ...good.env, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'other' } }, 'format'],
      ['bad url', { env: { ...good.env, ANTHROPIC_BASE_URL: 'http://remote.example.test' } }, 'url'],
      ['bad model', { env: Object.fromEntries(Object.entries(good.env).map(([k, v]) => [k, MODEL_VARS.includes(k) ? 'a b' : v])) }, 'model'],
    ];
    for (const [name, value, code] of variants) {
      if (typeof value === 'string') fs.writeFileSync(settingsFile(), value); else writeSettings(value);
      assert.throws(() => validateClaudeProviderConfig(dir), fails(code), name);
      assert.equal(readClaudeProviderInfo(dir)?.error, code, name);
      assert.equal(readClaudeProviderInfo(dir)?.provider, 'kimi', name);
    }
  });

  test('settings.json links and hard links are refused without touching their target', FILE_SYMLINKS, () => {
    create();
    fs.renameSync(settingsFile(), path.join(def, 'settings.json'));
    fs.symlinkSync(path.join(def, 'settings.json'), settingsFile(), 'file');
    const before = snapshot(temp.home);
    assert.throws(() => readClaudeProviderEditState(dir), fails('file'));
    assert.throws(() => assertClaudeProviderFilesLocal(dir), fails('file'));
    assert.equal(readClaudeProviderInfo(dir)?.error, 'file');
    assert.deepEqual(snapshot(temp.home), before);
  });

  test('a linked marker is refused', FILE_SYMLINKS, () => {
    create();
    fs.renameSync(markerFile(), path.join(def, 'marker.json'));
    fs.symlinkSync(path.join(def, 'marker.json'), markerFile(), 'file');
    assert.throws(() => assertClaudeProviderFilesLocal(dir), fails('file'));
    assert.throws(() => readClaudeProviderEditState(dir), fails('file'));
    assert.deepEqual(readClaudeProviderInfo(dir), { provider: 'custom', configured: false, error: 'file' });
  });

  test('a dangling marker link still reserves the directory', FILE_SYMLINKS, () => {
    fs.symlinkSync(path.join(def, 'missing.json'), markerFile(), 'file');
    assert.equal(hasClaudeProviderMarker(dir), true);
    assert.deepEqual(readClaudeProviderInfo(dir), { provider: 'custom', configured: false, error: 'file' });
  });

  test('hard-linked provider files are refused', () => {
    create();
    fs.linkSync(settingsFile(), path.join(def, 'copy.json'));
    const before = snapshot(temp.home);
    assert.throws(() => readClaudeProviderEditState(dir), fails('file'));
    assert.throws(() => assertClaudeProviderFilesLocal(dir), fails('file'));
    assert.deepEqual(snapshot(temp.home), before);
  });

  test('malformed markers show as a custom card with the marker error', () => {
    create();
    for (const text of ['{', '[]', '{"version":2,"provider":"kimi"}', '{"version":1,"provider":"lmstudio"}', '{"version":1,"provider":"kimi","x":1}']) {
      fs.writeFileSync(markerFile(), text);
      assert.deepEqual(readClaudeProviderInfo(dir), { provider: 'custom', configured: false, error: 'marker' }, text);
      assert.throws(() => assertClaudeProviderFilesLocal(dir), fails('marker'), text);
      assert.throws(() => readClaudeProviderKey(dir), fails('marker'), text);
    }
  });

  test('an unmarked directory is an ordinary account', () => {
    fs.writeFileSync(settingsFile(), '{"env":{"ANTHROPIC_AUTH_TOKEN":"x"}}');
    assert.equal(hasClaudeProviderMarker(dir), false);
    assert.equal(readClaudeProviderInfo(dir), undefined);
    assert.doesNotThrow(() => assertClaudeProviderFilesLocal(dir));
    assert.throws(() => readClaudeProviderEditState(dir), fails('unmanaged'));
  });
});

describe("Claude Code's own settings", () => {
  test('editing keeps every other key and env entry, in order', () => {
    create();
    const value = settings();
    const extra = {
      model: 'opus', permissions: { allow: ['Bash(ls)'], deny: [] }, hooks: {},
      env: { FIRST: '1', ...value.env, LAST: 'z', NUMBER_LIKE: '2' },
    };
    writeSettings(extra);
    editClaudeProviderConfig(dir, { model: 'kimi-new', key: 'sk-new' }, readClaudeProviderEditState(dir).revision);
    const edited = settings();
    assert.deepEqual(Object.keys(edited), ['model', 'permissions', 'hooks', 'env']);
    assert.equal(edited.model, 'opus');
    assert.deepEqual(edited.permissions, { allow: ['Bash(ls)'], deny: [] });
    assert.deepEqual(Object.keys(edited.env), Object.keys(extra.env));
    assert.equal(edited.env.FIRST, '1');
    assert.equal(edited.env.LAST, 'z');
    assert.equal(edited.env.ANTHROPIC_AUTH_TOKEN, 'sk-new');
    assert.equal(edited.env.ANTHROPIC_MODEL, 'kimi-new');
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), JSON.stringify(edited, null, 2) + '\n');
  });

  test('a BOM-prefixed settings.json is read', () => {
    create();
    fs.writeFileSync(settingsFile(), '﻿' + fs.readFileSync(settingsFile(), 'utf8'));
    assert.equal(readClaudeProviderInfo(dir)?.configured, true);
  });
});

describe('labels and model-list addresses', () => {
  test('labels', () => {
    assert.equal(claudeProviderLabel('kimi', 'Custom endpoint'), 'Kimi API');
    assert.equal(claudeProviderLabel('zai', 'Custom endpoint'), 'Z.ai API');
    assert.equal(claudeProviderLabel('custom', 'Custom endpoint'), 'Custom endpoint');
  });

  test('claudeModelsUrl', () => {
    assert.equal(claudeModelsUrl('kimi', CLAUDE_SERVICE_INFO.kimi.baseUrl!), 'https://api.moonshot.ai/v1');
    // A preset card moved to another endpoint lists that endpoint's models: its key must not go to the preset host
    assert.equal(claudeModelsUrl('kimi', 'https://proxy.example.test/anthropic'), 'https://proxy.example.test/anthropic/v1');
    assert.equal(claudeModelsUrl('zai', 'https://api.z.ai/api/anthropic/'), 'https://api.z.ai/api/paas/v4');
    assert.equal(claudeModelsUrl('zai', CLAUDE_SERVICE_INFO.zai.baseUrl!), 'https://api.z.ai/api/paas/v4');
    assert.equal(claudeModelsUrl('openrouter', CLAUDE_SERVICE_INFO.openrouter.baseUrl!), 'https://openrouter.ai/api/v1');
    assert.equal(claudeModelsUrl('ollama', 'http://localhost:11434/'), 'http://localhost:11434/v1');
    assert.equal(claudeModelsUrl('custom', 'https://gw.example.test/anthropic//'), 'https://gw.example.test/anthropic/v1');
  });

  test('the add form lists the services alphabetically by name, custom last', () => {
    const named = CLAUDE_API_SERVICES.filter((s) => s !== 'custom').map((s) => CLAUDE_SERVICE_INFO[s].name);
    assert.deepEqual(named, [...named].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
    assert.equal(CLAUDE_API_SERVICES.at(-1), 'custom');
  });
});

describe('fetchModels headers', () => {
  const original = globalThis.fetch;
  let seen: Array<{ url: string; headers: Record<string, string> }> = [];
  beforeEach(() => {
    seen = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = original; });

  test('anthropic requests also send x-api-key and anthropic-version', async () => {
    assert.deepEqual(await fetchModels('https://api.example.test/v1/', 'sk-k', 1000, { anthropic: true }), ['a', 'b']);
    assert.equal(seen[0].url, 'https://api.example.test/v1/models');
    assert.deepEqual(seen[0].headers, { Accept: 'application/json', Authorization: 'Bearer sk-k', 'x-api-key': 'sk-k', 'anthropic-version': '2023-06-01' });
  });

  test('without a key only the version header is added', async () => {
    await fetchModels('https://api.example.test/v1', '', 1000, { anthropic: true });
    assert.deepEqual(seen[0].headers, { Accept: 'application/json', 'anthropic-version': '2023-06-01' });
  });

  test('other callers keep the previous headers', async () => {
    await fetchModels('https://api.example.test/v1', 'sk-k');
    assert.deepEqual(seen[0].headers, { Accept: 'application/json', Authorization: 'Bearer sk-k' });
  });
});

describe('changing a Claude card\'s service', () => {
  test('a service change never keeps the saved key; a local server may have none, a cloud service needs one', () => {
    create('kimi');
    let state = readClaudeProviderEditState(dir);
    assert.throws(() => editClaudeProviderConfig(dir, { service: 'deepseek', model: 'deepseek-flash', key: '' }, state.revision), fails('key'));
    assert.equal(JSON.parse(fs.readFileSync(markerFile(), 'utf8')).provider, 'kimi', 'a refusal leaves the card as it was');
    editClaudeProviderConfig(dir, { service: 'ollama', model: 'qwen3', key: '' }, state.revision);
    state = readClaudeProviderEditState(dir);
    assert.deepEqual([state.service, state.baseUrl, state.hasKey, state.model], ['ollama', 'http://localhost:11434', false, 'qwen3']);
    assert.equal(settings().env.ANTHROPIC_AUTH_TOKEN, NO_KEY_PLACEHOLDER);
    editClaudeProviderConfig(dir, { service: 'custom', model: 'm', key: 'sk-gw', baseUrl: 'https://gw.example.test' }, state.revision);
    assert.deepEqual([readClaudeProviderEditState(dir).service, readClaudeProviderKey(dir), settings().env.ANTHROPIC_BASE_URL], ['custom', 'sk-gw', 'https://gw.example.test']);
    validateClaudeProviderConfig(dir);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
  });

  test('settings the user or Claude Code added are kept across a service change', () => {
    create('kimi');
    writeSettings({ ...settings(), permissions: { allow: ['Bash(ls)'] }, env: { ...settings().env, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' } });
    editClaudeProviderConfig(dir, { service: 'ollama', model: 'qwen3', key: '' }, readClaudeProviderEditState(dir).revision);
    assert.deepEqual(settings().permissions, { allow: ['Bash(ls)'] });
    assert.equal(settings().env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
  });
});
