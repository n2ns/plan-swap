import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import {
  CLAUDE_USAGE_MAX_AGE_MS, oneAtATime, parseUsageCache, queryClaudeUsage, queryEach, readClaudeUsage, readUsageFetchedAt, usageEnv,
  type ClaudeUsageChild, type ClaudeUsageSpawn,
} from '../src/claudeUsage';
import { ClaudeUsageMonitor, type ClaudeUsageState } from '../src/claudeUsageMonitor';
import { StatusBar, claudeUsageFailureText, claudeUsageParts } from '../src/statusBar';
import { htmlText, statusBarItems, tooltipText, setConfig, resetConfig } from './stubs/vscode';
import { claudePanelSource, SHOW_MODEL_LIMITS_SETTING } from '../src/accountsPanel';
import { AccountStore } from '../src/accounts';
import { LabelStore } from '../src/labels';
import { setLocale } from '../src/i18n';
import { LINUX_ONLY, makeTempHome, MemoryMemento, withEnv } from './helpers';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 3600_000;

function cache(over: Record<string, unknown> = {}, owner = 'acct-1'): Record<string, unknown> {
  return {
    oauthAccount: { emailAddress: 'dummy@example.com', accountUuid: owner, organizationUuid: 'org-1' },
    cachedUsageUtilization: {
      fetchedAtMs: NOW - 60_000,
      accountUuid: 'acct-1',
      utilization: {
        five_hour: { utilization: 10, resets_at: iso(NOW + 2 * HOUR) },
        seven_day: { utilization: 20, resets_at: iso(NOW + 48 * HOUR) },
        limits: [
          { kind: 'session', percent: 42, resets_at: iso(NOW + 2 * HOUR) },
          { kind: 'weekly_all', percent: 7.5, resets_at: iso(NOW + 48 * HOUR) },
          { kind: 'weekly_scoped', percent: 130, resets_at: iso(NOW + 49 * HOUR), scope: { model: { id: null, display_name: 'Fable' } } },
        ],
      },
      ...over,
    },
  };
}

test('parseUsageCache reads the limits list with model scopes, clamps percentages and keeps fetchedAtMs', () => {
  const u = parseUsageCache(cache(), NOW);
  assert.deepEqual(u, {
    checkedAt: NOW - 60_000,
    windows: [
      { usedPercent: 42, windowMinutes: 300, resetsAt: (NOW + 2 * HOUR) / 1000 },
      { usedPercent: 7.5, windowMinutes: 10080, resetsAt: (NOW + 48 * HOUR) / 1000 },
      { usedPercent: 100, windowMinutes: 10080, resetsAt: (NOW + 49 * HOUR) / 1000, scope: 'Fable' },
    ],
  });
  assert.ok(!JSON.stringify(u).includes('acct-1'), 'the account UUID is never returned');
});

test('parseUsageCache falls back to five_hour / seven_day without a limits list', () => {
  const data = cache();
  const util = (data.cachedUsageUtilization as { utilization: Record<string, unknown> }).utilization;
  delete util.limits;
  assert.deepEqual(parseUsageCache(data, NOW)?.windows, [
    { usedPercent: 10, windowMinutes: 300, resetsAt: (NOW + 2 * HOUR) / 1000 },
    { usedPercent: 20, windowMinutes: 10080, resetsAt: (NOW + 48 * HOUR) / 1000 },
  ]);
});

test('parseUsageCache rejects a cache of another sign-in, without a sign-in, too old, or without data', () => {
  assert.equal(parseUsageCache(cache({}, 'acct-2'), NOW), undefined, 'another account signed in to this directory');
  assert.equal(parseUsageCache(cache({ accountUuid: undefined }), NOW), undefined);
  const noOauth = cache();
  delete noOauth.oauthAccount;
  assert.equal(parseUsageCache(noOauth, NOW), undefined);
  assert.equal(parseUsageCache(cache({ fetchedAtMs: NOW - CLAUDE_USAGE_MAX_AGE_MS }), NOW), undefined);
  assert.equal(parseUsageCache(cache({ fetchedAtMs: 'x' }), NOW), undefined);
  assert.equal(parseUsageCache(cache({ utilization: { limits: [] } }), NOW), undefined);
  assert.equal(parseUsageCache({}, NOW), undefined);
  assert.equal(parseUsageCache(null, NOW), undefined);
});

