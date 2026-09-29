// Real Windows only: other spellings of the same folder (8.3 short names, '\\?\' prefixes) and reparse points that
// lstat reports as plain folders. Everything runs under a temporary HOME.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import { accountDir, caseVariantOf, checkSafeToDelete, defaultDir, deleteAccountDir, sameRealPath, scanAccountDirs } from '../src/paths';
import { migrateClaudeToShared } from '../src/claudeShare';
import { isOpaqueReparseDir } from '../src/platform';
import { makeTempHome, onWindows, type TempHome } from './helpers';

const WINDOWS = { skip: !onWindows && 'Windows file system behavior' };
let tmp: TempHome;
let home: string;

before(() => {
  tmp = makeTempHome('aliases');
  home = tmp.home;
  setLocale('en');
});
after(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  tmp.restore();
});
beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
});

// The 8.3 short form of an existing path, or undefined when the volume does not generate short names
function shortName(p: string): string | undefined {
  try {
    // Verbatim, so Node does not escape the quotes cmd.exe needs around a path with spaces
    const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).stdout.trim();
    return out && out.toLowerCase() !== p.toLowerCase() ? out : undefined;
  } catch {
    return undefined;
  }
}

describe('another spelling of the default Claude folder', WINDOWS, () => {
  test('a \\\\?\\ or 8.3 CLAUDE_CONFIG_DIR is still the default: not listed, not deletable, not merged into itself', () => {
    const work = accountDir('longaccountname');
    fs.mkdirSync(path.join(work, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(work, 'projects', 'p', 's.jsonl'), 'session');
    const spellings = ['\\\\?\\' + work, shortName(work)].filter((s): s is string => !!s);
    for (const spelling of spellings) {
      process.env.CLAUDE_CONFIG_DIR = spelling;
      assert.equal(sameRealPath(work, defaultDir()), true, spelling);
      assert.deepEqual(scanAccountDirs(), [], spelling);
      assert.equal(checkSafeToDelete(work), t('del.isDefault', { dir: work }), spelling);
      const r = migrateClaudeToShared(work, 'longaccountname', path.join(home, 'noproc'));
      assert.equal(r.duplicates, 0, spelling);
      assert.equal(fs.readFileSync(path.join(work, 'projects', 'p', 's.jsonl'), 'utf8'), 'session', spelling);
    }
  });
});

describe('account folders differing only in case', WINDOWS, () => {
  test('a kept .claude-Work is found for the name "work"; the exact spelling is not a variant', () => {
    fs.mkdirSync(path.join(home, '.claude-Work'));
    assert.equal(caseVariantOf(accountDir('work')), '.claude-Work');
    assert.equal(caseVariantOf(accountDir('Work')), undefined);
    assert.equal(caseVariantOf(accountDir('other')), undefined);
  });
});

describe('reparse points lstat reports as folders', WINDOWS, () => {
  // A junction whose target is the volume GUID path of an existing folder; lstat says "directory", readdir says "link"
  function volumeJunction(link: string, target: string): boolean {
    try {
      const drive = path.parse(target).root.replace(/\\$/, '');
      const volume = execFileSync('mountvol', [drive, '/L'], { encoding: 'utf8', windowsHide: true }).trim();
      fs.symlinkSync(volume + target.slice(path.parse(target).root.length), link, 'junction');
      return fs.statSync(link).isDirectory();
    } catch {
      return false;
    }
  }

  test('deleting an account removes such a junction without touching what lies behind it', async (ctx) => {
    const victim = path.join(home, 'victim');
    fs.mkdirSync(path.join(victim, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
    fs.symlinkSync(path.join(victim, 'inner'), path.join(victim, 'userlink'), 'junction');
    const acc = accountDir('reparse');
    fs.mkdirSync(acc);
    if (!volumeJunction(path.join(acc, 'vj'), victim)) return ctx.skip('volume GUID junctions unavailable here');
    assert.equal(isOpaqueReparseDir(path.join(acc, 'vj')), true);
    await deleteAccountDir(acc);
    assert.equal(fs.existsSync(acc), false);
    assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.lstatSync(path.join(victim, 'userlink')).isSymbolicLink(), true);
  });

  test('converting to shared leaves such a folder in place instead of moving its files away', (ctx) => {
    const victim = path.join(home, 'victim2');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
    const acc = accountDir('reparse2');
    fs.mkdirSync(path.join(acc, 'projects'), { recursive: true });
    if (!volumeJunction(path.join(acc, 'projects', 'userproj'), victim)) return ctx.skip('volume GUID junctions unavailable here');
    migrateClaudeToShared(acc, 'reparse2', path.join(home, 'noproc'));
    assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(defaultDir(), 'projects', 'userproj', 'keep.txt')), false);
  });
});
