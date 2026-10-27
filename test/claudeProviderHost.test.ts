// Claude API cards in the host: the add flow, panel rows, model lists, editing, switching, sharing and the exclusions
// from every subscription path. 'vscode' is aliased to ./stubs/vscode.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AccountStore } from '../src/accounts';
import { claudePanelSource, type AccountsPanel } from '../src/accountsPanel';
import { ensureClaudeLinks, isSharedClaudeAccount, makeClaudeIndependent, migrateClaudeToShared, copyClaudeIndependent } from '../src/claudeShare';
import { registerCommands } from '../src/commands';
import { claudeIdentity } from '../src/identityWarnings';
import { LabelStore } from '../src/labels';
import { RecommendExclusions, recommend } from '../src/recommend';
import { ClaudeModelCache } from '../src/claudeModelCache';
import { copySettingsStripped } from '../src/paths';
import { t } from '../src/i18n';
import type { AccountView, FromWebview, ToWebview } from '../src/protocol';
import { StatusBar } from '../src/statusBar';
import { makeTempHome, MemoryMemento, SHARING } from './helpers';
import { resetConfig, setConfig, statusBarItems, tooltipText, updates, window } from './stubs/vscode';

function harness() {
  resetConfig();
  // The panel's switch confirmation is not under test
  setConfig('planswap', 'claude.confirmSwitch', false);
  const tmp = makeTempHome('claude-card-host');
  const state = new MemoryMemento();
  const store = new AccountStore(state);
  const labels = new LabelStore(state, 'claude.labels');
  const exclusions = new RecommendExclusions(state, 'claude.recommendExcluded');
  const modelCache = new ClaudeModelCache(state);
  const checked: string[] = [];
  const source = claudePanelSource(store, labels, exclusions, () => ({ unavailable: false, checking: false }), modelCache);
  const messages: ToWebview[] = [];
  let handle!: (msg: FromWebview) => Promise<void>;
  const panel = {
    visible: true,
    setHandler(_mode: string, callback: typeof handle) { handle = callback; },
    resolve(_mode: string, dir: string) { return source.accounts().find((row) => row.dir === dir); },
    refresh() {},
    setSwitchedTo() {},
    post(message: ToWebview) { messages.push(message); },
  } as unknown as AccountsPanel;
  const statusBar = { update() {} } as unknown as StatusBar;
  const disposables = registerCommands({
    store, panel, statusBar, labels, exclusions, tools: {}, modelCache, procRoot: path.join(tmp.home, 'fakeproc'),
    checkSubscription: async (dir) => { checked.push(dir); },
  });
  return {
    home: tmp.home, store, source, messages, state, exclusions, checked,
    dir: (name: string) => path.join(tmp.home, `.claude-${name}`),
    row: (name: string): AccountView | undefined => source.accounts().find((r) => r.dir === path.join(tmp.home, `.claude-${name}`)),
    handle: (msg: FromWebview) => handle(msg),
    last: () => messages.at(-1) as { type: string; error?: string; models?: string[] },
    close() { disposables.forEach((d) => d.dispose()); tmp.restore(); resetConfig(); },
  };
}

const deepseek = { service: 'deepseek', key: 'synthetic-claude-key', model: 'deepseek-v4-pro' };
const settingsOf = (dir: string): { env: Record<string, string> } => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
const configuredEnv = (): Array<{ name: string; value: string }> | undefined =>
  updates.filter((u) => u.section === 'claudeCode').at(-1)?.value as Array<{ name: string; value: string }> | undefined;

function mockFetch(ctx: { mock: { method: typeof import('node:test').mock.method } }, answer: () => Promise<Response> | Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  ctx.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return answer(); });
  return calls;
}