test('parseUsageCache drops windows whose reset time has passed', () => {
  const u = parseUsageCache(cache(), NOW + 3 * HOUR);
  assert.deepEqual(u?.windows.map((w) => w.windowMinutes), [10080, 10080]);
  assert.equal(parseUsageCache(cache(), NOW + 50 * HOUR), undefined);
});

test('readClaudeUsage reads ~/.claude.json for the default account and <dir>/.claude.json otherwise', LINUX_ONLY, () => {
  const tmp = makeTempHome('claude-usage-read');
  try {
    const def = path.join(tmp.home, '.claude');
    const named = path.join(tmp.home, '.claude-work');
    fs.mkdirSync(def);
    fs.mkdirSync(named);
    fs.writeFileSync(path.join(tmp.home, '.claude.json'), JSON.stringify(cache()));
    fs.writeFileSync(path.join(named, '.claude.json'), '{"half":');
    assert.equal(readClaudeUsage(def, false, NOW)?.windows.length, 3);
    assert.equal(readClaudeUsage(named, true, NOW), undefined, 'a half-written file is unknown');
    assert.equal(readClaudeUsage(path.join(tmp.home, '.claude-none'), true, NOW), undefined);
  } finally { tmp.restore(); }
});

test('usageEnv points the CLI at the file PlanSwap reads and applies the Claude Code setting variables', LINUX_ONLY, () => {
  const tmp = makeTempHome('claude-usage-env');
  try {
    const home = path.join(tmp.home, '.claude');
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'host-key', HTTPS_PROXY: 'http://old' };
    const def = usageEnv(home, false, base, { ANTHROPIC_API_KEY: '', HTTPS_PROXY: 'http://proxy' });
    assert.equal(def.CLAUDE_CONFIG_DIR, undefined, 'the default ~/.claude uses ~/.claude.json');
    assert.equal(def.PATH, '/bin');
    assert.equal(def.ANTHROPIC_API_KEY, '', 'a variable cleared by the setting is not inherited');
    assert.equal(def.HTTPS_PROXY, 'http://proxy');
    assert.equal(base.ANTHROPIC_API_KEY, 'host-key', 'the base environment is not changed');
    assert.equal(usageEnv(home, true, base).CLAUDE_CONFIG_DIR, home);
    assert.equal(usageEnv(path.join(tmp.home, '.claude-work'), true, base).CLAUDE_CONFIG_DIR, path.join(tmp.home, '.claude-work'));
    // The extension host itself runs with CLAUDE_CONFIG_DIR: ~/.claude is then an ordinary folder with its own info file
    withEnv({ CLAUDE_CONFIG_DIR: path.join(tmp.home, 'elsewhere') }, () => {
      assert.equal(usageEnv(home, false, process.env).CLAUDE_CONFIG_DIR, home);
      assert.equal(usageEnv(path.join(tmp.home, 'elsewhere'), false, process.env).CLAUDE_CONFIG_DIR, path.join(tmp.home, 'elsewhere'));
    });
  } finally { tmp.restore(); }
});

interface FakeRun { command: string; args: string[]; options: SpawnOptions; child: FakeChild }
class FakeChild extends EventEmitter implements ClaudeUsageChild {
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  pid?: number;
  kill(): boolean {
    this.killed = true;
    this.signalCode = 'SIGTERM';
    return true;
  }
}

// behave: what the fake claude does once started (write the cache, print, exit)
function fakeSpawn(behave: (child: FakeChild) => void): { spawn: ClaudeUsageSpawn; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const spawn: ClaudeUsageSpawn = (command, args, options) => {
    const child = new FakeChild();
    runs.push({ command, args, options, child });
    setImmediate(() => behave(child));
    return child;
  };
  return { spawn, runs };
}

