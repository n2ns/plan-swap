import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { FileMemento } from '../src/fileState';
import { LowUsageNotices } from '../src/usageNotices';
import { makeTempHome } from './helpers';

const NOW = 1_000_000_000_000;
const hour = (used: number, resetsIn = 3600) => ({ usedPercent: used, windowMinutes: 300, resetsAt: NOW / 1000 + resetsIn });
const week = (used: number) => ({ usedPercent: used, windowMinutes: 10080, resetsAt: NOW / 1000 + 5 * 86400 });

test('a low window is announced once until its reset, also by another store on the same state file', async () => {
  const tmp = makeTempHome('low-usage');
  try {
    const dir = path.join(tmp.home, '.claude-work');
    let now = NOW;
    const notices = new LowUsageNotices(new FileMemento(), () => now);
    assert.equal(await notices.take('claude', dir, [hour(70), week(10)], 20), undefined);
    const first = await notices.take('claude', dir, [hour(85.5), week(10)], 20);
    assert.equal(first?.remaining, 14);
    assert.equal(first?.window.windowMinutes, 300);
    assert.equal(await notices.take('claude', dir, [hour(90), week(10)], 20), undefined);
    // Another editor window, and a reset time that moved slightly
    assert.equal(await new LowUsageNotices(new FileMemento(), () => now).take('claude', dir, [hour(95, 3630), week(10)], 20), undefined);
    // The same window of the other product or another account is separate
    assert.equal((await notices.take('codex', dir, [hour(90)], 20))?.remaining, 10);
    assert.equal((await notices.take('claude', path.join(tmp.home, '.claude-b'), [hour(90)], 20))?.remaining, 10);
    // After the reset (and its grace) the next period is announced again
    now = NOW + 3600_000 + 11 * 60_000;
    assert.equal((await notices.take('claude', dir, [{ ...hour(85), resetsAt: now / 1000 + 3600 }], 20))?.remaining, 15);
    const stored = new FileMemento().get<Array<{ resetsAt: number }>>('usage.lowNotified')!;
    assert.ok(stored.every((e) => e.resetsAt * 1000 > NOW + 3600_000), 'expired entries are pruned');
    assert.deepEqual(Object.keys(stored[0]).sort(), ['dir', 'product', 'resetsAt', 'windowMinutes']);
  } finally { tmp.restore(); }
});

test('several low windows at once are all recorded and the one with least left is named', async () => {
  const tmp = makeTempHome('low-usage-several');
  try {
    const notices = new LowUsageNotices(new FileMemento(), () => NOW);
    const low = await notices.take('codex', tmp.home, [hour(82), week(95)], 20);
    assert.equal(low?.window.windowMinutes, 10080);
    assert.equal(low?.remaining, 5);
    assert.equal(await notices.take('codex', tmp.home, [hour(83), week(96)], 20), undefined);
  } finally { tmp.restore(); }
});

test('used-up, model-specific, undated and reached windows are left to Claude Code and Codex', async () => {
  const tmp = makeTempHome('low-usage-skip');
  try {
    const notices = new LowUsageNotices(new FileMemento(), () => NOW);
    assert.equal(await notices.take('claude', tmp.home, [hour(100), hour(99.5)], 20), undefined);
    assert.equal(await notices.take('claude', tmp.home, [{ ...week(90), scope: 'Opus' }], 20), undefined);
    assert.equal(await notices.take('claude', tmp.home, [{ usedPercent: 90, windowMinutes: 300 }, { usedPercent: 90, resetsAt: NOW / 1000 + 60 }], 20), undefined);
    assert.equal(await notices.take('claude', tmp.home, [hour(90, -60)], 20), undefined);
    assert.equal(await notices.take('codex', tmp.home, [hour(90)], 20, true), undefined);
    assert.equal(new FileMemento().get('usage.lowNotified'), undefined);
  } finally { tmp.restore(); }
});

test('nothing is announced when the record cannot be saved', async () => {
  const failing = { get: () => undefined, keys: () => [], update: () => Promise.reject(new Error('read-only')) };
  const notices = new LowUsageNotices(failing, () => NOW);
  assert.equal(await notices.take('claude', '/tmp/x', [hour(90)], 20), undefined);
});
