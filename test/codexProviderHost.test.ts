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

test('provider actions are Codex-only and reject unsupported provider values', () => {
  const add = { type: 'add', mode: 'codex', name: 'deepseek', shared: false, provider: 'deepseek' };
  assert.deepEqual(checkMessage(add), add);
  assert.equal(checkMessage({ ...add, mode: 'claude' }), undefined);
  assert.equal(checkMessage({ ...add, provider: 'another' }), undefined);
  assert.equal(checkMessage({ type: 'editProvider', mode: 'claude', dir: '/unused' }), undefined);
  assert.equal(checkMessage({ type: 'editProvider', mode: 'codex' }), undefined);
});

test('creation uses a password prompt and exposes only configuration status without selecting an account', async (ctx) => {
  const h = harness();
  ctx.mock.method(window, 'showQuickPick', async <T>(items: T[]): Promise<T | undefined> => items[0]);
  const input = ctx.mock.method(window, 'showInputBox', async (_options?: unknown) => 'synthetic-provider-key');
  try {
    await h.handle({ type: 'add', mode: 'codex', name: 'deepseek', shared: false, provider: 'deepseek' });
    assert.deepEqual(h.messages.at(-1), { type: 'addResult', mode: 'codex', error: undefined });
    assert.equal((input.mock.calls[0].arguments[0] as { password: boolean }).password, true);
    const dir = path.join(h.home, '.codex-deepseek');
    const row = h.source.accounts().find((r) => r.dir === dir);
    assert.equal(row?.provider, 'deepseek');
    assert.equal(row?.providerConfigured, true);
    assert.equal(row?.usageEligible, undefined);
    assert.equal(row?.email, undefined);
    assert.equal(readSelectedDir(), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
    assert.doesNotMatch(JSON.stringify({ rows: h.source.accounts(), messages: h.messages }), /synthetic-provider-key/);
    const config = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    assert.match(config, /synthetic-provider-key/);
    const pick = ctx.mock.method(window, 'showQuickPick', async <T>(items: T[]): Promise<T | undefined> => items[1]);
    input.mock.mockImplementation(async () => '');
    await h.handle({ type: 'editProvider', mode: 'codex', dir });
    assert.equal(pick.mock.callCount(), 1);
    assert.match(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), /synthetic-provider-key/);
    assert.equal(h.source.accounts().find((r) => r.dir === dir)?.providerModel, 'deepseek-v4-pro');
  } finally { h.close(); }
});

test('cancelling key entry leaves no new directory or registered card', async (ctx) => {
  const h = harness();
  ctx.mock.method(window, 'showQuickPick', async <T>(items: T[]): Promise<T | undefined> => items[0]);
  ctx.mock.method(window, 'showInputBox', async () => undefined);
  try {
    await h.handle({ type: 'add', mode: 'codex', name: 'cancelled', shared: false, provider: 'deepseek' });
    assert.equal(fs.existsSync(path.join(h.home, '.codex-cancelled')), false);
    assert.equal(h.store.find('cancelled'), undefined);
    assert.equal(readSelectedDir(), undefined);
    const response = h.messages.at(-1);
    assert.ok(response?.type === 'addResult' && response.error);
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
    assert.equal(row?.provider, 'deepseek');
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