function answer(child: FakeChild, output: unknown, code = 0): void {
  child.stdout.end(typeof output === 'string' ? output : JSON.stringify(output));
  child.exitCode = code;
  child.emit('exit', code, null);
}

const SUCCESS = { type: 'result', subtype: 'success', is_error: false, local_command: 'usage', result: 'Current session: 42% used' };

test('queryClaudeUsage runs the local /usage command for the account and accepts a cache fetched during the run', LINUX_ONLY, async () => {
  const tmp = makeTempHome('claude-usage-query');
  try {
    const dir = path.join(tmp.home, '.claude-work');
    fs.mkdirSync(dir);
    const f = fakeSpawn((child) => {
      fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(cache({ fetchedAtMs: NOW })));
      answer(child, SUCCESS);
    });
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: f.spawn, now: () => NOW }), { ok: true });
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].command, 'claude');
    assert.deepEqual(f.runs[0].args, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--setting-sources', 'user']);
    assert.equal(f.runs[0].options.env?.CLAUDE_CONFIG_DIR, dir);
    assert.deepEqual(f.runs[0].options.stdio, ['ignore', 'pipe', 'ignore']);
    assert.equal(f.runs[0].child.killed, false);
  } finally { tmp.restore(); }
});

test('queryClaudeUsage reports a cache that was not fetched during the run, a missing cache and CLI errors', LINUX_ONLY, async () => {
  const tmp = makeTempHome('claude-usage-fail');
  try {
    const dir = path.join(tmp.home, '.claude-work');
    fs.mkdirSync(dir);
    const file = path.join(dir, '.claude.json');
    // Offline: the CLI prints its old cache without an error
    fs.writeFileSync(file, JSON.stringify(cache({ fetchedAtMs: NOW - 10 * 60_000 })));
    const stale = fakeSpawn((child) => answer(child, SUCCESS));
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: stale.spawn, now: () => NOW }), { ok: false, reason: 'notRefreshed' });

    // Offline with a cache too old to show: still reported as not refreshed
    fs.writeFileSync(file, JSON.stringify(cache({ fetchedAtMs: NOW - 2 * CLAUDE_USAGE_MAX_AGE_MS })));
    const old = fakeSpawn((child) => answer(child, SUCCESS));
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: old.spawn, now: () => NOW }), { ok: false, reason: 'notRefreshed' });

    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' } }));
    const none = fakeSpawn((child) => answer(child, SUCCESS));
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: none.spawn, now: () => NOW }), { ok: false, reason: 'noUsage' });

    const err = fakeSpawn((child) => answer(child, { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }, 1));
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: err.spawn, now: () => NOW }), { ok: false, reason: 'failed', detail: 'Not logged in' });

    const garbage = fakeSpawn((child) => answer(child, 'x'.repeat(500)));
    const g = await queryClaudeUsage(dir, true, { spawn: garbage.spawn, now: () => NOW });
    assert.equal(g.ok, false);
    assert.ok(!g.ok && g.reason === 'failed' && (g.detail?.length ?? 0) <= 200, 'output is truncated');

    const silent = fakeSpawn((child) => answer(child, '', 3));
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: silent.spawn, now: () => NOW }), { ok: false, reason: 'failed', detail: '3' });
  } finally { tmp.restore(); }
});

test('queryClaudeUsage reports a missing CLI and ends a hanging one after the timeout', LINUX_ONLY, async () => {
  const tmp = makeTempHome('claude-usage-timeout');
  try {
    const dir = path.join(tmp.home, '.claude-work');
    fs.mkdirSync(dir);
    const missing: ClaudeUsageSpawn = () => {
      const child = new FakeChild();
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: missing }), { ok: false, reason: 'cliMissing' });

    const hang = fakeSpawn(() => undefined);
    assert.deepEqual(await queryClaudeUsage(dir, true, { spawn: hang.spawn, timeoutMs: 20 }), { ok: false, reason: 'timeout' });
    assert.equal(hang.runs[0].child.killed, true, 'only the started child is ended');
  } finally { tmp.restore(); }
});

