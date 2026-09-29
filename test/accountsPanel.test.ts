import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { AccountsPanel, claudePanelSource, type PanelSource } from '../src/accountsPanel';
import { AccountStore } from '../src/accounts';
import { LabelStore } from '../src/labels';
import { readAccountInfo } from '../src/paths';
import type { FromWebview, ToWebview } from '../src/protocol';
import { makeTempHome, MemoryMemento } from './helpers';
import { setLocale, t } from '../src/i18n';

function harness() {
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
  const source: PanelSource = { accounts: () => [], enabled: () => true, pendingDir: () => undefined, watchTargets: () => [] };
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

for (const locale of ['es', 'ja'] as const) {
  test(`${locale}: initial document uses the selected language before frontend startup`, () => {
    setLocale(locale);
    const h = harness();
    try {
      assert.ok(h.view.webview.html.includes(`<html lang="${locale}">`));
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
