// Emulates Windows without Developer Mode on Linux: process.platform reads win32 and file symlinks fail with EPERM
// (directory links still work, as junctions do). Everything runs under a temporary HOME.
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as path from 'node:path';
import { setLocale } from '../src/i18n';
import { ensureClaudeLinks, isSharedClaudeAccount, migrateClaudeToShared } from '../src/claudeShare';
import { ensureCodexLinks, migrateCodexToShared } from '../src/codex/codexShare';
import { describeShareReport } from '../src/shareReport';
import { fileLinksAvailable } from '../src/platform';
import { makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const realSymlink = fsModule.symlinkSync;
let FAKE_PROC = '';

function emulate(devMode: boolean): void {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  mock.method(fsModule, 'symlinkSync', ((target: fs.PathLike, link: fs.PathLike, type?: string) => {
    if (type === 'file' && !devMode) throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
    return realSymlink(target, link);
  }) as typeof fs.symlinkSync);
}

before(() => {
  tmp = makeTempHome('nodevmode');
  home = tmp.home;
  setLocale('en');
  // An empty process tree: nothing is running
  FAKE_PROC = path.join(home, '..', `proc-${path.basename(home)}`);
  fs.mkdirSync(FAKE_PROC);
});
after(() => {
  fs.rmSync(FAKE_PROC, { recursive: true, force: true });
  tmp.restore();
});
beforeEach(() => {
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.claude'), { mode: 0o700 });
  fs.mkdirSync(path.join(home, '.codex'), { mode: 0o700 });
});
afterEach(() => {
  mock.restoreAll();
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('Windows without Developer Mode', () => {
  test('the probe reports missing file-link privilege and cleans up', () => {
    emulate(false);
    assert.equal(fileLinksAvailable(home), false);
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.planswap-probe')), []);
  });

  test('the probe passes with Developer Mode', () => {
    emulate(true);
    assert.equal(fileLinksAvailable(home), true);
  });

  test('Claude: folders are still linked, files are reported, nothing throws', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    const r = ensureClaudeLinks(acc, FAKE_PROC);
    assert.ok(r.linked.includes('projects'));
    assert.equal(fs.lstatSync(path.join(acc, 'projects')).isSymbolicLink(), true);
    // Config files are copied once; history is never copied
    assert.ok(r.copied?.includes('settings.json'));
    assert.ok(r.copied?.includes('CLAUDE.md'));
    assert.ok(r.noPrivilege?.includes('history.jsonl'));
    assert.equal(fs.lstatSync(path.join(acc, 'settings.json')).isFile(), true);
    assert.equal(fs.existsSync(path.join(acc, 'history.jsonl')), false);
    assert.equal(isSharedClaudeAccount(acc), true);
    assert.match(describeShareReport(r), /Developer Mode/);
    assert.match(describeShareReport(r), /copied once/);
  });

  test('copies never overwrite an existing account file', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    fs.writeFileSync(path.join(acc, 'CLAUDE.md'), 'mine\n');
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'default\n');
    const r = ensureClaudeLinks(acc, FAKE_PROC);
    assert.equal(fs.readFileSync(path.join(acc, 'CLAUDE.md'), 'utf8'), 'mine\n');
    assert.ok(r.conflicts.includes('CLAUDE.md'));
  });

  test('identical copies are upgraded to links once Developer Mode is on', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'rules\n');
    ensureClaudeLinks(acc, FAKE_PROC);
    assert.equal(fs.lstatSync(path.join(acc, 'CLAUDE.md')).isSymbolicLink(), false);
    mock.restoreAll();
    emulate(true);
    const r = ensureClaudeLinks(acc, FAKE_PROC);
    assert.ok(r.linked.includes('CLAUDE.md'));
    assert.equal(fs.lstatSync(path.join(acc, 'CLAUDE.md')).isSymbolicLink(), true);
    // A diverged copy is left alone
    fs.rmSync(path.join(acc, 'settings.json'));
    fs.writeFileSync(path.join(acc, 'settings.json'), '{"x":1}\n');
    assert.ok(ensureClaudeLinks(acc, FAKE_PROC).conflicts.includes('settings.json'));
  });

  test('Claude conversion keeps the account files instead of moving them away', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(path.join(acc, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(acc, 'CLAUDE.md'), 'mine\n');
    fs.writeFileSync(path.join(acc, 'history.jsonl'), '{"a":1}\n');
    const r = migrateClaudeToShared(acc, 'work', FAKE_PROC);
    assert.equal(fs.readFileSync(path.join(acc, 'CLAUDE.md'), 'utf8'), 'mine\n');
    assert.equal(fs.readFileSync(path.join(acc, 'history.jsonl'), 'utf8'), '{"a":1}\n');
    // The default may get an empty link target, but the account's content is never moved into it
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), '');
    assert.ok(r.noPrivilege?.includes('CLAUDE.md'));
    assert.equal(fs.lstatSync(path.join(acc, 'projects')).isSymbolicLink(), true);
  });

  test('Codex: folders link, files and databases are reported, conversion keeps account files', () => {
    emulate(false);
    const acc = path.join(home, '.codex-work');
    fs.mkdirSync(path.join(acc, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(acc, 'config.toml'), 'model = "x"\n');
    const r = migrateCodexToShared(acc, 'work', FAKE_PROC);
    assert.equal(fs.readFileSync(path.join(acc, 'config.toml'), 'utf8'), 'model = "x"\n');
    assert.ok(r.noPrivilege?.includes('config.toml'));
    assert.equal(fs.lstatSync(path.join(acc, 'sessions')).isSymbolicLink(), true);
    const again = ensureCodexLinks(acc);
    assert.ok(again.noPrivilege?.includes('history.jsonl'));
    const fresh = path.join(home, '.codex-fresh');
    fs.mkdirSync(fresh);
    const r2 = ensureCodexLinks(fresh);
    assert.ok(r2.copied?.includes('AGENTS.md'));
    assert.ok(!r2.copied?.some((n) => n.endsWith('.sqlite') || n.endsWith('.jsonl')));
  });

  test('with Developer Mode files link normally', () => {
    emulate(true);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    const r = ensureClaudeLinks(acc, FAKE_PROC);
    assert.equal(r.noPrivilege, undefined);
    assert.equal(fs.lstatSync(path.join(acc, 'settings.json')).isSymbolicLink(), true);
  });
});