test('queryClaudeUsage falls back to claude.cmd through the shell on Windows and ends that tree on timeout', async () => {
  const tmp = makeTempHome('claude-usage-win');
  try {
    const bin = path.join(tmp.home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '');
    const runs: FakeRun[] = [];
    const spawn: ClaudeUsageSpawn = (command, args, options) => {
      const child = new FakeChild();
      child.pid = 4242;
      runs.push({ command, args, options, child });
      if (!options.shell) setImmediate(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return child;
    };
    const killed: number[] = [];
    const r = await withEnv({ PATH: bin }, () => queryClaudeUsage(path.join(tmp.home, '.claude-work'), true,
      { spawn, platform: 'win32', timeoutMs: 30, killTree: (pid) => killed.push(pid) }));
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    assert.equal(runs.length, 2);
    assert.equal(runs[1].command, 'claude.cmd -p /usage --output-format json --no-session-persistence --setting-sources user');
    assert.deepEqual(runs[1].args, []);
    assert.equal(runs[1].options.shell, true);
    assert.deepEqual(killed, [4242], 'the tree of the started cmd.exe is ended');
    assert.equal(runs[1].child.killed, false);
  } finally { tmp.restore(); }
});

test('the monitor joins concurrent refreshes, re-checks only when stale or for another account, and keeps failures per directory', async () => {
  let dir = '/a';
  let now = 0;
  const calls: string[] = [];
  let release: (() => void) | undefined;
  let next: { ok: true } | { ok: false; reason: 'timeout' } = { ok: false, reason: 'timeout' };
  let signedIn = true;
  const states: ClaudeUsageState[] = [];
  const m = new ClaudeUsageMonitor(() => dir, (s) => states.push(s), {
    now: () => now,
    staleMs: 1000,
    eligible: () => signedIn,
    query: (d) => {
      calls.push(d);
      return new Promise((resolve) => { release = () => resolve(next); });
    },
  });
  const first = m.refresh();
  const joined = m.refreshIfStale();
  assert.equal(calls.length, 1, 'a running query is joined');
  assert.equal(m.current().checking, true);
  release!();
  await Promise.all([first, joined]);
  assert.deepEqual(m.current(), { checking: false, failure: { dir: '/a', reason: 'timeout', detail: undefined } });

  await m.refreshIfStale();
  assert.equal(calls.length, 1, 'a recent attempt, failed ones included, is not repeated');
  dir = '/b';
  signedIn = false;
  const count = states.length;
  await m.refreshIfStale();
  await m.refresh();
  assert.deepEqual(calls, ['/a'], 'a signed-out account is never queried');
  assert.deepEqual(m.current(), { checking: false }, 'the failure of /a is dropped once /b is current');
  assert.equal(states.length, count + 1, 'a skipped account does not keep notifying');
  await m.refreshIfStale();
  assert.equal(states.length, count + 1);
  signedIn = true;
  next = { ok: true };
  const other = m.refreshIfStale();
  release!();
  await other;
  assert.deepEqual(calls, ['/a', '/b'], 'a sign-in is checked at once');
  assert.deepEqual(m.current(), { checking: false, failure: undefined });
  now = 1000;
  const stale = m.refreshIfStale();
  release!();
  await stale;
  assert.equal(calls.length, 3);
  assert.ok(states.some((s) => s.checking));
});

test('the monitor skips a scheduled query while the account cache is fresh, but not a manual refresh', async () => {
  let now = 10_000;
  let cached: number | undefined = now - 500;
  let calls = 0;
  const m = new ClaudeUsageMonitor(() => '/a', () => undefined, {
    now: () => now, staleMs: 1000, cachedAt: () => cached,
    query: async () => { calls++; return { ok: true }; },
  });
  await m.refreshIfStale();
  assert.equal(calls, 0, 'refreshed elsewhere less than staleMs ago');
  now += 600;
  await m.refreshIfStale();
  assert.equal(calls, 1, 'the cache is older than staleMs');
  cached = undefined;
  await m.refreshIfStale();
  assert.equal(calls, 1, 'this window just tried: no retry before staleMs');
  await m.refresh();
  assert.equal(calls, 2, 'a manual refresh always queries');
  now += 1000;
  cached = now - 10;
  await m.refreshIfStale();
  assert.equal(calls, 2);
  now += 1000;
  cached = now + 10 * 60_000;
  await m.refreshIfStale();
  assert.equal(calls, 3, 'a cache time far in the future (clock moved back) is not fresh');
});

test('a staleMs function is read on every check, so a changed interval applies at once', async () => {
  let now = 0;
  let staleMs = 1000;
  let calls = 0;
  const m = new ClaudeUsageMonitor(() => '/a', () => undefined, {
    now: () => now, staleMs: () => staleMs,
    query: async () => { calls++; return { ok: true }; },
  });
  await m.refreshIfStale();
  assert.equal(calls, 1);
  now = 600;
  await m.refreshIfStale();
  assert.equal(calls, 1, 'within the interval');
  staleMs = 500;
  await m.refreshIfStale();
  assert.equal(calls, 2, 'the shorter interval has passed');
});

test('a cache refreshed elsewhere after a failed attempt clears that failure without querying', async () => {
  let now = 0;
  let cached: number | undefined;
  let calls = 0;
  const m = new ClaudeUsageMonitor(() => '/a', () => undefined, {
    now: () => now, staleMs: 1000, cachedAt: () => cached,
    query: async () => { calls++; return { ok: false, reason: 'timeout' }; },
  });
  await m.refresh();
  assert.equal(m.current().failure?.reason, 'timeout');
  now = 1500;
  cached = 1400;
  await m.refreshIfStale();
  assert.equal(calls, 1);
  assert.equal(m.current().failure, undefined);
});

test('readUsageFetchedAt returns the attributable cache time of any age', LINUX_ONLY, () => {
  const tmp = makeTempHome('claude-usage-fetched');
  try {
    const dir = path.join(tmp.home, '.claude-work');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(cache({ fetchedAtMs: 5 })));
    assert.equal(readUsageFetchedAt(dir, true), 5);
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(cache({}, 'acct-2')));
    assert.equal(readUsageFetchedAt(dir, true), undefined);
  } finally { tmp.restore(); }
});

