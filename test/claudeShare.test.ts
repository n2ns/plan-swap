import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import { describeShareReport } from '../src/shareReport';
import { execFileSync } from 'node:child_process';
import { pidAlive, type StartTimeProbe } from '../src/platform';
import {
  CLAUDE_SHARED_ENTRIES, claudeAccountBusy, copyClaudeIndependent, ensureClaudeLinks, isSharedClaudeAccount, makeClaudeIndependent,
  migrateClaudeToShared, sessionRecordsBusy,
} from '../src/claudeShare';
import { lstatOrUndefined, type MigrateReport } from '../src/shareLinks';
import { syncClaudeAccount } from '../src/claudeSync';
import { accountDir, deleteAccountDir } from '../src/paths';
import {
  assertMode, assertTempHome, makeTempHome, POSIX_ONLY, read, SHARING, snapshot, type TempHome, withEnv,
} from './helpers';

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

  test('a broken or unreadable child of skills / plugins is reported and left unlinked; its siblings are still linked', POSIX_ONLY, () => {
    const acc = accountDir('child-errors');
    const procRoot = fakeProc({});
    write(path.join(def, 'skills', 'good', 'SKILL.md'), 'good');
    fs.symlinkSync(path.join(home, 'absent'), path.join(def, 'skills', 'dangling'));
    fs.symlinkSync(path.join(def, 'skills', 'cycle'), path.join(def, 'skills', 'cycle'));
    fs.mkdirSync(path.join(def, 'skills', 'closed'));
    fs.writeFileSync(path.join(def, 'skills', 'closed', 'SKILL.md'), 'closed');
    fs.chmodSync(path.join(def, 'skills', 'closed'), 0);
    const unreadable = process.getuid?.() === 0 ? ['skills/cycle', 'skills/dangling'] : ['skills/closed', 'skills/cycle', 'skills/dangling'];
    try {
      for (const check of [true, false]) {
        const r = ensureClaudeLinks(acc, procRoot, { check, entries: ['skills'] });
        assert.deepEqual([...r.unreadable ?? []].sort(), unreadable, `check=${check}`);
        assert.deepEqual(r.linked, process.getuid?.() === 0 ? ['skills/closed', 'skills/good'] : ['skills/good'], `check=${check}`);
        assert.deepEqual(r.conflicts, []);
      }
      assert.ok(isLinkTo(path.join(acc, 'skills', 'good'), path.join(def, 'skills', 'good')));
      for (const name of unreadable) assert.equal(exists(path.join(acc, name)), false, name);
      assert.ok(describeShareReport(ensureClaudeLinks(acc, procRoot, { check: true, entries: ['skills'] })).includes('skills/dangling'));
    } finally {
      fs.chmodSync(path.join(def, 'skills', 'closed'), 0o700);
    }
  });

  test('incorrect source types and dangling or cyclic sources fail without replacing them', POSIX_ONLY, () => {
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
    const busy = (dir: string, probe: StartTimeProbe): boolean => sessionRecordsBusy(dir, probe, 'win32');
    assert.equal(busy(sessions, never), false);
    write(path.join(sessions, 'dead.json'), JSON.stringify({ pid: done, procStart: '1' }));
    write(path.join(sessions, 'bad.json'), '{ half');
    assert.equal(busy(sessions, never), false);
    write(path.join(sessions, 'live.json'), JSON.stringify({ pid: process.pid, procStart: '42' }));
    assert.equal(busy(sessions, () => new Map([[process.pid, '42']])), true);
    // The pid now belongs to another process (reused), or it exited between the two checks
    assert.equal(busy(sessions, () => new Map([[process.pid, '43']])), false);
    assert.equal(busy(sessions, () => new Map()), false);
    // A failed probe cannot rule the session out
    assert.equal(busy(sessions, () => undefined), true);
    // A macOS start time is not a Windows procStart: such a record cannot be told from a reused pid
    write(path.join(sessions, 'mac.json'), JSON.stringify({ pid: process.pid, procStart: 'Mon Oct 26 20:00:10 2026' }));
    assert.equal(busy(sessions, () => new Map([[process.pid, 'Mon Oct 26 20:00:10 2026']])), true);
    assert.equal(busy(sessions, () => new Map()), true);
    fs.rmSync(path.join(sessions, 'mac.json'));
    // A live record without procStart cannot be told from a reused pid
    write(path.join(sessions, 'old.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(busy(sessions, () => new Map()), true);
    // Shared account: sessions is a link to the default folder, whose records belong to every sharing account
    const shared = path.join(accountDir('winshared'), 'sessions');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(sessions, shared, 'junction');
    assert.equal(busy(shared, never), false);
  });
  test('macOS check: live pid whose ps start time matches the recorded procStart; shared sessions folders are not attributed', () => {
    const sessions = path.join(accountDir('mac'), 'sessions');
    const never = (): Map<number, string> => assert.fail('no probe expected');
    const busy = (dir: string, probe: StartTimeProbe): boolean => sessionRecordsBusy(dir, probe, 'darwin');
    assert.equal(busy(sessions, never), false);
    write(path.join(sessions, 'dead.json'), JSON.stringify({ pid: 0x7ffffffc, procStart: 'Mon Oct 26 20:00:10 2026' }));
    assert.equal(busy(sessions, never), false);
    // A one-digit day: ps pads it with a second space, the record may not
    write(path.join(sessions, 'live.json'), JSON.stringify({ pid: process.pid, procStart: 'Mon Oct  5 20:00:10 2026' }));
    const probed: number[][] = [];
    assert.equal(busy(sessions, (pids) => { probed.push(pids); return new Map([[process.pid, 'Mon Oct 5 20:00:10 2026']]); }), true);
    assert.deepEqual(probed, [[process.pid]], 'only the live pid is probed');
    assert.equal(busy(sessions, () => new Map([[process.pid, 'Mon  Oct 5  20:00:10 2026 ']])), true);
    // The pid now belongs to another process (reused), or it exited between the two checks
    assert.equal(busy(sessions, () => new Map([[process.pid, 'Mon Oct 5 20:00:11 2026']])), false);
    assert.equal(busy(sessions, () => new Map()), false);
    // A failed probe cannot rule the session out
    assert.equal(busy(sessions, () => undefined), true);
    // A Windows procStart, or none, cannot be told from a reused pid
    write(path.join(sessions, 'win.json'), JSON.stringify({ pid: process.pid, procStart: '42' }));
    assert.equal(busy(sessions, () => new Map([[process.pid, '42']])), true);
    assert.equal(busy(sessions, () => new Map()), true);
    fs.rmSync(path.join(sessions, 'win.json'));
    assert.equal(busy(sessions, () => new Map()), false);
    write(path.join(sessions, 'old.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(busy(sessions, () => new Map()), true);
    fs.rmSync(path.join(sessions, 'old.json'));
    // Shared account: sessions is a link to the default folder
    const shared = path.join(accountDir('macshared'), 'sessions');
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.symlinkSync(sessions, shared, 'junction');
    assert.equal(busy(shared, never), false);
  });
  test('claudeAccountBusy uses the session records on macOS with the default procRoot', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const acc = accountDir('macdefault');
    // A live record without procStart is busy on the session-record path without any probe; the /proc path (Linux)
    // would not attribute this test process to the account
    write(path.join(acc, 'sessions', 'a.json'), JSON.stringify({ pid: process.pid }));
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      assert.equal(claudeAccountBusy(acc), true, 'a live record without procStart counts as busy');
      fs.rmSync(path.join(acc, 'sessions', 'a.json'));
      assert.equal(claudeAccountBusy(acc), false, 'no records');
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
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

  test('a link to a skipped FIFO still points to the source entry', POSIX_ONLY, () => {
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
