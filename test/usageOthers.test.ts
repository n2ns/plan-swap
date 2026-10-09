import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OtherAccountChecks, type OtherAccountChecksOptions } from '../src/usageOthers';

const STALE = 15 * 60_000;

function make(overrides: Partial<OtherAccountChecksOptions> = {}) {
  let now = 10 * STALE;
  const queried: string[] = [];
  const checked = new Map<string, number>();
  const checks = new OtherAccountChecks({
    allowed: () => true,
    staleMs: () => STALE,
    checkedAt: (dir) => checked.get(dir),
    query: async (dir) => { queried.push(dir); },
    now: () => now,
    ...overrides,
  });
  return { checks, queried, checked, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('only accounts whose last check is older than the interval are queried, one after another in order', async () => {
  const { checks, queried, checked, now } = make();
  checked.set('/fresh', now() - STALE + 60_000);
  checked.set('/old', now() - STALE);
  await checks.run(['/never', '/fresh', '/old']);
  assert.deepEqual(queried, ['/never', '/old']);
});

test('an attempt, failed or not, is not repeated within the interval; it is once the interval has passed', async () => {
  let fail = true;
  const t = make({ query: async (dir) => { t.queried.push(dir); if (fail) throw new Error('boom'); } });
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, ['/a', '/b'], 'a rejected query does not stop the run');
  t.advance(STALE - 1);
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, ['/a', '/b'], 'no retry loop after a failure');
  fail = false;
  t.advance(1);
  await t.checks.run(['/a']);
  assert.deepEqual(t.queried, ['/a', '/b', '/a']);
});

test('a check by another window or trigger counts; a check time far in the future does not', async () => {
  const { checks, queried, checked, now } = make();
  checked.set('/elsewhere', now() - 60_000);
  checked.set('/future', now() + 3 * 60_000);
  checked.set('/skew', now() + 60_000);
  await checks.run(['/elsewhere', '/future', '/skew']);
  assert.deepEqual(queried, ['/future']);
});

test('the run stops before the next account once it is no longer allowed', async () => {
  let allowed = true;
  const t = make({ allowed: () => allowed, query: async (dir) => { t.queried.push(dir); allowed = false; } });
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, ['/a']);
  allowed = true;
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, ['/a', '/b'], 'the skipped account is checked by a later run');
});

test('a query that was not run (a manual refresh came first) stops the run and counts no attempt', async () => {
  let yieldTo = true;
  const t = make({ query: async (dir) => { if (yieldTo) return false; t.queried.push(dir); } });
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, [], 'the run stops at the first account');
  yieldTo = false;
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, ['/a', '/b'], 'the account is due at once on the next run');
});

test('a call while a run is going on does nothing; the interval is read for every account', async () => {
  let release!: () => void;
  let stale = STALE;
  const t = make({ staleMs: () => stale, query: (dir) => { t.queried.push(dir); return new Promise<void>((r) => { release = r; }); } });
  const first = t.checks.run(['/a']);
  await t.checks.run(['/b']);
  assert.deepEqual(t.queried, ['/a']);
  release();
  await first;
  t.advance(5 * 60_000);
  stale = 5 * 60_000;
  const second = t.checks.run(['/a']);
  release();
  await second;
  assert.deepEqual(t.queried, ['/a', '/a'], 'a shorter interval applies at once');
});


test('an account that became fresh in the queue is skipped without stopping or counting an attempt', async () => {
  let skip = true;
  const t = make({ query: async (dir) => {
    if (dir === '/a' && skip) return 'skipped';
    t.queried.push(dir);
  } });
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, ['/b']);
  skip = false;
  await t.checks.run(['/a', '/b']);
  assert.deepEqual(t.queried, ['/b', '/a'], 'the skipped account has no attempt; the actually queried one backs off');
});