test('the monitor follows up once when the current account changes during a query', async () => {
  let dir = '/a';
  const calls: string[] = [];
  const m = new ClaudeUsageMonitor(() => dir, () => undefined, {
    query: async (d) => {
      calls.push(d);
      if (d === '/a') dir = '/b';
      return { ok: true };
    },
  });
  await m.refresh();
  assert.deepEqual(calls, ['/a', '/b']);
});

test('claudeUsageParts lists the general windows, without model scopes, and only this directory\'s failure', () => {
  setLocale('en');
  const usage = { checkedAt: NOW, windows: [
    { usedPercent: 3, windowMinutes: 10080, scope: 'Fable' },
    { usedPercent: 42, windowMinutes: 300 },
  ] };
  const hidden = claudeUsageParts(usage, { checking: false }, '/a', NOW);
  assert.deepEqual({ rows: hidden.rows.map(htmlText), notes: hidden.notes }, { rows: ['| 5h | ██████░░░░ | 58% |  |'], notes: [] }, 'the model-specific window is left out');
  const failed = claudeUsageParts(usage, { checking: false, failure: { dir: '/a', reason: 'notRefreshed' } }, '/a', NOW);
  assert.deepEqual(failed.notes.map(htmlText), ['_Usage check failed_']);
  assert.deepEqual(claudeUsageParts(undefined, { checking: false, failure: { dir: '/b', reason: 'timeout' } }, '/a'), { rows: [], notes: [] });
  assert.deepEqual(claudeUsageParts(undefined, { checking: true }, '/a').notes.map(htmlText), ['_Checking usage limits…_']);
  assert.deepEqual(claudeUsageParts(usage, { checking: true, failure: { dir: '/a', reason: 'timeout' } }, '/a', NOW).notes.map(htmlText), ['_Checking usage limits…_'], 'checking wins over an old failure');
});