test('an independent card is created from the form fields, shows only provider status and is not switched to', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'ds', shared: false, provider: deepseek });
    assert.deepEqual(h.last(), { type: 'addResult', mode: 'claude', error: undefined });
    const dir = h.dir('ds');
    assert.ok(h.store.find('ds'));
    assert.equal(settingsOf(dir).env.ANTHROPIC_AUTH_TOKEN, 'synthetic-claude-key');
    assert.equal(fs.existsSync(path.join(dir, '.credentials.json')), false);
    const row = h.row('ds')!;
    assert.deepEqual(
      [row.provider, row.providerService, row.providerModel, row.providerHasKey, row.providerConfigured, row.loggedIn, row.usageEligible, row.usage, row.email],
      ['DeepSeek API', 'deepseek', 'deepseek-v4-pro', true, true, false, false, undefined, undefined]);
    assert.equal(row.shared, false);
    assert.equal(configuredEnv(), undefined, 'creation never switches');
    assert.doesNotMatch(JSON.stringify({ rows: h.source.accounts(), messages: h.messages }), /synthetic-claude-key/);
    const services = h.source.apiServices!();
    assert.deepEqual(services.map((s) => s.id), ['deepseek', 'kimi', 'ollama', 'openrouter', 'zai', 'custom']);
    assert.deepEqual(services[0].models, ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(services.at(-1)?.name, '');
    assert.ok(h.source.watchTargets().includes(path.join(dir, '.planswap-provider.json')));
  } finally { h.close(); }
});

test('a missing required key, an unusable endpoint, a bad model or an unknown service creates nothing', async () => {
  const h = harness();
  try {
    for (const [name, provider] of [
      ['nokey', { service: 'openrouter', key: '', model: 'vendor/m' }],
      ['remote', { service: 'custom', baseUrl: 'http://remote.example.test', key: '', model: 'm' }],
      ['nourl', { service: 'custom', key: '', model: 'm' }],
      ['badmodel', { service: 'kimi', key: 'k', model: 'a model' }],
      ['unknown', { service: 'elsewhere', key: 'k', model: 'm' }],
    ] as const) {
      await h.handle({ type: 'add', mode: 'claude', name, shared: false, provider });
      assert.ok(h.last().error, name);
      assert.equal(fs.existsSync(h.dir(name)), false, name);
      assert.equal(h.store.find(name), undefined, name);
    }
    // An existing folder is never adopted
    fs.mkdirSync(h.dir('kept'));
    await h.handle({ type: 'add', mode: 'claude', name: 'kept', shared: false, provider: deepseek });
    assert.equal(h.last().error, t('codex.provider.dirExists', { dir: h.dir('kept') }));
    assert.deepEqual(fs.readdirSync(h.dir('kept')), []);
  } finally { h.close(); }
});

test('a failure after the folder was made removes it again', async () => {
  const h = harness();
  try {
    // The default projects entry is a file: linking fails after the card files were written
    fs.mkdirSync(path.join(h.home, '.claude'));
    fs.writeFileSync(path.join(h.home, '.claude', 'projects'), '');
    await h.handle({ type: 'add', mode: 'claude', name: 'broken', shared: true, provider: deepseek });
    assert.equal(h.last().error, `${t('codex.provider.createFailed', { dir: h.dir('broken') })} ${t('codex.provider.error.write')}`);
    assert.equal(fs.existsSync(h.dir('broken')), false);
    assert.equal(h.store.find('broken'), undefined);
  } finally { h.close(); }
});

