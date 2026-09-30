import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { authFileStamp, CodexUsageMonitor, type CodexUsageState } from '../src/codex/codexUsageMonitor';
import type { UsageResult } from '../src/codex/codexUsage';
import { makeTempHome } from './helpers';

const okResult = (checkedAt: number, usedPercent = 10): UsageResult => ({
  ok: true,
  usage: { windows: [{ usedPercent }], limitReached: false, checkedAt },
});
const signedOut: UsageResult = { ok: false, reason: 'notLoggedIn' };
const failed: UsageResult = { ok: false, reason: 'failed', detail: 'boom' };
const expired: UsageResult = { ok: false, reason: 'authExpired' };

interface Harness {
  monitor: CodexUsageMonitor;
  states: CodexUsageState[];
  calls: string[];
  clock: { t: number };
  // Results returned by the next read calls, in order; when empty, read returns a pending promise released by `release`
  queue: Array<UsageResult | Error>;
  release: (r: UsageResult) => void;
  pending: number;
  // Value returned by the injected authStamp; the monitor reads it when a query ends and in refreshIfAuthChanged
  stamp: { v: string };
  identity: { v: string | undefined };
  accepted: Array<{ dir: string; result: UsageResult; stamp: string }>;
}

function harness(dir = '/home/u/.codex-work', staleMs = 1000): Harness {
  const h = {
    states: [] as CodexUsageState[],
    calls: [] as string[],
    clock: { t: 0 },
    queue: [] as Array<UsageResult | Error>,
    resolvers: [] as Array<(r: UsageResult) => void>,
    stamp: { v: 'x' },
    identity: { v: 'user-a' as string | undefined },
    accepted: [] as Array<{ dir: string; result: UsageResult; stamp: string }>,
  };
  const monitor = new CodexUsageMonitor(
    () => dir,
    (s) => h.states.push(s),
    {
      now: () => h.clock.t,
      staleMs,
      authStamp: () => h.stamp.v,
      authIdentity: () => h.identity.v,
      onAccepted: (dir, result, stamp) => { h.accepted.push({ dir, result, stamp }); },
      read: (d) => {
        h.calls.push(d);
        const next = h.queue.shift();
        if (next instanceof Error) return Promise.reject(next);
        if (next) return Promise.resolve(next);
        return new Promise<UsageResult>((resolve) => h.resolvers.push(resolve));
      },
    },
  );
  return {
    monitor,
    states: h.states,
    calls: h.calls,
    clock: h.clock,
    queue: h.queue,
    stamp: h.stamp,
    identity: h.identity,
    accepted: h.accepted,
    release: (r) => {
      const resolve = h.resolvers.shift();
      assert.ok(resolve, 'no pending read');
      resolve(r);
    },
    get pending() {
      return h.resolvers.length;
    },
  };
}