test('claudeUsageFailureText gives the long text used by the refresh-all warning', () => {
  setLocale('en');
  assert.equal(claudeUsageFailureText({ reason: 'cliMissing' }, false), 'Usage limits unavailable: the claude command was not found.');
  assert.equal(claudeUsageFailureText({ reason: 'failed' }, false), 'Usage limits unavailable: unknown error');
  assert.equal(claudeUsageFailureText({ reason: 'notRefreshed' }, true), 'Usage limits could not be refreshed; the values shown are from the last successful check.');
  assert.equal(claudeUsageFailureText({ reason: 'notRefreshed' }, false), 'Usage limits unavailable: Claude Code could not refresh them.', 'no shown values to point at');
});

test('queryEach runs the targets one after another, keeps going after a failure and stops when cancelled', async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const targets = [{ dir: '/a', label: 'A' }, { dir: '/b', label: 'B' }, { dir: '/c', label: 'C' }];
  const results = await queryEach(targets, async (dir) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setImmediate(r));
    active--;
    order.push(dir);
    if (dir === '/b') throw new Error('boom');
    return { ok: true };
  });
  assert.equal(maxActive, 1, 'never two queries at once');
  assert.deepEqual(order, ['/a', '/b', '/c']);
  assert.deepEqual(results.map((r) => r.result), [{ ok: true }, { ok: false, reason: 'failed', detail: 'boom' }, { ok: true }]);
  const steps: number[] = [];
  const partial = await queryEach(targets, async () => ({ ok: true }), (_t, i) => steps.push(i), () => steps.length >= 2);
  assert.equal(partial.length, 2);
  assert.deepEqual(steps, [0, 1]);
});

