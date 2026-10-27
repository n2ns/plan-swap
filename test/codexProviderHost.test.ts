import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkMessage, type AccountsPanel } from '../src/accountsPanel';
import { codexPanelSource, registerCodexCommands } from '../src/codex/codexCommands';
import { CodexAccountStore } from '../src/codex/codexStore';
import { CodexUsageMonitor, queryCodexAccount } from '../src/codex/codexUsageMonitor';
import { readCodexUsage } from '../src/codex/codexUsage';
import { installRcBlocks, readSelectedDir } from '../src/codex/codexState';
import { LabelStore } from '../src/labels';
import { ModelCache } from '../src/codex/modelCache';
import type { FromWebview, ToWebview } from '../src/protocol';
import { LINUX_ONLY, makeTempHome, MemoryMemento } from './helpers';
import { env, window } from './stubs/vscode';

function harness() {
  const tmp = makeTempHome('provider-host');
  const state = new MemoryMemento();
  const store = new CodexAccountStore(state);
  const labels = new LabelStore(state, 'codex.labels');
  const source = codexPanelSource(store, labels);
  const messages: ToWebview[] = [];
  let handle!: (msg: FromWebview) => Promise<void>;
  const panel = {
    setHandler(_mode: string, callback: typeof handle) { handle = callback; },
    resolve(_mode: string, dir: string) { return source.accounts().find((row) => row.dir === dir); },
    refresh() {},
    post(message: ToWebview) { messages.push(message); },
  } as unknown as AccountsPanel;
  const disposables = registerCodexCommands({ store, labels, panel, tools: {} });
  return {
    home: tmp.home, store, source, messages,
    handle: (msg: FromWebview) => handle(msg),
    close() { disposables.forEach((d) => d.dispose()); tmp.restore(); },
  };
}

const deepseekCard = { service: 'deepseek', key: 'synthetic-provider-key', model: 'deepseek-flash' };
// A fetch stand-in for the model-list request: records the URL and headers it was called with
function mockFetch(ctx: { mock: { method: typeof import('node:test').mock.method } }, answer: () => Promise<Response> | Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  ctx.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return answer(); });
  return calls;
}

test('provider actions carry well-formed API card fields, for either page', () => {
  const add = { type: 'add', mode: 'codex', name: 'deepseek', shared: false, provider: deepseekCard };
  assert.deepEqual(checkMessage(add), add);
  assert.deepEqual(checkMessage({ ...add, mode: 'claude' }), { ...add, mode: 'claude' });
  assert.equal(checkMessage({ ...add, provider: 'api' }), undefined);
  assert.equal(checkMessage({ ...add, provider: { ...deepseekCard, model: 1 } }), undefined);
  assert.equal(checkMessage({ ...add, provider: { ...deepseekCard, baseUrl: 2 } }), undefined);
  const models = { type: 'providerModels', mode: 'codex', request: 1, service: 'custom', key: '' };
  assert.deepEqual(checkMessage(models), models);
  assert.deepEqual(checkMessage({ ...models, mode: 'claude' }), { ...models, mode: 'claude' });
  assert.equal(checkMessage({ ...models, request: '1' }), undefined);
  assert.equal(checkMessage({ ...models, dir: 3 }), undefined);
  const save = { type: 'saveProvider', mode: 'codex', dir: '/d', model: 'm', key: '' };
  assert.deepEqual(checkMessage(save), save);
  assert.deepEqual(checkMessage({ ...save, mode: 'claude' }), { ...save, mode: 'claude' });
  assert.equal(checkMessage({ ...save, mode: 'other' }), undefined);
  assert.equal(checkMessage({ type: 'saveProvider', mode: 'codex', dir: '/d', key: '' }), undefined);
});

