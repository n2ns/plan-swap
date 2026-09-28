import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StatusBar } from '../src/statusBar';
import { AccountStore } from '../src/accounts';
import { CodexAccountStore } from '../src/codex/codexStore';
import { LabelStore } from '../src/labels';
import { makeTempHome, MemoryMemento } from './helpers';
import { statusBarItems, StatusBarAlignment } from './stubs/vscode';
import { writeSelectedDir } from '../src/codex/codexState';

for (const vendors of [[], ['claude'], ['codex'], ['claude', 'codex']]) {
  test(`status bar shows only configured vendors: ${vendors.join(',') || 'none'}`, () => {
    const temp = makeTempHome('status-bar');
    const state = new MemoryMemento();
    for (const vendor of vendors) fs.mkdirSync(path.join(temp.home, `.${vendor}`));
    const bar = new StatusBar(new AccountStore(state), new LabelStore(state, 'claude.labels'),
      { store: new CodexAccountStore(state), labels: new LabelStore(state, 'codex.labels') });
    try {
      const item = statusBarItems.at(-1)!;
      assert.equal(item.alignment, StatusBarAlignment.Right);
      assert.equal(item.visible, vendors.length > 0);
      assert.equal(item.text.includes('Claude:'), vendors.includes('claude'));
      assert.equal(item.text.includes('Codex:'), vendors.includes('codex'));
      assert.equal(item.tooltip.includes('Claude:'), vendors.includes('claude'));
      assert.equal(item.tooltip.includes('Codex:'), vendors.includes('codex'));
      assert.equal(item.command, 'workbench.view.extension.planswap');
    } finally { bar.dispose(); temp.restore(); }
  });
}

test('Codex status keeps effective account and reports pending selection with aliases', async () => {
  const temp = makeTempHome('status-pending');
  const state = new MemoryMemento();
  const store = new CodexAccountStore(state);
  const dir = path.join(temp.home, '.codex');
  const selected = path.join(temp.home, '.codex-work');
  fs.mkdirSync(dir);
  fs.mkdirSync(selected);
  await store.add({ name: 'work', dir: selected });
  await state.update('codex.labels', { work: 'Work alias' });
  writeSelectedDir(selected);
  const bar = new StatusBar(new AccountStore(state), new LabelStore(state, 'claude.labels'),
    { store, labels: new LabelStore(state, 'codex.labels') });
  try {
    const item = statusBarItems.at(-1)!;
    assert.equal(item.text, '$(account) Codex: default');
    assert.match(item.tooltip, /Pending: Work alias \(restart required\)/);
    writeSelectedDir(dir);
    bar.update();
    assert.doesNotMatch(item.tooltip, /Pending:/);
  } finally { bar.dispose(); temp.restore(); }
});
