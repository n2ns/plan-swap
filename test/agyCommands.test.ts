// The agy tab wiring: tab visibility, rows, usage attribution and panel messages, with a fake panel, an in-memory
// sign-in store, fake usage queries and a temporary HOME
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AgyAccounts, accountName, agyAccountsRoot } from '../src/agy/agyAccounts';
import { registerAgy } from '../src/agy/agyCommands';
import type { AgyErrorCode, LiveStore } from '../src/agy/agyLogin';
import type { AgyUsageResult } from '../src/agy/agyUsage';
import type { AccountsPanel, PanelSource } from '../src/accountsPanel';
import { applySidebarDisplay, checkMessage } from '../src/accountsPanel';
import { LabelStore } from '../src/labels';
import type { AccountView, FromWebview, ToWebview } from '../src/protocol';
import { MemoryMemento, makeTempHome, type TempHome } from './helpers';
import { commands as stubCommands, window, type StubTerminal } from './stubs/vscode';

const doc = (email: string, refresh: string) => ({ token: { access_token: `access-${refresh}`, refresh_token: refresh }, auth_method: 'consumer', id_token_email: email });

class MemoryStore implements LiveStore {
  readonly kind = 'keychain' as const;
  constructor(public value?: string) {}
  async read(): Promise<string | undefined> { return this.value; }
  async write(d: Record<string, unknown>): Promise<void> { this.value = JSON.stringify(d); }
  async blocked(): Promise<AgyErrorCode | undefined> { return undefined; }
}

class FakePanel {
  source?: PanelSource;
  handler?: (msg: FromWebview) => void | Promise<void>;
  posted: ToWebview[] = [];
  refreshes = 0;
  setAgySource(s: PanelSource | undefined): void { this.source = s; }
  setHandler(_mode: string, h: (msg: FromWebview) => void | Promise<void>): void { this.handler = h; }
  refresh(): void { this.refreshes++; }
  post(msg: ToWebview): void { this.posted.push(msg); }
  resolve(_mode: string, dir: string): { name: string; dir: string } | undefined {
    const row = this.source?.accounts().find((r) => r.dir === dir);
    return row && { name: row.name, dir: row.dir };
  }
  rows(): AccountView[] { return this.source?.accounts() ?? []; }
}

let tmp: TempHome;
let store: MemoryStore;
let panel: FakePanel;
let state: MemoryMemento;
let disposables: vscode.Disposable[] = [];
let usage: (cli: string | undefined) => Promise<AgyUsageResult>;
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  tmp?.restore();
  tmp = makeTempHome('agy-commands');
  store = new MemoryStore();
  panel = new FakePanel();
  state = new MemoryMemento();
  usage = async () => ({ ok: false, reason: 'timeout' });
});
afterEach(() => { for (const d of disposables) d.dispose(); disposables = []; });
after(() => tmp.restore());

function start(options: { cli?: string; exitWaitMs?: number } = { cli: '/opt/agy' }): AgyAccounts {
  const { cli } = options;
  const accounts = new AgyAccounts(store, agyAccountsRoot(tmp.home));
  disposables = registerAgy({
    panel: panel as unknown as AccountsPanel, state, labels: new LabelStore(state, 'agy.labels'), runGenericTool: async () => undefined,
    store, accounts, findCli: () => cli, readUsage: (c) => usage(c), exitWaitMs: options.exitWaitMs,
  });
  return accounts;
}

const fullUsage = (usedPercent: number): AgyUsageResult => ({ ok: true, usage: { windows: [{ usedPercent, windowMinutes: 300, scope: 'Gemini Models' }], checkedAt: 1 } });