test('creation takes the sidebar fields, keeps the key out of every view and selects nothing; saving keeps the key', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'codex', name: 'deepseek', shared: false, provider: deepseekCard });
    assert.deepEqual(h.messages.at(-1), { type: 'addResult', mode: 'codex', error: undefined });
    const dir = path.join(h.home, '.codex-deepseek');
    const row = h.source.accounts().find((r) => r.dir === dir);
    assert.deepEqual([row?.provider, row?.providerService, row?.providerHasKey, row?.providerConfigured], ['DeepSeek API', 'deepseek', true, true]);
    assert.equal(row?.usageEligible, undefined);
    assert.equal(readSelectedDir(), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    await h.handle({ type: 'saveProvider', mode: 'codex', dir, model: 'deepseek-v4-pro', key: '' });
    assert.deepEqual(h.messages.at(-1), { type: 'saveProviderResult', mode: 'codex', dir, error: undefined });
    assert.match(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), /synthetic-provider-key/);
    assert.equal(h.source.accounts().find((r) => r.dir === dir)?.providerModel, 'deepseek-v4-pro');
    assert.doesNotMatch(JSON.stringify({ rows: h.source.accounts(), messages: h.messages }), /synthetic-provider-key/);
  } finally { h.close(); }
});

test('a missing required key, an unusable endpoint or an unknown service creates nothing', async () => {
  const h = harness();
  try {
    for (const [name, provider] of [
      ['nokey', { service: 'openrouter', key: '', model: 'vendor/m' }],
      ['remote', { service: 'custom', baseUrl: 'http://remote.example.test/v1', key: '', model: 'm' }],
      ['unknown', { service: 'elsewhere', key: 'k', model: 'm' }],
    ] as const) {
      await h.handle({ type: 'add', mode: 'codex', name, shared: false, provider });
      assert.ok((h.messages.at(-1) as { error?: string }).error, name);
      assert.equal(fs.existsSync(path.join(h.home, `.codex-${name}`)), false, name);
      assert.equal(h.store.find(name), undefined, name);
    }
  } finally { h.close(); }
});

test('a custom endpoint and a local preset take an empty key and show their endpoint host', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'codex', name: 'gateway', shared: false, provider: { service: 'custom', baseUrl: 'https://gateway.example.test/v1', key: '', model: 'gateway-model' } });
    await h.handle({ type: 'add', mode: 'codex', name: 'local', shared: false, provider: { service: 'ollama', key: '', model: 'qwen' } });
    const rows = h.source.accounts();
    const gateway = rows.find((r) => r.dir === path.join(h.home, '.codex-gateway'));
    const local = rows.find((r) => r.dir === path.join(h.home, '.codex-local'));
    assert.deepEqual([gateway?.provider, gateway?.providerBaseUrl, gateway?.providerHost, gateway?.providerHasKey, gateway?.providerConfigured],
      ['Custom API', 'https://gateway.example.test/v1', 'gateway.example.test', false, true]);
    assert.deepEqual([local?.provider, local?.providerHost, local?.providerConfigured], ['Ollama API', 'localhost:11434', true]);
  } finally { h.close(); }
});

