// agy usage limits (fake child processes only) and agy CLI discovery in a temporary HOME
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { findAgy, parseAgyUsage, readAgyUsage, windowMinutes, type AgyUsageSpawn, type UsageSpawnChild } from '../src/agy/agyUsage';
import { POSIX_ONLY, makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
before(() => { tmp = makeTempHome('agy-usage'); });
after(() => tmp.restore());

const NOW = 1_700_000_000_000;
// The shape `agy -p /usage --output-format json` printed with agy 1.5.10 (values made up)
const ANSWER = JSON.stringify({
  conversation_id: '', status: 'SUCCESS', response: 'tab-separated text', num_turns: 0,
  command: { name: 'usage', data: { description: 'Within each group ...', groups: [
    { name: 'Gemini Models', description: 'Models within this group: ...', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-11-22T13:02:51Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-11-17T19:17:15Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0.1 }] },
  ] } },
});

describe('parseAgyUsage', () => {
  test('every bucket becomes a window scoped by its model group, the shorter window first within a group', () => {
    assert.deepEqual(parseAgyUsage(ANSWER, NOW), {
      checkedAt: NOW,
      windows: [
        { usedPercent: 0, windowMinutes: 300, resetsAt: Date.parse('2026-11-17T19:17:15Z') / 1000, scope: 'Gemini' },
        { usedPercent: 25, windowMinutes: 10080, resetsAt: Date.parse('2026-11-22T13:02:51Z') / 1000, scope: 'Gemini' },
        { usedPercent: 90, windowMinutes: 10080, resetsAt: undefined, scope: 'Claude/GPT' },
      ],
    });
  });
  test('a Gemini 4 Argon group is shown above the Gemini group', () => {
    const group = (name: string, id: string) => ({ name, buckets: [{ id, window: 'weekly', remaining_fraction: 0.5 }] });
    const scopes = (groups: unknown[]) => parseAgyUsage(JSON.stringify({ command: { data: { groups } } }), NOW)!.windows.map((w) => w.scope);
    assert.deepEqual(scopes([group('Gemini Models', 'gemini-weekly'), group('Claude and GPT models', '3p-weekly'), group('Gemini 4 Argon', 'gemini-argon-wtu-weekly')]),
      ['Argon', 'Gemini', 'Claude/GPT']);
    // Recognized by its bucket id too; without a Gemini group the order is agy's
    assert.deepEqual(scopes([group('Gemini Models', 'gemini-weekly'), group('Pro', 'gemini-argon-wtu-weekly')]), ['Argon', 'Gemini']);
    assert.deepEqual(scopes([group('Claude and GPT models', '3p-weekly'), group('Gemini 4 Argon', 'gemini-argon-wtu-weekly')]), ['Claude/GPT', 'Argon']);
  });
  test('known groups get short names; another group keeps agy\'s name without a trailing "Models"', () => {
    const scope = (name: string, id?: string) => parseAgyUsage(JSON.stringify({ command: { data: { groups: [{ name, buckets: [{ id, window: '5h', remaining_fraction: 1 }] }] } } }), NOW)!.windows[0].scope;
    assert.equal(scope('Gemini Models'), 'Gemini');
    assert.equal(scope('Claude and GPT models'), 'Claude/GPT');
    assert.equal(scope('Third-party', '3p-5h'), 'Claude/GPT');
    assert.equal(scope('Gemini 4 Argon'), 'Argon');
    assert.equal(scope('Image Models'), 'Image');
    assert.equal(scope('Models'), 'Models');
  });
  test('anything else is not a usage report', () => {
    for (const text of ['', 'not json', '{}', JSON.stringify({ command: { data: { groups: [] } } }), JSON.stringify({ command: { data: { groups: [{ buckets: [{ remaining_fraction: 'x' }] }] } } })]) {
      assert.equal(parseAgyUsage(text, NOW), undefined, text);
    }
  });
  test('window ids', () => {
    assert.equal(windowMinutes('5h'), 300);
    assert.equal(windowMinutes('weekly'), 10080);
    assert.equal(windowMinutes('30m'), 30);
    assert.equal(windowMinutes('2d'), 2880);
    assert.equal(windowMinutes('monthly'), undefined);
    assert.equal(windowMinutes(undefined), undefined);
  });
});

function fakeSpawn(behave: (child: EventEmitter & UsageSpawnChild & { stdout: PassThrough }) => void): { spawn: AgyUsageSpawn; calls: Array<{ command: string; args: string[] }>; killed: () => boolean } {
  const calls: Array<{ command: string; args: string[] }> = [];
  let killed = false;
  const spawn: AgyUsageSpawn = (command, args) => {
    calls.push({ command, args });
    // A killed process exits right after the signal
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => { killed = true; setImmediate(() => child.emit('close', null)); return true; } });
    setImmediate(() => behave(child));
    return child;
  };
  return { spawn, calls, killed: () => killed };
}