describe('agy tab', () => {
  test('no agy CLI: no tab', () => {
    start({});
    assert.equal(panel.source, undefined);
  });

  test('rows: saved accounts, the signed-in one current, labelled by the local part of the email', async () => {
    const accounts = start();
    store.value = JSON.stringify(doc('b.user@example.com', 'rb'));
    await accounts.sync();
    store.value = JSON.stringify(doc('a.user@example.com', 'ra'));
    usage = async () => fullUsage(40);
    await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
    const rows = panel.rows();
    assert.deepEqual(rows.map((r) => [r.label, r.email, r.isCurrent, r.usageEligible]), [
      ['a.user', 'a.user@example.com', true, true],
      ['b.user', 'b.user@example.com', false, false],
    ]);
    assert.deepEqual(rows[0].usage?.windows, [{ usedPercent: 40, windowMinutes: 300, scope: 'Gemini Models' }]);
    assert.equal(rows[1].usage, undefined, 'another account never gets the signed-in account\'s limits');
  });

  test('a usage answer is dropped when agy\'s sign-in changed during the query', async () => {
    const accounts = start();
    store.value = JSON.stringify(doc('b@example.com', 'rb'));
    await accounts.sync();
    store.value = JSON.stringify(doc('a@example.com', 'ra'));
    usage = async () => {
      store.value = JSON.stringify(doc('b@example.com', 'rb'));
      return fullUsage(10);
    };
    await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
    // A later query that ran while b was signed in before and after may record b; a never gets the answer
    assert.equal((state.get<Record<string, unknown>>('agy.usage') ?? {})[accountName('a@example.com')], undefined);
  });

  test('switch, rename, reorder and terminal messages', async () => {
    const accounts = start();
    store.value = JSON.stringify(doc('b@example.com', 'rb'));
    await accounts.sync();
    store.value = JSON.stringify(doc('a@example.com', 'ra'));
    await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
    const b = panel.rows().find((r) => r.email === 'b@example.com')!;

    await panel.handler!({ type: 'switch', mode: 'agy', dir: b.dir });
    assert.deepEqual(JSON.parse(store.value!), doc('b@example.com', 'rb'));
    assert.equal(panel.rows().find((r) => r.isCurrent)?.email, 'b@example.com');

    await panel.handler!({ type: 'rename', mode: 'agy', dir: b.dir, label: 'Work' });
    assert.deepEqual(panel.posted.at(-1), { type: 'renameResult', mode: 'agy', dir: b.dir, error: undefined });
    assert.equal(panel.rows().find((r) => r.dir === b.dir)?.label, 'Work');

    const a = panel.rows().find((r) => r.email === 'a@example.com')!;
    await panel.handler!({ type: 'reorder', mode: 'agy', dirs: [a.dir, b.dir] });
    assert.deepEqual(state.get('agy.order'), [accountName('a@example.com'), accountName('b@example.com')]);

    await panel.handler!({ type: 'remove', mode: 'agy', dir: b.dir });
    assert.ok(panel.rows().some((r) => r.dir === b.dir), 'the signed-in account is not removed');
    await panel.handler!({ type: 'remove', mode: 'agy', dir: a.dir });
    assert.deepEqual(panel.rows().map((r) => r.email), ['b@example.com']);
  });

  test('a directory that is not a row is ignored', async () => {
    start();
    await settle();
    await panel.handler!({ type: 'switch', mode: 'agy', dir: '/elsewhere' });
    assert.equal(store.value, undefined);
  });
});

test('the Update CLI tool runs agy update with the found CLI', async (ctx) => {
  const created = ctx.mock.method(window, 'createTerminal', window.createTerminal);
  start();
  await panel.handler!({ type: 'tool', mode: 'agy', tool: 'updateCli' });
  assert.deepEqual((created.mock.calls[0].result as StubTerminal).sent, ["'/opt/agy' update"]);
});

test('checkMessage accepts the agy tab and its sign-in tool', () => {
  assert.ok(checkMessage({ type: 'switch', mode: 'agy', dir: '/x' }));
  assert.ok(checkMessage({ type: 'tool', mode: 'agy', tool: 'agySignIn' }));
  assert.equal(checkMessage({ type: 'switch', mode: 'gemini', dir: '/x' }), undefined);
});

test('agy model-group windows follow the 5-hour and 7-day display settings; other scoped windows do not', () => {
  const row: AccountView = { kind: 'named', name: 'g1', label: 'a', dir: '/d', dirLabel: '/d', loggedIn: true, isCurrent: true,
    usage: { checkedAt: 1, windows: [{ usedPercent: 1, windowMinutes: 300, scope: 'Gemini Models' }, { usedPercent: 2, windowMinutes: 10080, scope: 'Gemini Models' }] } };
  const display = { email: true, fiveHour: false, weekly: true };
  assert.deepEqual(applySidebarDisplay([row], display, true)[0].usage?.windows.map((w) => w.windowMinutes), [10080]);
  assert.deepEqual(applySidebarDisplay([row], display)[0].usage?.windows.map((w) => w.windowMinutes), [300, 10080]);
});