test('model lists: DeepSeek from its catalog, others from GET <endpoint>/models with the typed or the saved key', async (ctx) => {
  const h = harness();
  const answer = { current: (): Response => new Response(JSON.stringify({ object: 'list', data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }, { id: 'bad id' }] })) };
  const calls = mockFetch(ctx, () => answer.current());
  const result = () => h.messages.at(-1) as { type: string; request: number; models?: string[]; error?: string };
  try {
    await h.handle({ type: 'providerModels', mode: 'codex', request: 1, service: 'deepseek', key: '' });
    assert.deepEqual(result(), { type: 'providerModelsResult', mode: 'codex', request: 1, models: ['deepseek-flash', 'deepseek-v4-pro'] });
    assert.equal(calls.length, 0, 'DeepSeek models come from its catalog');
    await h.handle({ type: 'providerModels', mode: 'codex', request: 2, service: 'custom', baseUrl: 'https://gw.example.test/v1/', key: 'typed-key' });
    assert.deepEqual(result().models, ['a-model', 'b-model']);
    assert.equal(calls[0].url, 'https://gw.example.test/v1/models');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer typed-key');
    assert.equal(calls[0].init?.redirect, 'error');
    await h.handle({ type: 'providerModels', mode: 'codex', request: 3, service: 'openrouter', key: 'k' });
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/models');
    // Editing: an empty key uses the card's saved key, which never appears in a message
    await h.handle({ type: 'add', mode: 'codex', name: 'saved', shared: false, provider: { service: 'custom', baseUrl: 'https://gw.example.test/v1', key: 'saved-key', model: 'a-model' } });
    await h.handle({ type: 'providerModels', mode: 'codex', request: 4, service: 'custom', baseUrl: 'https://gw.example.test/v1', key: '', dir: path.join(h.home, '.codex-saved') });
    assert.equal((calls.at(-1)?.init?.headers as Record<string, string>).Authorization, 'Bearer saved-key');
    assert.doesNotMatch(JSON.stringify(h.messages), /saved-key|typed-key/);
    // Failures name the status or the cause, never the body
    answer.current = () => new Response('secret body', { status: 401 });
    await h.handle({ type: 'providerModels', mode: 'codex', request: 5, service: 'custom', baseUrl: 'https://gw.example.test/v1', key: 'k' });
    assert.match(result().error ?? '', /HTTP 401/);
    assert.doesNotMatch(result().error ?? '', /secret body/);
    answer.current = () => { throw new TypeError('fetch failed'); };
    await h.handle({ type: 'providerModels', mode: 'codex', request: 6, service: 'custom', baseUrl: 'https://gw.example.test/v1', key: 'k' });
    assert.match(result().error ?? '', /reach the endpoint/);
    answer.current = () => new Response('{"models": []}');
    await h.handle({ type: 'providerModels', mode: 'codex', request: 7, service: 'custom', baseUrl: 'https://gw.example.test/v1', key: 'k' });
    assert.match(result().error ?? '', /OpenAI format/);
    const before = calls.length;
    await h.handle({ type: 'providerModels', mode: 'codex', request: 8, service: 'custom', baseUrl: 'http://remote.example.test/v1', key: 'k' });
    assert.ok(result().error);
    assert.equal(calls.length, before, 'a refused endpoint gets no request');
  } finally { h.close(); }
});

test('invalid provider cards cannot switch or open a subscription sign-in terminal', LINUX_ONLY, async (ctx) => {
  const h = harness();
  const previousRemote = env.remoteName;
  env.remoteName = undefined;
  const terminal = ctx.mock.method(window, 'createTerminal', () => { throw new Error('unexpected terminal'); });
  const error = ctx.mock.method(window, 'showErrorMessage', async () => undefined);
  try {
    const dir = path.join(h.home, '.codex-invalid');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.planswap-provider.json'), '{');
    await h.store.add({ name: 'invalid', dir });
    installRcBlocks();
    await h.handle({ type: 'switch', mode: 'codex', dir });
    await h.handle({ type: 'terminal', mode: 'codex', dir });
    assert.equal(readSelectedDir(), undefined);
    assert.equal(terminal.mock.callCount(), 0);
    assert.equal(error.mock.callCount(), 2);
    const row = h.source.accounts().find((r) => r.dir === dir);
    assert.equal(row?.provider, 'Custom API', 'an unreadable marker shows as a custom card');
    assert.equal(row?.providerConfigured, false);
    assert.equal(row?.usage, undefined);
  } finally { env.remoteName = previousRemote; h.close(); }
});

test('provider homes with auth files bypass subscription reads, cached quota and CLI queries', async () => {
  const tmp = makeTempHome('provider-no-quota');
  try {
    const dir = path.join(tmp.home, '.codex-provider');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.planswap-provider.json'), '{}');
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
    const never = (): never => { throw new Error('subscription path must not run'); };
    const monitor = new CodexUsageMonitor(() => dir, () => {}, {
      read: never, authIdentity: never, authStamp: never, cachedUsage: never, onAccepted: never,
    });
    await monitor.refresh();
    await monitor.refreshIfStale();
    await monitor.refreshIfAuthChanged();
    assert.equal(monitor.adoptCached(), false);
    monitor.clearIfAuthChanged();
    assert.deepEqual(monitor.current(), { checking: false });
    assert.deepEqual(await queryCodexAccount(dir, never, never, { authStamp: never, authIdentity: never }), { ok: false, reason: 'noRateLimits' });
    assert.deepEqual(await readCodexUsage(dir, { spawn: never }), { ok: false, reason: 'noRateLimits' });
  } finally { tmp.restore(); }
});

test('a saved key is only sent to its own card endpoint; a new endpoint needs the key typed again', async (ctx) => {
  const h = harness();
  const calls = mockFetch(ctx, () => new Response(JSON.stringify({ data: [{ id: 'm' }] })));
  try {
    await h.handle({ type: 'add', mode: 'codex', name: 'own', shared: false, provider: { service: 'custom', baseUrl: 'https://own.example.test/v1', key: 'sk-own-saved', model: 'm' } });
    const dir = path.join(h.home, '.codex-own');
    for (const other of [{ service: 'custom', baseUrl: 'https://elsewhere.example.test/v1' }, { service: 'openrouter' }]) {
      await h.handle({ type: 'providerModels', mode: 'codex', request: 9, key: '', dir, ...other });
      assert.ok((h.messages.at(-1) as { error?: string }).error, JSON.stringify(other));
    }
    assert.equal(calls.length, 0, 'the saved key went nowhere');
    await h.handle({ type: 'saveProvider', mode: 'codex', dir, model: 'm', key: '', baseUrl: 'https://elsewhere.example.test/v1' });
    assert.ok((h.messages.at(-1) as { error?: string }).error);
    assert.match(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), /own\.example\.test/);
    await h.handle({ type: 'saveProvider', mode: 'codex', dir, model: 'm', key: 'sk-new', baseUrl: 'https://elsewhere.example.test/v1' });
    assert.equal((h.messages.at(-1) as { error?: string }).error, undefined, 'with the key typed again the endpoint changes');
  } finally { h.close(); }
});

