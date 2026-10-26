import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkBaseUrl, createProviderConfig, editProviderConfig, preserveProviderConfig, PROVIDER_FILES, ProviderConfigError,
  readProviderEditState, readProviderInfo, validateProviderConfig,
} from '../src/codex/codexProvider';
import { copyCodexSeed } from '../src/codex/codexPaths';
import { copyCodexIndependent, ensureCodexLinks, isSharedCodexAccount, makeCodexIndependent, migrateCodexToShared } from '../src/codex/codexShare';
import { assertMode, FILE_SYMLINKS, makeTempHome, read, SHARING, snapshot, type TempHome } from './helpers';

let temp: TempHome;
let def: string;
let dir: string;
let proc: string;
beforeEach(() => {
  temp = makeTempHome('codex-provider');
  def = path.join(temp.home, '.codex');
  dir = path.join(temp.home, '.codex-deepseek-dev');
  proc = path.join(temp.home, 'fake-proc');
  for (const folder of [def, dir, proc]) fs.mkdirSync(folder, { mode: 0o700 });
});
afterEach(() => temp.restore());

const create = (): void => { createProviderConfig(dir, 'deepseek', { model: 'deepseek-flash', key: 'sk-test-key' }, def); };
const config = (): string => read(path.join(dir, 'config.toml'));
const owned = (): string[] => PROVIDER_FILES.map((file) => read(path.join(dir, file)));
const fails = (code: ProviderConfigError['code']) => (error: unknown): boolean => error instanceof ProviderConfigError && error.code === code;

