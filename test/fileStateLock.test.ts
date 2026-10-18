// The cross-process lock of FileMemento (design.md section 4): waiting for a live owner, taking over a lock left by a
// dead process or a crash, the timeout, and real concurrency between processes. With PLANSWAP_FILESTATE_WORKER set,
// this bundle runs as one of those processes instead of registering tests. Temporary HOME throughout.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileMemento, LOCK_STALE_MS } from '../src/fileState';
import { makeTempHome, read, type TempHome } from './helpers';

const workerSpec = process.env['PLANSWAP_FILESTATE_WORKER'];

if (workerSpec) {
  // Worker: "<file>|<key prefix>|<count>": count updates of its own keys on the shared file
  const [file = '', prefix = '', count = '0'] = workerSpec.split('|');
  const m = new FileMemento(file);
  (async () => {
    for (let i = 0; i < Number(count); i++) await m.update(`${prefix}${i}`, i);
  })().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
} else {
  let tmp: TempHome;
  before(() => { tmp = makeTempHome('fileState-lock'); });
  after(() => tmp.restore());

  const fileOf = (name: string): string => path.join(tmp.home, '.config', 'planswap', name);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // A pid that no process has: a child that already exited
  const deadPid = (): number => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    assert.equal(child.status, 0);
    return child.pid!;
  };

  describe('FileMemento lock', () => {
    test('the lock directory sits next to the file and is gone after an update', async () => {
      const m = new FileMemento(fileOf('a.json'));
      assert.equal(m.lockDir, fileOf('a.json') + '.lock');
      await m.update('k', 1);
      assert.equal(fs.existsSync(m.lockDir), false);
      assert.deepEqual(JSON.parse(read(fileOf('a.json'))), { k: 1 });
    });

    test('waits while a live process holds the lock, then writes', async () => {
      const m = new FileMemento(fileOf('b.json'));
      fs.mkdirSync(path.dirname(m.lockDir), { recursive: true });
      fs.mkdirSync(m.lockDir);
      fs.writeFileSync(path.join(m.lockDir, 'owner'), String(process.pid)); // this test process: alive
      let done = false;
      const pending = m.update('k', 'v').then(() => { done = true; });
      await sleep(200);
      assert.equal(done, false, 'still waiting');
      assert.equal(fs.existsSync(fileOf('b.json')), false, 'nothing written while the lock is held');
      fs.rmSync(m.lockDir, { recursive: true, force: true });
      await pending;
      assert.deepEqual(JSON.parse(read(fileOf('b.json'))), { k: 'v' });
      assert.equal(fs.existsSync(m.lockDir), false);
    });

    test('takes over a lock whose owner process is gone', async () => {
      const m = new FileMemento(fileOf('c.json'), 1000);
      fs.mkdirSync(m.lockDir, { recursive: true });
      fs.writeFileSync(path.join(m.lockDir, 'owner'), String(deadPid()));
      const started = Date.now();
      await m.update('k', 1);
      assert.ok(Date.now() - started < 900, 'did not wait for the timeout');
      assert.deepEqual(JSON.parse(read(fileOf('c.json'))), { k: 1 });
      assert.deepEqual(fs.readdirSync(path.dirname(m.lockDir)).filter((n) => n.includes('.lock')), [], 'no lock or stale leftover');
    });

    test('a lock without an owner note is taken over only once it is old', async () => {
      const m = new FileMemento(fileOf('d.json'), 300);
      // Old: a crash between mkdir and the owner note long ago
      fs.mkdirSync(m.lockDir, { recursive: true });
      const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
      fs.utimesSync(m.lockDir, old, old);
      await m.update('k', 1);
      assert.deepEqual(JSON.parse(read(fileOf('d.json'))), { k: 1 });
      // Fresh: another process is between mkdir and the owner note; the short wait of this instance runs out
      fs.mkdirSync(m.lockDir);
      await assert.rejects(m.update('k', 2), /holds the state file lock/);
      assert.deepEqual(JSON.parse(read(fileOf('d.json'))), { k: 1 }, 'nothing written');
      fs.rmSync(m.lockDir, { recursive: true, force: true });
    });

    test('the lock is released when the write fails', async () => {
      const file = fileOf('e.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '[1]'); // not a JSON object: update rejects before writing
      const m = new FileMemento(file);
      await assert.rejects(m.update('k', 1));
      assert.equal(fs.existsSync(m.lockDir), false);
    });

    test('three processes updating the same file at once lose no key', { timeout: 50_000 }, async () => {
      const file = fileOf('shared.json');
      const count = 25;
      const workers = ['a', 'b', 'c'].map((prefix) => new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [__filename], {
          env: { ...process.env, PLANSWAP_FILESTATE_WORKER: `${file}|${prefix}|${count}` },
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        child.on('exit', (code) => resolve(code ?? 1));
      }));
      const codes = await Promise.all(workers);
      assert.deepEqual(codes, [0, 0, 0]);
      const state = JSON.parse(read(file)) as Record<string, number>;
      assert.equal(Object.keys(state).length, 3 * count, 'every update survived');
      for (const prefix of ['a', 'b', 'c']) for (let i = 0; i < count; i++) assert.equal(state[`${prefix}${i}`], i);
      assert.equal(fs.existsSync(file + '.lock'), false);
    });
  });
}
