import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodexAccountStore } from '../src/codex/codexStore';
import { LabelStore } from '../src/labels';
import { CASE_SENSITIVE_FS, makeTempHome, MemoryMemento, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
before(() => {
  tmp = makeTempHome('codex-store');
  home = tmp.home;
});
after(() => tmp.restore());

describe('CodexAccountStore', () => {
  test('all() prepends ~/.codex even when CODEX_HOME is set; named() is sorted without a stored default entry', async () => {
    const memento = new MemoryMemento();
    const store = new CodexAccountStore(memento);
    await memento.update('codex.accounts', [
      { name: 'b', dir: path.join(home, '.codex-b') },
      { name: 'default', dir: '/elsewhere' },
      { name: 'a', dir: path.join(home, '.codex-a') },
    ]);
    process.env.CODEX_HOME = path.join(home, '.codex-a');
    try {
      assert.deepEqual(store.all().map((a) => a.name), ['default', 'a', 'b']);
      assert.equal(store.all()[0].dir, path.join(home, '.codex'));
      assert.equal(store.findByDir(path.join(home, '.codex-b') + '/')?.name, 'b');
    } finally {
      delete process.env.CODEX_HOME;
    }
  });

  test('add replaces an entry with the same name and clears the directory from the ignore list', async () => {
    const memento = new MemoryMemento();
    const store = new CodexAccountStore(memento);
    const dir = path.join(home, '.codex-a');
    await memento.update('codex.ignoredDirs', [dir + '/', '/other']);
    await store.add({ name: 'a', dir: '/old' });
    await store.add({ name: 'a', dir });
    assert.deepEqual(store.named(), [{ name: 'a', dir }]);
    assert.deepEqual(memento.get('codex.ignoredDirs'), ['/other']);
  });

  test('remove keeps the directory ignored; unignore lets syncWithDisk register it again', async () => {
    const dir = path.join(home, '.codex-a');
    fs.mkdirSync(dir);
    const memento = new MemoryMemento();
    const store = new CodexAccountStore(memento);
    await store.syncWithDisk();
    assert.deepEqual(store.named(), [{ name: 'a', dir }]);
    await store.remove('a');
    await store.syncWithDisk();
    assert.deepEqual(store.named(), []);
    assert.deepEqual(memento.get('codex.ignoredDirs'), [dir]);
    await store.unignore(dir + '/');
    assert.deepEqual(memento.get('codex.ignoredDirs'), []);
    await store.syncWithDisk();
    assert.deepEqual(store.named(), [{ name: 'a', dir }]);
    fs.rmSync(dir, { recursive: true });
  });

  test('syncWithDisk skips a scanned name equal to an existing display name until that alias changes', async () => {
    const dir = path.join(home, '.codex-work');
    fs.mkdirSync(dir);
    const memento = new MemoryMemento();
    const store = new CodexAccountStore(memento);
    const labels = new LabelStore(memento, 'codex.labels');
    const a = { name: 'a', dir: path.join(home, 'elsewhere-a') };
    fs.mkdirSync(a.dir);
    await store.add(a);
    await labels.set('a', 'work');
    await store.syncWithDisk(labels);
    assert.deepEqual(store.named(), [a]);
    await labels.set('a', undefined);
    await store.syncWithDisk(labels);
    assert.deepEqual(store.named(), [a, { name: 'work', dir }]);
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(a.dir, { recursive: true });
  });

  test('syncWithDisk prunes entries whose directory is gone, clears their alias and does not ignore the directory', async () => {
    const kept = path.join(home, '.codex-kept');
    fs.mkdirSync(kept);
    const memento = new MemoryMemento();
    const store = new CodexAccountStore(memento);
    const labels = new LabelStore(memento, 'codex.labels');
    const gone = { name: 'gone', dir: path.join(home, '.codex-gone') };
    await store.add(gone);
    await store.add({ name: 'kept', dir: kept });
    await labels.set('gone', 'old-alias');
    await labels.set('kept', 'kept-alias');
    await store.syncWithDisk(labels);
    assert.deepEqual(store.named(), [{ name: 'kept', dir: kept }]);
    assert.equal(labels.get('gone'), undefined);
    assert.equal(labels.get('kept'), 'kept-alias');
    assert.deepEqual(memento.get('codex.ignoredDirs'), []);
    // A recreated directory is discovered again
    fs.mkdirSync(gone.dir);
    await store.syncWithDisk(labels);
    assert.deepEqual(store.named(), [gone, { name: 'kept', dir: kept }]);
    fs.rmSync(gone.dir, { recursive: true });
    fs.rmSync(kept, { recursive: true });
  });

  test('syncWithDisk skips scanned names equal to a registered name or display name ignoring case', async () => {
    const foo = path.join(home, '.codex-foo');
    const work = path.join(home, '.codex-WORK');
    const def = path.join(home, '.codex-Default');
    for (const d of [foo, work, def]) fs.mkdirSync(d);
    const memento = new MemoryMemento();
    const store = new CodexAccountStore(memento);
    const labels = new LabelStore(memento, 'codex.labels');
    const upper = { name: 'Foo', dir: path.join(home, 'elsewhere-foo') };
    const b = { name: 'b', dir: path.join(home, 'elsewhere-b') };
    fs.mkdirSync(upper.dir);
    fs.mkdirSync(b.dir);
    await store.add(upper);
    await store.add(b);
    await labels.set('b', 'Work');
    await store.syncWithDisk(labels);
    assert.deepEqual(store.named(), [upper, b]);
    for (const d of [foo, work, def, upper.dir, b.dir]) fs.rmSync(d, { recursive: true });
  });

  test('syncWithDisk registers only one of two scanned directories whose names differ only in case', CASE_SENSITIVE_FS, async () => {
    const dirs = ['foo', 'Foo'].map((n) => path.join(home, `.codex-${n}`));
    for (const d of dirs) fs.mkdirSync(d);
    const store = new CodexAccountStore(new MemoryMemento());
    await store.syncWithDisk();
    assert.equal(store.named().length, 1);
    assert.ok(['foo', 'Foo'].includes(store.named()[0].name));
    for (const d of dirs) fs.rmSync(d, { recursive: true });
  });
});