describe('CodexUsageMonitor', () => {
  test('initial state is not checking and has no result', () => {
    const h = harness();
    assert.deepEqual(h.monitor.current(), { checking: false });
    assert.equal(h.monitor.current().result, undefined);
    assert.equal(h.states.length, 0);
    assert.equal(h.calls.length, 0);
  });

  test('refresh reports checking, then the new result, and reads dirOf()', async () => {
    const h = harness('/home/u/.codex-a');
    const first = okResult(1, 20);
    h.queue.push(first);
    await h.monitor.refresh();
    assert.deepEqual(h.calls, ['/home/u/.codex-a']);
    assert.deepEqual(h.states, [{ checking: true, result: undefined }, { checking: false, result: first }]);
    assert.deepEqual(h.monitor.current(), { checking: false, result: first });

    // A second refresh keeps the previous result visible while checking
    const p = h.monitor.refresh();
    assert.deepEqual(h.monitor.current(), { checking: true, result: first });
    const second = okResult(2, 40);
    h.release(second);
    await p;
    assert.deepEqual(h.states.slice(2), [{ checking: true, result: first }, { checking: false, result: second }]);
    assert.deepEqual(h.monitor.current(), { checking: false, result: second });
  });

  test('concurrent refresh calls join one running query', async () => {
    const h = harness();
    const a = h.monitor.refresh();
    const b = h.monitor.refresh();
    assert.equal(h.calls.length, 1);
    const r = okResult(5);
    h.release(r);
    await Promise.all([a, b]);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.monitor.current(), { checking: false, result: r });
    // After it finished, a new refresh starts a new query
    h.queue.push(okResult(6));
    await h.monitor.refresh();
    assert.equal(h.calls.length, 2);
  });

  test('refreshIfStale queries first, not again within staleMs, again after it', async () => {
    const h = harness(undefined, 1000);
    h.queue.push(okResult(0));
    await h.monitor.refreshIfStale();
    assert.equal(h.calls.length, 1);

    h.clock.t = 999;
    await h.monitor.refreshIfStale();
    assert.equal(h.calls.length, 1);

    h.clock.t = 1000;
    h.queue.push(okResult(1000));
    await h.monitor.refreshIfStale();
    assert.equal(h.calls.length, 2);
  });

  test('refreshIfStale while a query runs joins it', async () => {
    const h = harness(undefined, 1000);
    const a = h.monitor.refreshIfStale();
    const b = h.monitor.refreshIfStale();
    assert.equal(h.calls.length, 1);
    h.release(okResult(0));
    await Promise.all([a, b]);
    assert.equal(h.calls.length, 1);
  });

  test('a failed result counts as an attempt and is not retried immediately', async () => {
    const h = harness(undefined, 1000);
    h.queue.push(failed);
    await h.monitor.refreshIfStale();
    assert.deepEqual(h.monitor.current().result, failed);

    h.clock.t = 500;
    await h.monitor.refreshIfStale();
    assert.equal(h.calls.length, 1);

    h.clock.t = 1500;
    h.queue.push(okResult(1500));
    await h.monitor.refreshIfStale();
    assert.equal(h.calls.length, 2);
    assert.equal(h.monitor.current().result?.ok, true);
  });

  test('a read that throws becomes a failed result with the message as detail', async () => {
    const h = harness();
    h.queue.push(new Error('spawn exploded'));
    await h.monitor.refresh();
    assert.deepEqual(h.monitor.current(), { checking: false, result: { ok: false, reason: 'failed', detail: 'spawn exploded' } });
    assert.equal(h.states.at(-1)?.checking, false);
  });

  test('a thrown non-Error value is stringified into detail', async () => {
    const h = new CodexUsageMonitor(() => '/d', () => {}, {
      read: () => Promise.reject('plain string'),
      now: () => 0,
      authStamp: () => 'missing',
      authIdentity: () => undefined,
    });
    await h.refresh();
    assert.deepEqual(h.current().result, { ok: false, reason: 'failed', detail: 'plain string' });
  });

  test('refreshIfAuthChanged is a no-op before the first query', async () => {
    const h = harness();
    await h.monitor.refreshIfAuthChanged();
    h.stamp.v = 'y';
    await h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 0);
    assert.equal(h.states.length, 0);
  });

  test('refreshIfAuthChanged is a no-op while auth.json is unchanged, whatever the last result', async () => {
    for (const result of [okResult(1), signedOut, expired, failed, { ok: false, reason: 'timeout' } as UsageResult]) {
      const h = harness();
      h.queue.push(result);
      await h.monitor.refresh();
      await h.monitor.refreshIfAuthChanged();
      await h.monitor.refreshIfAuthChanged();
      assert.equal(h.calls.length, 1, `result ${result.ok ? 'ok' : result.reason}`);
    }
  });

  test('refreshIfAuthChanged queries after a sign-in (missing → present)', async () => {
    const h = harness();
    h.stamp.v = 'missing';
    h.queue.push(signedOut);
    await h.monitor.refresh();

    h.stamp.v = 'x';
    const r = okResult(1);
    h.queue.push(r);
    await h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.monitor.current().result, r);

    // The new stamp was recorded after that query: no further query
    await h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 2);
  });

  test('refreshIfAuthChanged queries after a re-login following an expired sign-in', async () => {
    const h = harness();
    h.queue.push(expired);
    await h.monitor.refresh();
    await h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 1);

    h.stamp.v = 'y';
    h.queue.push(okResult(2));
    await h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 2);
    assert.equal(h.monitor.current().result?.ok, true);
  });

  test('an auth.json change for the same identity during our own query is absorbed', async () => {
    const h = harness();
    const p = h.monitor.refresh();
    // Codex refreshes its token while answering
    h.stamp.v = 'refreshed';
    h.release(okResult(1));
    await p;
    await h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 1);
  });

  test('refreshIfAuthChanged while a query runs joins it', async () => {
    const h = harness();
    const a = h.monitor.refresh();
    h.stamp.v = 'y';
    const b = h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 1);
    h.release(okResult(1));
    await Promise.all([a, b]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.monitor.current().checking, false);
  });

  test('no pending reads remain after tests settle', async () => {
    const h = harness();
    const p = h.monitor.refresh();
    assert.equal(h.pending, 1);
    h.release(okResult(0));
    await p;
    assert.equal(h.pending, 0);
  });

  test('a sign-in change during a query discards the old response and saves only the new identity result', async () => {
    const h = harness();
    const old = okResult(1, 82);
    h.queue.push(old);
    await h.monitor.refresh();
    h.accepted.length = 0;
    const pending = h.monitor.refresh();
    h.identity.v = 'user-b';
    h.stamp.v = 'b';
    const joined = h.monitor.refreshIfAuthChanged();
    assert.equal(h.monitor.current().result, undefined);
    const fresh = okResult(2, 7);
    h.queue.push(fresh);
    h.release(old);
    await Promise.all([pending, joined]);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.accepted, [{ dir: h.calls[0], result: fresh, stamp: 'b' }]);
    assert.equal(h.monitor.current().result, fresh);
    const exposed = JSON.stringify({ states: h.states, accepted: h.accepted });
    assert.ok(!exposed.includes('user-a') && !exposed.includes('user-b'));
    await h.monitor.refreshIfAuthChanged();
    assert.equal(h.calls.length, 3);
  });

  test('an unknown identity with changed metadata is discarded and the next stale check retries immediately', async () => {
    const h = harness();
    h.identity.v = undefined;
    const pending = h.monitor.refresh();
    h.stamp.v = 'changed';
    h.release(okResult(1));
    await pending;
    assert.deepEqual(h.monitor.current(), { checking: false });
    assert.deepEqual(h.accepted, []);
    assert.equal(h.calls.length, 1);
    h.queue.push(okResult(2));
    await h.monitor.refreshIfStale();
    assert.equal(h.calls.length, 2);
  });

  test('repeated identity changes allow only one follow-up and remain eligible for an auth-change retry', async () => {
    let identity = 'a';
    let calls = 0;
    const accepted: UsageResult[] = [];
    const monitor = new CodexUsageMonitor(() => '/fixture', () => {}, {
      authStamp: () => identity, authIdentity: () => identity,
      read: async () => { calls++; if (calls <= 2) identity = String(calls); return okResult(calls); },
      onAccepted: (_dir, result) => { accepted.push(result); },
    });
    await monitor.refresh();
    assert.equal(calls, 2);
    assert.deepEqual(accepted, []);
    assert.deepEqual(monitor.current(), { checking: false });
    await monitor.refreshIfAuthChanged();
    assert.equal(calls, 3);
    assert.equal(accepted.length, 1);
  });

  test('an identity change while history is saving does not publish the old result', async () => {
    let identity = 'a';
    let releaseSave: (() => void) | undefined;
    const saving = new Promise<void>((resolve) => { releaseSave = resolve; });
    const states: CodexUsageState[] = [];
    const stamps: string[] = [];
    let calls = 0;
    const monitor = new CodexUsageMonitor(() => '/fixture', (state) => states.push(state), {
      authStamp: () => identity, authIdentity: () => identity,
      read: async () => okResult(++calls, calls === 1 ? 82 : 7),
      onAccepted: async (_dir, _result, stamp) => { stamps.push(stamp); if (stamp === 'a') await saving; },
    });
    const pending = monitor.refresh();
    await Promise.resolve();
    assert.deepEqual(stamps, ['a']);
    identity = 'b';
    releaseSave!();
    await pending;
    assert.deepEqual(stamps, ['a', 'b']);
    assert.equal(calls, 2);
    assert.ok(states.every((state) => !state.result?.ok || state.result.usage.windows[0].usedPercent !== 82));
    assert.ok(!JSON.stringify(states).includes('identity'));
  });

  test('a same-identity token refresh while saving is absorbed without changing the history stamp', async () => {
    let stamp = 'before';
    let calls = 0;
    const saved: string[] = [];
    const monitor = new CodexUsageMonitor(() => '/fixture', () => {}, {
      authStamp: () => stamp, authIdentity: () => 'user-a',
      read: async () => okResult(++calls),
      onAccepted: (_dir, _result, acceptedStamp) => { saved.push(acceptedStamp); stamp = 'refreshed'; },
    });
    await monitor.refresh();
    await monitor.refreshIfAuthChanged();
    assert.equal(calls, 1);
    assert.deepEqual(saved, ['before']);
  });
});

describe('authFileStamp', () => {
  test('reports missing, then a stat fingerprint that changes with the file', () => {
    const tmp = makeTempHome('usage-stamp');
    try {
      const dir = path.join(tmp.home, '.codex-work');
      fs.mkdirSync(dir);
      assert.equal(authFileStamp(dir), 'missing');
      assert.equal(authFileStamp(path.join(tmp.home, 'no-such-dir')), 'missing');

      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, '{"dummy":1}');
      const first = authFileStamp(dir);
      assert.notEqual(first, 'missing');
      assert.equal(authFileStamp(dir), first);

      fs.writeFileSync(auth, '{"dummy":"a longer dummy value"}');
      assert.notEqual(authFileStamp(dir), first);
    } finally {
      tmp.restore();
    }
  });
});