test('a key with inner whitespace is refused before any directory exists', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'codex', name: 'spaced', shared: false, provider: { service: 'openrouter', key: 'sk-abc def', model: 'm' } });
    assert.ok((h.messages.at(-1) as { error?: string }).error);
    assert.equal(fs.existsSync(path.join(h.home, '.codex-spaced')), false);
  } finally { h.close(); }
});

test('a preset list loaded with a key is cached for its service; a custom endpoint list is not', async (ctx) => {
  const tmp = makeTempHome('provider-cache');
  const state = new MemoryMemento();
  const store = new CodexAccountStore(state);
  const labels = new LabelStore(state, 'codex.labels');
  const cache = new ModelCache(state);
  const source = codexPanelSource(store, labels, undefined, undefined, cache);
  const messages: ToWebview[] = [];
  let handle!: (msg: FromWebview) => Promise<void>;
  const panel = {
    setHandler(_mode: string, callback: typeof handle) { handle = callback; },
    resolve(_mode: string, dir: string) { return source.accounts().find((row) => row.dir === dir); },
    refresh() {}, post(message: ToWebview) { messages.push(message); },
  } as unknown as AccountsPanel;
  const disposables = registerCodexCommands({ store, labels, panel, tools: {}, modelCache: cache });
  mockFetch(ctx, () => new Response(JSON.stringify({ data: [{ id: 'kimi-model' }] })));
  try {
    await handle({ type: 'providerModels', mode: 'codex', request: 1, service: 'kimi', key: 'k' });
    await handle({ type: 'providerModels', mode: 'codex', request: 2, service: 'custom', baseUrl: 'https://gw.example.test/v1', key: 'k' });
    await new Promise((r) => setImmediate(r));
    const services = source.apiServices!();
    assert.deepEqual(services.find((s) => s.id === 'kimi')?.models, ['kimi-model']);
    assert.equal(services.find((s) => s.id === 'custom')?.models, undefined);
    assert.deepEqual(services.find((s) => s.id === 'deepseek')?.models, ['deepseek-flash', 'deepseek-v4-pro']);
  } finally { disposables.forEach((d) => d.dispose()); tmp.restore(); }
});
