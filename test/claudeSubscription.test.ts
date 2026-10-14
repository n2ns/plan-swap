import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeSubscriptionChecks, queryClaudeSubscription, type ClaudeSubscriptionResult } from '../src/claudeSubscription';
import type { ClaudeUsageChild, ClaudeUsageSpawn } from '../src/claudeUsage';
import { makeTempHome, withEnv } from './helpers';

class Child extends EventEmitter implements ClaudeUsageChild {
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(): boolean { this.killed = true; return true; }
  finish(output: unknown, code: number): void {
    this.stdout.end(JSON.stringify(output)); this.exitCode = code; this.emit('exit', code, null);
  }
}
const denied = [{ type: 'assistant', error: 'oauth_org_not_allowed' }, { type: 'result', subtype: 'success', is_error: true }];
const success = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }, { type: 'result', subtype: 'success', is_error: false }];
function writeIdentity(dir: string, account = 'account-1'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: 'org' } }));
}
function reply(output: unknown, code = 0, before?: () => void): ClaudeUsageSpawn {
  return () => { const child = new Child(); queueMicrotask(() => { before?.(); child.finish(output, code); }); return child; };
}

test('subscription probe recognizes structured access denial, never generic errors or localized text', async () => {
  const home = makeTempHome('subscription');
  try {
    const dir = path.join(home.home, '.claude-test'); writeIdentity(dir);
    assert.equal(await queryClaudeSubscription(dir, true, { spawn: reply(denied, 1) }), 'unavailable');
    assert.equal(await queryClaudeSubscription(dir, true, { spawn: reply(success) }), 'available');
    for (const output of [
      [{ type: 'assistant', error: 'authentication_failed' }, denied[1]],
      [{ type: 'assistant', message: 'oauth_org_not_allowed' }, denied[1]],
      [{ type: 'assistant', error: 'oauth_org_not_allowed' }, success[1]],
      [success[1]],
    ]) assert.equal(await queryClaudeSubscription(dir, true, { spawn: reply(output, 1) }), 'unknown');
    assert.equal(await queryClaudeSubscription(dir, true, { spawn: reply(success, 1) }), 'unknown');
  } finally { home.restore(); }
});

test('probe constrains execution, cleans its temporary cwd, and validates identity after execution', async () => {
  const home = makeTempHome('subscription');
  try {
    const dir = path.join(home.home, '.claude-test'); writeIdentity(dir);
    let cwd = '';
    const spawn: ClaudeUsageSpawn = (command, args, options) => {
      assert.equal(command, 'claude');
      assert.equal(options.env?.CLAUDE_CONFIG_DIR, dir);
      assert.ok(args.includes('--no-session-persistence'));
      assert.equal(args[args.indexOf('--tools') + 1], '');
      assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks, true);
      assert.ok(args.includes('--strict-mcp-config'));
      cwd = String(options.cwd); assert.ok(fs.existsSync(cwd)); assert.notEqual(cwd, home.home);
      return reply(success, 0, () => writeIdentity(dir, 'account-2'))(command, args, options);
    };
    assert.equal(await queryClaudeSubscription(dir, true, { spawn }), 'unknown');
    assert.equal(fs.existsSync(cwd), false);
    await withEnv({ ANTHROPIC_API_KEY: 'fake' }, async () => {
      assert.equal(await queryClaudeSubscription(dir, true, { spawn: () => { throw new Error('must not spawn'); } }), 'unknown');
    });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'example' }));
    assert.equal(await queryClaudeSubscription(dir, true, { spawn: () => { throw new Error('must not spawn'); } }), 'unknown');
  } finally { home.restore(); }
});

test('probe handles cancellation, timeout, bounded output and missing CLI fallback', async () => {
  const home = makeTempHome('subscription');
  try {
    const dir = path.join(home.home, '.claude-test'); writeIdentity(dir);
    const controller = new AbortController(); const child = new Child();
    const cancelled = queryClaudeSubscription(dir, true, { signal: controller.signal, spawn: () => child });
    controller.abort(); assert.equal(await cancelled, 'unknown'); assert.equal(child.killed, true);
    const timed = new Child();
    assert.equal(await queryClaudeSubscription(dir, true, { timeoutMs: 5, spawn: () => timed }), 'unknown'); assert.ok(timed.killed);
    const large = new Child();
    const bounded = queryClaudeSubscription(dir, true, { spawn: () => { queueMicrotask(() => large.stdout.write('x'.repeat(1024 * 1024 + 1))); return large; } });
    assert.equal(await bounded, 'unknown'); assert.ok(large.killed);
    const commands: string[] = [];
    assert.equal(await queryClaudeSubscription(dir, true, {
      fallback: () => '/fake/bundled-claude',
      spawn: (command, args, options) => {
        commands.push(command);
        if (command === 'claude') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return reply(denied, 1)(command, args, options);
      },
    }), 'unavailable');
    assert.deepEqual(commands, ['claude', '/fake/bundled-claude']);
  } finally { home.restore(); }
});

test('checks deduplicate, stop automatic denied probes, retain denial on unknown, and recover manually', async () => {
  const home = makeTempHome('subscription');
  try {
    const dir = path.join(home.home, '.claude-test'); writeIdentity(dir);
    let now = 0; let calls = 0; let finish!: (result: ClaudeSubscriptionResult) => void;
    const checks = new ClaudeSubscriptionChecks(() => { calls++; return new Promise((resolve) => { finish = resolve; }); }, () => undefined, () => now);
    const first = checks.check(dir, true);
    assert.equal(checks.state(dir, true).checking, true);
    assert.equal(checks.check(dir, true, true), first);
    await Promise.resolve(); finish('unavailable'); assert.equal(await first, 'unavailable');
    assert.deepEqual(checks.state(dir, true), { unavailable: true, checking: false });
    now += 3600_000;
    await checks.check(dir, true); assert.equal(calls, 1);
    const retry = checks.check(dir, true, true); await Promise.resolve(); finish('unknown'); await retry;
    assert.equal(checks.state(dir, true).unavailable, true);
    await checks.check(dir, true, true); assert.equal(calls, 2);
    now += 60_000;
    const restored = checks.check(dir, true, true); await Promise.resolve(); finish('available'); await restored;
    assert.equal(checks.state(dir, true).unavailable, false);
    await checks.check(dir, true); assert.equal(calls, 3);
    now += 3600_000;
    const stale = checks.check(dir, true); await Promise.resolve(); writeIdentity(dir, 'other'); finish('unavailable');
    assert.equal(await stale, 'unknown'); assert.equal(checks.state(dir, true).unavailable, false);
  } finally { home.restore(); }
});