describe('readAgyUsage', () => {
  test('runs the read-only slash command and parses its answer', async () => {
    const f = fakeSpawn((c) => { c.stdout.end(ANSWER); c.stdout.on('end', () => c.emit('close', 0)); });
    const r = await readAgyUsage('/opt/agy', { spawn: f.spawn, now: () => NOW });
    assert.ok(r.ok);
    assert.equal(r.usage.windows.length, 3);
    assert.deepEqual(f.calls, [{ command: '/opt/agy', args: ['-p', '/usage', '--output-format', 'json'] }]);
  });
  test('failures carry no CLI output', async () => {
    assert.deepEqual(await readAgyUsage(undefined), { ok: false, reason: 'cliMissing' });
    const exit = fakeSpawn((c) => { c.stdout.end('secret-looking output'); c.emit('close', 1); });
    assert.deepEqual(await readAgyUsage('/opt/agy', { spawn: exit.spawn }), { ok: false, reason: 'failed', detail: 'exit 1' });
    const missing = fakeSpawn((c) => c.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    assert.equal((await readAgyUsage('/opt/agy', { spawn: missing.spawn })).ok === false && 'cliMissing', 'cliMissing');
    const garbled = fakeSpawn((c) => { c.stdout.end('{"status":"ERROR"}'); c.stdout.on('end', () => c.emit('close', 0)); });
    assert.deepEqual(await readAgyUsage('/opt/agy', { spawn: garbled.spawn }), { ok: false, reason: 'unparsed' });
  });
  test('a CLI that does not answer is stopped', async () => {
    const hung = fakeSpawn(() => undefined);
    assert.deepEqual(await readAgyUsage('/opt/agy', { spawn: hung.spawn, timeoutMs: 20 }), { ok: false, reason: 'timeout' });
    assert.ok(hung.killed());
  });
  test('Windows: an agy.cmd shim runs through a shell with its path quoted', async () => {
    let options: { shell: boolean } | undefined;
    let command = '';
    const spawn: AgyUsageSpawn = (c, _a, o) => {
      command = c;
      options = o;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
      setImmediate(() => child.emit('close', 1));
      return child;
    };
    await readAgyUsage('C:\\Tools\\agy.cmd', { spawn, platform: 'win32' });
    assert.equal(options?.shell, true);
    assert.equal(command, '"C:\\Tools\\agy.cmd"');
  });
});

describe('findAgy', () => {
  test('PATH first, then the installer folder; a non-executable file does not count', POSIX_ONLY, () => {
    const bin = path.join(tmp.home, 'bin');
    const local = path.join(tmp.home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(local, { recursive: true });
    assert.equal(findAgy({ PATH: bin }, 'linux', tmp.home), undefined);
    fs.writeFileSync(path.join(local, 'agy'), '', { mode: 0o755 });
    assert.equal(findAgy({ PATH: bin }, 'linux', tmp.home), path.join(local, 'agy'));
    fs.writeFileSync(path.join(bin, 'agy'), '', { mode: 0o644 });
    assert.equal(findAgy({ PATH: bin }, 'linux', tmp.home), path.join(local, 'agy'));
    fs.chmodSync(path.join(bin, 'agy'), 0o755);
    assert.equal(findAgy({ PATH: bin }, 'linux', tmp.home), path.join(bin, 'agy'));
  });
  test('Windows looks for agy.exe and agy.cmd on PATH only', () => {
    const dir = path.join(tmp.home, 'win');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agy.cmd'), '');
    assert.equal(findAgy({ Path: dir }, 'win32', tmp.home), path.join(dir, 'agy.cmd'));
    assert.equal(findAgy({ Path: '' }, 'win32', tmp.home), undefined);
  });
});

describe('review fixes', () => {
  test('Linux never finds an agy in Windows PATH folders under /mnt/<drive>', POSIX_ONLY, () => {
    // Pretend an agy shim sits in the Windows npm folder that WSL appends to PATH; nothing is read from /mnt
    const home = path.join(tmp.home, 'no-agy-home');
    const env = { PATH: '/usr/bin:/mnt/c/Users/x/AppData/Roaming/npm' };
    assert.equal(findAgy(env, 'linux', home, (file) => file.startsWith('/mnt/c/')), undefined);
    assert.equal(findAgy(env, 'linux', home, (file) => file === '/usr/bin/agy'), '/usr/bin/agy');
  });
  test('Windows: a timed-out agy.cmd query ends the whole process tree', async () => {
    const killed: number[] = [];
    let child!: EventEmitter;
    const spawn: AgyUsageSpawn = () => (child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 4242, kill: () => true }));
    const killTree = async (pid: number): Promise<boolean> => {
      killed.push(pid);
      setImmediate(() => child.emit('close', 1));
      return true;
    };
    assert.deepEqual(await readAgyUsage('C:\\Tools\\agy.cmd', { spawn, platform: 'win32', timeoutMs: 10, killTree }), { ok: false, reason: 'timeout' });
    assert.deepEqual(killed, [4242]);
  });
});

describe('second review fixes', () => {
  test('a timed-out query resolves only after its own process has exited', async () => {
    let closed = false;
    const spawn: AgyUsageSpawn = () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 7, kill: () => {
        // The process takes a moment to exit after the signal
        setTimeout(() => { closed = true; child.emit('close', null); }, 40);
        return true;
      } });
      return child;
    };
    const r = await readAgyUsage('/opt/agy', { spawn, timeoutMs: 10 });
    assert.equal(closed, true, 'resolved before the query process exited');
    assert.equal(r.ok, false);
  });
  test('a query process that does not exit after the signal is reported as still running', async () => {
    const spawn: AgyUsageSpawn = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 8, kill: () => true });
    const r = await readAgyUsage('/opt/agy', { spawn, timeoutMs: 10, exitWaitMs: 20 });
    assert.equal(!r.ok && r.reason, 'stuck');
  });
  test('Windows: the shim\'s tree must be ended before the query counts as finished', async () => {
    const spawn: AgyUsageSpawn = () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 9, kill: () => true });
      return child;
    };
    let ended!: (ok: boolean) => void;
    const result = readAgyUsage('C:\\Tools\\agy.cmd', { spawn, platform: 'win32', timeoutMs: 10, exitWaitMs: 50,
      killTree: () => new Promise<boolean>((r) => { ended = r; }) });
    setTimeout(() => ended(false), 15);
    const r = await result;
    assert.equal(!r.ok && r.reason, 'stuck', 'a failed taskkill leaves the query unconfirmed');
  });
});
