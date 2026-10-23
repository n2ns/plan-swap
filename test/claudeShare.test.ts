import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import { execFileSync, spawn } from 'node:child_process';
import { pidAlive } from '../src/platform';
import {
  CLAUDE_SHARED_ENTRIES, claudeAccountBusy, copyClaudeIndependent, copyTree, ensureClaudeLinks, isSharedClaudeAccount, lstatOrUndefined,
  makeClaudeIndependent, mergeEntry, migrateClaudeToShared, moveEntry, syncClaudeAccount, type MigrateReport, windowsSessionsBusy,
} from '../src/claudeShare';
import { accountDir, deleteAccountDir, realPath } from '../src/paths';
import { assertTempHome, makeTempHome, assertMode, FILE_SYMLINKS, LINUX_ONLY, onWindows, SHARING, read, snapshot, withEnv, type TempHome } from './helpers';

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

describe('Claude account writes protect a nested default directory', () => {
  for (const linkedDefault of [false, true]) {
    test(`refuses account writes when the default directory is ${linkedDefault ? 'linked into' : 'inside'} the account`, () => {
      const acc = accountDir('parent');
      const nested = path.join(acc, 'agents', 'main');
      const configured = linkedDefault ? path.join(home, 'linked-default') : nested;
      const fromJson = path.join(nested, '.claude.json');
      const procRoot = path.join(home, 'fakeproc');
      write(path.join(nested, '000-default-user-file.md'), 'default content');
      write(fromJson, JSON.stringify({ mcpServers: { server: { command: 'server' } } }));
      write(path.join(acc, 'own.md'), 'account content');
      fs.mkdirSync(procRoot);
      if (linkedDefault) fs.symlinkSync(nested, configured, 'junction');
      process.env.CLAUDE_CONFIG_DIR = configured;
      try {
        const before = snapshot(home);
        const operations = [
          () => ensureClaudeLinks(acc, procRoot),
          () => migrateClaudeToShared(acc, 'parent', procRoot),
          () => syncClaudeAccount(fromJson, acc),
          () => copyClaudeIndependent(fromJson, acc),
          () => makeClaudeIndependent(fromJson, acc),
        ];
        for (const operation of operations) {
          assert.throws(operation, { message: t('account.containsDefaultDir', { dir: acc, default: configured }) });
          assert.deepEqual(snapshot(home), before);
        }
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });
  }
});

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
    assert.deepEqual(r.conflicts.sort(), ['CLAUDE.md', 'agents']);
    assert.ok(fs.statSync(path.join(acc, 'todos')).isDirectory());
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

  test('settings.json is refused for every identity key; the account gets a stripped copy and an explaining note', () => {
    const acc = accountDir('a');
    const settings = path.join(acc, 'settings.json');
    const note = (key: string, why: 'credential' | 'loginMethod' | 'location', result: string): string =>
      t('share.r.settingsRefused', { key, why: t(`share.r.why.${why}`), result });
    const cases: Array<[Record<string, unknown>, string, 'credential' | 'loginMethod' | 'location']> = [
      [{ apiKeyHelper: 'x' }, 'apiKeyHelper', 'credential'],
      [{ forceLoginMethod: 'claudeai' }, 'forceLoginMethod', 'loginMethod'],
      ...(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE'] as const)
        .map((k): [Record<string, unknown>, string, 'credential'] => [{ env: { [k]: 'v' } }, `env.${k}`, 'credential']),
      [{ env: { ANTHROPIC_FEDERATION_RULE_ID: 'r', ANTHROPIC_ORGANIZATION_ID: 'o' } }, 'env.ANTHROPIC_FEDERATION_RULE_ID', 'credential'],
      [{ env: { CLAUDE_CONFIG_DIR: '/x' } }, 'env.CLAUDE_CONFIG_DIR', 'location'],
      [{ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x' } }, 'env.CLAUDE_SECURESTORAGE_CONFIG_DIR', 'location'],
    ];
    for (const [data, key, why] of cases) {
      fs.rmSync(acc, { recursive: true, force: true });
      fs.mkdirSync(acc);
      write(path.join(def, 'settings.json'), JSON.stringify({ model: 'm', ...data }));
      const r = ensureClaudeLinks(acc);
      assert.deepEqual(r.refused, ['settings.json'], key);
      assert.deepEqual(JSON.parse(read(settings)), { model: 'm', ...(data.env ? { env: {} } : {}) }, key);
      assert.deepEqual(r.refusedNotes, { 'settings.json': note(key, why, t('share.r.settingsCopied', { key })) }, key);
      // The next refresh keeps the copy and says so
      assert.deepEqual(ensureClaudeLinks(acc).refusedNotes, { 'settings.json': note(key, why, t('share.r.settingsOwn')) }, key);
    }

    // Not an identity setting: forceLoginOrgUUID only pre-selects an organization, one federation variable alone is
    // no credential
    fs.rmSync(acc, { recursive: true, force: true });
    fs.mkdirSync(acc);
    write(path.join(def, 'settings.json'), JSON.stringify({ forceLoginOrgUUID: 'org', env: { ANTHROPIC_ORGANIZATION_ID: 'o' } }));
    let r = ensureClaudeLinks(acc);
    assert.deepEqual(r.refused, []);
    assert.ok(r.linked.includes('settings.json'));
    fs.unlinkSync(settings);

    write(path.join(def, 'settings.json'), '{ bad');
    r = ensureClaudeLinks(acc);
    assert.deepEqual(r.refused, ['settings.json']);
    assert.equal(read(path.join(def, 'settings.json')), '{ bad');
    assert.ok(!exists(settings), 'no copy of an unreadable file');
    assert.deepEqual(r.refusedNotes, { 'settings.json': t('share.r.settingsUnreadable') });

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

  test('absent optional sources and their missing or expected links are healthy without writes', () => {
    const acc = accountDir('optional');
    const procRoot = fakeProc({});
    ensureClaudeLinks(acc, procRoot);
    const optional = CLAUDE_SHARED_ENTRIES.filter(({ name }) => !['projects', 'history.jsonl', 'file-history'].includes(name));
    for (const { name } of optional) fs.rmSync(path.join(def, name), { recursive: true });
    for (const name of ['skills', 'plugins']) fs.rmSync(path.join(def, name), { recursive: true });
    fs.unlinkSync(path.join(acc, 'agents'));
    const before = snapshot(home);
    assert.deepEqual(ensureClaudeLinks(acc, procRoot, { check: true }), { linked: [], created: [], conflicts: [], refused: [] });
    assert.deepEqual(snapshot(home), before);
    write(path.join(acc, 'agents', 'own.md'), 'account agent');
    fs.unlinkSync(path.join(acc, 'tasks'));
    fs.symlinkSync(NOWHERE, path.join(acc, 'tasks'), 'junction');
    const conflicts = ensureClaudeLinks(acc, procRoot, { check: true });
    assert.deepEqual(conflicts.conflicts, ['tasks', 'agents']);
    assert.deepEqual(conflicts.elsewhere, ['tasks']);
    assert.deepEqual(conflicts.created, []);
  });

  test('optional conflicts do not initialize unused default targets', () => {
    const acc = accountDir('conflict');
    write(path.join(acc, 'tasks', 'own.json'), 'own task');
    write(path.join(acc, 'settings.json'), '{"model":"own"}');
    const report = ensureClaudeLinks(acc, fakeProc({}), { entries: ['tasks', 'settings.json'] });
    assert.deepEqual(report.conflicts, ['settings.json', 'tasks']);
    assert.deepEqual(report.created, []);
    assert.equal(exists(path.join(def, 'tasks')), false);
    assert.equal(exists(path.join(def, 'settings.json')), false);
    assert.equal(read(path.join(acc, 'tasks', 'own.json')), 'own task');
  });

  for (const elsewhere of [false, true]) {
    test(`a missing core source is not a fault for ${elsewhere ? 'a link elsewhere' : 'an account-owned directory'}`, () => {
      const acc = accountDir('own-history');
      const procRoot = fakeProc({});
      ensureClaudeLinks(acc, procRoot);
      fs.unlinkSync(path.join(acc, 'file-history'));
      fs.rmSync(path.join(def, 'file-history'), { recursive: true });
      const own = elsewhere ? path.join(home, 'other-history') : path.join(acc, 'file-history');
      write(path.join(own, 'snapshot'), 'account snapshot');
      if (elsewhere) fs.symlinkSync(own, path.join(acc, 'file-history'), 'junction');
      const before = snapshot(home);
      for (const check of [true, false]) {
        const report = ensureClaudeLinks(acc, procRoot, { check });
        assert.deepEqual(report.created, []);
        assert.deepEqual(report.linked, []);
        assert.deepEqual(report.conflicts, ['file-history']);
        assert.deepEqual(report.elsewhere ?? [], elsewhere ? ['file-history'] : []);
        assert.equal(exists(path.join(def, 'file-history')), false);
        assert.equal(read(path.join(acc, 'file-history', 'snapshot')), 'account snapshot');
        assert.deepEqual(snapshot(home), before);
      }
    });
  }

  test('shared account history is still merged back when the default history is missing', () => {
    const acc = accountDir('rewritten-history');
    const procRoot = fakeProc({});
    ensureClaudeLinks(acc, procRoot);
    fs.unlinkSync(path.join(acc, 'history.jsonl'));
    fs.unlinkSync(path.join(def, 'history.jsonl'));
    write(path.join(acc, 'history.jsonl'), '{"own":1}\n');
    const before = snapshot(home);
    const check = ensureClaudeLinks(acc, procRoot, { check: true });
    assert.deepEqual(check.created, ['history.jsonl']);
    assert.deepEqual(check.merged, ['history.jsonl']);
    assert.deepEqual(check.conflicts, []);
    assert.deepEqual(snapshot(home), before);
    const repair = ensureClaudeLinks(acc, procRoot);
    assert.deepEqual(repair.merged, ['history.jsonl']);
    assert.ok(isLinkTo(path.join(acc, 'history.jsonl'), path.join(def, 'history.jsonl')));
    assert.equal(read(path.join(def, 'history.jsonl')), '{"own":1}\n');
  });

  test('an inaccessible source remains an error rather than an absent optional entry', (ctx) => {
    const acc = accountDir('denied');
    const procRoot = fakeProc({});
    fs.mkdirSync(path.join(def, 'tasks'));
    const before = snapshot(def);
    const access = fsModule.accessSync;
    ctx.mock.method(fsModule, 'accessSync', (file: fs.PathLike, mode?: number) => {
      if (String(file) === path.join(def, 'tasks')) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
      return access(file, mode);
    });
    for (const check of [true, false]) {
      assert.throws(() => ensureClaudeLinks(acc, procRoot, { check, entries: ['tasks'] }), { code: 'EACCES' });
      assert.equal(exists(path.join(acc, 'tasks')), false);
      assert.deepEqual(snapshot(def), before);
    }
  });

  test('absent core sources remain reported and are never recreated by a check', () => {
    const acc = accountDir('core');
    const procRoot = fakeProc({});
    ensureClaudeLinks(acc, procRoot);
    const core = ['history.jsonl', 'projects', 'file-history'];
    for (const name of core) fs.rmSync(path.join(def, name), { recursive: true });
    const before = snapshot(home);
    assert.deepEqual(ensureClaudeLinks(acc, procRoot, { check: true }).created, core);
    assert.deepEqual(snapshot(home), before);
  });

  test('refresh initializes tasks and uploads for first writes visible from another linked account', () => {
    const first = accountDir('first');
    const second = accountDir('second');
    const procRoot = fakeProc({});
    ensureClaudeLinks(first, procRoot);
    ensureClaudeLinks(second, procRoot);
    for (const name of ['tasks', 'uploads']) fs.rmSync(path.join(def, name), { recursive: true });
    assert.deepEqual(ensureClaudeLinks(first, procRoot, { check: true }).created, []);
    const initialized = ensureClaudeLinks(first, procRoot);
    assert.deepEqual(initialized.created, ['tasks', 'uploads']);
    // The writer creates only its session directory; it relies on the shared parent being usable.
    for (const name of ['tasks', 'uploads']) {
      fs.mkdirSync(path.join(first, name, 'session'));
      fs.writeFileSync(path.join(first, name, 'session', 'first.json'), '{"continued":true}');
      assert.equal(read(path.join(second, name, 'session', 'first.json')), '{"continued":true}');
      fs.writeFileSync(path.join(second, name, 'session', 'second.json'), '{"other":true}');
      assert.equal(read(path.join(first, name, 'session', 'second.json')), '{"other":true}');
    }
  });

  test('retired todos data and links survive refresh and are detached only on unshare', () => {
    const acc = accountDir('legacy');
    const procRoot = fakeProc({});
    ensureClaudeLinks(acc, procRoot);
    assert.equal(exists(path.join(def, 'todos')), false);
    assert.equal(exists(path.join(acc, 'todos')), false);
    write(path.join(def, 'todos', 'old.json'), 'legacy data');
    fs.symlinkSync(path.join(def, 'todos'), path.join(acc, 'todos'), 'junction');
    const before = snapshot(home);
    assert.deepEqual(ensureClaudeLinks(acc, procRoot), { linked: [], created: [], conflicts: [], refused: [] });
    assert.deepEqual(snapshot(home), before);
    const result = makeClaudeIndependent(path.join(home, '.claude.json'), acc);
    assert.ok(result.removed.includes('todos'));
    assert.equal(exists(path.join(acc, 'todos')), false);
    assert.equal(read(path.join(def, 'todos', 'old.json')), 'legacy data');
  });

  test('selective repair initializes only selected entries and leaves unrelated history and identity settings alone', () => {
    const acc = accountDir('scoped');
    const procRoot = fakeProc({});
    ensureClaudeLinks(acc, procRoot);
    fs.rmSync(path.join(def, 'tasks'), { recursive: true });
    fs.rmSync(path.join(def, 'uploads'), { recursive: true });
    fs.unlinkSync(path.join(acc, 'history.jsonl'));
    write(path.join(acc, 'history.jsonl'), 'account history\n');
    write(path.join(def, 'settings.json'), '{"apiKeyHelper":"own-helper"}');
    write(path.join(acc, '.credentials.json'), 'fixture credentials');
    const before = snapshot(home);
    assert.deepEqual(ensureClaudeLinks(acc, procRoot, { entries: [] }), { linked: [], created: [], conflicts: [], refused: [] });
    assert.deepEqual(snapshot(home), before);
    const report = ensureClaudeLinks(acc, procRoot, { entries: ['tasks', '.credentials.json', 'skills/../settings.json'] });
    assert.deepEqual(report.created, ['tasks']);
    assert.deepEqual(report.linked, []);
    assert.equal(exists(path.join(def, 'uploads')), false);
    assert.equal(read(path.join(acc, 'history.jsonl')), 'account history\n');
    assert.equal(read(path.join(def, 'history.jsonl')), '');
    assert.ok(isLinkTo(path.join(acc, 'settings.json'), path.join(def, 'settings.json')));
    assert.equal(read(path.join(acc, '.credentials.json')), 'fixture credentials');
    assert.equal(exists(path.join(def, '.credentials.json')), false);
  });

  test('selective child repair neither repairs siblings nor converts an unselected whole-folder link', () => {
    const acc = accountDir('children');
    const procRoot = fakeProc({});
    write(path.join(def, 'skills', 'one', 'SKILL.md'), 'one');
    write(path.join(def, 'skills', 'two', 'SKILL.md'), 'two');
    fs.mkdirSync(acc);
    fs.symlinkSync(path.join(def, 'skills'), path.join(acc, 'skills'), 'junction');
    const before = snapshot(home);
    assert.deepEqual(ensureClaudeLinks(acc, procRoot, { entries: ['skills/one'] }), { linked: [], created: [], conflicts: [], refused: [] });
    assert.deepEqual(snapshot(home), before);
    const converted = ensureClaudeLinks(acc, procRoot, { entries: ['skills'] });
    assert.deepEqual(converted.unlinked, ['skills']);
    assert.deepEqual(converted.linked, ['skills/one', 'skills/two']);
    fs.unlinkSync(path.join(acc, 'skills', 'one'));
    fs.unlinkSync(path.join(acc, 'skills', 'two'));
    fs.symlinkSync(path.join(def, 'skills', 'gone'), path.join(acc, 'skills', 'gone'), 'junction');
    assert.deepEqual(ensureClaudeLinks(acc, procRoot, { entries: ['skills/one'] }).linked, ['skills/one']);
    assert.equal(exists(path.join(acc, 'skills', 'two')), false);
    assert.ok(fs.lstatSync(path.join(acc, 'skills', 'gone')).isSymbolicLink());
    assert.equal(exists(path.join(def, 'projects')), false);
  });

  test('incorrect source types and dangling or cyclic sources fail without replacing them', LINUX_ONLY, () => {
    const acc = accountDir('invalid');
    const procRoot = fakeProc({});
    for (const kind of ['file', 'dangling', 'cycle']) {
      const target = path.join(def, 'tasks');
      if (kind === 'file') write(target, 'not a directory');
      else fs.symlinkSync(kind === 'cycle' ? target : path.join(home, 'absent'), target);
      for (const check of [true, false]) {
        const before = snapshot(def);
        assert.throws(() => ensureClaudeLinks(acc, procRoot, { check, entries: ['tasks'] }));
        assert.deepEqual(snapshot(def), before);
        assert.equal(exists(path.join(acc, 'tasks')), false);
      }
      fs.unlinkSync(target);
    }
    fs.mkdirSync(path.join(def, 'settings.json'));
    assert.throws(() => ensureClaudeLinks(acc, procRoot, { check: true, entries: ['settings.json'] }));
    write(path.join(def, 'skills'), 'not a directory');
    assert.throws(() => ensureClaudeLinks(acc, procRoot, { check: true, entries: ['skills'] }));
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

  test('a shared account stays shared while the default projects folder is missing, and the refresh recreates it', () => {
    const acc = accountDir('dangling');
    fs.mkdirSync(acc);
    ensureClaudeLinks(acc);
    fs.rmSync(path.join(def, 'projects'), { recursive: true });
    assert.equal(fs.existsSync(path.join(acc, 'projects')), false, 'the link dangles');
    assert.equal(isSharedClaudeAccount(acc), true);
    // A dangling link to somewhere else is still not shared
    const other = accountDir('elsewhere');
    fs.mkdirSync(other);
    fs.symlinkSync(path.join(home, 'gone'), path.join(other, 'projects'));
    assert.equal(isSharedClaudeAccount(other), false);
    ensureClaudeLinks(acc);
    assert.ok(fs.statSync(path.join(def, 'projects')).isDirectory());
    assert.equal(isSharedClaudeAccount(acc), true);
  });
});

describe('syncClaudeAccount', () => {
  const src = (): string => path.join(home, '.claude.json');
  const info = (dir: string): Record<string, any> => JSON.parse(read(path.join(dir, '.claude.json')));
  const STRIPE = { type: 'http', url: 'https://mcp.stripe.com/' };

  test('full sync merges both ways, keeps other keys and modes, records the base and skips unchanged files', () => {
    write(src(), JSON.stringify({
      oauthAccount: { emailAddress: 'def@x' },
      mcpServers: { a: { command: 'a' }, b: { command: 'b' } },
      projects: { '/p': { allowedTools: ['X'], hasTrustDialogAccepted: true, history: ['secret'] } },
    }));
    fs.chmodSync(src(), 0o640);
    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'acc@x' },
      mcpServers: { b: { command: 'own' }, c: { command: 'c' } },
      projects: { '/p': { allowedTools: [], lastCost: 3 }, '/q': { allowedTools: ['Q'] } },
    }));
    fs.chmodSync(path.join(acc, '.claude.json'), 0o640);
    // No base yet: nothing is removed, the account in use wins a differing server
    const r = syncClaudeAccount(src(), acc, 'full', { inUse: true });
    assert.deepEqual(r.changed, ['mcpServers', 'projects:/p']);
    assert.deepEqual(r.defaultChanged, ['mcpServers', 'projects:/q']);
    const data = info(acc);
    const defData = JSON.parse(read(src()));
    assert.deepEqual(data.mcpServers, { b: { command: 'own' }, c: { command: 'c' }, a: { command: 'a' } });
    assert.deepEqual(defData.mcpServers, { a: { command: 'a' }, b: { command: 'own' }, c: { command: 'c' } });
    assert.deepEqual(data.oauthAccount, { emailAddress: 'acc@x' });
    assert.deepEqual(defData.oauthAccount, { emailAddress: 'def@x' });
    assert.deepEqual(data.projects['/p'], { allowedTools: ['X'], lastCost: 3, hasTrustDialogAccepted: true });
    assert.deepEqual(defData.projects['/p'], { allowedTools: ['X'], hasTrustDialogAccepted: true, history: ['secret'] });
    assert.deepEqual(defData.projects['/q'], { allowedTools: ['Q'] });
    assertMode(path.join(acc, '.claude.json'), '640');
    assertMode(src(), '640');
    assertMode(path.join(acc, '.planswap-sync.json'), '600');
    assert.ok(!read(path.join(acc, '.planswap-sync.json')).includes('own'), 'the base holds hashes only');

    // In sync → no write
    const texts = [read(src()), read(path.join(acc, '.claude.json')), read(path.join(acc, '.planswap-sync.json'))];
    assert.deepEqual(syncClaudeAccount(src(), acc), { changed: [], defaultChanged: [] });
    assert.deepEqual([read(src()), read(path.join(acc, '.claude.json')), read(path.join(acc, '.planswap-sync.json'))], texts);
  });

  test('a change on either side since the last sync survives, removals included, and the account wins a conflict', () => {
    write(src(), JSON.stringify({ mcpServers: { keep: { command: 'k' }, dropByAccount: { command: 'd' }, dropByDefault: { command: 'e' }, both: { command: 'old' } } }));
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    syncClaudeAccount(src(), acc);
    // The default gains a project server and loses one; the account changes one, removes one and adds one
    const defData = JSON.parse(read(src()));
    delete defData.mcpServers.dropByDefault;
    defData.mcpServers.both = { command: 'default' };
    defData.projects = { '/w': { mcpServers: { stripe: STRIPE } } };
    write(src(), JSON.stringify(defData));
    const accData = info(acc);
    delete accData.mcpServers.dropByAccount;
    accData.mcpServers.both = { command: 'account' };
    accData.mcpServers.added = { command: 'a' };
    write(path.join(acc, '.claude.json'), JSON.stringify(accData));
    syncClaudeAccount(src(), acc);
    const expected = { keep: { command: 'k' }, both: { command: 'account' }, added: { command: 'a' } };
    for (const data of [JSON.parse(read(src())), info(acc)]) {
      assert.deepEqual(data.mcpServers, expected);
      assert.deepEqual(data.projects['/w'].mcpServers, { stripe: STRIPE });
    }
  });

  test('without a base a value differing on both sides takes the side in use, and nothing is removed', () => {
    // Before this version the account's copy was a mirror; the default changed a server and removed one meanwhile
    const defaults = { api: { url: 'v2' }, keep: { command: 'k' } };
    write(src(), JSON.stringify({ mcpServers: defaults }));
    const idle = accountDir('idle');
    write(path.join(idle, '.claude.json'), JSON.stringify({ mcpServers: { api: { url: 'v1' }, gone: { command: 'g' } } }));
    assert.deepEqual(syncClaudeAccount(src(), idle, 'check'), { changed: ['mcpServers'], quiet: [] });
    syncClaudeAccount(src(), idle);
    const expected = { api: { url: 'v2' }, gone: { command: 'g' }, keep: { command: 'k' } };
    assert.deepEqual(info(idle).mcpServers, expected);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, expected);
    // The account in use (the outgoing account of a switch) holds the latest value
    write(src(), JSON.stringify({ mcpServers: defaults }));
    const used = accountDir('used');
    write(path.join(used, '.claude.json'), JSON.stringify({ mcpServers: { api: { url: 'v1' } } }));
    assert.deepEqual(syncClaudeAccount(src(), used, 'check', { inUse: true }), { changed: ['mcpServers'], quiet: [] });
    syncClaudeAccount(src(), used, 'full', { inUse: true });
    assert.deepEqual(info(used).mcpServers, { api: { url: 'v1' }, keep: { command: 'k' } });
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { api: { url: 'v1' }, keep: { command: 'k' } });
  });

  test('a server the default gained while the account was current survives switching away (regression)', () => {
    write(src(), JSON.stringify({ projects: { '/w': { mcpServers: {} } } }));
    const acc = accountDir('current');
    fs.mkdirSync(acc);
    syncClaudeAccount(src(), acc);
    // `claude mcp add` in a plain terminal writes into the default account meanwhile
    write(src(), JSON.stringify({ projects: { '/w': { mcpServers: { stripe: STRIPE } } } }));
    // The check of the current account lists it; switching away keeps it in the default
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check'), { changed: ['projects:/w'], quiet: [] });
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).projects['/w'].mcpServers, { stripe: STRIPE });
    assert.deepEqual(info(acc).projects['/w'].mcpServers, { stripe: STRIPE });
  });

  test('pull writes only the selected groups into the account, never the default, and check lists them read only', () => {
    write(src(), JSON.stringify({
      mcpServers: { added: { command: 'new' } },
      hasCompletedOnboarding: true,
      projects: { '/selected': { allowedTools: ['shared'], hasTrustDialogAccepted: true }, '/unselected': { allowedTools: ['default'] }, '/trust': { hasTrustDialogAccepted: true } },
    }));
    const acc = accountDir('repair');
    write(path.join(acc, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'account@fixture' },
      mcpServers: { own: { command: 'own' } },
      projects: { '/selected': { allowedTools: ['own'], lastCost: 1 }, '/unselected': { allowedTools: ['account'] } },
    }));
    const sourceBefore = read(src());
    const accountBefore = read(path.join(acc, '.claude.json'));
    const checked = syncClaudeAccount(src(), acc, 'check');
    assert.deepEqual(checked, { changed: ['mcpServers', 'projects:/selected', 'projects:/unselected', 'projects:/trust', 'hasCompletedOnboarding'], quiet: ['projects:/trust'] });
    assert.equal(read(path.join(acc, '.claude.json')), accountBefore);
    assert.ok(!exists(path.join(acc, '.planswap-sync.json')));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'pull', { groups: ['mcpServers', 'projects:/selected'] }).changed, ['mcpServers', 'projects:/selected']);
    const data = info(acc);
    assert.deepEqual(data.mcpServers, { own: { command: 'own' }, added: { command: 'new' } });
    // Without a base the arrays are united
    assert.deepEqual(data.projects['/selected'], { allowedTools: ['own', 'shared'], lastCost: 1, hasTrustDialogAccepted: true });
    assert.deepEqual(data.projects['/unselected'], { allowedTools: ['account'] });
    assert.equal(data.hasCompletedOnboarding, undefined);
    assert.equal(read(src()), sourceBefore);
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check', { groups: ['mcpServers', 'projects:/selected'] }).changed, []);
    // The default still lacks 'own': the next full sync still gives it, nothing is lost
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { added: { command: 'new' }, own: { command: 'own' } });
    assert.deepEqual(JSON.parse(read(src())).projects['/selected'].allowedTools, ['own', 'shared']);
  });

  test('the .mcp.json enable / disable lists are one item, so opposing states never mix', () => {
    write(src(), JSON.stringify({ projects: { '/p': { enabledMcpjsonServers: ['s'], disabledMcpjsonServers: [] } } }));
    const acc = accountDir('pair');
    fs.mkdirSync(acc);
    syncClaudeAccount(src(), acc);
    // The account disables the server afterwards: the pair moves as a whole
    const data = info(acc);
    data.projects['/p'].enabledMcpjsonServers = [];
    data.projects['/p'].disabledMcpjsonServers = ['s'];
    write(path.join(acc, '.claude.json'), JSON.stringify(data));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).projects['/p'], { enabledMcpjsonServers: [], disabledMcpjsonServers: ['s'] });
  });

  test('MCP sign-ins sync both ways and every other credential key stays untouched', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ claudeAiOauth: { accessToken: 'default-login' }, mcpOAuth: { 'stripe|1': { accessToken: 'd1' } } }));
    fs.chmodSync(defCred, 0o600);
    const acc = accountDir('auth');
    const accCred = path.join(acc, '.credentials.json');
    write(accCred, JSON.stringify({ claudeAiOauth: { accessToken: 'account-login' }, mcpOAuth: { 'notion|2': { accessToken: 'n2' } }, mcpOAuthClientConfig: { 'notion|2': { clientSecret: 'cs' } } }));
    fs.chmodSync(accCred, 0o600);
    syncClaudeAccount(src(), acc);
    const both = { 'stripe|1': { accessToken: 'd1' }, 'notion|2': { accessToken: 'n2' } };
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuth, both);
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth, { 'notion|2': { accessToken: 'n2' }, 'stripe|1': { accessToken: 'd1' } });
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuthClientConfig, { 'notion|2': { clientSecret: 'cs' } });
    assert.deepEqual(JSON.parse(read(defCred)).claudeAiOauth, { accessToken: 'default-login' });
    assert.deepEqual(JSON.parse(read(accCred)).claudeAiOauth, { accessToken: 'account-login' });
    assertMode(defCred, '600');
    assertMode(accCred, '600');
    for (const token of ['d1', 'n2', 'cs', 'login']) assert.ok(!read(path.join(acc, '.planswap-sync.json')).includes(token));

    // A token refreshed by the account reaches the default; a refresh the account lacks is a quiet check group
    const accData = JSON.parse(read(accCred));
    accData.mcpOAuth['stripe|1'] = { accessToken: 'd1-refreshed' };
    write(accCred, JSON.stringify(accData));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check'), { changed: [], quiet: [] });
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuth['stripe|1'], { accessToken: 'd1-refreshed' });
    const defData = JSON.parse(read(defCred));
    defData.mcpOAuth['stripe|1'] = { accessToken: 'd1-again' };
    defData.mcpOAuth['linear|3'] = { accessToken: 'l3' };
    write(defCred, JSON.stringify(defData));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check'), { changed: ['mcpOAuth:stripe|1', 'mcpOAuth:linear|3'], quiet: ['mcpOAuth:stripe|1'] });
    // A sign-in missing on one side is no removal: it comes back from the other side
    syncClaudeAccount(src(), acc);
    const signedOut = JSON.parse(read(accCred));
    delete signedOut.mcpOAuth['linear|3'];
    write(accCred, JSON.stringify(signedOut));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuth['linear|3'], { accessToken: 'l3' });
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth['linear|3'], { accessToken: 'l3' });
  });

  test('a credentials file rewritten by a new Claude sign-in gets the sign-ins back instead of removing them everywhere', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: { 'stripe|1': { accessToken: 'd1' }, 'notion|2': { accessToken: 'n2' } } }));
    const acc = accountDir('relogin');
    const accCred = path.join(acc, '.credentials.json');
    write(accCred, JSON.stringify({ claudeAiOauth: { accessToken: 'old-login' } }));
    syncClaudeAccount(src(), acc);
    assert.equal(Object.keys(JSON.parse(read(accCred)).mcpOAuth).length, 2);
    // Signing out and in again leaves a fresh file with the Claude sign-in only; one new authorization before the switch
    write(accCred, JSON.stringify({ claudeAiOauth: { accessToken: 'new-login' }, mcpOAuth: { 'linear|3': { accessToken: 'l3' } } }));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(Object.keys(JSON.parse(read(defCred)).mcpOAuth).sort(), ['linear|3', 'notion|2', 'stripe|1']);
    assert.deepEqual(JSON.parse(read(accCred)).claudeAiOauth, { accessToken: 'new-login' });
    assert.deepEqual(Object.keys(JSON.parse(read(accCred)).mcpOAuth).sort(), ['linear|3', 'notion|2', 'stripe|1']);
  });

  test('a recreated info file or another default dir makes the base unknown, so nothing is removed', () => {
    write(src(), JSON.stringify({ firstStartTime: 'd', mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    const acc = accountDir('recreated');
    write(path.join(acc, '.claude.json'), JSON.stringify({ firstStartTime: 'y1' }));
    syncClaudeAccount(src(), acc);
    // The account's info file is deleted and Claude Code creates a new one with a single trusted project
    write(path.join(acc, '.claude.json'), JSON.stringify({ firstStartTime: 'y2', projects: { '/w': { hasTrustDialogAccepted: true } } }));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' }, b: { command: 'b' } });
    assert.deepEqual(info(acc).mcpServers, { a: { command: 'a' }, b: { command: 'b' } });
    // Removals work again once the new file is synced
    const data = info(acc);
    delete data.mcpServers.b;
    write(path.join(acc, '.claude.json'), JSON.stringify(data));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });

    // A base recorded against another default dir does not apply
    const base = JSON.parse(read(path.join(acc, '.planswap-sync.json')));
    write(path.join(acc, '.planswap-sync.json'), JSON.stringify({ ...base, defaultDir: path.join(home, 'elsewhere') }));
    const own = info(acc);
    delete own.mcpServers.a;
    write(path.join(acc, '.claude.json'), JSON.stringify(own));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });
    assert.equal(JSON.parse(read(path.join(acc, '.planswap-sync.json'))).defaultDir, realPath(def));
  });

  test('an info file that gains its firstStartTime on Claude Code\'s first start keeps its base', () => {
    write(src(), JSON.stringify({ firstStartTime: 'd', mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    const acc = accountDir('first-start');
    fs.mkdirSync(acc);
    // Adding the account creates its info file without firstStartTime; Claude Code adds one at its first start
    syncClaudeAccount(src(), acc);
    assert.equal(info(acc).firstStartTime, undefined);
    const data = info(acc);
    data.firstStartTime = 'y';
    delete data.mcpServers.b;
    write(path.join(acc, '.claude.json'), JSON.stringify(data));
    syncClaudeAccount(src(), acc, 'full', { inUse: true });
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });
    assert.deepEqual(info(acc).mcpServers, { a: { command: 'a' } });
    // A file recorded with a firstStartTime and now without one is another file
    write(path.join(acc, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(info(acc).mcpServers, { a: { command: 'a' } });
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });
  });

  test('sign-ins are not synced while either credentials file is missing, and none is created', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: { 'stripe|1': { accessToken: 'd1' } } }));
    const acc = accountDir('signed-out');
    fs.mkdirSync(acc);
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check').changed, []);
    syncClaudeAccount(src(), acc);
    assert.ok(!exists(path.join(acc, '.credentials.json')));
    fs.rmSync(defCred);
    write(path.join(acc, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'notion|2': { accessToken: 'n2' } } }));
    syncClaudeAccount(src(), acc);
    assert.ok(!exists(defCred));
  });

  test('a linked or multiply linked credentials file is refused without writing', FILE_SYMLINKS, () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: {} }));
    const acc = accountDir('alias');
    fs.mkdirSync(acc);
    const accCred = path.join(acc, '.credentials.json');
    fs.symlinkSync(defCred, accCred);
    assert.throws(() => syncClaudeAccount(src(), acc), { message: t('mcp.unsafeTarget', { file: accCred }) });
    fs.unlinkSync(accCred);
    // A hard link makes both names unsafe; the default's is checked first
    fs.linkSync(defCred, accCred);
    assert.throws(() => syncClaudeAccount(src(), acc, 'check'), { message: t('mcp.unsafeTarget', { file: defCred }) });
    assert.equal(read(defCred), JSON.stringify({ mcpOAuth: {} }));
  });

  test('a credentials commit waits for Claude Code\'s storage lock, takes over a stale one and refuses a held one', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: { 'stripe|1': { accessToken: 'd1' } } }));
    const acc = accountDir('locked');
    const accCred = path.join(acc, '.credentials.json');
    write(accCred, '{}');
    const lock = path.join(acc, '.storage-write.lock');
    fs.mkdirSync(lock);
    // Another process (a Claude Code credentials write) releases the lock while the commit waits for it
    spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 200)", lock], { stdio: 'ignore' });
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth, { 'stripe|1': { accessToken: 'd1' } });
    assert.ok(!exists(lock));
    fs.rmSync(path.join(acc, '.planswap-sync.json'));
    write(accCred, '{}');
    fs.mkdirSync(lock);
    assert.throws(() => syncClaudeAccount(src(), acc), { message: t('mcp.changed', { file: accCred }) });
    assert.equal(read(accCred), '{}');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth, { 'stripe|1': { accessToken: 'd1' } });
    assert.ok(!exists(lock));
    assert.ok(!exists(path.join(def, '.storage-write.lock')));
  });

  test('an empty group selection does not read any file', (ctx) => {
    const readSpy = ctx.mock.method(fsModule, 'readFileSync', () => { throw new Error('unexpected read'); });
    assert.deepEqual(syncClaudeAccount(src(), accountDir('empty'), 'pull', { groups: [] }), { changed: [] });
    assert.equal(readSpy.mock.callCount(), 0);
  });

  test('missing account info is created 0600; bad files throw without writing; the default dir is a no-op', () => {
    write(src(), JSON.stringify({ mcpServers: { m: { command: 'm' } } }));
    const b = accountDir('b');
    fs.mkdirSync(b);
    syncClaudeAccount(src(), b);
    assertMode(path.join(b, '.claude.json'), '600');
    assert.deepEqual(info(b).mcpServers, { m: { command: 'm' } });

    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), '[1]');
    assert.throws(() => syncClaudeAccount(src(), acc), /Not a valid JSON object/);
    assert.equal(read(path.join(acc, '.claude.json')), '[1]');
    write(path.join(acc, '.claude.json'), '{}');
    write(src(), '{ half');
    assert.throws(() => syncClaudeAccount(src(), acc), /default account's info file/);
    assert.equal(read(path.join(acc, '.claude.json')), '{}');

    write(src(), JSON.stringify({ mcpServers: { a: {} } }));
    assert.deepEqual(syncClaudeAccount(src(), def).changed, []);
    assert.ok(!exists(path.join(def, '.claude.json')));
  });

  test('a credential alias as account info is refused in every mode without reading it', FILE_SYMLINKS, (ctx) => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('protected');
    const file = path.join(acc, '.claude.json');
    const credential = path.join(def, '.credentials.json');
    write(credential, '{"synthetic":true}');
    fs.mkdirSync(acc);
    fs.symlinkSync(credential, file);
    const originalRead = fsModule.readFileSync;
    ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.notEqual(String(candidate), credential, 'credential payload must not be opened');
      return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
    }) as typeof fs.readFileSync);
    for (const mode of ['full', 'pull', 'check', 'fill'] as const) {
      assert.throws(() => syncClaudeAccount(src(), acc, mode), { message: t('mcp.unsafeTarget', { file }) });
    }
    assert.ok(fs.lstatSync(file).isSymbolicLink());
  });

  test('neutral sibling credential aliases and nested default links are refused in every mode', FILE_SYMLINKS, (ctx) => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('neutral-backing'); fs.mkdirSync(acc);
    const file = path.join(acc, '.claude.json');
    const other = accountDir('neutral-owner'); fs.mkdirSync(other);
    const external = path.join(home, 'neutral-external.json'); write(external, '{}');
    const owner = path.join(other, '.credentials.json'); fs.symlinkSync(external, owner);
    const nested = path.join(def, 'rules', 'linked-rule.json');
    fs.mkdirSync(path.dirname(nested), { recursive: true }); fs.symlinkSync(external, nested);
    const originalRead = fsModule.readFileSync;
    const spy = ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.notEqual(String(candidate), external, 'protected external payload must not be opened');
      return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
    }) as typeof fs.readFileSync);
    for (const destination of [external, nested]) {
      if (destination === nested) fs.unlinkSync(owner);
      fs.symlinkSync(destination, file);
      for (const mode of ['full', 'check'] as const) {
        assert.throws(() => syncClaudeAccount(src(), acc, mode), { message: t('mcp.unsafeTarget', { file }) });
        if (destination === nested) {
          const alias = path.join(home, 'default-info-alias'); fs.symlinkSync(def, alias, 'junction');
          withEnv({ CLAUDE_CONFIG_DIR: alias }, () => {
            assert.throws(() => syncClaudeAccount(src(), acc, mode), { message: t('mcp.unsafeTarget', { file }) });
          });
          fs.unlinkSync(alias);
        }
      }
      assert.ok(fs.lstatSync(file).isSymbolicLink()); fs.unlinkSync(file);
    }
    spy.mock.restore(); assert.equal(read(external), '{}');
  });

  test('safe external info links still sync and an original target replaced by a credential alias is refused', FILE_SYMLINKS, () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('external'); fs.mkdirSync(acc);
    const file = path.join(acc, '.claude.json');
    const external = path.join(home, 'external-info.json'); write(external, '{}');
    fs.symlinkSync(external, file);
    assert.deepEqual(syncClaudeAccount(src(), acc).changed, ['mcpServers']);
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    write(external, '{}');
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    const credential = path.join(acc, '.credentials.json'); write(credential, '{}');
    assert.throws(() => syncClaudeAccount(src(), acc, 'full', { beforeCommit: () => {
      if (!fs.lstatSync(external).isSymbolicLink()) { fs.unlinkSync(external); fs.symlinkSync(credential, external); }
    } }), { message: t('mcp.unsafeTarget', { file }) });
    assert.equal(read(credential), '{}');
    assert.ok(fs.lstatSync(external).isSymbolicLink());
    assert.ok(!fs.readdirSync(home).some((name) => name.includes('.planswap-') && name.endsWith('.tmp')));
  });

  test('a file rewritten by the CLI between read and rename is left unchanged and the next run converges', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('race');
    const file = path.join(acc, '.claude.json');
    write(file, JSON.stringify({ userID: 'u' }));
    const rewritten = JSON.stringify({ userID: 'u', numStartups: 2 });
    assert.throws(() => syncClaudeAccount(src(), acc, 'full', { beforeCommit: () => fs.writeFileSync(file, rewritten) }), { message: t('mcp.changed', { file: realPath(file) }) });
    assert.equal(read(file), rewritten);
    assert.deepEqual(fs.readdirSync(acc), ['.claude.json']);
    assert.deepEqual(syncClaudeAccount(src(), acc).changed, ['mcpServers']);
    assert.deepEqual(JSON.parse(read(file)), { userID: 'u', numStartups: 2, mcpServers: { a: { command: 'a' } } });

    // The default rewritten meanwhile: refused as well, the account stays as it was
    write(path.join(acc, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' }, own: { command: 'o' } } }));
    const defRewritten = JSON.stringify({ mcpServers: { a: { command: 'a' } }, numStartups: 5 });
    assert.throws(() => syncClaudeAccount(src(), acc, 'full', { beforeCommit: () => fs.writeFileSync(src(), defRewritten) }), { message: t('mcp.changed', { file: realPath(src()) }) });
    assert.equal(read(src()), defRewritten);
  });

  test('a dangling default info link is refused', FILE_SYMLINKS, () => {
    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), JSON.stringify({ mcpServers: { a: {} } }));
    fs.symlinkSync(path.join(home, 'gone.json'), src());
    assert.throws(() => syncClaudeAccount(src(), acc), { message: t('mcp.unsafeTarget', { file: src() }) });
    assert.ok(fs.lstatSync(src()).isSymbolicLink());
  });

  test('fill adds only the default MCP servers the account lacks, and writes nothing else', (ctx) => {
    const defText = JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { missing: { command: 'm' }, differs: { command: 'default' } },
      projects: { '/p': { hasTrustDialogAccepted: true, mcpServers: { proj: { command: 'p' } } } },
    });
    write(src(), defText);
    const defCred = JSON.stringify({ mcpOAuth: { 'missing|0123456789abcdef': { accessToken: 'synthetic' } } });
    write(path.join(def, '.credentials.json'), defCred);
    const acc = accountDir('fill');
    const file = path.join(acc, '.claude.json');
    write(file, JSON.stringify({ oauthAccount: { emailAddress: 'a@x' }, mcpServers: { differs: { command: 'own' }, extra: { command: 'e' } } }));
    fs.chmodSync(file, 0o640);
    write(path.join(acc, '.credentials.json'), '{}');
    // The credentials files are never read
    const credentials = [path.join(def, '.credentials.json'), path.join(acc, '.credentials.json')].map((f) => path.resolve(f));
    const reads: string[] = [];
    const realRead = fs.readFileSync;
    ctx.mock.method(fsModule, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      reads.push(path.resolve(String(file)));
      return (realRead as (...a: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync);
    const r = syncClaudeAccount(src(), acc, 'fill');
    ctx.mock.restoreAll();
    assert.ok(reads.length > 0, 'the read spy saw the info file reads');
    assert.deepEqual(reads.filter((f) => credentials.includes(f)), []);
    assert.deepEqual(r, { changed: ['mcpServers'], added: ['missing'] });
    assert.deepEqual(info(acc), {
      oauthAccount: { emailAddress: 'a@x' },
      mcpServers: { differs: { command: 'own' }, extra: { command: 'e' }, missing: { command: 'm' } },
    });
    assertMode(file, '640');
    assert.equal(read(src()), defText, 'the default info file is never written');
    assert.equal(read(path.join(def, '.credentials.json')), defCred);
    assert.equal(read(path.join(acc, '.credentials.json')), '{}');
    // Nothing left to add: no write at all
    const texts = [read(file), read(path.join(acc, '.planswap-sync.json'))];
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill'), { changed: [], added: [] });
    assert.deepEqual([read(file), read(path.join(acc, '.planswap-sync.json'))], texts);
  });

  test('fill does not re-add a server removed from the account after a sync, and adds one the default gained since', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('removed');
    const file = path.join(acc, '.claude.json');
    write(file, '{}');
    // Removed after a full sync
    syncClaudeAccount(src(), acc);
    write(file, JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, []);
    // Removed after a fill (fill records the base too)
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, ['b']);
    write(file, JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, []);
    // Changed in the default after the account removed it: the account wins, still not re-added
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a2' }, b: { command: 'b' } } }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, []);
    assert.deepEqual(info(acc), { mcpServers: {} });
    // Pull, unlike fill, changes and removes servers the account has
    const other = accountDir('pull');
    write(src(), JSON.stringify({ mcpServers: { x: { command: 'x' }, y: { command: 'y' } } }));
    write(path.join(other, '.claude.json'), '{}');
    syncClaudeAccount(src(), other);
    write(src(), JSON.stringify({ mcpServers: { y: { command: 'y2' } } }));
    assert.deepEqual(syncClaudeAccount(src(), other, 'fill').added, []);
    assert.deepEqual(info(other).mcpServers, { x: { command: 'x' }, y: { command: 'y' } });
    syncClaudeAccount(src(), other, 'pull', { groups: ['mcpServers'] });
    assert.deepEqual(info(other).mcpServers, { y: { command: 'y2' } });
  });

  test('fill refuses an account info file changed since it was read and leaves it unchanged', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('fill-race');
    const file = path.join(acc, '.claude.json');
    write(file, JSON.stringify({ userID: 'u' }));
    const rewritten = JSON.stringify({ userID: 'u', numStartups: 2 });
    assert.throws(() => syncClaudeAccount(src(), acc, 'fill', { beforeCommit: () => fs.writeFileSync(file, rewritten) }), { message: t('mcp.changed', { file: realPath(file) }) });
    assert.equal(read(file), rewritten);
    assert.deepEqual(fs.readdirSync(acc), ['.claude.json']);
  });

  test('onboarding keys are added only to a signed-in account that lacks them', () => {
    write(src(), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.286', githubRepoPaths: { 'o/r': ['/r'] } }));
    // Signed out: its first-start onboarding is how it signs in, so nothing is added
    const out = accountDir('out');
    write(path.join(out, '.claude.json'), JSON.stringify({ userID: 'u' }));
    assert.deepEqual(syncClaudeAccount(src(), out).changed, []);
    assert.equal(Object.hasOwn(info(out), 'hasCompletedOnboarding'), false);

    // Signed in by email in the info file
    const byEmail = accountDir('mail');
    write(path.join(byEmail, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
    assert.deepEqual(syncClaudeAccount(src(), byEmail).changed, ['hasCompletedOnboarding', 'lastOnboardingVersion']);
    const data = info(byEmail);
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.lastOnboardingVersion, '2.1.286');
    assert.equal(Object.hasOwn(data, 'githubRepoPaths'), false, 'githubRepoPaths is not synced');

    // Signed in by the credentials file; a value of its own is kept
    const byFile = accountDir('file');
    write(path.join(byFile, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: false, mcpServers: {} }));
    write(path.join(byFile, '.credentials.json'), '{}');
    assert.deepEqual(syncClaudeAccount(src(), byFile).changed, ['lastOnboardingVersion']);
    assert.equal(info(byFile).hasCompletedOnboarding, false);
    assert.equal(read(path.join(byFile, '.credentials.json')), '{}');
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
  test('links follow migrated targets when the account home is reached through a directory alias', async () => {
    const physicalHome = path.join(home, 'physical-home');
    const aliasHome = path.join(home, 'alias-home');
    fs.mkdirSync(physicalHome);
    fs.symlinkSync(physicalHome, aliasHome, 'junction');
    await withEnv({ HOME: aliasHome, USERPROFILE: aliasHome }, async () => {
      const acc = accountDir('alias');
      const shared = path.join(aliasHome, '.claude');
      write(path.join(shared, 'agents', 'target.md'), 'default agent');
      write(path.join(acc, 'agents', 'target.md'), 'account agent');
      write(path.join(acc, 'CLAUDE.md'), 'account instructions');
      write(path.join(aliasHome, 'outside.md'), 'external agent');
      fs.symlinkSync('target.md', path.join(acc, 'agents', 'relative.md'), 'file');
      fs.symlinkSync(path.join(acc, 'agents', 'target.md'), path.join(acc, 'agents', 'absolute.md'), 'file');
      fs.symlinkSync('../CLAUDE.md', path.join(acc, 'agents', 'instructions.md'), 'file');
      fs.symlinkSync('../../outside.md', path.join(acc, 'agents', 'external.md'), 'file');

      const report = migrateClaudeToShared(acc, 'alias', fakeProc({}));
      assert.ok(report.keptBoth.includes('agents/target.md.from-alias'));
      await deleteAccountDir(acc);
      assert.equal(read(path.join(shared, 'agents', 'target.md')), 'default agent');
      for (const name of ['relative.md', 'absolute.md']) {
        assert.ok(fs.lstatSync(path.join(shared, 'agents', name)).isSymbolicLink());
        assert.equal(read(path.join(shared, 'agents', name)), 'account agent');
      }
      assert.equal(read(path.join(shared, 'agents', 'instructions.md')), 'account instructions');
      assert.equal(read(path.join(shared, 'agents', 'external.md')), 'external agent');
    });
  });

  test('relative links follow migrated targets and keep external targets after account deletion', async () => {
    const acc = accountDir('relative');
    const relocated = path.join(home, 'profiles', 'main');
    write(path.join(home, 'dotfiles', 'agent.md'), 'external agent');
    write(path.join(relocated, 'agents', 'target.md'), 'default agent');
    write(path.join(acc, 'agents', 'target.md'), 'account agent');
    write(path.join(acc, 'rules', 'rule.md'), 'account rule');
    write(path.join(acc, 'CLAUDE.md'), 'account instructions');
    fs.symlinkSync('../../dotfiles/agent.md', path.join(acc, 'agents', 'external.md'), 'file');
    fs.symlinkSync('target.md', path.join(acc, 'agents', 'alias.md'), 'file');
    fs.symlinkSync('target.md', path.join(relocated, 'agents', 'alias.md'), 'file');
    fs.symlinkSync('../rules/rule.md', path.join(acc, 'agents', 'rule.md'), 'file');
    fs.symlinkSync('../CLAUDE.md', path.join(acc, 'agents', 'instructions.md'), 'file');
    process.env.CLAUDE_CONFIG_DIR = relocated;
    try {
      const report = migrateClaudeToShared(acc, 'relative', fakeProc({}));
      assert.ok(report.keptBoth.includes('agents/target.md.from-relative'));
      assert.ok(report.keptBoth.includes('agents/alias.md.from-relative'));
      await deleteAccountDir(acc);
      assert.equal(read(path.join(relocated, 'agents', 'external.md')), 'external agent');
      assert.equal(read(path.join(relocated, 'agents', 'alias.md')), 'default agent');
      assert.equal(read(path.join(relocated, 'agents', 'alias.md.from-relative')), 'account agent');
      assert.equal(read(path.join(relocated, 'agents', 'rule.md')), 'account rule');
      assert.equal(read(path.join(relocated, 'agents', 'instructions.md')), 'account instructions');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  test('a folder kept beside a conflicting file keeps internal and external link targets', async () => {
    const acc = accountDir('folder');
    write(path.join(def, 'agents', 'bundle'), 'default file');
    write(path.join(home, 'outside.md'), 'external');
    write(path.join(acc, 'agents', 'bundle', 'target.md'), 'inside');
    fs.symlinkSync('target.md', path.join(acc, 'agents', 'bundle', 'inside.md'), 'file');
    fs.symlinkSync('../../../outside.md', path.join(acc, 'agents', 'bundle', 'outside.md'), 'file');
    const report = migrateClaudeToShared(acc, 'folder', fakeProc({}));
    assert.deepEqual(report.keptBoth, ['agents/bundle.from-folder']);
    await deleteAccountDir(acc);
    assert.equal(read(path.join(def, 'agents', 'bundle')), 'default file');
    assert.equal(read(path.join(def, 'agents', 'bundle.from-folder', 'inside.md')), 'inside');
    assert.equal(read(path.join(def, 'agents', 'bundle.from-folder', 'outside.md')), 'external');
  });

  test('links whose final targets are identical are dropped without replacing the default link', () => {
    const acc = accountDir('identical-link');
    write(path.join(home, 'outside.md'), 'external');
    fs.mkdirSync(path.join(def, 'agents'));
    fs.mkdirSync(path.join(acc, 'agents'), { recursive: true });
    fs.symlinkSync('../../outside.md', path.join(acc, 'agents', 'alias.md'), 'file');
    fs.symlinkSync(path.join(home, 'outside.md'), path.join(def, 'agents', 'alias.md'), 'file');
    const report = migrateClaudeToShared(acc, 'identical-link', fakeProc({}));
    assert.equal(report.duplicates, 1);
    assert.deepEqual(report.keptBoth, []);
    assert.equal(fs.readlinkSync(path.join(def, 'agents', 'alias.md')), path.join(home, 'outside.md'));
  });

  test('a link to a skipped FIFO still points to the source entry', LINUX_ONLY, () => {
    const acc = accountDir('pipe');
    fs.mkdirSync(path.join(acc, 'agents'), { recursive: true });
    const pipe = path.join(acc, 'agents', 'pipe');
    execFileSync('mkfifo', [pipe]);
    fs.symlinkSync('pipe', path.join(acc, 'agents', 'alias'));
    const report = migrateClaudeToShared(acc, 'pipe', fakeProc({}));
    assert.ok(report.conflicts.includes('agents'));
    assert.equal(fs.realpathSync(path.join(def, 'agents', 'alias')), pipe);
    assert.ok(fs.lstatSync(pipe).isFIFO());
  });

  test('a refused Windows link keeps its dependent source links instead of moving broken aliases', (ctx) => {
    const acc = accountDir('no-privilege');
    const relocated = path.join(home, 'profiles', 'main');
    write(path.join(home, 'outside.md'), 'external');
    fs.mkdirSync(path.join(acc, 'agents'), { recursive: true });
    fs.mkdirSync(relocated, { recursive: true });
    fs.symlinkSync('z.md', path.join(acc, 'agents', 'a.md'), 'file');
    fs.symlinkSync('../../outside.md', path.join(acc, 'agents', 'z.md'), 'file');
    const before = snapshot(path.join(acc, 'agents'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    const symlink = fsModule.symlinkSync;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    ctx.mock.method(fsModule, 'symlinkSync', ((target: fs.PathLike, link: fs.PathLike, type?: fs.symlink.Type) => {
      if (type === 'file') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return symlink(target, link, type);
    }) as typeof fs.symlinkSync);
    process.env.CLAUDE_CONFIG_DIR = relocated;
    try {
      const report = migrateClaudeToShared(acc, 'no-privilege', fakeProc({}));
      assert.ok(report.noPrivilege?.includes('agents/z.md'));
      assert.ok(report.noPrivilege?.includes('agents/a.md'));
      assert.deepEqual(snapshot(path.join(acc, 'agents')), before);
      assert.equal(read(path.join(acc, 'agents', 'a.md')), 'external');
      assert.equal(fs.existsSync(path.join(relocated, 'agents', 'a.md')), false);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      Object.defineProperty(process, 'platform', platform);
    }
  });

  test('a dangling default source fails the final link refresh while migrated content and backups survive', () => {
    fs.symlinkSync(NOWHERE, path.join(def, 'CLAUDE.md'));
    const acc = accountDir('dangling');
    write(path.join(acc, 'CLAUDE.md'), 'acc rules');
    write(path.join(acc, 'projects', 'p', 'a.jsonl'), 'a');
    assert.throws(() => migrateClaudeToShared(acc, 'dangling', fakeProc({})), { code: 'ENOENT' });
    assert.equal(read(path.join(acc, 'CLAUDE.md.independent-backup')), 'acc rules');
    assert.equal(fs.readlinkSync(path.join(def, 'CLAUDE.md')), NOWHERE);   // the default entry is never touched
    assert.equal(read(path.join(def, 'projects', 'p', 'a.jsonl')), 'a');
    assert.equal(exists(path.join(acc, 'CLAUDE.md')), false);
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
    assert.equal(exists(path.join(def, 'settings.json')), false);
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
    assert.throws(() => migrateClaudeToShared(acc, 'a', fakeProc({ 42: { CLAUDE_CONFIG_DIR: acc } })), { message: t('share.busy', { name: 'a' }) });
    assert.equal(read(path.join(acc, 'projects', 'p', 'x')), 'x');
    assert.ok(!exists(path.join(def, 'projects')));
  });

  test('refuses when the caller reports the account busy (terminal opened during the copy-fallback prompt); nothing moved', () => {
    const acc = accountDir('a');
    write(path.join(acc, 'projects', 'p', 'x'), 'x');
    assert.throws(() => migrateClaudeToShared(acc, 'a', fakeProc({}), 'Work', { busy: () => true }), { message: t('share.busy', { name: 'Work' }) });
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

describe('default entries linked to the account\'s own files', SHARING, () => {
  test('conversion and later refreshes leave the account file in place and report it', () => {
    const acc = accountDir('own');
    write(path.join(acc, 'settings.json'), '{"model":"x"}\n');
    write(path.join(acc, 'CLAUDE.md'), 'account rules');
    write(path.join(acc, 'history.jsonl'), '{"h":1}\n');
    for (const name of ['settings.json', 'CLAUDE.md', 'history.jsonl']) fs.symlinkSync(path.join(acc, name), path.join(def, name), 'file');
    const r = migrateClaudeToShared(acc, 'own', fakeProc({}));
    assert.equal(r.duplicates, 0);
    assert.equal(r.moved, 0);
    const check = (report: { conflicts: string[] }): void => {
      for (const name of ['settings.json', 'CLAUDE.md', 'history.jsonl']) {
        assert.ok(report.conflicts.includes(name), name);
        assert.ok(fs.lstatSync(path.join(acc, name)).isFile(), name);
        assert.ok(isLinkTo(path.join(def, name), path.join(acc, name)), name);
      }
      assert.equal(read(path.join(acc, 'settings.json')), '{"model":"x"}\n');
      assert.equal(read(path.join(acc, 'CLAUDE.md')), 'account rules');
      assert.equal(read(path.join(def, 'history.jsonl')), '{"h":1}\n');
    };
    check(r);
    assert.equal(isSharedClaudeAccount(acc), true);
    // The shared account's history merge-back must not merge the file into itself either
    const r2 = ensureClaudeLinks(acc, fakeProc({}));
    assert.ok(!r2.merged?.includes('history.jsonl'));
    check(r2);
    check(ensureClaudeLinks(acc, fakeProc({}), { check: true }));
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

  test('unlinking and linking again forget the sync base, so changes made while independent are no removals', () => {
    write(src(), JSON.stringify({ mcpServers: { s: { command: 's' }, keep: { command: 'k' } } }));
    const acc = accountDir('relinked');
    fs.mkdirSync(acc, { mode: 0o700 });
    const proc = path.join(home, 'fake-proc'); fs.mkdirSync(proc);
    ensureClaudeLinks(acc, proc);
    syncClaudeAccount(src(), acc);
    assert.ok(exists(path.join(acc, '.planswap-sync.json')));
    makeClaudeIndependent(src(), acc);
    assert.ok(!exists(path.join(acc, '.planswap-sync.json')));
    // While independent the account drops a server it got; linking again keeps the default's
    const data = JSON.parse(read(path.join(acc, '.claude.json')));
    delete data.mcpServers.s;
    write(path.join(acc, '.claude.json'), JSON.stringify(data));
    write(path.join(acc, '.planswap-sync.json'), JSON.stringify({ items: {} }));
    migrateClaudeToShared(acc, 'relinked', proc);
    assert.ok(!exists(path.join(acc, '.planswap-sync.json')));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { s: { command: 's' }, keep: { command: 'k' } });
  });

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
