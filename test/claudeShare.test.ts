import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import { execFileSync } from 'node:child_process';
import { pidAlive } from '../src/platform';
import {
  CLAUDE_SHARED_ENTRIES, claudeAccountBusy, copyClaudeIndependent, copyTree, ensureClaudeLinks, isSharedClaudeAccount, lstatOrUndefined,
  makeClaudeIndependent, mergeEntry, migrateClaudeToShared, mirrorClaudeJson, type MigrateReport, windowsSessionsBusy,
} from '../src/claudeShare';
import { accountDir, deleteAccountDir } from '../src/paths';
import { assertTempHome, makeTempHome, assertMode, LINUX_ONLY, onWindows, SHARING, read, snapshot, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
let def: string;

before(() => {
  tmp = makeTempHome('share');
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
const isLinkTo = (link: string, target: string): boolean =>
  fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target;
const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

describe('ensureClaudeLinks', SHARING, () => {
  test('creates absolute links and empty default entries with modes; idempotent', () => {
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    const r = ensureClaudeLinks(acc);
    for (const { name } of CLAUDE_SHARED_ENTRIES) {
      assert.ok(isLinkTo(path.join(acc, name), path.join(def, name)), name);
      assert.ok(r.linked.includes(name), name);
      assert.ok(r.created.includes(name), name);
    }
    assert.equal(read(path.join(def, 'settings.json')), '{}\n');
    assert.equal(read(path.join(def, 'CLAUDE.md')), '');
    assertMode(path.join(def, 'history.jsonl'), '600');
    assertMode(path.join(def, 'projects'), '700');
    assertMode(path.join(def, 'skills'), '700');
    assert.ok(fs.lstatSync(path.join(acc, 'skills')).isDirectory());
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.refused, []);

    const again = ensureClaudeLinks(acc);
    assert.deepEqual(again, { linked: [], created: [], conflicts: [], refused: [] });
  });

  test('existing default content is kept; conflicts are left untouched', () => {
    write(path.join(def, 'CLAUDE.md'), 'rules');
    write(path.join(def, 'projects', 'p', 'x.jsonl'), 'x');
    fs.mkdirSync(path.join(home, 'elsewhere'));
    const acc = accountDir('a');
    write(path.join(acc, 'CLAUDE.md'), 'own');
    fs.mkdirSync(path.join(acc, 'todos'));
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(acc, 'agents'));
    const r = ensureClaudeLinks(acc);
    assert.deepEqual(r.conflicts.sort(), ['CLAUDE.md', 'agents', 'todos']);
    assert.ok(!r.created.includes('CLAUDE.md'));
    assert.equal(read(path.join(def, 'CLAUDE.md')), 'rules');
    assert.equal(read(path.join(acc, 'CLAUDE.md')), 'own');
    assert.equal(fs.readlinkSync(path.join(acc, 'agents')), path.join(home, 'elsewhere'));
    assert.equal(read(path.join(acc, 'projects', 'p', 'x.jsonl')), 'x');
  });

  test('a relative link to the default entry counts as linked', () => {
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    fs.mkdirSync(path.join(def, 'projects'));
    fs.symlinkSync('../.claude/projects', path.join(acc, 'projects'));
    const r = ensureClaudeLinks(acc);
    assert.ok(!r.linked.includes('projects'));
    assert.ok(!r.conflicts.includes('projects'));
  });

  test('settings.json is refused when the default has identity keys or is invalid JSON', () => {
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    write(path.join(def, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'k' } }));
    let r = ensureClaudeLinks(acc);
    assert.deepEqual(r.refused, ['settings.json']);
    assert.ok(!exists(path.join(acc, 'settings.json')));

    write(path.join(def, 'settings.json'), JSON.stringify({ apiKeyHelper: 'x' }));
    r = ensureClaudeLinks(acc);
    assert.deepEqual(r.refused, ['settings.json']);

    write(path.join(def, 'settings.json'), '{ bad');
    r = ensureClaudeLinks(acc);
    assert.deepEqual(r.refused, ['settings.json']);
    assert.equal(read(path.join(def, 'settings.json')), '{ bad');

    write(path.join(def, 'settings.json'), JSON.stringify({ env: { FOO: '1' }, model: 'x' }));
    r = ensureClaudeLinks(acc);
    assert.deepEqual(r.refused, []);
    assert.deepEqual(r.linked, ['settings.json']);
  });

  test('skills and plugins are linked per child; excludes skipped; stale links removed', () => {
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', 'two', 'SKILL.md'), '2');
    write(path.join(def, 'skills', 'synced', 'x'), 's');
    write(path.join(def, 'skills', '.trash', 'x'), 't');
    write(path.join(def, 'plugins', 'installed_plugins.json'), '{}');
    const acc = accountDir('a');
    write(path.join(acc, 'skills', 'mine', 'SKILL.md'), 'm');
    write(path.join(acc, 'skills', 'two', 'SKILL.md'), 'own two');
    write(path.join(acc, 'skills', 'synced', 'y'), 'own synced');
    let r = ensureClaudeLinks(acc);
    assert.ok(isLinkTo(path.join(acc, 'skills', 'one'), path.join(def, 'skills', 'one')));
    assert.ok(isLinkTo(path.join(acc, 'plugins', 'installed_plugins.json'), path.join(def, 'plugins', 'installed_plugins.json')));
    assert.ok(r.linked.includes('skills/one'));
    assert.ok(r.conflicts.includes('skills/two'));
    assert.ok(!exists(path.join(def, 'skills', 'mine')));
    assert.equal(read(path.join(acc, 'skills', 'synced', 'y')), 'own synced');
    assert.ok(!exists(path.join(acc, 'skills', '.trash')));

    fs.rmSync(path.join(def, 'skills', 'one'), { recursive: true });
    r = ensureClaudeLinks(acc);
    assert.ok(!exists(path.join(acc, 'skills', 'one')));
    assert.ok(exists(path.join(acc, 'skills', 'mine')));
  });

  test('replaces a whole-folder skills link to the default by per-child links', () => {
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', 'synced', 'x'), 's');
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    fs.symlinkSync(path.join(def, 'skills'), path.join(acc, 'skills'));
    ensureClaudeLinks(acc);
    assert.ok(fs.lstatSync(path.join(acc, 'skills')).isDirectory());
    assert.ok(isLinkTo(path.join(acc, 'skills', 'one'), path.join(def, 'skills', 'one')));
    assert.ok(!exists(path.join(acc, 'skills', 'synced')));
    assert.equal(read(path.join(def, 'skills', 'one', 'SKILL.md')), '1');
    assert.equal(read(path.join(def, 'skills', 'synced', 'x')), 's');
  });

  test('default dir → empty report, nothing written', () => {
    const r = ensureClaudeLinks(def);
    assert.deepEqual(r, { linked: [], created: [], conflicts: [], refused: [] });
    assert.deepEqual(fs.readdirSync(def), []);
  });
});

