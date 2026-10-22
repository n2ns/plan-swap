// Read-modify-writes of one state key while another window holds the lock (FileMemento, design.md section 4): the
// other window's write to the same key, made before the lock is released, must survive. The other window is
// simulated by holding <file>.lock with a live pid and writing the file directly. Temporary HOME throughout.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileMemento, STATE_JSON } from '../src/fileState';
import { AccountStoreBase, type StoredAccount } from '../src/accountStore';
import { LabelStore } from '../src/labels';
import { RecommendExclusions } from '../src/recommend';
import { LowUsageNotices } from '../src/usageNotices';
import { CodexUsageHistory } from '../src/codex/codexUsageHistory';
import { LinkCheckNotices } from '../src/linkCheck';
import { showEnvironmentWarnings } from '../src/extension';
import { window } from 'vscode';
import { t } from '../src/i18n';
import { makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
before(() => { tmp = makeTempHome('fileState-same-key'); });
after(() => tmp.restore());

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readState = (): Record<string, unknown> => JSON.parse(fs.readFileSync(STATE_JSON(), 'utf8')) as Record<string, unknown>;
const writeState = (state: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(STATE_JSON()), { recursive: true });
  fs.writeFileSync(STATE_JSON(), JSON.stringify(state));
};
// Another window holds the lock (the live test runner as its owner) until the returned function is called
const holdLock = (m: FileMemento): (() => void) => {
  fs.mkdirSync(m.lockDir, { recursive: true });
  fs.writeFileSync(path.join(m.lockDir, 'owner'), String(process.ppid));
  return () => fs.rmSync(m.lockDir, { recursive: true, force: true });
};
// Starts op while the lock is held, lets the other window write meanwhile, then releases the lock
async function whileLocked<T>(m: FileMemento, op: () => Promise<T>, otherWindow: () => void): Promise<T> {
  const release = holdLock(m);
  const pending = op();
  await sleep(50);
  otherWindow();
  release();
  return pending;
}

describe('same-key updates keep another window\'s write made while this one waited for the lock', () => {
  test('syncWithDisk does not re-register an account another window removed', async () => {
    const dirOf = (n: string): string => path.join(tmp.home, `.claude-${n}`);
    for (const n of ['a', 'b', 'c']) fs.mkdirSync(dirOf(n), { recursive: true });
    const acc = (n: string): StoredAccount => ({ name: n, dir: dirOf(n) });
    writeState({ accounts: [acc('a'), acc('b')] });
    const m = new FileMemento();
    const store = new AccountStoreBase<StoredAccount>(m, {
      stateKey: 'accounts', ignoredKey: 'ignoredDirs', orderKey: 'claude.order', defaultName: 'default',
      defaultDir: () => path.join(tmp.home, '.claude'),
      scan: () => [acc('c')],
    });
    await whileLocked(m, () => store.syncWithDisk(), () => writeState({ ignoredDirs: [dirOf('b')], accounts: [acc('a')] }));
    assert.deepEqual((readState()['accounts'] as StoredAccount[]).map((a) => a.name), ['a', 'c']);
    assert.deepEqual(readState()['ignoredDirs'], [dirOf('b')]);
  });

  test('LabelStore.set keeps an alias another window stored', async () => {
    writeState({ 'claude.labels': { a: 'Alpha' } });
    const m = new FileMemento();
    await whileLocked(m, () => new LabelStore(m, 'claude.labels').set('b', 'Beta'),
      () => writeState({ 'claude.labels': { a: 'Alpha', c: 'Gamma' } }));
    assert.deepEqual(readState()['claude.labels'], { a: 'Alpha', c: 'Gamma', b: 'Beta' });
  });

  test('RecommendExclusions.set keeps a mark another window set', async () => {
    writeState({});
    const m = new FileMemento();
    await whileLocked(m, () => new RecommendExclusions(m, 'claude.recommendExcluded').set('b', true),
      () => writeState({ 'claude.recommendExcluded': ['c'] }));
    assert.deepEqual(readState()['claude.recommendExcluded'], ['c', 'b']);
  });

  test('two LowUsageNotices.take calls waiting for the lock both keep their record', async () => {
    writeState({});
    const now = 1_000_000_000_000;
    const window = { usedPercent: 90, windowMinutes: 300, resetsAt: now / 1000 + 3600 };
    const dir = path.join(tmp.home, '.claude-work');
    const m = new FileMemento();
    const notices = new LowUsageNotices(m, () => now);
    const [claude, codex] = await whileLocked(m,
      () => Promise.all([notices.take('claude', dir, [window], 20), notices.take('codex', dir, [window], 20)]), () => {});
    assert.equal(claude?.remaining, 10);
    assert.equal(codex?.remaining, 10);
    assert.equal(await notices.take('claude', dir, [window], 20), undefined, 'the Claude window is not announced again');
    assert.equal(await notices.take('codex', dir, [window], 20), undefined, 'the Codex window is not announced again');
  });

  test('CodexUsageHistory.record keeps an observation another window recorded', async () => {
    writeState({});
    const now = 100_000;
    const usage = (percent: number) => ({ checkedAt: now, limitReached: false, windows: [{ usedPercent: percent, windowMinutes: 300, resetsAt: now / 1000 + 3600 }] });
    const a = path.join(tmp.home, '.codex-a');
    const b = path.join(tmp.home, '.codex-b');
    const m = new FileMemento();
    const history = new CodexUsageHistory(m, () => now, () => 'stamp');
    await whileLocked(m, () => history.record(a, { ok: true, usage: usage(42) }, 'stamp'),
      () => writeState({ 'codex.usageHistory': [{ dir: b, stamp: 'stamp', usage: usage(80) }] }));
    assert.equal(history.get(a)?.windows[0].usedPercent, 42);
    assert.equal(history.get(b)?.windows[0].usedPercent, 80, 'the other window\'s observation survives');
  });
  test('LinkCheckNotices.take keeps the record another window stored for the other vendor', async () => {
    writeState({});
    const m = new FileMemento();
    const other = { fp: 'other', at: 1 };
    const announced = await whileLocked(m, () => new LinkCheckNotices(m, () => 1000).take('claude', ['k']),
      () => writeState({ 'links.announced': { codex: other } }));
    assert.equal(announced, true);
    const record = readState()['links.announced'] as Record<string, unknown>;
    assert.deepEqual(record['codex'], other);
    assert.ok(record['claude']);
  });
  test('"Don\'t Show Again" keeps the warning another window dismissed', async (ctx) => {
    writeState({});
    const m = new FileMemento();
    ctx.mock.method(window, 'showWarningMessage', async () => t('common.dontShowAgain'));
    await whileLocked(m, () => showEnvironmentWarnings(m, { PATH: '/bin', ANTHROPIC_API_KEY: 'x' }, tmp.home, { set: [], cleared: [] }),
      () => writeState({ 'warnings.dismissed': ['oneDriveHome'] }));
    assert.deepEqual(readState()['warnings.dismissed'], ['oneDriveHome', 'claudeEnv:ANTHROPIC_API_KEY']);
  });
});
