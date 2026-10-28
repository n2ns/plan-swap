// createRefreshAll (src/usageRefreshAll.ts): the shared refresh-all orchestration with a fake query
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshAll, cooldownSeconds, splitCooldown, type RefreshAllOptions } from '../src/usageRefreshAll';
import { t } from '../src/i18n';
import { window } from './stubs/vscode';

type Result = { ok: true } | { ok: false; reason: 'failed' | 'timeout'; detail?: string };
const KEYS = { none: 'claude.usageAllNone', progress: 'claude.usageAllProgress', cancelled: 'claude.usageAllCancelled', done: 'claude.usageAllDone', failed: 'claude.usageAllFailed' } as const;

interface Harness { infos: string[]; warnings: string[]; queried: string[]; afterRuns: number; cancel: () => void }

function harness(ctx: { mock: { method: typeof import('node:test').mock.method } }, options: Partial<RefreshAllOptions<Result>> & { results?: Record<string, Result> }): Harness & { run(): Promise<void>; running(): boolean } {
  // The state object is returned as is (the queries and the cancel hook write to it), with the runner's methods added
  const h: Harness = { infos: [], warnings: [], queried: [], afterRuns: 0, cancel: () => undefined };
  ctx.mock.method(window, 'showInformationMessage', async (m: string) => { h.infos.push(m); return undefined; });
  ctx.mock.method(window, 'showWarningMessage', async (m: string) => { h.warnings.push(m); return undefined; });
  // The stub's token never cancels: this one lets a test cancel from inside a query
  ctx.mock.method(window, 'withProgress', async (_o: unknown, task: (p: { report(v: unknown): void }, tok: { onCancellationRequested(l: () => void): { dispose(): void } }) => Promise<unknown>) =>
    task({ report() {} }, { onCancellationRequested: (listener) => { h.cancel = listener; return { dispose() {} }; } }));
  const all = createRefreshAll<Result>({
    keys: KEYS,
    eligible: () => [{ dir: '/a', label: 'A' }, { dir: '/b', label: 'B' }, { dir: '/c', label: 'C' }],
    cooldownLeft: () => 0,
    query: async (dir, signal) => {
      h.queried.push(dir);
      if (signal.aborted) return { ok: false, reason: 'failed', detail: 'cancelled' };
      return options.results?.[dir] ?? { ok: true };
    },
    failureText: (_dir, result) => `failure:${result.reason}`,
    afterRun: () => { h.afterRuns++; },
    ...options,
  });
  return Object.assign(h, { run: all.run, running: all.running });
}

test('splitCooldown and cooldownSeconds', () => {
  const split = splitCooldown([{ dir: '/a', label: 'A' }, { dir: '/b', label: 'B' }, { dir: '/c', label: 'C' }], (dir) => ({ '/a': 0, '/b': 2500, '/c': 900 }[dir] ?? 0));
  assert.deepEqual(split.due.map((x) => x.dir), ['/a']);
  assert.deepEqual(split.skipped.map((x) => x.dir), ['/b', '/c']);
  assert.equal(split.waitMs, 900);
  assert.equal(cooldownSeconds(1), 1);
  assert.equal(cooldownSeconds(1001), 2);
});

test('no eligible account, or every account in its cooldown, only informs', async (ctx) => {
  const none = harness(ctx, { eligible: () => [] });
  await none.run();
  assert.deepEqual(none.infos, [t('claude.usageAllNone')]);
  assert.deepEqual(none.queried, []);
  const cooling = harness(ctx, { cooldownLeft: () => 1500 });
  await cooling.run();
  assert.deepEqual(cooling.infos.at(-1), t('usage.allCooldown', { seconds: 2 }));
  assert.deepEqual(cooling.queried, []);
  assert.equal(cooling.afterRuns, 0);
});

test('queries the due accounts in order, skips the cooling one, names the failures and is not re-entrant', async (ctx) => {
  const h = harness(ctx, { cooldownLeft: (dir) => (dir === '/b' ? 5000 : 0), results: { '/c': { ok: false, reason: 'timeout' } } });
  const first = h.run();
  assert.equal(h.running(), true);
  await h.run();
  await first;
  assert.equal(h.running(), false);
  assert.deepEqual(h.queried, ['/a', '/c'], 'the second call while running did nothing');
  assert.equal(h.afterRuns, 1);
  assert.deepEqual(h.infos, []);
  assert.deepEqual(h.warnings, [`${t('claude.usageAllFailed', { ok: 1, n: 2, failures: 'C (failure:timeout)' })} ${t('usage.allSkipped', { n: 1 })}`]);
  const ok = harness(ctx, {});
  await ok.run();
  assert.deepEqual(ok.infos, [t('claude.usageAllDone', { n: 3 })]);
});

test('cancelling stops before the next account; the ended query is neither a success nor a failure', async (ctx) => {
  const h = harness(ctx, {});
  let cancelled = false;
  const all = createRefreshAll<Result>({
    keys: KEYS,
    eligible: () => [{ dir: '/a', label: 'A' }, { dir: '/b', label: 'B' }, { dir: '/c', label: 'C' }],
    cooldownLeft: () => 0,
    query: async (dir, signal) => {
      h.queried.push(dir);
      if (dir === '/b' && !cancelled) { cancelled = true; h.cancel(); }
      return signal.aborted ? { ok: false, reason: 'failed', detail: 'cancelled' } : { ok: true };
    },
    failureText: () => 'x',
    afterRun: () => { h.afterRuns++; },
  });
  await all.run();
  assert.deepEqual(h.queried, ['/a', '/b']);
  assert.deepEqual(h.infos, [t('claude.usageAllCancelled', { ok: 1, n: 3 })]);
  assert.deepEqual(h.warnings, []);
});

test('more than three failures are summarized', async (ctx) => {
  const fail: Result = { ok: false, reason: 'failed', detail: 'boom' };
  const h = harness(ctx, {
    eligible: () => ['a', 'b', 'c', 'd', 'e'].map((n) => ({ dir: `/${n}`, label: n.toUpperCase() })),
    results: { '/a': fail, '/b': fail, '/c': fail, '/d': fail },
  });
  await h.run();
  assert.deepEqual(h.warnings, [t('claude.usageAllFailed', { ok: 1, n: 5, failures: `A (failure:failed); B (failure:failed); C (failure:failed); ${t('claude.usageAllMore', { n: 1 })}` })]);
});