describe('ensureClaudeLinks history repair', SHARING, () => {
  test('a real history.jsonl in a shared account (after `claude project purge`) is merged back and relinked', () => {
    write(path.join(def, 'history.jsonl'), '{"a":1}\n{"a":2}\n');
    const acc = accountDir('h');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureClaudeLinks(acc);
    fs.unlinkSync(path.join(acc, 'history.jsonl'));
    write(path.join(acc, 'history.jsonl'), '{"a":1}\n{"b":3}\n');
    const r = ensureClaudeLinks(acc);
    assert.ok(r.linked.includes('history.jsonl'));
    assert.ok(!r.conflicts.includes('history.jsonl'));
    assert.ok(isLinkTo(path.join(acc, 'history.jsonl'), path.join(def, 'history.jsonl')));
    assert.equal(read(path.join(def, 'history.jsonl')), '{"a":1}\n{"a":2}\n{"b":3}\n');
  });

  test('an independent account keeps its own history.jsonl (reported as a conflict)', () => {
    const acc = accountDir('i');
    write(path.join(acc, 'history.jsonl'), '{"own":1}\n');
    const r = ensureClaudeLinks(acc);
    assert.ok(r.conflicts.includes('history.jsonl'));
    assert.equal(read(path.join(acc, 'history.jsonl')), '{"own":1}\n');
  });

  test('a real history.jsonl is left as is and reported under busy while the account is in use', () => {
    write(path.join(def, 'history.jsonl'), '{"a":1}\n');
    const acc = accountDir('h');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureClaudeLinks(acc);
    fs.unlinkSync(path.join(acc, 'history.jsonl'));
    write(path.join(acc, 'history.jsonl'), '{"b":3}\n');
    write(path.join(def, 'sessions', '42.json'), JSON.stringify({ pid: 42 }));
    const r = ensureClaudeLinks(acc, fakeProc({ 42: { CLAUDE_CONFIG_DIR: acc } }));
    assert.deepEqual(r.busy, ['history.jsonl']);
    assert.ok(!r.linked.includes('history.jsonl') && !r.conflicts.includes('history.jsonl'));
    assert.ok(fs.lstatSync(path.join(acc, 'history.jsonl')).isFile());
    assert.equal(read(path.join(acc, 'history.jsonl')), '{"b":3}\n');
    assert.equal(read(path.join(def, 'history.jsonl')), '{"a":1}\n');
    // Another account's session does not block the repair
    const again = ensureClaudeLinks(acc, fakeProc({ 42: { CLAUDE_CONFIG_DIR: accountDir('other') } }));
    assert.equal(again.busy, undefined);
    assert.ok(again.linked.includes('history.jsonl'));
    assert.equal(read(path.join(def, 'history.jsonl')), '{"a":1}\n{"b":3}\n');
  });

  test('a whole-folder skills link and dangling child links are kept while the account is in use', () => {
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    const acc = accountDir('s');
    fs.mkdirSync(acc, { mode: 0o700 });
    fs.symlinkSync(path.join(def, 'skills'), path.join(acc, 'skills'));
    fs.mkdirSync(path.join(acc, 'plugins'), { mode: 0o700 });
    fs.symlinkSync(path.join(def, 'plugins', 'gone'), path.join(acc, 'plugins', 'gone'));
    write(path.join(acc, 'sessions', '7.json'), JSON.stringify({ pid: 7 }));
    const busy = fakeProc({ 7: { CLAUDE_CONFIG_DIR: acc } });
    const r = ensureClaudeLinks(acc, busy);
    assert.deepEqual(r.busy, ['skills', 'plugins/gone']);
    assert.ok(fs.lstatSync(path.join(acc, 'skills')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(acc, 'plugins', 'gone')).isSymbolicLink());
    const later = ensureClaudeLinks(acc, fakeProc({}));
    assert.equal(later.busy, undefined);
    assert.ok(fs.lstatSync(path.join(acc, 'skills')).isDirectory());
    assert.ok(isLinkTo(path.join(acc, 'skills', 'one'), path.join(def, 'skills', 'one')));
    assert.ok(!exists(path.join(acc, 'plugins', 'gone')));
  });
});