describe('native DeepSeek card configuration', () => {
  test('creates native config without subscription credentials and exposes only secret-free status', () => {
    const original = 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel = "old"\n[model_providers.old]\nexperimental_bearer_token = "old-secret"\n';
    fs.writeFileSync(path.join(def, 'config.toml'), original);
    fs.writeFileSync(path.join(def, 'auth.json'), 'subscription-secret');
    const before = snapshot(def);
    assert.deepEqual(createProviderConfig(dir, 'deepseek', { model: 'deepseek-flash', key: 'sk-test-key' }, def), { skipped: [] });
    assert.deepEqual(snapshot(def), before);
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    assert.match(config(), /approval_policy = "on-request"/);
    assert.match(config(), /sandbox_mode = "workspace-write"/);
    assert.equal(config().includes('old-secret'), false);
    assert.ok(config().includes(`model_catalog_json = ${JSON.stringify(path.join(dir, 'models.json'))}`));
    assert.equal(readProviderInfo(dir)?.configured, true);
    assert.equal(JSON.stringify(readProviderInfo(dir)).includes('sk-test-key'), false);
    for (const file of PROVIDER_FILES) assertMode(path.join(dir, file), '600');
    assertMode(dir, '700');
  });

  test('does not seed unsupported TOML forms or assignments inside multiline values', () => {
    fs.writeFileSync(path.join(def, 'config.toml'), 'notes = """\napproval_policy = "never"\n"""\n');
    assert.deepEqual(createProviderConfig(dir, 'deepseek', { model: 'deepseek-flash', key: 'sk-test-key' }, def), { skipped: ['config.toml'] });
    assert.equal(config().includes('approval_policy'), false);
    validateProviderConfig(dir);
  });

  test('refuses existing provider files, default home and invalid inputs without overwriting', () => {
    assert.throws(() => createProviderConfig(def, 'deepseek', { model: 'deepseek-flash', key: 'key' }, def), fails('file'));
    assert.throws(() => createProviderConfig(dir, 'deepseek', { model: 'other-model', key: 'key' }, def), fails('model'));
    assert.throws(() => createProviderConfig(dir, 'deepseek', { model: 'deepseek-flash', key: 'bad\nkey' }, def), fails('key'));
    assert.deepEqual(fs.readdirSync(dir), []);
    create();
    const before = snapshot(dir);
    assert.throws(create, fails('exists'));
    assert.deepEqual(snapshot(dir), before);
  });

  test('edits model and replacement key while preserving seeded settings and detects stale revisions', () => {
    fs.writeFileSync(path.join(def, 'config.toml'), 'approval_policy = "on-request"\n');
    create();
    const state = readProviderEditState(dir);
    assert.equal(JSON.stringify(state).includes('sk-test-key'), false);
    editProviderConfig(dir, { model: 'deepseek-v4-pro', key: '' }, state.revision);
    assert.match(config(), /sk-test-key/);
    assert.match(config(), /approval_policy = "on-request"/);
    assert.equal(readProviderInfo(dir)?.model, 'deepseek-v4-pro');
    assert.throws(() => editProviderConfig(dir, { model: 'deepseek-flash', key: 'replacement' }, state.revision), fails('changed'));
    const next = readProviderEditState(dir);
    editProviderConfig(dir, { model: 'deepseek-v4-pro', key: 'replacement' }, next.revision);
    assert.equal(config().includes('sk-test-key'), false);
    assert.match(config(), /replacement/);
    assert.equal(fs.readdirSync(dir).some((file) => file.endsWith('.lock') || file.endsWith('.tmp')), false);
  });

  test('missing key is configured false and can be repaired with the native edit flow', () => {
    create();
    fs.writeFileSync(path.join(dir, 'config.toml'), config().replace('sk-test-key', ''));
    assert.equal(readProviderInfo(dir)?.error, 'key');
    assert.throws(() => validateProviderConfig(dir), fails('key'));
    const edit = readProviderEditState(dir);
    editProviderConfig(dir, { model: edit.model, key: 'replacement' }, edit.revision);
    assert.equal(readProviderInfo(dir)?.configured, true);
  });

  test('owned fields in unsupported forms and a damaged catalog are preserved and reported without source text', () => {
    create();
    fs.writeFileSync(path.join(dir, 'config.toml'), 'approval_policy = { secret = "do-not-show" }\n' + config());
    const before = snapshot(dir);
    assert.equal(readProviderInfo(dir)?.configured, true);
    assert.throws(() => readProviderEditState(dir), (error: unknown) => fails('format')(error) && !(error as Error).message.includes('do-not-show'));
    assert.deepEqual(snapshot(dir), before);
    fs.writeFileSync(path.join(dir, 'models.json'), '{}');
    assert.equal(readProviderInfo(dir)?.configured, false);
  });

  test('catalog changes during prompts invalidate the edit snapshot', () => {
    create();
    const state = readProviderEditState(dir);
    fs.appendFileSync(path.join(dir, 'models.json'), '\n');
    assert.throws(() => editProviderConfig(dir, { model: state.model, key: 'replacement' }, state.revision), fails('changed'));
    assert.match(config(), /sk-test-key/);
  });

  test('native project trust and supported reasoning effort remain readable and survive key or model edits', () => {
    create();
    const source = config().replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "max"')
      + '\n[projects."/work/project.with.dots=and]brackets"]\ntrust_level = "trusted" # retain this comment\n';
    fs.writeFileSync(path.join(dir, 'config.toml'), source);
    validateProviderConfig(dir);
    assert.equal(readProviderInfo(dir)?.configured, true);
    const state = readProviderEditState(dir);
    editProviderConfig(dir, { model: 'deepseek-v4-pro', key: 'replacement' }, state.revision);
    assert.equal(config(), source.replace('model = "deepseek-flash"', 'model = "deepseek-v4-pro"').replace('sk-test-key', 'replacement'));
    assert.equal(readProviderInfo(dir)?.configured, true);
  });

  test('native removal of an explicit reasoning effort is preserved when editing', () => {
    create();
    fs.writeFileSync(path.join(dir, 'config.toml'), config().replace('model_reasoning_effort = "high"\n', ''));
    validateProviderConfig(dir);
    const state = readProviderEditState(dir);
    editProviderConfig(dir, { model: state.model, key: 'replacement' }, state.revision);
    assert.equal(config().includes('model_reasoning_effort'), false);
  });

  test('escaped owned key names cannot silently skip a requested model or key edit', () => {
    create();
    const source = config();
    for (const entry of [
      { text: source.replace('model =', '"\\u006dodel" ='), model: 'deepseek-v4-pro', key: '' },
      { text: source.replace('experimental_bearer_token =', '"experimental_bearer_toke\\u006e" ='), model: 'deepseek-flash', key: 'replacement' },
    ]) {
      fs.writeFileSync(path.join(dir, 'config.toml'), entry.text);
      const state = readProviderEditState(dir);
      assert.throws(() => editProviderConfig(dir, { model: entry.model, key: entry.key }, state.revision), fails('format'));
      assert.equal(config(), entry.text);
    }
  });

  test('operational reads and editing both skip unrelated complete values', () => {
    create();
    const extra = 'notes = """\n[model_providers.deepseek]\nexperimental_bearer_token = "ignored"\n"""\n';
    fs.writeFileSync(path.join(dir, 'config.toml'), extra + config()
      + '\n[notice]\nflag = true\n[[skills.config]]\npath = "one"\n[[skills.config]]\npath = "two"\n');
    validateProviderConfig(dir);
    assert.equal(readProviderInfo(dir)?.configured, true);
    assert.equal(readProviderEditState(dir).model, 'deepseek-flash');
  });

  test('tables Codex writes on its own do not block editing and stay byte-identical', () => {
    create();
    const source = config() + '\n[tui]\nscreen_reader_detection_done = true\n[tui.model_availability_nux]\n"deepseek-flash" = 1\n'
      + '[notice]\nhide_full_access_warning = true\n[hooks.state."hook:one"]\ntrusted_hash = "abc"\n'
      + '[mcp_servers.tool]\ncommand = "tool"\nargs = [\n  "--flag",\n]\n';
    fs.writeFileSync(path.join(dir, 'config.toml'), source);
    const state = readProviderEditState(dir);
    editProviderConfig(dir, { model: 'deepseek-v4-pro', key: 'replacement' }, state.revision);
    assert.equal(config(), source.replace('model = "deepseek-flash"', 'model = "deepseek-v4-pro"').replace('sk-test-key', 'replacement'));
  });

  test('editing leaves look-alike lines inside multiline values untouched', () => {
    create();
    const extra = 'notes = """\nmodel = "inside"\n[model_providers.deepseek]\nexperimental_bearer_token = "ignored"\n"""\n';
    const source = extra + config();
    fs.writeFileSync(path.join(dir, 'config.toml'), source);
    const state = readProviderEditState(dir);
    editProviderConfig(dir, { model: 'deepseek-v4-pro', key: 'replacement' }, state.revision);
    assert.equal(config(), extra + source.slice(extra.length).replace('model = "deepseek-flash"', 'model = "deepseek-v4-pro"').replace('sk-test-key', 'replacement'));
  });

  test('a missing key is inserted under the real provider table, not a look-alike inside a multiline value', () => {
    create();
    const extra = 'notes = """\n[model_providers.deepseek]\n"""\n';
    fs.writeFileSync(path.join(dir, 'config.toml'), extra + config().replace(/^experimental_bearer_token = .*\n/m, ''));
    assert.equal(readProviderInfo(dir)?.error, 'key');
    const state = readProviderEditState(dir);
    editProviderConfig(dir, { model: state.model, key: 'replacement' }, state.revision);
    assert.equal(readProviderInfo(dir)?.configured, true);
    assert.ok(config().startsWith(extra));
  });

  test('generated config holds only settings the Codex CLI recognizes', () => {
    create();
    assert.equal(config().includes('preferred_auth_method'), false);
    assert.match(config(), /^forced_login_method = "api"$/m);
  });

  test('alternate authentication or routing is still refused by operational validation', () => {
    create();
    const source = config();
    for (const changed of [
      'profile = "other"\n' + source,
      source + '\n[model_providers.deepseek.auth]\ncommand = "other"\n',
      source + 'requires_openai_auth = true\n',
    ]) {
      fs.writeFileSync(path.join(dir, 'config.toml'), changed);
      assert.throws(() => validateProviderConfig(dir), fails('format'));
    }
  });

  test('a missing or damaged catalog does not report a configured card', () => {
    create();
    fs.writeFileSync(path.join(dir, 'models.json'), '{"models":[]}');
    assert.equal(readProviderInfo(dir)?.error, 'catalog');
    assert.throws(() => validateProviderConfig(dir), fails('catalog'));
    fs.unlinkSync(path.join(dir, 'models.json'));
    assert.equal(readProviderInfo(dir)?.configured, false);
  });

  test('unmarked DeepSeek configs are preserved but not adopted', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model_provider = "deepseek"\n');
    assert.equal(preserveProviderConfig(dir), true);
    assert.equal(readProviderInfo(dir)?.error, 'unmanaged');
    assert.equal(readProviderInfo(dir)?.provider, 'deepseek', 'an unmarked DeepSeek config still shows as DeepSeek');
    assert.deepEqual(copyCodexSeed(def, dir), { copied: [], skipped: [] });
  });

  test('an unused DeepSeek provider definition does not reclassify a subscription account', () => {
    for (const selection of ['', 'model_provider = "openai"\n']) {
      fs.writeFileSync(path.join(dir, 'config.toml'), selection + '[model_providers.deepseek]\nbase_url = "https://api.deepseek.com/"\n');
      assert.equal(preserveProviderConfig(dir), false);
      assert.equal(readProviderInfo(dir), undefined);
    }
    for (const source of [
      '[profiles.deepseek]\nmodel_provider = "deepseek"\n',
      'notes = """\nmodel_provider = "deepseek"\n"""\n',
    ]) {
      fs.writeFileSync(path.join(dir, 'config.toml'), source);
      assert.equal(readProviderInfo(dir), undefined);
    }
    fs.writeFileSync(path.join(dir, 'config.toml'), 'notes = """\nmodel_provider = "openai"\n"""\nmodel_provider = "deepseek"\n');
    assert.equal(readProviderInfo(dir)?.error, 'unmanaged');
  });
});

