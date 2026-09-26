import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileMemento, STATE_JSON } from '../src/fileState';
import { makeTempHome, MemoryMemento, mode, read, type TempHome } from './helpers';

let tmp: TempHome;
before(() => { tmp = makeTempHome('fileState'); });
after(() => tmp.restore());

const fresh = (name: string): FileMemento => new FileMemento(path.join(tmp.home, '.config', 'planswap', name));

describe('FileMemento', () => {
  test('default path is ~/.config/planswap/state.json', () => {
    assert.equal(STATE_JSON(), path.join(tmp.home, '.config', 'planswap', 'state.json'));
  });
  test('missing file reads as empty; defaultValue returned', () => {
    const m = fresh('a.json');
    assert.equal(m.exists(), false);
    assert.equal(m.get('accounts'), undefined);
    assert.deepEqual(m.get('accounts', []), []);
    assert.deepEqual(m.keys(), []);
  });
  test('update writes the file atomically with mode 0600 in a 0700 directory and reads back', async () => {
    const m = fresh('b.json');
    await m.update('accounts', [{ name: 'x', dir: '/tmp/x' }]);
    await m.update('claude.labels', { x: 'Work' });
    const file = path.join(tmp.home, '.config', 'planswap', 'b.json');
    assert.equal(mode(file), '600');
    assert.equal(mode(path.dirname(file)), '700');
    assert.deepEqual(JSON.parse(read(file)), { accounts: [{ name: 'x', dir: '/tmp/x' }], 'claude.labels': { x: 'Work' } });
    assert.deepEqual(fresh('b.json').get('claude.labels'), { x: 'Work' });
    assert.deepEqual([...m.keys()].sort(), ['accounts', 'claude.labels']);
    assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')).length, 0);
  });
  test('update with undefined deletes the key', async () => {
    const m = fresh('c.json');
    await m.update('k', 1);
    await m.update('k', undefined);
    assert.equal(m.get('k'), undefined);
    assert.deepEqual(m.keys(), []);
  });
  test('invalid or non-object content is treated as empty and overwritten on update', async () => {
    const file = path.join(tmp.home, '.config', 'planswap', 'd.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const m = fresh('d.json');
    assert.equal(m.get('k'), undefined);
    fs.writeFileSync(file, '[1,2]');
    assert.equal(m.get('0'), undefined);
    await m.update('k', 'v');
    assert.deepEqual(JSON.parse(read(file)), { k: 'v' });
  });
  test('update merges into the file as it is on disk, so keys written by another process meanwhile are kept', async () => {
    const m = fresh('i.json');
    await m.update('accounts', [{ name: 'x', dir: '/tmp/x' }]);
    const file = path.join(tmp.home, '.config', 'planswap', 'i.json');
    // Another extension host rewrote the file between the two updates
    fs.writeFileSync(file, JSON.stringify({ accounts: [{ name: 'y', dir: '/tmp/y' }], 'codex.labels': { y: 'Y' } }));
    await m.update('claude.labels', { x: 'Work' });
    assert.deepEqual(JSON.parse(read(file)), {
      accounts: [{ name: 'y', dir: '/tmp/y' }],
      'codex.labels': { y: 'Y' },
      'claude.labels': { x: 'Work' },
    });
  });
  test('own properties only: __proto__ and constructor are not resolved from the prototype', async () => {
    const m = fresh('e.json');
    assert.equal(m.get('constructor'), undefined);
    assert.equal(m.get('__proto__'), undefined);
    await m.update('__proto__', { a: 1 });
    assert.deepEqual(m.get('__proto__'), { a: 1 });
  });
});

describe('FileMemento.importOnce', () => {
  test('copies the six state keys from globalState and creates the file', async () => {
    const source = new MemoryMemento();
    await source.update('accounts', [{ name: 'a', dir: '/tmp/a' }]);
    await source.update('codex.labels', { a: 'A' });
    await source.update('panel.activeTab', 'codex');
    const m = fresh('f.json');
    await m.importOnce(source);
    assert.equal(m.exists(), true);
    assert.deepEqual(m.get('accounts'), [{ name: 'a', dir: '/tmp/a' }]);
    assert.deepEqual(m.get('codex.labels'), { a: 'A' });
    assert.equal(m.get('panel.activeTab'), undefined);
  });
  test('creates an empty file when globalState has nothing, and never imports again once the file exists', async () => {
    const source = new MemoryMemento();
    const m = fresh('g.json');
    await m.importOnce(source);
    assert.equal(m.exists(), true);
    assert.deepEqual(m.keys(), []);
    await source.update('accounts', [{ name: 'late', dir: '/tmp/late' }]);
    await m.importOnce(source);
    assert.equal(m.get('accounts'), undefined);
  });
  test('does not overwrite an existing file', async () => {
    const m = fresh('h.json');
    await m.update('accounts', [{ name: 'keep', dir: '/tmp/keep' }]);
    const source = new MemoryMemento();
    await source.update('accounts', [{ name: 'other', dir: '/tmp/other' }]);
    await m.importOnce(source);
    assert.deepEqual(m.get('accounts'), [{ name: 'keep', dir: '/tmp/keep' }]);
  });
});