describe('isSharedClaudeAccount', SHARING, () => {
  test('true only when projects links to the default projects', () => {
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    assert.equal(isSharedClaudeAccount(acc), false);
    ensureClaudeLinks(acc);
    assert.equal(isSharedClaudeAccount(acc), true);
    assert.equal(isSharedClaudeAccount(def), false);
    const b = accountDir('b');
    fs.mkdirSync(path.join(b, 'projects'), { recursive: true });
    assert.equal(isSharedClaudeAccount(b), false);
    fs.mkdirSync(path.join(home, 'other'));
    const c = accountDir('c');
    fs.mkdirSync(c);
    fs.symlinkSync(path.join(home, 'other'), path.join(c, 'projects'));
    assert.equal(isSharedClaudeAccount(c), false);
  });
});

describe('mirrorClaudeJson', () => {
  const src = (): string => path.join(home, '.claude.json');

  test('mcpServers exact copy (incl. removal), projects subset, other keys and mode kept', () => {
    write(src(), JSON.stringify({
      oauthAccount: { emailAddress: 'def@x' },
      mcpServers: { a: { command: 'a' }, b: { command: 'b' } },
      projects: { '/p': { allowedTools: ['X'], hasTrustDialogAccepted: true, history: ['secret'] } },
    }));
    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'acc@x' },
      mcpServers: { b: { command: 'old' }, gone: { command: 'g' } },
      projects: { '/p': { allowedTools: [], lastCost: 3 }, '/q': { allowedTools: ['Q'] } },
    }));
    fs.chmodSync(path.join(acc, '.claude.json'), 0o640);
    const r = mirrorClaudeJson(src(), acc);
    assert.deepEqual(r.changed, ['mcpServers', 'projects:/p']);
    const data = JSON.parse(read(path.join(acc, '.claude.json')));
    assert.deepEqual(data.mcpServers, { a: { command: 'a' }, b: { command: 'b' } });
    assert.deepEqual(data.oauthAccount, { emailAddress: 'acc@x' });
    assert.deepEqual(data.projects['/p'], { allowedTools: ['X'], lastCost: 3, hasTrustDialogAccepted: true });
    assert.deepEqual(data.projects['/q'], { allowedTools: ['Q'] });
    assertMode(path.join(acc, '.claude.json'), '640');

    // Unchanged → no write
    const mtime = fs.statSync(path.join(acc, '.claude.json')).mtimeMs;
    const text = read(path.join(acc, '.claude.json'));
    assert.deepEqual(mirrorClaudeJson(src(), acc).changed, []);
    assert.equal(read(path.join(acc, '.claude.json')), text);
    assert.equal(fs.statSync(path.join(acc, '.claude.json')).mtimeMs, mtime);
  });

  test('default without mcpServers empties the account; missing target created 0600', () => {
    write(src(), JSON.stringify({ projects: {} }));
    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), JSON.stringify({ mcpServers: { x: {} } }));
    assert.deepEqual(mirrorClaudeJson(src(), acc).changed, ['mcpServers']);
    assert.deepEqual(JSON.parse(read(path.join(acc, '.claude.json'))).mcpServers, {});

    const b = accountDir('b');
    fs.mkdirSync(b);
    assert.deepEqual(mirrorClaudeJson(src(), b).changed, []);
    assert.ok(!exists(path.join(b, '.claude.json')));
    write(src(), JSON.stringify({ mcpServers: { m: { command: 'm' } } }));
    assert.deepEqual(mirrorClaudeJson(src(), b).changed, ['mcpServers']);
    assertMode(path.join(b, '.claude.json'), '600');
  });

  test('bad target or bad source throws without writing; default dir is a no-op', () => {
    write(src(), JSON.stringify({ mcpServers: { a: {} } }));
    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), '[1]');
    assert.throws(() => mirrorClaudeJson(src(), acc), /Not a valid JSON object/);
    assert.equal(read(path.join(acc, '.claude.json')), '[1]');

    write(path.join(acc, '.claude.json'), '{}');
    write(src(), '{ half');
    assert.throws(() => mirrorClaudeJson(src(), acc), /default account's info file/);
    assert.equal(read(path.join(acc, '.claude.json')), '{}');

    write(src(), JSON.stringify({ mcpServers: { a: {} } }));
    assert.deepEqual(mirrorClaudeJson(src(), def).changed, []);
    assert.ok(!exists(path.join(def, '.claude.json')));
  });

  test('a target rewritten by the CLI between read and rename is left unchanged and reported', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('race');
    const file = path.join(acc, '.claude.json');
    write(file, JSON.stringify({ userID: 'u' }));
    const rewritten = JSON.stringify({ userID: 'u', numStartups: 2 });
    assert.throws(() => mirrorClaudeJson(src(), acc, () => fs.writeFileSync(file, rewritten)), { message: t('mcp.changed', { file }) });
    assert.equal(read(file), rewritten);
    assert.deepEqual(fs.readdirSync(acc), ['.claude.json']);
    // The next run starts from the new content
    assert.deepEqual(mirrorClaudeJson(src(), acc).changed, ['mcpServers']);
    assert.deepEqual(JSON.parse(read(file)), { userID: 'u', numStartups: 2, mcpServers: { a: { command: 'a' } } });
  });
});