describe('review fixes', () => {
  test('while agy reads the Linux keyring, no card is current and no usage is recorded', async () => {
    const blockedStore = Object.assign(new MemoryStore(JSON.stringify(doc('f@example.com', 'rf'))), { blocked: async () => 'linuxKeyring' as AgyErrorCode });
    store = blockedStore;
    const accounts = start();
    await accounts.sync();
    let queried = 0;
    usage = async () => { queried++; return fullUsage(5); };
    await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
    assert.equal(queried, 0);
    assert.deepEqual(state.get('agy.usage') ?? {}, {});
    assert.ok(panel.rows().every((r) => !r.isCurrent && !r.usageEligible));
  });

  test('a switch during a running usage query waits for it and then queries the new account', async () => {
    const accounts = start();
    store.value = JSON.stringify(doc('b@example.com', 'rb'));
    await accounts.sync();
    store.value = JSON.stringify(doc('a@example.com', 'ra'));
    await accounts.sync();
    let release!: () => void;
    const queriedFor: string[] = [];
    usage = async () => {
      queriedFor.push(JSON.parse(store.value!).id_token_email);
      if (queriedFor.length === 1) await new Promise<void>((r) => { release = r; });
      return fullUsage(20);
    };
    const first = panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
    await settle();
    const b = panel.rows().find((r) => r.email === 'b@example.com')!;
    const switching = panel.handler!({ type: 'switch', mode: 'agy', dir: b.dir });
    await settle();
    assert.equal(JSON.parse(store.value!).id_token_email, 'a@example.com', 'the switch waits for the running query');
    release();
    await first;
    await switching;
    for (let i = 0; i < 5; i++) await settle();
    assert.deepEqual(queriedFor, ['a@example.com', 'b@example.com']);
    assert.ok((state.get<Record<string, unknown>>('agy.usage') ?? {})[accountName('b@example.com')]);
  });
});

test('a switch is refused while PlanSwap\'s own usage query process has not ended', async () => {
  const accounts = start({ cli: '/opt/agy', exitWaitMs: 20 });
  store.value = JSON.stringify(doc('b@example.com', 'rb'));
  await accounts.sync();
  store.value = JSON.stringify(doc('a@example.com', 'ra'));
  usage = async () => ({ ok: false, reason: 'stuck', exited: new Promise<void>(() => undefined) });
  await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
  const b = panel.rows().find((r) => r.email === 'b@example.com')!;
  await panel.handler!({ type: 'switch', mode: 'agy', dir: b.dir });
  assert.equal(JSON.parse(store.value!).id_token_email, 'a@example.com');
});

test('a switch from the palette is refused while PlanSwap\'s own usage query process has not ended', async (ctx) => {
  const accounts = start({ cli: '/opt/agy', exitWaitMs: 20 });
  store.value = JSON.stringify(doc('b@example.com', 'rb'));
  await accounts.sync();
  store.value = JSON.stringify(doc('a@example.com', 'ra'));
  usage = async () => ({ ok: false, reason: 'stuck', exited: new Promise<void>(() => undefined) });
  await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
  ctx.mock.method(vscode.window, 'showQuickPick', async (items: Array<{ description?: string }>) => items.find((i) => i.description === 'b@example.com'));
  const errors = ctx.mock.method(vscode.window, 'showErrorMessage', async () => undefined);
  await stubCommands.registered['planswap.agy.switchAccount']();
  assert.equal(JSON.parse(store.value!).id_token_email, 'a@example.com');
  assert.equal(errors.mock.callCount(), 1, 'the switch reaches the refusal');
});

test('a refresh while a stopped query has not exited leaves no finished run behind that blocks later queries', async (ctx) => {
  let focus: ((e: { focused: boolean }) => void) | undefined;
  ctx.mock.method(vscode.window, 'onDidChangeWindowState', (listener: (e: { focused: boolean }) => void) => {
    focus = listener;
    return { dispose() {} };
  });
  const accounts = start({ cli: '/opt/agy', exitWaitMs: 20 });
  store.value = JSON.stringify(doc('a@example.com', 'ra'));
  await accounts.sync();
  let exit!: () => void;
  const exited = new Promise<void>((r) => { exit = r; });
  let queries = 0;
  usage = async () => (++queries === 1 ? { ok: false, reason: 'stuck', exited } : fullUsage(20));
  await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
  await panel.handler!({ type: 'tool', mode: 'agy', tool: 'refreshUsage' });
  assert.equal(queries, 1, 'no second agy beside the stopped one');
  exit();
  for (let i = 0; i < 3; i++) await settle();
  focus!({ focused: true });
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(queries, 2, 'an automatic refresh queries again once the stopped process exited');
});
