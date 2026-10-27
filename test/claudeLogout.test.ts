import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { LOGOUT_TIMEOUT_MS, logoutClaude } from '../src/claudeLogout';
import type { ClaudeUsageChild, ClaudeUsageSpawn } from '../src/claudeUsage';

interface FakeRun { command: string; args: string[]; options: SpawnOptions; child: FakeChild }
class FakeChild extends EventEmitter implements ClaudeUsageChild {
  stdout = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.signalCode = 'SIGTERM';
    return true;
  }
}

// behave: what the fake claude does once started; a command in enoent fails to start like a missing executable
function fakeSpawn(behave: (child: FakeChild) => void, enoent: string[] = []): { spawn: ClaudeUsageSpawn; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const spawn: ClaudeUsageSpawn = (command, args, options) => {
    const child = new FakeChild();
    runs.push({ command, args, options, child });
    setImmediate(() => {
      if (enoent.includes(command)) child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
      else behave(child);
    });
    return child;
  };
  return { spawn, runs };
}
const exit = (code: number | null, signal: NodeJS.Signals | null = null) => (child: FakeChild): void => {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('exit', code, signal);
};

const DIR = path.resolve('/Users/u/.claude-work');

test('logoutClaude runs `claude auth logout` with exactly the resolved folder as CLAUDE_CONFIG_DIR and reads no output', async () => {
  const f = fakeSpawn(exit(0));
  const result = await logoutClaude(DIR + path.sep, { spawn: f.spawn, platform: 'darwin', env: { HTTPS_PROXY: 'http://proxy', ANTHROPIC_API_KEY: '' } });
  assert.deepEqual(result, { ok: true });
  assert.equal(f.runs.length, 1);
  const [{ command, args, options }] = f.runs;
  assert.equal(command, 'claude');
  assert.deepEqual(args, ['auth', 'logout']);
  assert.equal(options.env?.CLAUDE_CONFIG_DIR, DIR, 'no trailing separator: the Keychain item is named after the exact string');
  assert.equal(options.env?.HTTPS_PROXY, 'http://proxy', 'the setting variables apply');
  assert.equal(options.env?.ANTHROPIC_API_KEY, '');
  assert.equal(options.stdio, 'ignore');
});

test('logoutClaude falls back to the bundled CLI and reports a missing CLI', async () => {
  const bundled = path.resolve('/ext/resources/native-binary/claude');
  const f = fakeSpawn(exit(0), ['claude']);
  assert.deepEqual(await logoutClaude(DIR, { spawn: f.spawn, platform: 'darwin', fallback: () => bundled }), { ok: true });
  assert.deepEqual(f.runs.map((r) => r.command), ['claude', bundled]);
  assert.equal(f.runs[1].options.env?.CLAUDE_CONFIG_DIR, DIR);
  const missing = fakeSpawn(exit(0), ['claude']);
  assert.deepEqual(await logoutClaude(DIR, { spawn: missing.spawn, platform: 'darwin', fallback: () => undefined }), { ok: false, reason: 'cliMissing' });
});

test('logoutClaude reports a non-zero exit or a signal by code only', async () => {
  assert.deepEqual(await logoutClaude(DIR, { spawn: fakeSpawn(exit(1)).spawn, platform: 'darwin' }), { ok: false, reason: 'failed', detail: 'exit code 1' });
  assert.deepEqual(await logoutClaude(DIR, { spawn: fakeSpawn(exit(null, 'SIGKILL')).spawn, platform: 'darwin' }), { ok: false, reason: 'failed', detail: 'signal SIGKILL' });
});

test('logoutClaude stops a CLI that does not finish in time; the default limit is 30 s', async () => {
  const hung = fakeSpawn(() => undefined);
  assert.deepEqual(await logoutClaude(DIR, { spawn: hung.spawn, platform: 'darwin', timeoutMs: 20 }), { ok: false, reason: 'timeout' });
  assert.equal(hung.runs[0].child.killed, true);
  assert.equal(LOGOUT_TIMEOUT_MS, 30_000);
  // The deadline counts from the start: a clock already at the limit starts nothing, one below it does
  const clock = (later: number) => { let n = 0; return () => (n++ === 0 ? 0 : later); };
  const none = fakeSpawn(exit(0));
  assert.deepEqual(await logoutClaude(DIR, { spawn: none.spawn, platform: 'darwin', now: clock(LOGOUT_TIMEOUT_MS) }), { ok: false, reason: 'timeout' });
  assert.equal(none.runs.length, 0);
  const one = fakeSpawn(exit(0));
  assert.deepEqual(await logoutClaude(DIR, { spawn: one.spawn, platform: 'darwin', now: clock(LOGOUT_TIMEOUT_MS - 5000) }), { ok: true });
  assert.equal(one.runs.length, 1);
});
