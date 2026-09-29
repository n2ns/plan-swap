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
import { LinkPrivilegeError, copyLink, createLink, fileLinksAvailable } from '../src/platform';
import { deleteAccountDir } from '../src/paths';
import { askCopyFallback } from '../src/linkPolicy';
import { window } from './stubs/vscode';
import { FILE_SYMLINKS, makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
const realSymlink = fsModule.symlinkSync;
let FAKE_PROC = '';
const COPY = { copyConfig: true };

function emulate(devMode: boolean): void {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  mock.method(fsModule, 'symlinkSync', ((target: fs.PathLike, link: fs.PathLike, type?: string) => {
    if (type === 'file' && !devMode) throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
    return realSymlink(target, link, type as fs.symlink.Type | undefined);
  }) as typeof fs.symlinkSync);
}

before(() => {
  tmp = makeTempHome('nodevmode');
  home = tmp.home;
  setLocale('en');
  FAKE_PROC = path.join(home, '.fake-proc');
});
after(() => tmp.restore());
beforeEach(() => {
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
  // An empty process tree: nothing is running
  fs.mkdirSync(FAKE_PROC);
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

  test('the probe passes with Developer Mode', FILE_SYMLINKS, () => {
    emulate(true);
    assert.equal(fileLinksAvailable(home), true);
  });

  test('Claude: folders are still linked, files are reported, nothing throws', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    const r = ensureClaudeLinks(acc, FAKE_PROC, COPY);
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
    const r = ensureClaudeLinks(acc, FAKE_PROC, COPY);
    assert.equal(fs.readFileSync(path.join(acc, 'CLAUDE.md'), 'utf8'), 'mine\n');
    // Without file links a real config file is the expected state, so it is not reported as a conflict
    assert.ok(!r.conflicts.includes('CLAUDE.md'));
  });

  test('identical copies are upgraded to links once Developer Mode is on', FILE_SYMLINKS, () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'rules\n');
    ensureClaudeLinks(acc, FAKE_PROC, COPY);
    assert.equal(fs.lstatSync(path.join(acc, 'CLAUDE.md')).isSymbolicLink(), false);
    mock.restoreAll();
    emulate(true);
    const r = ensureClaudeLinks(acc, FAKE_PROC, COPY);
    assert.ok(r.linked.includes('CLAUDE.md'));
    assert.equal(fs.lstatSync(path.join(acc, 'CLAUDE.md')).isSymbolicLink(), true);
    // A diverged copy is left alone
    fs.rmSync(path.join(acc, 'settings.json'));
    fs.writeFileSync(path.join(acc, 'settings.json'), '{"x":1}\n');
    assert.ok(ensureClaudeLinks(acc, FAKE_PROC, COPY).conflicts.includes('settings.json'));
  });

  test('Claude conversion keeps the account files instead of moving them away', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(path.join(acc, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(acc, 'CLAUDE.md'), 'mine\n');
    fs.writeFileSync(path.join(acc, 'history.jsonl'), '{"a":1}\n');
    const r = migrateClaudeToShared(acc, 'work', FAKE_PROC, 'work', COPY);
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
    const r2 = ensureCodexLinks(fresh, COPY);
    assert.ok(r2.copied?.includes('AGENTS.md'));
    assert.ok(!r2.copied?.some((n) => n.endsWith('.sqlite') || n.endsWith('.jsonl')));
  });

  test('without consent nothing is copied', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    const r = ensureClaudeLinks(acc, FAKE_PROC);
    assert.equal(r.copied, undefined);
    assert.ok(r.noPrivilege?.includes('CLAUDE.md'));
    assert.equal(fs.existsSync(path.join(acc, 'CLAUDE.md')), false);
  });

  test('the modal is a modal warning with copy and skip buttons; dismissing means skip', async () => {
    emulate(false);
    const seen: unknown[][] = [];
    const answers: Array<string | undefined> = ['Copy files', 'Skip', undefined];
    mock.method(window, 'showWarningMessage', async (...args: unknown[]) => (seen.push(args), answers.shift()));
    assert.deepEqual(await askCopyFallback(home, 'Claude'), { copyConfig: true });
    assert.deepEqual(await askCopyFallback(home, 'Claude'), { copyConfig: false });
    assert.deepEqual(await askCopyFallback(home, 'Codex'), { copyConfig: false });
    assert.match(String(seen[2][0]), /config\.toml, AGENTS\.md, hooks\.json/);
    assert.deepEqual(seen[0].slice(1), [{ modal: true }, 'Copy files', 'Skip']);
    assert.match(String(seen[0][0]), /Switching accounts still works/);
    assert.match(String(seen[0][0]), /settings\.json, CLAUDE\.md/);
  });

  test('no question when file links work', FILE_SYMLINKS, async () => {
    emulate(true);
    const m = mock.method(window, 'showWarningMessage', async () => undefined);
    assert.deepEqual(await askCopyFallback(home, 'Claude'), {});
    assert.equal(m.mock.callCount(), 0);
  });

  test('history is not merged away while files cannot be linked back', () => {
    emulate(false);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    // The projects link makes the account count as shared; history.jsonl could not be linked (Developer Mode off)
    const first = ensureClaudeLinks(acc, FAKE_PROC);
    assert.ok(first.noPrivilege?.includes('history.jsonl'));
    fs.writeFileSync(path.join(acc, 'history.jsonl'), '{"a":1}\n');
    const second = ensureClaudeLinks(acc, FAKE_PROC);
    assert.equal(fs.readFileSync(path.join(acc, 'history.jsonl'), 'utf8'), '{"a":1}\n');
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'history.jsonl'), 'utf8'), '');
    assert.equal(second.busy, undefined);
  });

  test('an EPERM on a directory junction is an ordinary error, not a Developer Mode hint', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mock.method(fsModule, 'symlinkSync', () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const dir = path.join(home, 'somedir');
    fs.mkdirSync(dir);
    assert.throws(() => createLink(dir, path.join(home, 'l1'), 'win32'), (e: Error) => !(e instanceof LinkPrivilegeError));
    fs.writeFileSync(path.join(home, 'f'), '');
    assert.throws(() => createLink(path.join(home, 'f'), path.join(home, 'l2'), 'win32'), LinkPrivilegeError);
  });

  test('createLink uses junctions for folders and file symlinks for files; copyLink resolves relative targets', FILE_SYMLINKS, () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const types: Array<string | undefined> = [];
    mock.method(fsModule, 'symlinkSync', ((target: fs.PathLike, link: fs.PathLike, type?: string) => {
      types.push(type);
      return realSymlink(target, link, type as fs.symlink.Type | undefined);
    }) as typeof fs.symlinkSync);
    const dir = path.join(home, 'd');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(home, 'f'), '');
    createLink(dir, path.join(home, 'ld'), 'win32');
    createLink(path.join(home, 'f'), path.join(home, 'lf'), 'win32');
    assert.deepEqual(types, ['junction', 'file']);
    fs.mkdirSync(path.join(home, 'sub'));
    realSymlink('../f', path.join(home, 'sub', 'rel'));
    copyLink(path.join(home, 'sub', 'rel'), path.join(home, 'copied'), 'win32');
    assert.equal(fs.readlinkSync(path.join(home, 'copied')), path.join(home, 'f'));
  });

  test('deleting an account never descends through links into the default account', FILE_SYMLINKS, async () => {
    emulate(true);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'projects', 'keep.txt'), 'x');
    ensureClaudeLinks(acc, FAKE_PROC);
    await deleteAccountDir(acc);
    assert.equal(fs.existsSync(acc), false);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'projects', 'keep.txt'), 'utf8'), 'x');
  });

  test('with Developer Mode files link normally', FILE_SYMLINKS, () => {
    emulate(true);
    const acc = path.join(home, '.claude-work');
    fs.mkdirSync(acc);
    const r = ensureClaudeLinks(acc, FAKE_PROC, COPY);
    assert.equal(r.noPrivilege, undefined);
    assert.equal(fs.lstatSync(path.join(acc, 'settings.json')).isSymbolicLink(), true);
  });
});