test('a linked card links the shared entries but keeps both provider files and never gives the default its env', SHARING, async () => {
  const h = harness();
  try {
    const def = path.join(h.home, '.claude');
    fs.mkdirSync(def);
    fs.writeFileSync(path.join(def, 'settings.json'), '{"theme":"dark"}\n');
    await h.handle({ type: 'add', mode: 'claude', name: 'linked', shared: true, provider: deepseek });
    assert.equal(h.last().error, undefined);
    const dir = h.dir('linked');
    assert.equal(isSharedClaudeAccount(dir), true);
    for (const file of ['settings.json', '.planswap-provider.json']) assert.equal(fs.lstatSync(path.join(dir, file)).isSymbolicLink(), false, file);
    assert.equal(settingsOf(dir).env.ANTHROPIC_AUTH_TOKEN, 'synthetic-claude-key');
    assert.equal(fs.readFileSync(path.join(def, 'settings.json'), 'utf8'), '{"theme":"dark"}\n');
    assert.equal(fs.existsSync(path.join(def, '.planswap-provider.json')), false);
    assert.equal(h.row('linked')?.shared, true);

    // Unshare and share again: the provider files stay byte for byte, the default settings unchanged
    const before = ['settings.json', '.planswap-provider.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    makeClaudeIndependent(path.join(h.home, '.claude.json'), dir);
    assert.equal(isSharedClaudeAccount(dir), false);
    migrateClaudeToShared(dir, 'linked', path.join(h.home, 'fakeproc'));
    assert.equal(isSharedClaudeAccount(dir), true);
    assert.deepEqual(['settings.json', '.planswap-provider.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), before);
    assert.equal(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(def, 'settings.json'), 'utf8'), '{"theme":"dark"}\n');
    assert.deepEqual(ensureClaudeLinks(dir, path.join(h.home, 'fakeproc'), { check: true }).conflicts, []);
  } finally { h.close(); }
});

test('sharing refuses a card whose own settings.json is a link, and nothing copies settings into a card', SHARING, async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'card', shared: false, provider: deepseek });
    const dir = h.dir('card');
    const def = path.join(h.home, '.claude');
    fs.mkdirSync(def, { recursive: true });
    fs.writeFileSync(path.join(def, 'settings.json'), '{}\n');
    assert.equal(copySettingsStripped(def, dir), false);
    const own = path.join(dir, 'settings.json');
    fs.renameSync(own, path.join(h.home, 'moved.json'));
    fs.symlinkSync(path.join(h.home, 'moved.json'), own, 'file');
    const message = t('claude.provider.notLocal', { dir });
    assert.throws(() => ensureClaudeLinks(dir, path.join(h.home, 'fakeproc')), { message });
    assert.throws(() => migrateClaudeToShared(dir, 'card', path.join(h.home, 'fakeproc')), { message });
    assert.throws(() => copyClaudeIndependent(path.join(h.home, '.claude.json'), dir), { message });
    assert.equal(isSharedClaudeAccount(dir), false);
  } finally { h.close(); }
});

test('switching validates the card first and writes only CLAUDE_CONFIG_DIR', async () => {
  const h = harness();
  const errors: string[] = [];
  const original = window.showErrorMessage;
  window.showErrorMessage = async (...args: unknown[]) => { errors.push(String(args[0])); return undefined; };
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'ds', shared: false, provider: deepseek });
    const dir = h.dir('ds');
    await h.handle({ type: 'switch', mode: 'claude', dir });
    assert.deepEqual(configuredEnv(), [{ name: 'CLAUDE_CONFIG_DIR', value: dir }]);
    // Back to the default, then break the card: the switch is refused with the reason
    await h.handle({ type: 'switch', mode: 'claude', dir: path.join(h.home, '.claude') });
    const count = updates.length;
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"env":{}}\n');
    await h.handle({ type: 'switch', mode: 'claude', dir });
    assert.equal(updates.length, count);
    assert.match(errors.at(-1) ?? '', /API card configuration is invalid/);
  } finally { window.showErrorMessage = original; h.close(); }
});

test('cards are left out of identity, recommendations, subscription checks and recommendation marks', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'ds', shared: false, provider: deepseek });
    const dir = h.dir('ds');
    // Even an info file with a sign-in (written by Claude Code itself) does not make the card an identity
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@example.test', accountUuid: 'a', organizationUuid: 'o' },
      cachedUsageUtilization: {} }));
    assert.equal(claudeIdentity(dir), undefined);
    assert.equal(h.source.identityOf!(dir), undefined);
    const row = h.row('ds')!;
    assert.equal(row.email, undefined);
    assert.equal(row.usageEligible, false);
    await h.handle({ type: 'subscriptionCheck', mode: 'claude', dir });
    assert.deepEqual(h.checked, []);
    await h.handle({ type: 'recommendExclude', mode: 'claude', dir, excluded: true });
    assert.equal(h.exclusions.has('ds'), false);
    // Neither recommended nor counted, even with a usage observation
    const usage = { windows: [{ usedPercent: 0, windowMinutes: 300 }], checkedAt: 1 };
    const rows: AccountView[] = [
      { kind: 'default', name: 'default', label: 'default', dir: '/d', dirLabel: '/d', loggedIn: true, isCurrent: true, usage: { windows: [{ usedPercent: 95, windowMinutes: 300 }], checkedAt: 1 } },
      { ...row, usage },
    ];
    assert.equal(recommend(rows, 10), undefined);
  } finally { h.close(); }
});

