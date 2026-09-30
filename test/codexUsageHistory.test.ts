import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { FileMemento } from '../src/fileState';
import { CodexUsageHistory, USAGE_HISTORY_MAX_AGE_MS } from '../src/codex/codexUsageHistory';
import type { UsageResult } from '../src/codex/codexUsage';
import { makeTempHome } from './helpers';

const observed = (time: number, percent = 42): UsageResult => ({ ok: true, usage: {
  checkedAt: time, limitReached: false,
  windows: [{ usedPercent: percent, windowMinutes: 300, resetsAt: time / 1000 + 3600 },
    { usedPercent: 12, windowMinutes: 10080, resetsAt: time / 1000 + 7 * 86400 }],
} });

test('usage observations survive a new store and stay associated with their directory', async () => {
  const tmp = makeTempHome('usage-history');
  try {
    const state = new FileMemento();
    const a = path.join(tmp.home, '.codex-a');
    const b = path.join(tmp.home, '.codex-b');
    const history = new CodexUsageHistory(state, () => 100_000, () => 'stamp');
    await history.record(a, observed(100_000), 'stamp');
    await history.record(b, observed(100_000, 80), 'stamp');
    const reopened = new CodexUsageHistory(new FileMemento(), () => 101_000, () => 'stamp');
    assert.equal(reopened.get(a)?.windows[0].usedPercent, 42);
    assert.equal(reopened.get(b)?.windows[0].usedPercent, 80);
    assert.equal(reopened.get(a)?.checkedAt, 100_000);
    assert.equal(reopened.get(path.join(tmp.home, '.codex-new')), undefined);
    assert.deepEqual(Object.keys(state.get<object[]>('codex.usageHistory')![0]), ['dir', 'stamp', 'usage']);
  } finally { tmp.restore(); }
});

test('reset windows and observations older than one day disappear without predicting zero usage', async () => {
  const tmp = makeTempHome('usage-expiry');
  try {
    let now = 100_000;
    const history = new CodexUsageHistory(new FileMemento(), () => now, () => 'stamp');
    await history.record(tmp.home, observed(now), 'stamp');
    now += 3600_000;
    assert.deepEqual(history.get(tmp.home)?.windows.map((w) => w.windowMinutes), [10080]);
    now = 100_000 + USAGE_HISTORY_MAX_AGE_MS;
    assert.equal(history.get(tmp.home), undefined);
  } finally { tmp.restore(); }
});

test('changed sign-in metadata hides old usage and a successful query records the new stamp', async () => {
  const tmp = makeTempHome('usage-signin');
  try {
    let stamp = 'before';
    const history = new CodexUsageHistory(new FileMemento(), () => 100_000, () => stamp);
    await history.record(tmp.home, observed(100_000), stamp);
    stamp = 'after';
    assert.equal(history.get(tmp.home), undefined);
    await history.record(tmp.home, observed(100_000, 81), stamp);
    assert.equal(history.get(tmp.home)?.windows[0].usedPercent, 81);
    stamp = 'missing';
    assert.equal(history.get(tmp.home), undefined);
  } finally { tmp.restore(); }
});

test('temporary failures retain observations while sign-out and rejected authentication clear them', async () => {
  const tmp = makeTempHome('usage-failure');
  try {
    const history = new CodexUsageHistory(new FileMemento(), () => 100_000, () => 'stamp');
    for (const reason of ['notLoggedIn', 'authExpired'] as const) {
      await history.record(tmp.home, observed(100_000), 'stamp');
      await history.record(tmp.home, { ok: false, reason: 'timeout' }, 'stamp');
      assert.equal(history.get(tmp.home)?.windows[0].usedPercent, 42);
      await history.record(tmp.home, { ok: false, reason }, 'stamp');
      assert.equal(history.get(tmp.home), undefined);
    }
  } finally { tmp.restore(); }
});

test('a response with an outdated accepted stamp neither replaces nor clears the current identity history', async () => {
  const tmp = makeTempHome('usage-history-race');
  try {
    const history = new CodexUsageHistory(new FileMemento(), () => 100_000, () => 'b');
    await history.record(tmp.home, observed(100_000, 7), 'b');
    for (const result of [observed(100_000, 82), { ok: false, reason: 'authExpired' }] as UsageResult[]) {
      await history.record(tmp.home, result, 'a');
      assert.equal(history.get(tmp.home)?.windows[0].usedPercent, 7);
    }
  } finally { tmp.restore(); }
});