test('oneAtATime runs tasks in call order without overlap, also after a failure', async () => {
  const queue = oneAtATime();
  const log: string[] = [];
  let active = 0;
  const task = (name: string, fail = false) => async (): Promise<string> => {
    assert.equal(active, 0, 'never two tasks at once');
    active++;
    log.push(`start ${name}`);
    await new Promise((r) => setImmediate(r));
    active--;
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([queue(task('a')), queue(task('b', true)), queue(task('c'))]);
  assert.deepEqual(log, ['start a', 'start b', 'start c']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('queryClaudeUsage ends the running child when the signal aborts', LINUX_ONLY, async () => {
  const tmp = makeTempHome('claude-usage-abort');
  try {
    const hang = fakeSpawn(() => undefined);
    const abort = new AbortController();
    const pending = queryClaudeUsage(path.join(tmp.home, '.claude-work'), true, { spawn: hang.spawn, signal: abort.signal, timeoutMs: 5000 });
    await new Promise((r) => setImmediate(r));
    abort.abort();
    assert.deepEqual(await pending, { ok: false, reason: 'failed', detail: 'cancelled' });
    assert.equal(hang.runs[0].child.killed, true);
  } finally { tmp.restore(); }
});

test('the monitor takes a result recorded for the current directory only', () => {
  const m = new ClaudeUsageMonitor(() => '/a', () => undefined, { query: async () => ({ ok: true }) });
  m.record('/b', { ok: false, reason: 'timeout' });
  assert.equal(m.current().failure, undefined, 'another directory is ignored');
  m.record('/a', { ok: false, reason: 'timeout' });
  assert.deepEqual(m.current().failure, { dir: '/a', reason: 'timeout', detail: undefined });
  m.record('/a', { ok: true });
  assert.equal(m.current().failure, undefined);
});

test('the status bar text shows Claude with what is left of its short window; the tooltip lists its windows with a refresh link after the plan', LINUX_ONLY, () => {
  setLocale('en');
  const tmp = makeTempHome('status-claude-usage');
  try {
    fs.mkdirSync(path.join(tmp.home, '.claude'));
    const fresh = cache({ fetchedAtMs: Date.now() - 60_000 });
    (fresh.cachedUsageUtilization as { utilization: Record<string, unknown> }).utilization = {
      limits: [{ kind: 'session', percent: 42, resets_at: iso(Date.now() + HOUR) }, { kind: 'weekly_all', percent: 7, resets_at: iso(Date.now() + 48 * HOUR) }],
    };
    fs.writeFileSync(path.join(tmp.home, '.claude.json'), JSON.stringify(fresh));
    const memento = new MemoryMemento();
    const bar = new StatusBar(new AccountStore(memento), new LabelStore(memento, 'claude.labels'));
    try {
      bar.setClaudeUsage({ checking: false });
      const item = statusBarItems.at(-1)!;
      assert.equal(item.text, '$(dashboard) Claude 58%');
      const tip = tooltipText(item.tooltip);
      assert.match(tip, /^\| 5h \|/m);
      assert.equal(tip.match(/\(command:[^ )]+/g)?.join(), '(command:planswap.claude.refreshUsage', 'only the refresh link');
      // Signed in (identity present) but nothing displayable cached
      fs.writeFileSync(path.join(tmp.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1', organizationUuid: 'org-1' } }));
      bar.update();
      assert.equal(item.text, '$(dashboard) Claude', 'no usage, no percentage');
    } finally { bar.dispose(); }
  } finally { tmp.restore(); }
});

test('Claude panel rows carry the cached usage of a subscription sign-in only', LINUX_ONLY, async () => {
  const tmp = makeTempHome('panel-claude-usage');
  try {
    const work = path.join(tmp.home, '.claude-work');
    const other = path.join(tmp.home, '.claude-other');
    fs.mkdirSync(work);
    fs.mkdirSync(other);
    const fresh = cache({ fetchedAtMs: Date.now() - 60_000 });
    (fresh.cachedUsageUtilization as { utilization: Record<string, unknown> }).utilization = {
      limits: [{ kind: 'session', percent: 42, resets_at: iso(Date.now() + HOUR) },
        { kind: 'weekly_scoped', percent: 25, resets_at: iso(Date.now() + 48 * HOUR), scope: { model: { display_name: 'Fable' } } }],
    };
    fs.writeFileSync(path.join(work, '.claude.json'), JSON.stringify(fresh));
    // Re-signed in to another account: the old cache is not shown
    fs.writeFileSync(path.join(other, '.claude.json'), JSON.stringify({ ...fresh, oauthAccount: { emailAddress: 'b@example.com', accountUuid: 'acct-2', organizationUuid: 'org' } }));
    const memento = new MemoryMemento();
    await memento.update('accounts', [{ name: 'work', dir: work }, { name: 'other', dir: other }]);
    const rows = claudePanelSource(new AccountStore(memento), new LabelStore(memento, 'claude.labels')).accounts();
    const row = rows.find((r) => r.dir === work);
    assert.equal(row?.usage?.windows[0].usedPercent, 42);
    assert.equal(row?.usage?.windows.length, 1);
    setConfig('planswap', SHOW_MODEL_LIMITS_SETTING, true);
    const shown = claudePanelSource(new AccountStore(memento), new LabelStore(memento, 'claude.labels')).accounts().find((r) => r.dir === work);
    assert.equal(shown?.usage?.windows.length, 2);
    assert.equal(shown?.usage?.windows[1].scope, 'Fable');
    assert.equal(row?.usageEligible, true);
    assert.equal(row?.usage?.windows[0].windowMinutes, 300);
    assert.equal(rows.find((r) => r.dir === other)?.usage, undefined);
    assert.ok(!JSON.stringify(rows).includes('acct-1'), 'no identity key reaches the Webview');
  } finally { resetConfig(); tmp.restore(); }
});