test('editing keeps the saved key; an ordinary account cannot be edited as a card', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'gw', shared: false, provider: { service: 'custom', baseUrl: 'https://gw.example.test/anthropic', key: 'saved-key', model: 'm1' } });
    const dir = h.dir('gw');
    await h.handle({ type: 'saveProvider', mode: 'claude', dir, model: 'm2', key: '' });
    assert.deepEqual(h.last(), { type: 'saveProviderResult', mode: 'claude', dir, error: undefined });
    assert.equal(settingsOf(dir).env.ANTHROPIC_AUTH_TOKEN, 'saved-key');
    assert.equal(settingsOf(dir).env.ANTHROPIC_MODEL, 'm2');
    assert.equal(h.row('gw')?.providerModel, 'm2');
    // Another endpoint keeps the saved key: the user decides, the form only reminds
    await h.handle({ type: 'saveProvider', mode: 'claude', dir, model: 'm2', baseUrl: 'https://other.example.test', key: '' });
    assert.equal(h.last().error, undefined);
    assert.equal(settingsOf(dir).env.ANTHROPIC_BASE_URL, 'https://other.example.test');
    assert.equal(settingsOf(dir).env.ANTHROPIC_AUTH_TOKEN, 'saved-key');
    // An unmarked account
    fs.mkdirSync(h.dir('plain'));
    await h.store.add({ name: 'plain', dir: h.dir('plain') });
    await h.handle({ type: 'saveProvider', mode: 'claude', dir: h.dir('plain'), model: 'm', key: 'k' });
    assert.equal(h.last().error, t('claude.provider.error.unmanaged'));
    assert.equal(fs.existsSync(path.join(h.dir('plain'), 'settings.json')), false);
    assert.doesNotMatch(JSON.stringify(h.messages), /saved-key/);
  } finally { h.close(); }
});

test('model lists: DeepSeek fixed; others through claudeModelsUrl with the typed key or the card\'s own saved key', async (ctx) => {
  const h = harness();
  const answer = { current: (): Response => new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] })) };
  const calls = mockFetch(ctx, () => answer.current());
  try {
    await h.handle({ type: 'providerModels', mode: 'claude', request: 1, service: 'deepseek', key: '' });
    assert.deepEqual(h.last().models, ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(calls.length, 0);
    await h.handle({ type: 'providerModels', mode: 'claude', request: 2, service: 'kimi', key: 'typed-key' });
    assert.deepEqual(h.last().models, ['a', 'b']);
    assert.equal(calls[0].url, 'https://api.moonshot.ai/v1/models');
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer typed-key');
    assert.equal(headers['x-api-key'], 'typed-key');
    assert.equal(calls[0].init?.redirect, 'error');
    // A preset list at its own endpoint is cached for the next form
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.source.apiServices!().find((s) => s.id === 'kimi')?.models, ['a', 'b']);
    // Custom endpoints are never cached
    await h.handle({ type: 'providerModels', mode: 'claude', request: 3, service: 'custom', baseUrl: 'https://gw.example.test/anthropic', key: 'k' });
    assert.equal(calls.at(-1)?.url, 'https://gw.example.test/anthropic/v1/models');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.source.apiServices!().find((s) => s.id === 'custom')?.models, undefined);

    await h.handle({ type: 'add', mode: 'claude', name: 'gw', shared: false, provider: { service: 'custom', baseUrl: 'https://gw.example.test/anthropic', key: 'saved-key', model: 'a' } });
    const dir = h.dir('gw');
    await h.handle({ type: 'providerModels', mode: 'claude', request: 4, service: 'custom', baseUrl: 'https://gw.example.test/anthropic', key: '', dir });
    assert.equal((calls.at(-1)?.init?.headers as Record<string, string>).Authorization, 'Bearer saved-key');
    // A changed endpoint gets the saved key (the edit form reminds the user); another service never does
    await h.handle({ type: 'providerModels', mode: 'claude', request: 5, service: 'custom', baseUrl: 'https://other.example.test/anthropic', key: '', dir });
    assert.equal(calls.at(-1)?.url, 'https://other.example.test/anthropic/v1/models');
    assert.equal((calls.at(-1)?.init?.headers as Record<string, string>).Authorization, 'Bearer saved-key');
    await h.handle({ type: 'providerModels', mode: 'claude', request: 6, service: 'kimi', key: '', dir });
    const other = calls.at(-1)?.init?.headers as Record<string, string>;
    assert.equal(calls.at(-1)?.url, 'https://api.moonshot.ai/v1/models');
    assert.deepEqual([other.Authorization, other['x-api-key']], [undefined, undefined], 'the saved key never goes to another service');
    answer.current = () => new Response('secret body', { status: 401 });
    await h.handle({ type: 'providerModels', mode: 'claude', request: 7, service: 'custom', baseUrl: 'https://gw.example.test/anthropic', key: 'k' });
    assert.match(h.last().error ?? '', /HTTP 401/);
    assert.doesNotMatch(JSON.stringify(h.messages), /saved-key|typed-key|secret body/);
  } finally { h.close(); }
});