describe('API services other than DeepSeek', () => {
  const createService = (service: Parameters<typeof createProviderConfig>[1], input: { model: string; key: string; baseUrl?: string }) =>
    createProviderConfig(dir, service, input, def);

  test('a preset writes one planswap provider at its endpoint, without a model catalog', () => {
    createService('openrouter', { model: 'vendor/model-1', key: 'sk-or-test' });
    assert.equal(read(path.join(dir, '.planswap-provider.json')), '{"version":1,"provider":"openrouter"}\n');
    assert.match(config(), /^model = "vendor\/model-1"$/m);
    assert.match(config(), /^model_provider = "planswap"$/m);
    assert.match(config(), /^\[model_providers\.planswap\]$/m);
    assert.match(config(), /^base_url = "https:\/\/openrouter\.ai\/api\/v1"$/m);
    assert.match(config(), /^wire_api = "responses"$/m);
    assert.equal(config().includes('model_catalog_json'), false);
    assert.equal(fs.existsSync(path.join(dir, 'models.json')), false);
    for (const file of ['.planswap-provider.json', 'config.toml']) assertMode(path.join(dir, file), '600');
    assert.deepEqual(readProviderInfo(dir), { provider: 'openrouter', model: 'vendor/model-1', host: 'openrouter.ai', configured: true, error: undefined });
    assert.equal(JSON.stringify(readProviderInfo(dir)).includes('sk-or-test'), false);
  });

  test('a local server needs no key; a cloud preset does', () => {
    createService('ollama', { model: 'qwen3-coder', key: '' });
    assert.equal(config().includes('experimental_bearer_token'), false);
    assert.match(config(), /^base_url = "http:\/\/localhost:11434\/v1"$/m);
    validateProviderConfig(dir);
    assert.equal(readProviderInfo(dir)?.configured, true);
    const other = path.join(temp.home, '.codex-zai');
    fs.mkdirSync(other, { mode: 0o700 });
    assert.throws(() => createProviderConfig(other, 'zai', { model: 'glm-x', key: '' }, def), fails('key'));
    assert.deepEqual(fs.readdirSync(other), []);
  });

  test('endpoints must be https, or http on this machine, without credentials, query or fragment', () => {
    for (const url of ['https://ai.example.test/v1', 'http://localhost:4000/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8000/v1']) {
      assert.equal(checkBaseUrl(url), url);
    }
    for (const url of ['http://ai.example.test/v1', 'ftp://ai.example.test', 'https://user:pass@ai.example.test/v1',
      'https://ai.example.test/v1?key=1', 'https://ai.example.test/v1#x', 'https://ai.example.test/v1?', 'https://ai.example.test/v1#', 'not a url', '', 'https://ai.example.test/v 1']) {
      assert.throws(() => checkBaseUrl(url), fails('url'), url);
    }
    assert.throws(() => createService('custom', { model: 'm', key: '', baseUrl: 'http://ai.example.test/v1' }), fails('url'));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('editing changes the model and endpoint, keeps or adds the key, and keeps native settings', () => {
    createService('custom', { model: 'gateway-model', key: '', baseUrl: 'https://gw.example.test/v1' });
    const native = '\n[tui]\nscreen_reader_detection_done = true\n';
    fs.appendFileSync(path.join(dir, 'config.toml'), native);
    let state = readProviderEditState(dir);
    assert.deepEqual({ ...state, revision: undefined }, { service: 'custom', model: 'gateway-model', baseUrl: 'https://gw.example.test/v1', hasKey: false, revision: undefined });
    editProviderConfig(dir, { model: 'other-model', key: '', baseUrl: 'https://gw2.example.test/v1' }, state.revision);
    assert.match(config(), /^model = "other-model"$/m);
    assert.match(config(), /^base_url = "https:\/\/gw2\.example\.test\/v1"$/m);
    assert.equal(config().includes('experimental_bearer_token'), false);
    assert.ok(config().endsWith(native));
    state = readProviderEditState(dir);
    editProviderConfig(dir, { model: 'other-model', key: 'sk-gateway' }, state.revision);
    assert.match(config(), /^\[model_providers\.planswap\]\n(?:.*\n)*experimental_bearer_token = "sk-gateway"$/m);
    assert.equal(readProviderEditState(dir).hasKey, true);
    state = readProviderEditState(dir);
    assert.throws(() => editProviderConfig(dir, { model: 'other-model', key: '', baseUrl: 'http://gw.example.test/v1' }, state.revision), fails('url'));
    assert.match(config(), /gw2\.example\.test/);
  });

  test('routing changes and a model catalog are refused; reasoning effort chosen in Codex is kept', () => {
    createService('kimi', { model: 'kimi-model', key: 'sk-kimi' });
    const source = config();
    fs.writeFileSync(path.join(dir, 'config.toml'), source.replace('forced_login_method = "api"', 'forced_login_method = "api"\nmodel_reasoning_effort = "medium"'));
    validateProviderConfig(dir);
    for (const changed of [
      source.replace('model_provider = "planswap"', 'model_provider = "openai"'),
      source.replace('[model_providers.planswap]', '[model_providers.other]'),
      source.replace('wire_api = "responses"', 'wire_api = "chat"'),
      source + 'model_catalog_json = "/elsewhere/models.json"\n',
      `model_catalog_json = ${JSON.stringify(path.join(dir, 'models.json'))}\n` + source,
      'openai_base_url = "https://elsewhere.example.test"\n' + source,
    ]) {
      fs.writeFileSync(path.join(dir, 'config.toml'), changed);
      assert.throws(() => validateProviderConfig(dir), (error: unknown) => error instanceof ProviderConfigError, changed);
    }
  });

  test('sharing keeps the card config local and never adopts the default config', () => {
    fs.writeFileSync(path.join(def, 'config.toml'), 'model = "gpt-default"\n');
    createService('xai', { model: 'grok-model', key: 'sk-xai' });
    const before = config();
    ensureCodexLinks(dir, {}, proc);
    assert.equal(fs.lstatSync(path.join(dir, 'config.toml')).isSymbolicLink(), false);
    assert.equal(config(), before);
    assert.equal(read(path.join(def, 'config.toml')), 'model = "gpt-default"\n');
  });
});

describe('provider files stay independent throughout sharing', SHARING, () => {
  test('creation, repair and both conversions preserve provider files even with no default config', () => {
    create();
    const before = owned();
    ensureCodexLinks(dir, {}, proc);
    assert.equal(isSharedCodexAccount(dir), true);
    ensureCodexLinks(dir, {}, proc);
    assert.deepEqual(owned(), before);
    assert.equal(fs.existsSync(path.join(def, 'config.toml')), false);
    makeCodexIndependent(dir, 'deepseek-dev', proc);
    assert.equal(isSharedCodexAccount(dir), false);
    assert.deepEqual(owned(), before);
    migrateCodexToShared(dir, 'deepseek-dev', proc);
    assert.equal(isSharedCodexAccount(dir), true);
    assert.deepEqual(owned(), before);
    assert.equal(fs.existsSync(path.join(def, 'config.toml')), false);
    for (const file of PROVIDER_FILES) assert.equal(fs.lstatSync(path.join(dir, file)).isSymbolicLink(), false);
  });

  test('independent copying does not restore a missing API config from default', () => {
    create();
    fs.unlinkSync(path.join(dir, 'config.toml'));
    fs.writeFileSync(path.join(def, 'config.toml'), 'model = "subscription"\n');
    copyCodexIndependent(dir);
    assert.equal(fs.existsSync(path.join(dir, 'config.toml')), false);
    assert.equal(readProviderInfo(dir)?.configured, false);
  });

  test('invalid marker stops sharing before writes and does not fall back to subscription behavior', () => {
    fs.writeFileSync(path.join(dir, PROVIDER_FILES[0]), '{"provider":"other"}');
    const before = snapshot(temp.home);
    for (const action of [() => ensureCodexLinks(dir, {}, proc), () => copyCodexIndependent(dir), () => migrateCodexToShared(dir, 'deepseek-dev', proc)]) {
      assert.throws(action, fails('marker'));
      assert.deepEqual(snapshot(temp.home), before);
    }
    assert.equal(readProviderInfo(dir)?.error, 'marker');
  });

  test('unmarked DeepSeek config is not moved into an empty default home', () => {
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model_provider = "deepseek"\n');
    migrateCodexToShared(dir, 'deepseek-dev', proc);
    assert.equal(config(), 'model_provider = "deepseek"\n');
    assert.equal(fs.existsSync(path.join(def, 'config.toml')), false);
  });
});

test('provider file links stop editing and sharing without touching their target', FILE_SYMLINKS, () => {
  create();
  fs.renameSync(path.join(dir, 'config.toml'), path.join(def, 'config.toml'));
  fs.symlinkSync(path.join(def, 'config.toml'), path.join(dir, 'config.toml'), 'file');
  const before = snapshot(temp.home);
  assert.throws(() => readProviderEditState(dir), fails('file'));
  assert.throws(() => ensureCodexLinks(dir, {}, proc), fails('file'));
  assert.deepEqual(snapshot(temp.home), before);
});

test('hard-linked provider files are not edited or shared', () => {
  create();
  fs.linkSync(path.join(dir, 'config.toml'), path.join(def, 'copy.toml'));
  const before = snapshot(temp.home);
  assert.throws(() => readProviderEditState(dir), fails('file'));
  assert.throws(() => ensureCodexLinks(dir, {}, proc), fails('file'));
  assert.deepEqual(snapshot(temp.home), before);
});
