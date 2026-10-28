// moveEntry, mergeEntry and copyTree (src/shareMerge.ts): the move / merge / copy machinery both vendors use, in a
// temporary HOME
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setLocale } from '../src/i18n';
import { copyTree, mergeEntry, moveEntry } from '../src/shareMerge';
import { lstatOrUndefined, type MigrateReport } from '../src/shareLinks';
import { assertMode, assertTempHome, makeTempHome, onWindows, POSIX_ONLY, read, SHARING, snapshot, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
let def: string;

before(() => {
  tmp = makeTempHome('share-merge');
  home = tmp.home;
  def = path.join(home, '.claude');
  setLocale('en');
});
after(() => tmp.restore());

// Fresh default dir and no account dirs before each test
beforeEach(() => {
  assertTempHome(home);
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
  fs.mkdirSync(def, { mode: 0o700 });
});

// A dangling link target; absolute on every platform (Windows stores a rooted target with the current drive)
const NOWHERE = path.resolve('/nowhere');
const write = (f: string, content: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

describe('mergeEntry', () => {
  test('a fifo the default lacks is left in place instead of being moved', POSIX_ONLY, () => {
    const src = path.join(home, 'merge-src');
    const dst = path.join(home, 'merge-dst');
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    execFileSync('mkfifo', [path.join(src, 'pipe')]);
    const report: MigrateReport = { linked: [], created: [], conflicts: [], refused: [], moved: 0, duplicates: 0, keptBoth: [], backups: [] };
    mergeEntry(path.join(src, 'pipe'), path.join(dst, 'pipe'), 'pipe', { report, account: 'x' });
    assert.ok(fs.lstatSync(path.join(src, 'pipe')).isFIFO());
    assert.ok(!fs.existsSync(path.join(dst, 'pipe')));
    assert.equal(report.moved, 0);
    assert.deepEqual(report.keptBoth, []);
  });
});

describe('moveEntry link targets', SHARING, () => {
  test('whole-tree moves preserve internal and external relative links on the same and another volume', (ctx) => {
    const physicalParent = path.join(home, 'physical-parent');
    const aliasParent = path.join(home, 'alias-parent');
    fs.mkdirSync(physicalParent);
    fs.symlinkSync(physicalParent, aliasParent, 'junction');
    for (const crossVolume of [false, true]) {
      const src = path.join(aliasParent, `move-src-${crossVolume}`);
      const dst = path.join(home, 'profiles', `move-dst-${crossVolume}`);
      write(path.join(home, 'outside.md'), 'outside');
      write(path.join(src, 'target.md'), 'inside');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync('target.md', path.join(src, 'inside.md'), 'file');
      fs.symlinkSync('../../outside.md', path.join(src, 'outside.md'), 'file');
      const mocked = crossVolume ? ctx.mock.method(fsModule, 'renameSync', (() => {
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      }) as typeof fs.renameSync) : undefined;
      try {
        assert.equal(moveEntry(src, dst), true);
        assert.equal(fs.existsSync(src), false);
        assert.equal(read(path.join(dst, 'inside.md')), 'inside');
        assert.equal(read(path.join(dst, 'outside.md')), 'outside');
      } finally {
        mocked?.mock.restore();
      }
    }
  });

  test('a refused cross-volume link copy keeps every source entry and removes the partial destination', (ctx) => {
    const src = path.join(home, 'move-src');
    const dst = path.join(home, 'move-dst');
    write(path.join(src, '000-file.md'), 'keep');
    fs.symlinkSync('gone.md', path.join(src, 'dangling.md'), 'file');
    const before = snapshot(src);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    const symlink = fsModule.symlinkSync;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    ctx.mock.method(fsModule, 'renameSync', (() => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); }) as typeof fs.renameSync);
    ctx.mock.method(fsModule, 'symlinkSync', ((target: fs.PathLike, link: fs.PathLike, type?: fs.symlink.Type) => {
      if (type === 'file') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return symlink(target, link, type);
    }) as typeof fs.symlinkSync);
    try {
      assert.equal(moveEntry(src, dst), false);
      assert.deepEqual(snapshot(src), before);
      assert.equal(fs.existsSync(dst), false);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('copyTree relative links', SHARING, () => {
  test('a link inside the copied tree points into the copy; one leading outside still reaches its target', () => {
    const src = path.join(home, 'dotfiles', 'agents');
    write(path.join(src, 'shared', 'a.md'), 'inside');
    write(path.join(home, 'dotfiles', 'common', 'b.md'), 'outside');
    fs.symlinkSync(path.join('shared', 'a.md'), path.join(src, 'in.md'), 'file');
    fs.symlinkSync(path.join('..', 'common', 'b.md'), path.join(src, 'out.md'), 'file');
    const dst = path.join(home, 'copy', 'agents');
    fs.mkdirSync(path.dirname(dst));
    copyTree(src, dst);
    assert.equal(read(path.join(dst, 'in.md')), 'inside');
    assert.equal(read(path.join(dst, 'out.md')), 'outside');
    // The inside link resolves into the copy, not back into the source
    assert.equal(fs.realpathSync(path.join(dst, 'in.md')), fs.realpathSync(path.join(dst, 'shared', 'a.md')));
    if (!onWindows) assert.equal(fs.readlinkSync(path.join(dst, 'in.md')), path.join('shared', 'a.md'));
  });
});

describe('copyTree', SHARING, () => {
  test('copies links verbatim, keeps modes, skips fifos and existing entries; throws EEXIST on demand', () => {
    const src = path.join(home, 'tree-src');
    const dst = path.join(home, 'tree-dst');
    write(path.join(src, 'a', 'f.txt'), 'f');
    fs.chmodSync(path.join(src, 'a', 'f.txt'), 0o640);
    fs.symlinkSync(NOWHERE, path.join(src, 'lnk'));
    execFileSync('mkfifo', [path.join(src, 'pipe')]);
    write(path.join(dst, 'a', 'f.txt'), 'old');
    copyTree(src, dst);
    assert.equal(read(path.join(dst, 'a', 'f.txt')), 'old');   // never overwritten
    assert.equal(fs.readlinkSync(path.join(dst, 'lnk')), NOWHERE);
    assert.ok(!fs.existsSync(path.join(dst, 'pipe')));
    fs.rmSync(path.join(dst, 'a', 'f.txt'));
    copyTree(src, dst);
    assert.equal(read(path.join(dst, 'a', 'f.txt')), 'f');
    assertMode(path.join(dst, 'a', 'f.txt'), '640');
    assert.throws(() => copyTree(src, dst, 'throw'), { code: 'EEXIST' });
  });

  test('an unreadable folder throws an ordinary error instead of ending the process', POSIX_ONLY, () => {
    if (process.getuid?.() === 0) return;   // root ignores directory permissions
    const src = path.join(home, 'tree-src');
    write(path.join(src, 'ok.txt'), 'ok');
    write(path.join(src, 'locked', 'f.txt'), 'f');
    fs.chmodSync(path.join(src, 'locked'), 0o000);
    const dst = path.join(home, 'tree-dst');
    try {
      assert.throws(() => copyTree(src, dst), /EACCES/);
    } finally {
      // The target folder was created with the source's mode before the read failed
      for (const d of [path.join(src, 'locked'), path.join(dst, 'locked')]) if (lstatOrUndefined(d)) fs.chmodSync(d, 0o700);
    }
  });
});