test('a card without a saved key loads models from, and saves, a new endpoint without a key typed', async (ctx) => {
  const h = harness();
  const calls = mockFetch(ctx, () => new Response(JSON.stringify({ data: [{ id: 'local-model' }] })));
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'local', shared: false, provider: { service: 'custom', baseUrl: 'http://127.0.0.1:8080', key: '', model: 'local-model' } });
    const dir = h.dir('local');
    await h.handle({ type: 'providerModels', mode: 'claude', request: 1, service: 'custom', baseUrl: 'http://127.0.0.1:18080', key: '', dir });
    assert.deepEqual(h.last().models, ['local-model']);
    assert.equal(calls.at(-1)?.url, 'http://127.0.0.1:18080/v1/models');
    const headers = calls.at(-1)?.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['x-api-key'], undefined);
    await h.handle({ type: 'saveProvider', mode: 'claude', dir, model: 'local-model', baseUrl: 'http://127.0.0.1:18080', key: '' });
    assert.equal(h.last().error, undefined);
    assert.equal(settingsOf(dir).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18080');
  } finally { h.close(); }
});

test('the status bar shows a current card as its label and service, without usage', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'ds', shared: false, provider: deepseek });
    setConfig('claudeCode', 'environmentVariables', [{ name: 'CLAUDE_CONFIG_DIR', value: h.dir('ds') }]);
    const bar = new StatusBar(h.store, new LabelStore(h.state, 'claude.labels'));
    try {
      const tip = tooltipText(statusBarItems.at(-1)!.tooltip);
      assert.match(tip, /ds \(DeepSeek API\)/);
      assert.doesNotMatch(tip, /Not logged in/);
    } finally { bar.dispose(); }
  } finally { h.close(); }
});

test('a Claude card can change its service from the edit form, and its key is revealed only on request', async () => {
  const h = harness();
  try {
    await h.handle({ type: 'add', mode: 'claude', name: 'svc', shared: false, provider: { service: 'kimi', key: 'sk-kimi-saved', model: 'kimi-k2' } });
    const dir = h.dir('svc');
    await h.handle({ type: 'revealProviderKey', mode: 'claude', dir });
    assert.deepEqual(h.last(), { type: 'providerKeyResult', mode: 'claude', dir, key: 'sk-kimi-saved', error: undefined });
    await h.handle({ type: 'saveProvider', mode: 'claude', dir, service: 'openrouter', model: 'vendor/m', key: '' });
    assert.ok(h.last().error, 'OpenRouter needs a key of its own');
    await h.handle({ type: 'saveProvider', mode: 'claude', dir, service: 'ollama', model: 'qwen3', key: '' });
    assert.equal(h.last().error, undefined);
    assert.deepEqual([h.row('svc')?.providerService, h.row('svc')?.providerHasKey, settingsOf(dir).env.ANTHROPIC_BASE_URL], ['ollama', false, 'http://localhost:11434']);
    await h.handle({ type: 'revealProviderKey', mode: 'claude', dir });
    assert.equal((h.last() as { key?: string }).key, undefined, 'the placeholder of a keyless card is not a key');
  } finally { h.close(); }
});
