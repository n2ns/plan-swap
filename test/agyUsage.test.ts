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
  test('every bucket becomes a window scoped by its model group', () => {
    assert.deepEqual(parseAgyUsage(ANSWER, NOW), {
      checkedAt: NOW,
      windows: [
        { usedPercent: 25, windowMinutes: 10080, resetsAt: Date.parse('2026-11-22T13:02:51Z') / 1000, scope: 'Gemini Models' },
        { usedPercent: 0, windowMinutes: 300, resetsAt: Date.parse('2026-11-17T19:17:15Z') / 1000, scope: 'Gemini Models' },
        { usedPercent: 90, windowMinutes: 10080, resetsAt: undefined, scope: 'Claude and GPT models' },
      ],
    });
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
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => { killed = true; return true; } });
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
    const spawn: AgyUsageSpawn = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 4242, kill: () => true });
    assert.deepEqual(await readAgyUsage('C:\\Tools\\agy.cmd', { spawn, platform: 'win32', timeoutMs: 10, killTree: (pid) => killed.push(pid) }), { ok: false, reason: 'timeout' });
    assert.deepEqual(killed, [4242]);
  });
});
