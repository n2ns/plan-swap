import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { AccountsPanel, applySidebarDisplay, claudePanelSource, sidebarThresholds, type PanelSource } from '../src/accountsPanel';
import { AccountStore } from '../src/accounts';
import { LabelStore } from '../src/labels';
import { readAccountInfo } from '../src/paths';
import type { AccountView, FromWebview, ToWebview } from '../src/protocol';
import { makeTempHome, MemoryMemento } from './helpers';
import { intlLocale, setLocale, t } from '../src/i18n';
import { resetConfig, setConfig } from './stubs/vscode';

function harness(claude?: PanelSource) {
  const messages: ToWebview[] = [];
  let receive!: (msg: FromWebview) => void;
  let visibility!: () => void;
  let dispose!: () => void;
  const view = {
    visible: true,
    webview: {
      html: '', options: {}, cspSource: 'test-resource:',
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: async (msg: ToWebview) => { messages.push(msg); return true; },
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
    },
    onDidChangeVisibility: (listener: typeof visibility) => { visibility = listener; },
    onDidDispose: (listener: typeof dispose) => { dispose = listener; },
  };
  const source: PanelSource = claude ?? { accounts: () => [], enabled: () => true, pendingDir: () => undefined, watchTargets: () => [] };
  const panel = new AccountsPanel({ path: '/extension' } as vscode.Uri, { claude: source, codex: source }, new MemoryMemento());
  panel.resolveWebviewView(view as unknown as vscode.WebviewView);
  return { panel, view, messages, receive: (msg: FromWebview) => receive(msg), visible(value: boolean) { view.visible = value; visibility(); }, dispose: () => dispose() };
}

test('add account waits for the first document and sends state before focus', async () => {
  const h = harness();
  try {
    assert.match(h.view.webview.html, /role="status"/);
    await h.panel.focusAdd('codex');
    assert.equal(h.messages.length, 0);
    h.receive({ type: 'ready' });
    assert.deepEqual(h.messages.map((msg) => msg.type), ['state', 'focusAdd']);
    assert.deepEqual(h.messages[1], { type: 'focusAdd', mode: 'codex' });
  } finally { h.panel.dispose(); }
});

test('each tab carries the new-folder prefix in the platform spelling', () => {
  const h = harness();
  try {
    h.receive({ type: 'ready' });
    const msg = h.messages[0];
    assert.ok(msg?.type === 'state');
    assert.equal(msg.state.claude.dirPrefix, `~${path.sep}.claude-`);
    assert.equal(msg.state.codex.dirPrefix, `~${path.sep}.codex-`);
  } finally { h.panel.dispose(); }
});

test('add account waits for the replacement document after hiding the panel', async () => {
  const h = harness();
  try {
    h.receive({ type: 'ready' });
    h.visible(false);
    h.visible(true);
    h.messages.length = 0;
    await h.panel.focusAdd('codex');
    assert.equal(h.messages.length, 0);
    h.receive({ type: 'ready' });
    assert.deepEqual(h.messages.map((msg) => msg.type), ['state', 'focusAdd']);
    assert.deepEqual(h.messages[1], { type: 'focusAdd', mode: 'codex' });
    h.messages.length = 0;
    h.receive({ type: 'ready' });
    assert.deepEqual(h.messages.map((msg) => msg.type), ['state']);
    await h.panel.focusAdd('claude');
    assert.deepEqual(h.messages.at(-1), { type: 'focusAdd', mode: 'claude' });
  } finally { h.panel.dispose(); }
});

for (const locale of ['zh-tw', 'es', 'ja'] as const) {
  test(`${locale}: initial document uses the selected language before frontend startup`, () => {
    setLocale(locale);
    const h = harness();
    try {
      assert.ok(h.view.webview.html.includes(`<html lang="${intlLocale(locale)}">`));
      assert.ok(h.view.webview.html.includes(t('panel.loading')));
    } finally { h.panel.dispose(); setLocale('en'); }
  });
}

test('Claude panel rows show the email but never carry the identity comparison key', async () => {
  const tmp = makeTempHome('panel-identity');
  try {
    const dir = path.join(tmp.home, '.claude-work');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'dummy@example.com', accountUuid: 'dummy-account', organizationUuid: 'dummy-org' },
    }));
    const memento = new MemoryMemento();
    const store = new AccountStore(memento);
    await memento.update('accounts', [{ name: 'work', dir }]);
    assert.ok(readAccountInfo(dir).identity, 'the account info has an identity');

    const rows = claudePanelSource(store, new LabelStore(memento, 'claude.labels')).accounts();
    const row = rows.find((r) => r.dir === dir);
    assert.equal(row?.email, 'dummy@example.com');
    assert.equal(row?.loggedIn, true);
    for (const r of rows) assert.ok(!('identity' in r), `row ${r.name} has no identity`);
  } finally { tmp.restore(); }
});