// Fake /proc: <root>/<pid>/environ
function fakeProc(procs: Record<number, Record<string, string>>): string {
  const root = path.join(home, 'fakeproc');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  for (const [pid, env] of Object.entries(procs)) {
    write(path.join(root, pid, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
  }
  return root;
}

describe('claudeAccountBusy', () => {
  test('matches live pids by CLAUDE_CONFIG_DIR in environ', () => {
    const acc = accountDir('a');
    write(path.join(acc, 'sessions', '100.json'), JSON.stringify({ pid: 100 }));
    write(path.join(acc, 'sessions', 'bad.json'), '{ half');
    // Dead pid
    assert.equal(claudeAccountBusy(acc, fakeProc({})), false);
    // Live pid of another account (shared sessions folder)
    assert.equal(claudeAccountBusy(acc, fakeProc({ 100: { CLAUDE_CONFIG_DIR: accountDir('b') } })), false);
    assert.equal(claudeAccountBusy(acc, fakeProc({ 100: { PATH: '/bin', CLAUDE_CONFIG_DIR: acc } })), true);
    // Default dir: processes without CLAUDE_CONFIG_DIR or with the default
    write(path.join(def, 'sessions', '200.json'), JSON.stringify({ pid: 200 }));
    assert.equal(claudeAccountBusy(def, fakeProc({ 200: { PATH: '/bin' } })), true);
    assert.equal(claudeAccountBusy(def, fakeProc({ 200: { CLAUDE_CONFIG_DIR: def } })), true);
    assert.equal(claudeAccountBusy(def, fakeProc({ 200: { CLAUDE_CONFIG_DIR: acc } })), false);
    // No sessions folder
    assert.equal(claudeAccountBusy(accountDir('none'), fakeProc({})), false);
  });
  test('Windows check: live pid with a matching start time; shared sessions folders are not attributed', () => {
    const acc = accountDir('win');
    const sessions = path.join(acc, 'sessions');
    // A pid no process can have (the pid of an exited child could be reused before the check)
    const done = 0x7ffffffc;
    assert.equal(pidAlive(done), false);
    const never = (): Map<number, string> => assert.fail('no probe expected');
    assert.equal(windowsSessionsBusy(sessions, never), false);
    write(path.join(sessions, 'dead.json'), JSON.stringify({ pid: done, procStart: '1' }));
    write(path.join(sessions, 'bad.json'), '{ half');
    assert.equal(windowsSessionsBusy(sessions, never), false);
    write(path.join(sessions, 'live.json'), JSON.stringify({ pid: process.pid, procStart: '42' }));
    assert.equal(windowsSessionsBusy(sessions, () => new Map([[process.pid, '42']])), true);
    // The pid now belongs to another process (reused), or it exited between the two checks
    assert.equal(windowsSessionsBusy(sessions, () => new Map([[process.pid, '43']])), false);
    assert.equal(windowsSessionsBusy(sessions, () => new Map()), false);
    // A failed probe cannot rule the session out
    assert.equal(windowsSessionsBusy(sessions, () => undefined), true);
    // A live record without procStart cannot be told from a reused pid
    write(path.join(sessions, 'old.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(windowsSessionsBusy(sessions, () => new Map()), true);
    // Shared account: sessions is a link to the default folder, whose records belong to every sharing account
    const shared = path.join(accountDir('winshared'), 'sessions');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(sessions, shared, 'junction');
    assert.equal(windowsSessionsBusy(shared, never), false);
  });
  test('a missing procRoot counts a session file as busy', () => {
    const acc = accountDir('noproc');
    const noproc = path.join(home, 'noproc');
    assert.equal(claudeAccountBusy(acc, noproc), false);
    write(path.join(acc, 'sessions', '300.json'), JSON.stringify({ pid: 300 }));
    assert.equal(claudeAccountBusy(acc, noproc), true);
  });
});

describe('isSharedClaudeAccount on Windows', { skip: process.platform !== 'win32' && 'Windows behavior' }, () => {
  test('a projects junction whose target differs from the default dir only in case still counts as shared', () => {
    fs.mkdirSync(path.join(def, 'projects'));
    const acc = accountDir('case');
    fs.mkdirSync(acc);
    const upper = path.join(path.dirname(def), path.basename(def).toUpperCase(), 'projects');
    fs.symlinkSync(upper, path.join(acc, 'projects'), 'junction');
    assert.equal(isSharedClaudeAccount(acc), true);
  });
});

describe('mergeEntry', () => {
  test('a fifo the default lacks is left in place instead of being moved', LINUX_ONLY, () => {
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

describe('migrateClaudeToShared', SHARING, () => {
  test('a dangling link in the default dir does not abort the migration; the account file is backed up', () => {
    fs.symlinkSync(NOWHERE, path.join(def, 'CLAUDE.md'));
    const acc = accountDir('dangling');
    write(path.join(acc, 'CLAUDE.md'), 'acc rules');
    write(path.join(acc, 'projects', 'p', 'a.jsonl'), 'a');
    const r = migrateClaudeToShared(acc, 'dangling', fakeProc({}));
    assert.deepEqual(r.backups, ['CLAUDE.md.independent-backup']);
    assert.equal(read(path.join(acc, 'CLAUDE.md.independent-backup')), 'acc rules');
    assert.equal(fs.readlinkSync(path.join(def, 'CLAUDE.md')), NOWHERE);   // the default entry is never touched
    assert.equal(read(path.join(def, 'projects', 'p', 'a.jsonl')), 'a');
    assert.ok(isSharedClaudeAccount(acc));
  });

  test('a settings.json / CLAUDE.md the default lacks is moved into the default instead of being backed up', () => {
    const acc = accountDir('solo');
    write(path.join(acc, 'settings.json'), '{"model":"a"}');
    write(path.join(acc, 'CLAUDE.md'), 'acc rules');
    const r = migrateClaudeToShared(acc, 'solo', fakeProc({}));
    assert.deepEqual(r.backups, []);
    assert.equal(read(path.join(def, 'settings.json')), '{"model":"a"}');
    assert.equal(read(path.join(def, 'CLAUDE.md')), 'acc rules');
    assert.ok(isLinkTo(path.join(acc, 'settings.json'), path.join(def, 'settings.json')));
    assert.ok(isLinkTo(path.join(acc, 'CLAUDE.md'), path.join(def, 'CLAUDE.md')));
  });

  test('an account settings.json with identity keys is never moved into a default that lacks one', () => {
    const acc = accountDir('keyed');
    write(path.join(acc, 'settings.json'), '{"apiKeyHelper":"x"}');
    migrateClaudeToShared(acc, 'keyed', fakeProc({}));
    assert.equal(read(path.join(acc, 'settings.json')), '{"apiKeyHelper":"x"}');
    assert.ok(!fs.lstatSync(path.join(acc, 'settings.json')).isSymbolicLink());
    assert.notEqual(read(path.join(def, 'settings.json')), '{"apiKeyHelper":"x"}');
  });

  test('merges into the default dir, keeps identity files, ends shared', () => {
    write(path.join(def, 'projects', 'p', 'same.jsonl'), 'same');
    write(path.join(def, 'projects', 'p', 'memory', 'MEMORY.md'), 'def mem');
    write(path.join(def, 'projects', 'p', 'memory', 'MEMORY.md.from-xn'), 'older');
    write(path.join(def, 'history.jsonl'), '{"d":1}');
    write(path.join(def, 'settings.json'), '{"model":"d"}');
    write(path.join(def, 'CLAUDE.md'), 'def rules');
    write(path.join(def, 'skills', 'shared', 'SKILL.md'), 'S');

    const acc = accountDir('xn');
    write(path.join(acc, 'projects', 'p', 'same.jsonl'), 'same');
    write(path.join(acc, 'projects', 'p', 'new.jsonl'), 'new');
    write(path.join(acc, 'projects', 'p', 'memory', 'MEMORY.md'), 'acc mem');
    write(path.join(acc, 'projects', 'q', 'only.jsonl'), 'q');
    fs.symlinkSync(NOWHERE, path.join(acc, 'projects', 'q', 'lnk'));
    write(path.join(acc, 'history.jsonl'), '{"a":1}\n{"a":2}');
    write(path.join(acc, 'settings.json'), '{"model":"a"}');
    write(path.join(acc, 'CLAUDE.md'), 'def rules');
    write(path.join(acc, 'skills', 'mine', 'SKILL.md'), 'M');
    write(path.join(acc, 'skills', 'synced', 'x'), 'synced');
    write(path.join(acc, '.credentials.json'), 'secret');
    write(path.join(acc, '.claude.json'), '{"oauthAccount":{}}');
    write(path.join(acc, 'backups', 'b'), 'b');
    write(path.join(acc, 'plugins', 'synced', 'x'), 'ps');

    const r = migrateClaudeToShared(acc, 'xn', fakeProc({}));
    assert.equal(r.moved, 5);   // new.jsonl, only.jsonl, lnk, skills/mine/SKILL.md, history.jsonl
    assert.equal(r.duplicates, 2);   // same.jsonl, CLAUDE.md
    assert.deepEqual(r.keptBoth, ['projects/p/memory/MEMORY.md.from-xn-2']);
    assert.deepEqual(r.backups, ['settings.json.independent-backup']);
    assert.deepEqual(r.conflicts, []);

    assert.equal(read(path.join(def, 'projects', 'p', 'new.jsonl')), 'new');
    assert.equal(read(path.join(def, 'projects', 'p', 'memory', 'MEMORY.md')), 'def mem');
    assert.equal(read(path.join(def, 'projects', 'p', 'memory', 'MEMORY.md.from-xn')), 'older');
    assert.equal(read(path.join(def, 'projects', 'p', 'memory', 'MEMORY.md.from-xn-2')), 'acc mem');
    assert.equal(fs.readlinkSync(path.join(def, 'projects', 'q', 'lnk')), NOWHERE);
    assert.equal(read(path.join(def, 'history.jsonl')), '{"d":1}\n{"a":1}\n{"a":2}\n');
    assert.equal(read(path.join(def, 'settings.json')), '{"model":"d"}');
    assert.equal(read(path.join(acc, 'settings.json.independent-backup')), '{"model":"a"}');
    assert.equal(read(path.join(def, 'skills', 'mine', 'SKILL.md')), 'M');
    assert.ok(!exists(path.join(def, 'skills', 'synced')));

    assert.equal(read(path.join(acc, '.credentials.json')), 'secret');
    assert.equal(read(path.join(acc, '.claude.json')), '{"oauthAccount":{}}');
    assert.equal(read(path.join(acc, 'backups', 'b')), 'b');
    assert.equal(read(path.join(acc, 'skills', 'synced', 'x')), 'synced');
    assert.equal(read(path.join(acc, 'plugins', 'synced', 'x')), 'ps');
    for (const e of ['projects', 'history.jsonl', 'settings.json', 'CLAUDE.md']) {
      assert.ok(isLinkTo(path.join(acc, e), path.join(def, e)), e);
    }
    assert.ok(isLinkTo(path.join(acc, 'skills', 'mine'), path.join(def, 'skills', 'mine')));
    assert.ok(isLinkTo(path.join(acc, 'skills', 'shared'), path.join(def, 'skills', 'shared')));
    assert.equal(isSharedClaudeAccount(acc), true);
  });

  test('backup names get a numeric suffix; history created 0600 when missing', () => {
    write(path.join(def, 'CLAUDE.md'), 'def rules');
    const acc = accountDir('a');
    write(path.join(acc, 'CLAUDE.md'), 'own');
    write(path.join(acc, 'CLAUDE.md.independent-backup'), 'older');
    write(path.join(acc, 'history.jsonl'), '{"a":1}\n');
    const r = migrateClaudeToShared(acc, 'a', fakeProc({}));
    assert.deepEqual(r.backups, ['CLAUDE.md.independent-backup-2']);
    assert.equal(read(path.join(acc, 'CLAUDE.md.independent-backup-2')), 'own');
    assert.equal(read(path.join(def, 'history.jsonl')), '{"a":1}\n');
    assertMode(path.join(def, 'history.jsonl'), '600');
    assert.equal(read(path.join(def, 'CLAUDE.md')), 'def rules');
  });

  test('settings.json stays when the default settings cannot be shared', () => {
    write(path.join(def, 'settings.json'), JSON.stringify({ forceLoginMethod: 'claudeai' }));
    const acc = accountDir('a');
    write(path.join(acc, 'settings.json'), '{"model":"a"}');
    const r = migrateClaudeToShared(acc, 'a', fakeProc({}));
    assert.deepEqual(r.refused, ['settings.json']);
    assert.deepEqual(r.backups, []);
    assert.equal(read(path.join(acc, 'settings.json')), '{"model":"a"}');
  });

  test('refuses while the account is busy; nothing moved', () => {
    const acc = accountDir('a');
    write(path.join(acc, 'sessions', '42.json'), JSON.stringify({ pid: 42 }));
    write(path.join(acc, 'projects', 'p', 'x'), 'x');
    assert.throws(() => migrateClaudeToShared(acc, 'a', fakeProc({ 42: { CLAUDE_CONFIG_DIR: acc } })), /still running with account a;/);
    assert.equal(read(path.join(acc, 'projects', 'p', 'x')), 'x');
    assert.ok(!exists(path.join(def, 'projects')));
  });

  test('the busy error names the display name when one is passed', () => {
    const acc = accountDir('a');
    write(path.join(acc, 'sessions', '42.json'), JSON.stringify({ pid: 42 }));
    assert.throws(
      () => migrateClaudeToShared(acc, 'a', fakeProc({ 42: { CLAUDE_CONFIG_DIR: acc } }), 'Work'),
      { message: t('share.busy', { name: 'Work' }) },
    );
  });
});

describe('copyClaudeIndependent', SHARING, () => {
  test('relative links to the copied root stay inside the independent account', () => {
    const agents = path.join(def, 'agents');
    write(path.join(agents, 'a.md'), 'default');
    fs.mkdirSync(path.join(agents, 'nested'));
    fs.symlinkSync('.', path.join(agents, 'self'), 'dir');
    fs.symlinkSync('..', path.join(agents, 'nested', 'root'), 'dir');
    const acc = accountDir('solo');

    copyClaudeIndependent(path.join(home, '.claude.json'), acc);

    const copied = path.join(acc, 'agents');
    for (const link of ['self', path.join('nested', 'root')]) {
      assert.equal(fs.realpathSync(path.join(copied, link)), fs.realpathSync(copied));
      fs.writeFileSync(path.join(copied, link, 'a.md'), 'independent');
      assert.equal(read(path.join(agents, 'a.md')), 'default');
    }
  });

  test('copies config without overwriting; excludes synced buckets; strips settings', () => {
    write(path.join(def, 'settings.json'), JSON.stringify({ model: 'm', apiKeyHelper: 'x', env: { ANTHROPIC_API_KEY: 'k', A: '1' } }));
    write(path.join(def, 'CLAUDE.md'), 'rules');
    write(path.join(def, 'agents', 'a.md'), 'agent');
    fs.symlinkSync(NOWHERE, path.join(def, 'agents', 'lnk'));
    write(path.join(def, 'commands', 'c.md'), 'cmd');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', 'synced', 'x'), 's');
    write(path.join(def, 'skills', '.trash', 'x'), 't');
    write(path.join(def, '.credentials.json'), 'secret');
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { m: { command: 'm' } } }));

    const acc = accountDir('a');
    write(path.join(acc, 'commands', 'c.md'), 'own');
    const r = copyClaudeIndependent(path.join(home, '.claude.json'), acc);
    assert.deepEqual(r.copied, ['settings.json', 'CLAUDE.md', 'agents', 'skills/one', 'mcpServers']);
    assert.deepEqual(JSON.parse(read(path.join(acc, 'settings.json'))), { model: 'm', env: { A: '1' } });
    assert.equal(read(path.join(acc, 'CLAUDE.md')), 'rules');
    assert.ok(!fs.lstatSync(path.join(acc, 'CLAUDE.md')).isSymbolicLink());
    assert.equal(read(path.join(acc, 'agents', 'a.md')), 'agent');
    assert.equal(fs.readlinkSync(path.join(acc, 'agents', 'lnk')), NOWHERE);
    assert.equal(read(path.join(acc, 'commands', 'c.md')), 'own');
    assert.equal(read(path.join(acc, 'skills', 'one', 'SKILL.md')), '1');
    assert.ok(!exists(path.join(acc, 'skills', 'synced')));
    assert.ok(!exists(path.join(acc, 'skills', '.trash')));
    assert.ok(!exists(path.join(acc, '.credentials.json')));
    assert.deepEqual(JSON.parse(read(path.join(acc, '.claude.json'))).mcpServers, { m: { command: 'm' } });

    // Second run copies nothing new
    assert.deepEqual(copyClaudeIndependent(path.join(home, '.claude.json'), acc).copied, []);
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

  test('an unreadable folder throws an ordinary error instead of ending the process', LINUX_ONLY, () => {
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

describe('makeClaudeIndependent', SHARING, () => {
  const src = (): string => path.join(home, '.claude.json');

  test('removes the links, copies the config once, leaves history and the default dir alone', () => {
    write(path.join(def, 'settings.json'), JSON.stringify({ model: 'm', enabledPlugins: { p: true }, env: { A: '1' } }));
    write(path.join(def, 'CLAUDE.md'), 'rules');
    write(path.join(def, 'rules', 'r.md'), 'r');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', 'synced', 'x'), 's');
    write(path.join(def, 'plugins', 'installed_plugins.json'), '{}');
    write(path.join(def, 'history.jsonl'), '{"d":1}\n');
    write(path.join(def, 'projects', 'p', 'x.jsonl'), 'x');
    write(path.join(def, '.credentials.json'), 'def secret');
    write(src(), JSON.stringify({ mcpServers: { m: { command: 'm' } } }));
    const acc = accountDir('a');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureClaudeLinks(acc);
    write(path.join(acc, '.credentials.json'), 'secret');
    write(path.join(acc, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
    write(path.join(acc, 'skills', 'mine', 'SKILL.md'), 'M');
    const before = snapshot(def);

    const r = makeClaudeIndependent(src(), acc);
    assert.equal(isSharedClaudeAccount(acc), false);
    for (const { name } of CLAUDE_SHARED_ENTRIES) assert.ok(r.removed.includes(name), name);
    assert.ok(r.removed.includes('skills/one'));
    assert.ok(r.removed.includes('plugins/installed_plugins.json'));
    assert.ok(!r.removed.includes('skills/mine'));
    // The config folders ensureClaudeLinks created empty in the default dir are copied as empty folders
    assert.deepEqual(r.copied, ['settings.json', 'CLAUDE.md', 'agents', 'commands', 'output-styles', 'hooks', 'rules', 'skills/one', 'mcpServers']);
    for (const e of fs.readdirSync(acc, { recursive: true }) as string[]) {
      assert.ok(!fs.lstatSync(path.join(acc, e)).isSymbolicLink(), `${e} is still a link`);
    }
    for (const e of ['history.jsonl', 'projects', 'sessions', 'todos', 'file-history']) assert.ok(!exists(path.join(acc, e)), e);
    assert.deepEqual(JSON.parse(read(path.join(acc, 'settings.json'))), { model: 'm', env: { A: '1' } });
    assert.equal(read(path.join(acc, 'CLAUDE.md')), 'rules');
    assert.equal(read(path.join(acc, 'rules', 'r.md')), 'r');
    assert.equal(read(path.join(acc, 'skills', 'one', 'SKILL.md')), '1');
    assert.equal(read(path.join(acc, 'skills', 'mine', 'SKILL.md')), 'M');
    assert.ok(!exists(path.join(acc, 'skills', 'synced')));
    assert.ok(fs.lstatSync(path.join(acc, 'plugins')).isDirectory());
    assert.deepEqual(fs.readdirSync(path.join(acc, 'plugins')), []);
    assert.equal(read(path.join(acc, '.credentials.json')), 'secret');
    const json = JSON.parse(read(path.join(acc, '.claude.json')));
    assert.deepEqual(json.oauthAccount, { emailAddress: 'a@x' });
    assert.deepEqual(json.mcpServers, { m: { command: 'm' } });
    assert.deepEqual(snapshot(def), before);
  });

  test('an entry the account replaced by a real file or a link elsewhere is kept', () => {
    write(path.join(def, 'CLAUDE.md'), 'rules');
    fs.mkdirSync(path.join(home, 'elsewhere'));
    const acc = accountDir('a');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureClaudeLinks(acc);
    fs.unlinkSync(path.join(acc, 'CLAUDE.md'));
    write(path.join(acc, 'CLAUDE.md'), 'own');
    fs.unlinkSync(path.join(acc, 'agents'));
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(acc, 'agents'));
    const r = makeClaudeIndependent(path.join(home, '.claude.json'), acc);
    assert.ok(!r.removed.includes('CLAUDE.md'));
    assert.ok(!r.removed.includes('agents'));
    assert.ok(!r.copied.includes('CLAUDE.md'));
    assert.equal(read(path.join(acc, 'CLAUDE.md')), 'own');
    assert.equal(fs.readlinkSync(path.join(acc, 'agents')), path.join(home, 'elsewhere'));
    assert.equal(isSharedClaudeAccount(acc), false);
    assert.equal(read(path.join(def, 'CLAUDE.md')), 'rules');
  });

  test('a whole-folder skills link from an earlier version is removed as one entry and replaced by copies', () => {
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'projects', 'p', 'x.jsonl'), 'x');
    const acc = accountDir('legacy');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureClaudeLinks(acc);
    fs.rmSync(path.join(acc, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(def, 'skills'), path.join(acc, 'skills'));
    const before = snapshot(def);
    const r = makeClaudeIndependent(src(), acc);
    assert.ok(r.removed.includes('skills'));
    assert.ok(!r.removed.includes('skills/one'));
    assert.ok(r.copied.includes('skills/one'));
    assert.ok(fs.lstatSync(path.join(acc, 'skills')).isDirectory());
    assert.equal(read(path.join(acc, 'skills', 'one', 'SKILL.md')), '1');
    assert.deepEqual(snapshot(def), before);
  });

  test('a failed copy leaves the account shared: the history links and the projects marker are still there', () => {
    write(path.join(def, 'settings.json'), '{"model":"m"}');
    write(path.join(def, 'history.jsonl'), '{"d":1}\n');
    write(path.join(def, 'projects', 'p', 'x.jsonl'), 'x');
    write(src(), JSON.stringify({ mcpServers: { m: { command: 'm' } } }));
    const acc = accountDir('half');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureClaudeLinks(acc);
    write(path.join(acc, '.claude.json'), 'not json');   // syncMcpServers throws at the end of the copy
    const before = snapshot(def);
    assert.throws(() => makeClaudeIndependent(src(), acc));
    assert.equal(isSharedClaudeAccount(acc), true);
    assert.ok(isLinkTo(path.join(acc, 'history.jsonl'), path.join(def, 'history.jsonl')));
    assert.ok(isLinkTo(path.join(acc, 'projects'), path.join(def, 'projects')));
    assert.deepEqual(JSON.parse(read(path.join(acc, 'settings.json'))), { model: 'm' });   // already copied, reported by ensureClaudeLinks
    assert.ok(ensureClaudeLinks(acc).conflicts.includes('settings.json'));
    assert.deepEqual(snapshot(def), before);
  });

  test('throws for the default dir and for an independent account; nothing written', () => {
    write(path.join(def, 'CLAUDE.md'), 'rules');
    const acc = accountDir('a');
    write(path.join(acc, 'projects', 'p', 'x.jsonl'), 'x');
    const before = snapshot(home);
    assert.throws(() => makeClaudeIndependent(path.join(home, '.claude.json'), def), { message: t('unshare.default', { dir: def }) });
    assert.throws(() => makeClaudeIndependent(path.join(home, '.claude.json'), acc), { message: t('unshare.notShared', { dir: acc }) });
    assert.deepEqual(snapshot(home), before);
  });
});

describe('deleteAccountDir on a shared account', () => {
  test('removes the links only; the default content survives', async () => {
    write(path.join(def, 'projects', 'p', 'x.jsonl'), 'x');
    write(path.join(def, 'CLAUDE.md'), 'rules');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    ensureClaudeLinks(acc);
    write(path.join(acc, '.credentials.json'), 'secret');
    await deleteAccountDir(acc);
    assert.ok(!exists(acc));
    assert.equal(read(path.join(def, 'projects', 'p', 'x.jsonl')), 'x');
    assert.equal(read(path.join(def, 'CLAUDE.md')), 'rules');
    assert.equal(read(path.join(def, 'skills', 'one', 'SKILL.md')), '1');
    assert.ok(exists(path.join(def, 'history.jsonl')));
  });
});