test('each tab carries the recommendation computed on the full rows; the setting turns it off', () => {
  resetConfig();
  const usage = (used: number) => ({ windows: [{ usedPercent: used, windowMinutes: 300 }], checkedAt: 1 });
  const rows = (): AccountView[] => [
    { kind: 'default', name: 'default', label: 'default', dir: '/h/.claude', dirLabel: '~/.claude', loggedIn: true, isCurrent: true, usage: usage(80) },
    { kind: 'named', name: 'work', label: 'work', dir: '/h/.claude-work', dirLabel: '~/.claude-work', loggedIn: true, isCurrent: false, usage: usage(10) },
  ];
  const h = harness({ accounts: rows, enabled: () => true, pendingDir: () => undefined, watchTargets: () => [] });
  const state = (): ToWebview => { h.messages.length = 0; h.receive({ type: 'ready' }); return h.messages[0]; };
  try {
    let msg = state();
    assert.ok(msg.type === 'state');
    assert.equal(msg.state.claude.recommended, '/h/.claude-work');
    assert.equal(msg.state.claude.hideRecommendation, undefined);
    // The 5-hour window hidden for display still counts for the recommendation
    setConfig('planswap', 'sidebar.showFiveHourLimit', false);
    msg = state();
    assert.ok(msg.type === 'state');
    assert.deepEqual(msg.state.claude.accounts[0].usage, { windows: [], checkedAt: 1 });
    assert.equal(msg.state.claude.recommended, '/h/.claude-work');
    setConfig('planswap', 'sidebar.showRecommendation', false);
    msg = state();
    assert.ok(msg.type === 'state');
    assert.equal(msg.state.claude.recommended, undefined);
    assert.equal(msg.state.claude.hideRecommendation, true);
  } finally { h.panel.dispose(); resetConfig(); }
});

test('the sidebar color thresholds default to 30 / 10 and are clamped to 0..100', () => {
  resetConfig();
  try {
    assert.deepEqual(sidebarThresholds(), { warning: 30, error: 10 });
    setConfig('planswap', 'sidebar.warningThreshold', 60);
    setConfig('planswap', 'sidebar.errorThreshold', -5);
    assert.deepEqual(sidebarThresholds(), { warning: 60, error: 0 });
    setConfig('planswap', 'sidebar.warningThreshold', 'x');
    setConfig('planswap', 'sidebar.errorThreshold', 150);
    assert.deepEqual(sidebarThresholds(), { warning: 30, error: 100 });
  } finally { resetConfig(); }
});

test('the sidebar display settings hide the email and the general 5-hour / 7-day windows of every row', () => {
  const now = Date.now();
  const rows = [{
    name: 'work', dir: '/w', label: 'work', kind: 'named', isCurrent: true, loggedIn: true, email: 'a@example.com', plan: 'Max 5x',
    usage: { checkedAt: now, windows: [{ usedPercent: 10, windowMinutes: 300 }, { usedPercent: 20, windowMinutes: 10080 }, { usedPercent: 30, windowMinutes: 10080, scope: 'Fable' }] },
  }] as Parameters<typeof applySidebarDisplay>[0];
  const all = { email: true, fiveHour: true, weekly: true };
  assert.deepEqual(applySidebarDisplay(rows, all), rows, 'everything shown by default');
  const noEmail = applySidebarDisplay(rows, { ...all, email: false })[0];
  assert.equal(noEmail.email, undefined);
  assert.equal(noEmail.plan, 'Max 5x');
  const noFive = applySidebarDisplay(rows, { ...all, fiveHour: false })[0];
  assert.deepEqual(noFive.usage?.windows.map((w) => w.windowMinutes), [10080, 10080]);
  const noWeekly = applySidebarDisplay(rows, { ...all, weekly: false })[0];
  assert.deepEqual(noWeekly.usage?.windows.map((w) => [w.windowMinutes, w.scope]), [[300, undefined], [10080, 'Fable']], 'model-specific windows follow their own setting');
  const generalOnly = [{ ...rows[0], usage: { checkedAt: now, windows: rows[0].usage!.windows.slice(0, 2) } }];
  assert.deepEqual(applySidebarDisplay(generalOnly, { email: true, fiveHour: false, weekly: false })[0].usage, { checkedAt: now, windows: [] }, 'no window left: the observation time stays');
  assert.equal(rows[0].email, 'a@example.com', 'the input rows are not changed');
});
