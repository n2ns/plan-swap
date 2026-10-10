import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import {
  CODEX_IDENTITY_CONFIG_KEYS, CODEX_SHARED_ENTRIES, codexAccountBusy, copyCodexIndependent, ensureCodexLinks,
  isSharedCodexAccount, makeCodexIndependent, migrateCodexToShared,
} from '../src/codex/codexShare';
import { codexAccountDir, deleteCodexDir } from '../src/codex/codexPaths';
import { describeShareReport } from '../src/shareReport';
import { sameRealPath } from '../src/paths';
import { assertTempHome, makeTempHome, assertMode, LINUX_ONLY, onWindows, SHARING, read, snapshot, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
let def: string;

before(() => {
  tmp = makeTempHome('codexshare');
  home = tmp.home;
  def = path.join(home, '.codex');
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
const newAccount = (name: string): string => {
  const acc = codexAccountDir(name);
  fs.mkdirSync(acc, { mode: 0o700 });
  return acc;
};
const LINK_ONLY = CODEX_SHARED_ENTRIES.filter((e) => e.kind === 'link-only').map((e) => e.name);
// Windows never links the databases (writes through a linked SQLite database are lost there)
const linkedHere = (name: string): boolean => !(onWindows && name.endsWith('.sqlite'));
const LINKED_ENTRIES = CODEX_SHARED_ENTRIES.filter((e) => linkedHere(e.name));

describe('default directory ancestor safety', () => {
  test('link repair, conversion and copying refuse an account containing the linked default directory without writes', () => {
    const acc = newAccount('work');
    const target = path.join(acc, 'sessions', 'main');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(def, target);
    fs.symlinkSync(target, def, 'junction');
    write(path.join(def, 'keep.txt'), 'default data');
    write(path.join(def, 'config.toml'), 'model = "default"\n');
    write(path.join(acc, 'AGENTS.md'), 'account rules');
    const proc = fakeProc({});
    const before = snapshot(home);

    for (const operation of [
      () => ensureCodexLinks(acc, {}, proc),
      () => migrateCodexToShared(acc, 'work', proc),
      () => copyCodexIndependent(acc),
    ]) {
      assert.throws(operation, { message: t('account.containsDefaultDir', { dir: acc, default: def }) });
      assert.deepEqual(snapshot(home), before);
    }
  });

  test('unlinking refuses a shared account containing the linked default directory without writes', () => {
    const acc = newAccount('work');
    const target = path.join(acc, 'local', 'default');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(def, target);
    fs.symlinkSync(target, def, 'junction');
    write(path.join(def, 'sessions', 'keep.jsonl'), 'default session');
    write(path.join(def, 'config.toml'), 'model = "default"\n');
    fs.symlinkSync(path.join(def, 'sessions'), path.join(acc, 'sessions'), 'junction');
    const proc = fakeProc({});
    const before = snapshot(home);

    assert.equal(isSharedCodexAccount(acc), true);
    assert.throws(() => makeCodexIndependent(acc, 'work', proc), {
      message: t('account.containsDefaultDir', { dir: acc, default: def }),
    });
    assert.deepEqual(snapshot(home), before);
  });
});

describe('ensureCodexLinks', SHARING, () => {
  test('absent optional themes do not request repair, with or without the expected account link', () => {
    const acc = newAccount('a');
    const proc = fakeProc({});
    ensureCodexLinks(acc, {}, proc);
    fs.rmdirSync(path.join(def, 'themes'));
    for (const linked of [true, false]) {
      if (!linked) fs.unlinkSync(path.join(acc, 'themes'));
      const before = snapshot(home);
      assert.deepEqual(ensureCodexLinks(acc, { check: true }, proc), { linked: [], created: [], conflicts: [], refused: [] });
      assert.deepEqual(snapshot(home), before);
    }
  });

  test('absent optional themes preserve an account directory or foreign link as a note', () => {
    const acc = newAccount('a');
    const proc = fakeProc({});
    ensureCodexLinks(acc, {}, proc);
    fs.rmdirSync(path.join(def, 'themes'));
    fs.unlinkSync(path.join(acc, 'themes'));
    write(path.join(acc, 'themes', 'own.tmTheme'), 'own theme');
    const before = snapshot(home);
    assert.deepEqual(ensureCodexLinks(acc, { check: true }, proc), {
      linked: [], created: [], conflicts: ['themes'], refused: [],
    });
    assert.deepEqual(snapshot(home), before);
    const elsewhere = path.join(home, 'own-themes');
    fs.renameSync(path.join(acc, 'themes'), elsewhere);
    fs.symlinkSync(elsewhere, path.join(acc, 'themes'), 'junction');
    const beforeLink = snapshot(home);
    assert.deepEqual(ensureCodexLinks(acc, { check: true }, proc), {
      linked: [], created: [], conflicts: ['themes'], refused: [], elsewhere: ['themes'],
    });
    assert.deepEqual(snapshot(home), beforeLink);
  });

  test('refresh initializes optional themes for first writes and checks still detect missing links to existing themes', () => {
    const acc = newAccount('a');
    const other = newAccount('b');
    const proc = fakeProc({});
    ensureCodexLinks(acc, {}, proc);
    fs.rmdirSync(path.join(def, 'themes'));
    fs.unlinkSync(path.join(acc, 'themes'));
    const refreshed = ensureCodexLinks(acc, {}, proc);
    assert.ok(refreshed.created.includes('themes'));
    assert.ok(refreshed.linked.includes('themes'));
    fs.writeFileSync(path.join(acc, 'themes', 'shared.tmTheme'), 'shared theme');
    ensureCodexLinks(other, {}, proc);
    assert.equal(read(path.join(other, 'themes', 'shared.tmTheme')), 'shared theme');
    fs.unlinkSync(path.join(acc, 'themes'));
    const before = snapshot(home);
    assert.deepEqual(ensureCodexLinks(acc, { check: true }, proc), {
      linked: ['themes'], created: [], conflicts: [], refused: [],
    });
    assert.deepEqual(snapshot(home), before);
  });

  test('invalid or dangling default themes remain check errors rather than optional absence', () => {
    const acc = newAccount('a');
    const proc = fakeProc({});
    ensureCodexLinks(acc, {}, proc);
    const target = path.join(def, 'themes');
    fs.rmdirSync(target);
    fs.writeFileSync(target, 'not a directory');
    let before = snapshot(home);
    assert.throws(() => ensureCodexLinks(acc, { check: true }, proc), { message: t('share.badEntry', { file: target }) });
    assert.deepEqual(snapshot(home), before);
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(home, 'missing-themes'), target, 'junction');
    before = snapshot(home);
    assert.throws(() => ensureCodexLinks(acc, { check: true }, proc), { code: 'ENOENT' });
    assert.deepEqual(snapshot(home), before);
  });

  test('creates absolute links and empty default entries with modes; link-only targets are not created; idempotent', () => {
    const acc = newAccount('a');
    const r = ensureCodexLinks(acc);
    for (const { name, kind } of LINKED_ENTRIES) {
      assert.ok(isLinkTo(path.join(acc, name), path.join(def, name)), name);
      assert.ok(r.linked.includes(name), name);
      assert.equal(r.created.includes(name), kind !== 'link-only', name);
    }
    for (const name of LINK_ONLY) {
      assert.ok(!exists(path.join(def, name)), name);
      assert.ok(!fs.existsSync(path.join(acc, name)), `${name} dangles`);
    }
    assert.equal(read(path.join(def, 'hooks.json')), '{}\n');
    assert.equal(read(path.join(def, 'config.toml')), '');
    assert.equal(read(path.join(def, 'AGENTS.md')), '');
    assertMode(path.join(def, 'session_index.jsonl'), '600');
    assertMode(path.join(def, 'sessions'), '700');
    assertMode(path.join(def, '.tmp'), '700');
    assertMode(path.join(def, 'skills'), '700');
    assertMode(path.join(def, 'plugins', 'cache'), '700');
    assert.ok(r.created.includes('.tmp'));
    assert.ok(r.created.includes('skills'));
    assert.ok(r.created.includes('plugins/cache'));
    // The account keeps real folders for .tmp, skills and plugins/cache
    for (const f of ['.tmp', 'skills', 'plugins', path.join('plugins', 'cache')]) {
      const st = fs.lstatSync(path.join(acc, f));
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), f);
      assertMode(path.join(acc, f), '700', f);
    }
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.refused, []);

    assert.deepEqual(ensureCodexLinks(acc), { linked: [], created: [], conflicts: [], refused: [] });
  });

  test('a dangling lock link is written through into the default .tmp', () => {
    const acc = newAccount('a');
    ensureCodexLinks(acc);
    // What Codex does with the maintenance lock: open with O_CREAT (no O_EXCL)
    fs.closeSync(fs.openSync(path.join(acc, '.tmp', 'rollout-maintenance.lock'), 'a'));
    assert.ok(fs.lstatSync(path.join(def, '.tmp', 'rollout-maintenance.lock')).isFile());
    assert.ok(fs.lstatSync(path.join(acc, '.tmp', 'rollout-maintenance.lock')).isSymbolicLink());
  });

  test('existing default content is kept; conflicts are left untouched', () => {
    write(path.join(def, 'AGENTS.md'), 'rules');
    write(path.join(def, 'sessions', '2026', 'x.jsonl'), 'x');
    fs.mkdirSync(path.join(home, 'elsewhere'));
    const acc = newAccount('a');
    write(path.join(acc, 'AGENTS.md'), 'own');
    fs.mkdirSync(path.join(acc, 'rules'));
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(acc, 'agents'));
    write(path.join(acc, 'history.jsonl'), '{"own":1}\n');
    const r = ensureCodexLinks(acc);
    // Not shared yet when the run started: a real history.jsonl is a conflict, not a repair
    assert.deepEqual(r.conflicts.sort(), ['AGENTS.md', 'agents', 'history.jsonl', 'rules']);
    assert.ok(!r.created.includes('AGENTS.md'));
    assert.equal(read(path.join(def, 'AGENTS.md')), 'rules');
    assert.equal(read(path.join(acc, 'AGENTS.md')), 'own');
    assert.equal(read(path.join(acc, 'history.jsonl')), '{"own":1}\n');
    assert.equal(read(path.join(def, 'history.jsonl')), '');
    assert.equal(fs.readlinkSync(path.join(acc, 'agents')), path.join(home, 'elsewhere'));
    assert.equal(read(path.join(acc, 'sessions', '2026', 'x.jsonl')), 'x');
  });

  test('a linked or non-folder account .tmp is a conflict and is left alone', () => {
    fs.mkdirSync(path.join(def, '.tmp'));
    const acc = newAccount('a');
    fs.symlinkSync(path.join(def, '.tmp'), path.join(acc, '.tmp'));
    let r = ensureCodexLinks(acc);
    assert.ok(r.conflicts.includes('.tmp/rollout-maintenance.lock'));
    assert.ok(!r.conflicts.includes('.tmp/rollout-compression.lock'));
    assert.ok(isLinkTo(path.join(acc, '.tmp'), path.join(def, '.tmp')));
    assert.deepEqual(fs.readdirSync(path.join(def, '.tmp')), []);

    const b = newAccount('b');
    write(path.join(b, '.tmp'), 'file');
    r = ensureCodexLinks(b);
    assert.ok(r.conflicts.includes('.tmp/rollout-maintenance.lock'));
    assert.equal(read(path.join(b, '.tmp')), 'file');
  });

  test('config.toml is refused for every identity key and an unreadable default', () => {
    const acc = newAccount('a');
    const cfg = path.join(def, 'config.toml');
    const refused = (text: string): boolean => {
      write(cfg, text);
      const r = ensureCodexLinks(acc);
      assert.equal(read(cfg), text);
      return r.refused.includes('config.toml');
    };
    for (const key of CODEX_IDENTITY_CONFIG_KEYS) {
      assert.ok(refused(`model = "gpt"\n${key} = "x"\n`), key);
      assert.ok(!exists(path.join(acc, 'config.toml')), key);
    }
    write(cfg, 'sqlite_home = "/srv/codex"\n');
    assert.equal(ensureCodexLinks(acc).refusedNotes?.['config.toml'], t('share.r.configSqliteHome'));
    assert.ok(refused("'forced_login_method' = \"x\"\n"));
    assert.ok(refused('forced_chatgpt_workspace_id = ["a", "b"]\n'));
    for (const key of ['forced_login_method', 'forced_chatgpt_workspace_id']) {
      assert.ok(refused(`instructions = """\nPrint \\""" as an example:\n[example]\n"""\n${key} = "x"\n`));
      assert.ok(!exists(path.join(acc, 'config.toml')), key);
    }
    // Provider and profile settings and the credential stores only choose how Codex runs: shareable
    for (const text of [
      'model_provider = "corp"\n[model_providers.corp]\nbase_url = "x"\n',
      'profile = "work"\n[profiles.work]\nmodel = "x"\n',
      'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n',
      'chatgpt_base_url = "x"\nopenai_base_url = "x"\nlog_dir = "/tmp/x"\noss_provider = "ollama"\n',
    ]) {
      assert.ok(!refused(text), text);
      assert.ok(isLinkTo(path.join(acc, 'config.toml'), cfg), text);
      fs.unlinkSync(path.join(acc, 'config.toml'));
    }
    // Not top-level / inside a multi-line value: shareable
    assert.ok(!refused('[tui]\nsqlite_home = "x"\n'));
    assert.ok(isLinkTo(path.join(acc, 'config.toml'), cfg));
    fs.unlinkSync(path.join(acc, 'config.toml'));
    assert.ok(!refused('notify = [\n  "sqlite_home = 1",\n]\ninstructions = """\nforced_login_method = "x"\n"""\n'));

    // Unreadable as text (a folder)
    fs.rmSync(cfg);
    fs.unlinkSync(path.join(acc, 'config.toml'));
    fs.mkdirSync(cfg);
    const r = ensureCodexLinks(acc);
    assert.ok(r.refused.includes('config.toml'));
    assert.equal(r.refusedNotes?.['config.toml'], t('share.r.configUnreadable'));
    assert.ok(!exists(path.join(acc, 'config.toml')));
  });

  test('account-local sqlite_home permits linking, read-only checks and refresh of existing links', () => {
    const cfg = path.join(def, 'config.toml');
    const acc = newAccount('a');
    write(cfg, 'model = "gpt"\n');
    ensureCodexLinks(acc);
    write(cfg, 'sqlite_home = "."\nmodel = "gpt"\n');
    const before = snapshot(home);
    assert.ok(!ensureCodexLinks(acc, { check: true }).refused.includes('config.toml'));
    assert.deepEqual(snapshot(home), before, 'checking does not alter the config link or its target');
    assert.ok(!ensureCodexLinks(acc).refused.includes('config.toml'));
    assert.ok(isLinkTo(path.join(acc, 'config.toml'), cfg), 'refresh keeps the existing link');
    const second = newAccount('b');
    assert.ok(!ensureCodexLinks(second).refused.includes('config.toml'));
    assert.ok(isLinkTo(path.join(second, 'config.toml'), cfg), 'a new account can link the same config');
    assert.equal(read(cfg), 'sqlite_home = "."\nmodel = "gpt"\n');
  });

  test('an existing config.toml link is removed when the default config later gains identity keys; other entries stay', () => {
    const acc = newAccount('a');
    const cfg = path.join(def, 'config.toml');
    write(cfg, 'model = "gpt"\n');
    ensureCodexLinks(acc);
    assert.ok(isLinkTo(path.join(acc, 'config.toml'), cfg));
    write(cfg, 'model = "gpt"\nforced_login_method = "chatgpt"\n');
    const r = ensureCodexLinks(acc);
    assert.deepEqual(r.refused, ['config.toml']);
    assert.ok(!exists(path.join(acc, 'config.toml')), 'the link is removed, no copy is made');
    assert.equal(read(cfg), 'model = "gpt"\nforced_login_method = "chatgpt"\n');
    // The account is left without config.toml: the notice names the key and what it does
    assert.deepEqual(r.refusedNotes, { 'config.toml': t('share.r.configSignsOut', { key: 'forced_login_method' }) });
    assert.equal(describeShareReport(r), t('share.r.configSignsOut', { key: 'forced_login_method' }));
    assert.ok(isLinkTo(path.join(acc, 'AGENTS.md'), path.join(def, 'AGENTS.md')));
    // A real file or a link elsewhere in the account is not touched
    write(path.join(acc, 'config.toml'), 'model = "own"\n');
    const own = ensureCodexLinks(acc);
    assert.deepEqual(own.refused, ['config.toml']);
    assert.equal(own.refusedNotes, undefined, 'an account with its own config.toml gets the plain refusal');
    assert.equal(read(path.join(acc, 'config.toml')), 'model = "own"\n');
  });

  test('skills and plugins/cache are linked per child; excludes skipped; stale links removed', () => {
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', 'two', 'SKILL.md'), '2');
    write(path.join(def, 'skills', '.system', 'x', 'SKILL.md'), 'sys');
    write(path.join(def, 'plugins', 'cache', 'openai-curated', 'p'), 'p');
    write(path.join(def, 'plugins', 'cache', 'openai-curated-remote', 'r'), 'r');
    write(path.join(def, 'plugins', 'config.json'), '{}');
    const acc = newAccount('a');
    write(path.join(acc, 'skills', 'mine', 'SKILL.md'), 'm');
    write(path.join(acc, 'skills', 'two', 'SKILL.md'), 'own two');
    write(path.join(acc, 'skills', '.system', 'y'), 'own system');
    let r = ensureCodexLinks(acc);
    assert.ok(isLinkTo(path.join(acc, 'skills', 'one'), path.join(def, 'skills', 'one')));
    assert.ok(isLinkTo(path.join(acc, 'plugins', 'cache', 'openai-curated'), path.join(def, 'plugins', 'cache', 'openai-curated')));
    assert.ok(r.linked.includes('skills/one'));
    assert.ok(r.linked.includes('plugins/cache/openai-curated'));
    assert.ok(r.conflicts.includes('skills/two'));
    assert.ok(!exists(path.join(def, 'skills', 'mine')));
    assert.equal(read(path.join(acc, 'skills', '.system', 'y')), 'own system');
    assert.ok(!exists(path.join(acc, 'plugins', 'cache', 'openai-curated-remote')));
    assert.ok(!exists(path.join(acc, 'plugins', 'config.json')));

    fs.rmSync(path.join(def, 'skills', 'one'), { recursive: true });
    r = ensureCodexLinks(acc);
    assert.ok(!exists(path.join(acc, 'skills', 'one')));
    assert.ok(exists(path.join(acc, 'skills', 'mine')));
  });

  test('replaces whole-folder skills / plugins links to the default by per-child links', () => {
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', '.system', 'x'), 's');
    write(path.join(def, 'plugins', 'cache', 'c', 'f'), 'c');
    write(path.join(def, 'plugins', 'config.json'), '{}');
    const acc = newAccount('a');
    fs.symlinkSync(path.join(def, 'skills'), path.join(acc, 'skills'));
    fs.symlinkSync(path.join(def, 'plugins'), path.join(acc, 'plugins'));
    const r = ensureCodexLinks(acc);
    assert.deepEqual(r.conflicts, []);
    assert.ok(fs.lstatSync(path.join(acc, 'skills')).isDirectory());
    assert.ok(fs.lstatSync(path.join(acc, 'plugins')).isDirectory());
    assert.ok(isLinkTo(path.join(acc, 'skills', 'one'), path.join(def, 'skills', 'one')));
    assert.ok(isLinkTo(path.join(acc, 'plugins', 'cache', 'c'), path.join(def, 'plugins', 'cache', 'c')));
    assert.ok(!exists(path.join(acc, 'skills', '.system')));
    assert.equal(read(path.join(def, 'skills', '.system', 'x')), 's');
    assert.equal(read(path.join(def, 'plugins', 'config.json')), '{}');
  });

  test('a real history / session index in a shared account is merged back and relinked', () => {
    write(path.join(def, 'history.jsonl'), '{"d":1}\n{"d":2}');
    write(path.join(def, 'session_index.jsonl'), '{"s":1}\n');
    const acc = newAccount('a');
    ensureCodexLinks(acc);
    // Codex rewrote the files by rename
    fs.unlinkSync(path.join(acc, 'history.jsonl'));
    write(path.join(acc, 'history.jsonl'), '{"d":1}\n{"d":2}\n{"a":1}\n{"a":1}\n{"a":2}\n');
    fs.unlinkSync(path.join(acc, 'session_index.jsonl'));
    write(path.join(acc, 'session_index.jsonl'), '{"s":1}\n');
    const r = ensureCodexLinks(acc);
    assert.deepEqual(r.linked.sort(), ['history.jsonl', 'session_index.jsonl']);
    assert.deepEqual(r.conflicts, []);
    assert.equal(read(path.join(def, 'history.jsonl')), '{"d":1}\n{"d":2}\n{"a":1}\n{"a":2}\n');
    assert.equal(read(path.join(def, 'session_index.jsonl')), '{"s":1}\n');
    assert.ok(isLinkTo(path.join(acc, 'history.jsonl'), path.join(def, 'history.jsonl')));
    assert.ok(isLinkTo(path.join(acc, 'session_index.jsonl'), path.join(def, 'session_index.jsonl')));
  });

  test('a real sqlite db in a shared account is a conflict and stays untouched', () => {
    const acc = newAccount('a');
    ensureCodexLinks(acc);
    fs.rmSync(path.join(acc, 'state_5.sqlite'), { force: true });   // the link (none on Windows)
    write(path.join(acc, 'state_5.sqlite'), 'db');
    const r = ensureCodexLinks(acc);
    // Windows does not link databases at all, so an account's own one is expected there
    assert.deepEqual(r.conflicts, onWindows ? [] : ['state_5.sqlite']);
    assert.equal(read(path.join(acc, 'state_5.sqlite')), 'db');
    assert.ok(!exists(path.join(def, 'state_5.sqlite')));
  });

  test('default dir → empty report, nothing written', () => {
    assert.deepEqual(ensureCodexLinks(def), { linked: [], created: [], conflicts: [], refused: [] });
    assert.deepEqual(fs.readdirSync(def), []);
  });
});

describe('isSharedCodexAccount', SHARING, () => {
  test('true only when sessions links to the default sessions', () => {
    const acc = newAccount('a');
    assert.equal(isSharedCodexAccount(acc), false);
    ensureCodexLinks(acc);
    assert.equal(isSharedCodexAccount(acc), true);
    assert.equal(isSharedCodexAccount(def), false);
    const b = codexAccountDir('b');
    fs.mkdirSync(path.join(b, 'sessions'), { recursive: true });
    assert.equal(isSharedCodexAccount(b), false);
    fs.mkdirSync(path.join(home, 'other'));
    const c = newAccount('c');
    fs.symlinkSync(path.join(home, 'other'), path.join(c, 'sessions'));
    assert.equal(isSharedCodexAccount(c), false);
  });

  test('a shared account stays shared while the default sessions folder is missing, and the refresh recreates it', () => {
    const acc = newAccount('dangling');
    ensureCodexLinks(acc);
    fs.rmSync(path.join(def, 'sessions'), { recursive: true });
    assert.equal(fs.existsSync(path.join(acc, 'sessions')), false, 'the link dangles');
    assert.equal(isSharedCodexAccount(acc), true);
    const other = newAccount('elsewhere');
    fs.symlinkSync(path.join(home, 'gone'), path.join(other, 'sessions'));
    assert.equal(isSharedCodexAccount(other), false);
    ensureCodexLinks(acc);
    assert.ok(fs.statSync(path.join(def, 'sessions')).isDirectory());
    assert.equal(isSharedCodexAccount(acc), true);
  });
});

// Fake /proc: <root>/<pid>/exe (link) and <root>/<pid>/environ
function fakeProc(procs: Record<number, { exe?: string; env: Record<string, string> }>): string {
  const root = path.join(home, 'fakeproc');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'self'));
  for (const [pid, { exe, env }] of Object.entries(procs)) {
    write(path.join(root, pid, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    if (exe) fs.symlinkSync(exe, path.join(root, pid, 'exe'));
  }
  return root;
}
const CODEX_EXE = '/opt/codex/vendor/x86_64-unknown-linux-musl/codex/codex';

describe('codexAccountBusy', LINUX_ONLY, () => {
  test('matches codex processes by exe basename and CODEX_HOME', () => {
    const acc = newAccount('a');
    assert.equal(codexAccountBusy(acc, fakeProc({})), false);
    assert.equal(codexAccountBusy(acc, fakeProc({ 10: { exe: CODEX_EXE, env: { CODEX_HOME: acc } } })), true);
    assert.equal(codexAccountBusy(acc, fakeProc({ 10: { exe: `${CODEX_EXE} (deleted)`, env: { CODEX_HOME: acc } } })), true);
    // Another account, or a shell / MCP child inheriting CODEX_HOME, or no readable exe
    assert.equal(codexAccountBusy(acc, fakeProc({ 10: { exe: CODEX_EXE, env: { CODEX_HOME: codexAccountDir('b') } } })), false);
    assert.equal(codexAccountBusy(acc, fakeProc({ 10: { exe: '/usr/bin/bash', env: { CODEX_HOME: acc } } })), false);
    assert.equal(codexAccountBusy(acc, fakeProc({ 10: { exe: '/usr/bin/node', env: { CODEX_HOME: acc } } })), false);
    assert.equal(codexAccountBusy(acc, fakeProc({ 10: { env: { CODEX_HOME: acc } } })), false);
    // A link to the account dir resolves to it
    fs.symlinkSync(acc, path.join(home, 'alias'));
    assert.equal(codexAccountBusy(acc, fakeProc({ 10: { exe: CODEX_EXE, env: { CODEX_HOME: path.join(home, 'alias') } } })), true);
    // Default dir: unset / empty / ~/.codex
    assert.equal(codexAccountBusy(def, fakeProc({ 20: { exe: CODEX_EXE, env: { PATH: '/bin' } } })), true);
    assert.equal(codexAccountBusy(def, fakeProc({ 20: { exe: CODEX_EXE, env: { CODEX_HOME: '' } } })), true);
    assert.equal(codexAccountBusy(def, fakeProc({ 20: { exe: CODEX_EXE, env: { CODEX_HOME: def } } })), true);
    assert.equal(codexAccountBusy(def, fakeProc({ 20: { exe: CODEX_EXE, env: { CODEX_HOME: acc } } })), false);
    // An unset CODEX_HOME never matches a named account
    assert.equal(codexAccountBusy(acc, fakeProc({ 20: { exe: CODEX_EXE, env: { PATH: '/bin' } } })), false);
    // Missing procRoot: a running Codex cannot be ruled out
    assert.equal(codexAccountBusy(acc, path.join(home, 'noproc')), true);
  });

  test('a live app-server daemon makes the account busy', () => {
    const acc = newAccount('a');
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]);
    write(path.join(acc, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: process.pid, processIdentity: { startTicks } }));
    assert.equal(codexAccountBusy(acc, fakeProc({})), true);
  });
});

describe('codexAccountBusy on Windows', { skip: !onWindows && 'Windows behavior' }, () => {
  test('only the account daemon counts, not every running codex.exe', () => {
    const acc = newAccount('a');
    assert.equal(codexAccountBusy(acc), false);
    write(path.join(acc, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: process.pid }));
    assert.equal(codexAccountBusy(acc), true);
  });
});

describe('migrateCodexToShared', SHARING, () => {
  test('relative links keep external and migrated targets when the default directory is relocated', async () => {
    const relocated = path.join(home, 'profiles', 'main');
    fs.mkdirSync(path.dirname(relocated), { recursive: true });
    fs.renameSync(def, relocated);
    fs.symlinkSync(relocated, def, 'junction');
    const acc = newAccount('work');
    const target = path.join(home, 'dotfiles', 'agent.md');
    write(target, 'external agent');
    write(path.join(acc, 'AGENTS.md'), 'account instructions');
    fs.mkdirSync(path.join(acc, 'agents'));
    fs.symlinkSync(path.join('..', '..', 'dotfiles', 'agent.md'), path.join(acc, 'agents', 'custom.md'), 'file');
    fs.symlinkSync(path.join('..', 'AGENTS.md'), path.join(acc, 'agents', 'instructions.md'), 'file');

    const report = migrateCodexToShared(acc, 'work', fakeProc({}));

    assert.equal(isSharedCodexAccount(acc), true);
    assert.deepEqual(report.conflicts, []);
    assert.ok(fs.lstatSync(path.join(def, 'agents', 'custom.md')).isSymbolicLink());
    assert.ok(sameRealPath(path.join(def, 'agents', 'custom.md'), target));
    assert.equal(read(path.join(acc, 'agents', 'custom.md')), 'external agent');
    await deleteCodexDir(acc);
    assert.equal(read(path.join(def, 'agents', 'instructions.md')), 'account instructions');
    assert.equal(read(path.join(def, 'agents', 'custom.md')), 'external agent');
    assert.equal(read(target), 'external agent');
  });

  test('a config.toml / AGENTS.md the default lacks is moved into the default instead of being backed up', () => {
    const acc = newAccount('solo');
    write(path.join(acc, 'config.toml'), 'model = "gpt"\n');
    write(path.join(acc, 'AGENTS.md'), 'acc rules');
    const r = migrateCodexToShared(acc, 'solo', fakeProc({}));
    assert.deepEqual(r.backups, []);
    assert.equal(read(path.join(def, 'config.toml')), 'model = "gpt"\n');
    assert.equal(read(path.join(def, 'AGENTS.md')), 'acc rules');
    assert.ok(isLinkTo(path.join(acc, 'config.toml'), path.join(def, 'config.toml')));
  });

  test('an account config.toml with identity keys is never moved into a default that lacks one', () => {
    const acc = newAccount('keyed');
    write(path.join(acc, 'config.toml'), 'forced_chatgpt_workspace_id = "x"\n');
    migrateCodexToShared(acc, 'keyed', fakeProc({}));
    assert.equal(read(path.join(acc, 'config.toml')), 'forced_chatgpt_workspace_id = "x"\n');
    assert.ok(!fs.lstatSync(path.join(acc, 'config.toml')).isSymbolicLink());
    assert.ok(!read(path.join(def, 'config.toml')).includes('forced_chatgpt_workspace_id'));
  });

  test('merges into the default dir, keeps identity and untouched entries, ends shared', () => {
    write(path.join(def, 'sessions', '2026', 'same.jsonl'), 'same');
    write(path.join(def, 'sessions', '2026', 'diff.jsonl'), 'def');
    write(path.join(def, 'history.jsonl'), '{"d":1}\n');
    write(path.join(def, 'session_index.jsonl'), '{"s":1}');
    write(path.join(def, 'config.toml'), 'model = "d"\n');
    write(path.join(def, 'AGENTS.md'), 'def rules');
    write(path.join(def, 'skills', 'shared', 'SKILL.md'), 'S');
    write(path.join(def, 'plugins', 'cache', 'p', 'f'), 'P');

    const acc = codexAccountDir('xn');
    write(path.join(acc, 'sessions', '2026', 'same.jsonl'), 'same');
    write(path.join(acc, 'sessions', '2026', 'diff.jsonl'), 'acc');
    write(path.join(acc, 'sessions', '2026', 'new.jsonl'), 'new');
    write(path.join(acc, 'archived_sessions', 'old.jsonl'), 'old');
    write(path.join(acc, 'history.jsonl'), '{"d":1}\n{"a":1}\n{"a":2}');
    write(path.join(acc, 'session_index.jsonl'), '{"s":2}\n');
    write(path.join(acc, 'config.toml'), 'model = "a"\n');
    write(path.join(acc, 'AGENTS.md'), 'def rules');
    write(path.join(acc, 'skills', 'mine', 'SKILL.md'), 'M');
    write(path.join(acc, 'skills', '.system', 'x'), 'sys');
    write(path.join(acc, 'plugins', 'cache', 'q', 'f'), 'Q');
    write(path.join(acc, 'plugins', 'cache', 'openai-curated-remote', 'r'), 'R');
    write(path.join(acc, 'plugins', 'config.json'), 'own plugins');
    write(path.join(acc, 'auth.json'), '{"tokens":{}}');
    write(path.join(acc, 'memories', 'm.md'), 'memory');
    write(path.join(acc, 'memories_1.sqlite'), 'mem db');
    write(path.join(acc, 'logs_2.sqlite'), 'logs');
    write(path.join(acc, 'models_cache.json'), '{}');
    write(path.join(acc, '.tmp', 'rollout-maintenance.lock'), '');
    write(path.join(acc, '.tmp', 'other'), 'o');
    fs.chmodSync(path.join(acc, 'memories', 'm.md'), 0o640);
    const memMtime = fs.statSync(path.join(acc, 'memories', 'm.md')).mtimeMs;

    const r = migrateCodexToShared(acc, 'xn', fakeProc({}));
    // new.jsonl, old.jsonl, history.jsonl, session_index.jsonl, skills/mine/SKILL.md, plugins/cache/q/f
    assert.equal(r.moved, 7);   // includes the maintenance lock the default lacked
    assert.equal(r.duplicates, 2);   // same.jsonl, AGENTS.md
    assert.deepEqual(r.keptBoth, ['sessions/2026/diff.jsonl.from-xn']);
    assert.deepEqual(r.backups.sort(), ['config.toml.independent-backup']);
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.refused, []);

    assert.equal(read(path.join(def, 'sessions', '2026', 'new.jsonl')), 'new');
    assert.equal(read(path.join(def, 'sessions', '2026', 'diff.jsonl')), 'def');
    assert.equal(read(path.join(def, 'sessions', '2026', 'diff.jsonl.from-xn')), 'acc');
    assert.equal(read(path.join(def, 'archived_sessions', 'old.jsonl')), 'old');
    assert.equal(read(path.join(def, 'history.jsonl')), '{"d":1}\n{"a":1}\n{"a":2}\n');
    assert.equal(read(path.join(def, 'session_index.jsonl')), '{"s":1}\n{"s":2}\n');
    assert.equal(read(path.join(def, 'config.toml')), 'model = "d"\n');
    assert.equal(read(path.join(acc, 'config.toml.independent-backup')), 'model = "a"\n');
    assert.equal(read(path.join(def, 'skills', 'mine', 'SKILL.md')), 'M');
    assert.equal(read(path.join(def, 'plugins', 'cache', 'q', 'f'), ), 'Q');
    assert.ok(!exists(path.join(def, 'skills', '.system')));
    assert.ok(!exists(path.join(def, 'plugins', 'cache', 'openai-curated-remote')));
    assert.ok(!exists(path.join(def, 'plugins', 'config.json')));

    // Never touched
    assert.equal(read(path.join(acc, 'auth.json')), '{"tokens":{}}');
    assert.ok(!exists(path.join(def, 'auth.json')));
    assert.equal(read(path.join(acc, 'memories', 'm.md')), 'memory');
    assertMode(path.join(acc, 'memories', 'm.md'), '640');
    assert.equal(fs.statSync(path.join(acc, 'memories', 'm.md')).mtimeMs, memMtime);
    assert.ok(!exists(path.join(def, 'memories')));
    assert.equal(read(path.join(acc, 'memories_1.sqlite')), 'mem db');
    assert.equal(read(path.join(acc, 'logs_2.sqlite')), 'logs');
    assert.equal(read(path.join(acc, 'models_cache.json')), '{}');
    assert.equal(read(path.join(acc, '.tmp', 'other')), 'o');
    assert.equal(read(path.join(acc, 'skills', '.system', 'x')), 'sys');
    assert.equal(read(path.join(acc, 'plugins', 'cache', 'openai-curated-remote', 'r')), 'R');
    assert.equal(read(path.join(acc, 'plugins', 'config.json')), 'own plugins');

    for (const e of ['sessions', 'archived_sessions', 'history.jsonl', 'session_index.jsonl', 'config.toml', 'AGENTS.md', 'state_5.sqlite', '.tmp/rollout-maintenance.lock'].filter(linkedHere)) {
      assert.ok(isLinkTo(path.join(acc, e), path.join(def, e)), e);
    }
    assert.ok(isLinkTo(path.join(acc, 'skills', 'mine'), path.join(def, 'skills', 'mine')));
    assert.ok(isLinkTo(path.join(acc, 'skills', 'shared'), path.join(def, 'skills', 'shared')));
    assert.ok(isLinkTo(path.join(acc, 'plugins', 'cache', 'p'), path.join(def, 'plugins', 'cache', 'p')));
    assert.ok(isLinkTo(path.join(acc, 'plugins', 'cache', 'q'), path.join(def, 'plugins', 'cache', 'q')));
    assert.equal(isSharedCodexAccount(acc), true);
  });

  test('sqlite dbs are backed up with their -wal / -shm files, then linked', LINUX_ONLY, () => {
    write(path.join(def, 'state_5.sqlite'), 'def db');
    const acc = codexAccountDir('a');
    write(path.join(acc, 'state_5.sqlite'), 'acc db');
    write(path.join(acc, 'state_5.sqlite-wal'), 'wal');
    write(path.join(acc, 'state_5.sqlite-shm'), 'shm');
    write(path.join(acc, 'goals_1.sqlite'), 'goals');
    write(path.join(acc, 'goals_1.sqlite.independent-backup-shm'), 'older');
    const r = migrateCodexToShared(acc, 'a', fakeProc({}));
    assert.deepEqual(r.backups.sort(), [
      'goals_1.sqlite.independent-backup-2',
      'state_5.sqlite.independent-backup', 'state_5.sqlite.independent-backup-shm', 'state_5.sqlite.independent-backup-wal',
    ]);
    assert.equal(read(path.join(acc, 'state_5.sqlite.independent-backup')), 'acc db');
    assert.equal(read(path.join(acc, 'state_5.sqlite.independent-backup-wal')), 'wal');
    assert.equal(read(path.join(acc, 'state_5.sqlite.independent-backup-shm')), 'shm');
    assert.equal(read(path.join(acc, 'goals_1.sqlite.independent-backup-2')), 'goals');
    assert.ok(!exists(path.join(acc, 'state_5.sqlite-wal')));
    assert.ok(!exists(path.join(acc, 'state_5.sqlite-shm')));
    assert.ok(isLinkTo(path.join(acc, 'state_5.sqlite'), path.join(def, 'state_5.sqlite')));
    assert.ok(isLinkTo(path.join(acc, 'goals_1.sqlite'), path.join(def, 'goals_1.sqlite')));
    assert.equal(read(path.join(def, 'state_5.sqlite')), 'def db');
    assert.ok(!exists(path.join(def, 'goals_1.sqlite')));
    assert.deepEqual(r.conflicts, []);
  });

  test('config.toml stays when the default config cannot be shared; missing history created 0600', () => {
    write(path.join(def, 'config.toml'), 'sqlite_home = "/srv/codex"\n');
    const acc = codexAccountDir('a');
    write(path.join(acc, 'config.toml'), 'model = "a"\n');
    write(path.join(acc, 'history.jsonl'), '{"a":1}');
    const r = migrateCodexToShared(acc, 'a', fakeProc({}));
    assert.deepEqual(r.refused, ['config.toml']);
    assert.deepEqual(r.backups, []);
    assert.equal(read(path.join(acc, 'config.toml')), 'model = "a"\n');
    assert.equal(read(path.join(def, 'history.jsonl')), '{"a":1}\n');
    assertMode(path.join(def, 'history.jsonl'), '600');
  });

  test('jsonl files whose lines the default already has do not count as moved', () => {
    write(path.join(def, 'history.jsonl'), '{"d":1}\n{"d":2}\n');
    write(path.join(def, 'session_index.jsonl'), '{"s":1}\n');
    const acc = newAccount('a');
    write(path.join(acc, 'history.jsonl'), '{"d":2}\n');
    write(path.join(acc, 'session_index.jsonl'), '{"s":1}\n{"s":2}\n');
    const r = migrateCodexToShared(acc, 'a', fakeProc({}));
    assert.equal(r.moved, 1, 'only session_index.jsonl received lines');
    assert.equal(read(path.join(def, 'history.jsonl')), '{"d":1}\n{"d":2}\n');
    assert.equal(read(path.join(def, 'session_index.jsonl')), '{"s":1}\n{"s":2}\n');
    assert.ok(isLinkTo(path.join(acc, 'history.jsonl'), path.join(def, 'history.jsonl')));
  });

  test('refuses while the account is busy; nothing moved', () => {
    const acc = codexAccountDir('a');
    write(path.join(acc, 'sessions', 'x.jsonl'), 'x');
    assert.throws(
      () => migrateCodexToShared(acc, 'a', fakeProc({ 7: { exe: CODEX_EXE, env: { CODEX_HOME: acc } } })),
      { message: t('share.busyCodex', { name: 'a' }) },
    );
    assert.equal(read(path.join(acc, 'sessions', 'x.jsonl')), 'x');
    assert.ok(!exists(path.join(def, 'sessions')));
  });

  test('refuses when the caller reports the account busy (terminal opened during the copy-fallback prompt); nothing moved', () => {
    const acc = codexAccountDir('a');
    write(path.join(acc, 'sessions', 'x.jsonl'), 'x');
    assert.throws(() => migrateCodexToShared(acc, 'a', fakeProc({}), { busy: () => true }), { message: t('share.busyCodex', { name: 'a' }) });
    assert.equal(read(path.join(acc, 'sessions', 'x.jsonl')), 'x');
    assert.ok(!exists(path.join(def, 'sessions')));
  });

  test('default dir → empty report', () => {
    const r = migrateCodexToShared(def, 'default', fakeProc({}));
    assert.deepEqual(r, { linked: [], created: [], conflicts: [], refused: [], moved: 0, duplicates: 0, keptBoth: [], backups: [] });
  });
});

describe('copyCodexIndependent', SHARING, () => {
  test('copies config without overwriting, never links, never copies auth', () => {
    write(path.join(def, 'config.toml'), 'model = "m"\n');
    write(path.join(def, 'AGENTS.md'), 'rules');
    fs.chmodSync(path.join(def, 'AGENTS.md'), 0o644);
    write(path.join(def, 'hooks.json'), '{"h":1}');
    write(path.join(def, 'rules', 'r.rules'), 'r');
    fs.symlinkSync(NOWHERE, path.join(def, 'rules', 'lnk'));
    write(path.join(def, 'hooks', 'h.sh'), 'h');
    write(path.join(def, 'agents', 'a.toml'), 'a');
    write(path.join(def, 'themes', 't.json'), 't');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', '.system', 'x'), 's');
    write(path.join(def, 'auth.json'), 'secret');
    write(path.join(def, 'sessions', 'x.jsonl'), 'x');

    const acc = codexAccountDir('a');
    write(path.join(acc, 'themes', 't.json'), 'own');
    const r = copyCodexIndependent(acc);
    assert.deepEqual(r.copied, ['config.toml', 'AGENTS.md', 'hooks.json', 'rules', 'hooks', 'agents', 'skills/one']);
    assert.deepEqual(r.skipped, []);
    assert.equal(read(path.join(acc, 'config.toml')), 'model = "m"\n');
    assert.equal(read(path.join(acc, 'AGENTS.md')), 'rules');
    assert.ok(!fs.lstatSync(path.join(acc, 'AGENTS.md')).isSymbolicLink());
    assertMode(path.join(acc, 'AGENTS.md'), '600');
    assertMode(path.join(acc, 'hooks.json'), '600');
    assert.equal(read(path.join(acc, 'rules', 'r.rules')), 'r');
    assert.equal(fs.readlinkSync(path.join(acc, 'rules', 'lnk')), NOWHERE);
    assert.equal(read(path.join(acc, 'themes', 't.json')), 'own');
    assert.equal(read(path.join(acc, 'skills', 'one', 'SKILL.md')), '1');
    assert.ok(!exists(path.join(acc, 'skills', '.system')));
    assert.ok(!exists(path.join(acc, 'auth.json')));
    assert.ok(!exists(path.join(acc, 'sessions')));

    // Second run copies nothing new; the seed reports the existing config
    const again = copyCodexIndependent(acc);
    assert.deepEqual(again.copied, []);
    assert.deepEqual(again.skipped.map((s) => s.file), ['config.toml']);
  });

  test('identity keys keep config.toml out (skipped with a reason)', () => {
    write(path.join(def, 'config.toml'), 'forced_chatgpt_workspace_id = "corp"\n');
    const acc = codexAccountDir('a');
    const r = copyCodexIndependent(acc);
    assert.deepEqual(r.copied, []);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /forced_chatgpt_workspace_id/);
    assert.ok(!exists(path.join(acc, 'config.toml')));
    assertMode(acc, '700');
  });
});

describe('copyCodexIndependent skills children', SHARING, () => {
  test('a linked skills child is copied from its real location; a dangling child link is skipped', () => {
    write(path.join(home, 'dotfiles', 'skill', 'SKILL.md'), 'real');
    fs.mkdirSync(path.join(def, 'skills'));
    fs.symlinkSync(path.join(home, 'dotfiles', 'skill'), path.join(def, 'skills', 'linked'));
    fs.symlinkSync(path.join(home, 'missing'), path.join(def, 'skills', 'gone'));
    const acc = newAccount('a');
    const r = copyCodexIndependent(acc);
    assert.ok(r.copied.includes('skills/linked'));
    assert.ok(!r.copied.includes('skills/gone'));
    assert.ok(fs.lstatSync(path.join(acc, 'skills', 'linked')).isDirectory());
    assert.equal(read(path.join(acc, 'skills', 'linked', 'SKILL.md')), 'real');
    assert.ok(!exists(path.join(acc, 'skills', 'gone')));
  });
});

describe('makeCodexIndependent', SHARING, () => {
  test('removes the links (dangling sqlite links too), copies the config once, leaves the default dir alone', () => {
    write(path.join(def, 'config.toml'), 'model = "m"\n');
    write(path.join(def, 'AGENTS.md'), 'rules');
    write(path.join(def, 'hooks.json'), '{"h":1}');
    write(path.join(def, 'rules', 'r.rules'), 'r');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'skills', '.system', 'x'), 's');
    write(path.join(def, 'plugins', 'cache', 'p', 'f'), 'P');
    write(path.join(def, 'history.jsonl'), '{"d":1}\n');
    write(path.join(def, 'sessions', '2026', 'x.jsonl'), 'x');
    write(path.join(def, 'auth.json'), 'def secret');
    const acc = newAccount('a');
    ensureCodexLinks(acc);
    for (const name of LINK_ONLY) assert.ok(!fs.existsSync(path.join(acc, name)), `${name} dangles`);
    write(path.join(acc, 'auth.json'), 'secret');
    write(path.join(acc, 'memories', 'm.md'), 'mem');
    write(path.join(acc, 'skills', 'mine', 'SKILL.md'), 'M');
    const before = snapshot(def);

    const r = makeCodexIndependent(acc, 'a', fakeProc({}));
    assert.equal(isSharedCodexAccount(acc), false);
    for (const { name } of LINKED_ENTRIES) assert.ok(r.removed.includes(name), name);
    assert.ok(r.removed.includes('skills/one'));
    assert.ok(r.removed.includes('plugins/cache/p'));
    assert.ok(!r.removed.includes('skills/mine'));
    // The config folders ensureCodexLinks created empty in the default dir are copied as empty folders
    assert.deepEqual(r.copied, ['config.toml', 'AGENTS.md', 'hooks.json', 'rules', 'hooks', 'agents', 'themes', 'skills/one']);
    assert.deepEqual(r.skipped, []);
    for (const e of fs.readdirSync(acc, { recursive: true }) as string[]) {
      assert.ok(!fs.lstatSync(path.join(acc, e)).isSymbolicLink(), `${e} is still a link`);
    }
    for (const e of ['history.jsonl', 'session_index.jsonl', 'sessions', 'archived_sessions', ...LINK_ONLY]) {
      assert.ok(!exists(path.join(acc, e)), e);
    }
    assert.equal(read(path.join(acc, 'config.toml')), 'model = "m"\n');
    assert.equal(read(path.join(acc, 'AGENTS.md')), 'rules');
    assert.equal(read(path.join(acc, 'hooks.json')), '{"h":1}');
    assert.equal(read(path.join(acc, 'rules', 'r.rules')), 'r');
    assert.equal(read(path.join(acc, 'skills', 'one', 'SKILL.md')), '1');
    assert.equal(read(path.join(acc, 'skills', 'mine', 'SKILL.md')), 'M');
    assert.ok(!exists(path.join(acc, 'skills', '.system')));
    assert.deepEqual(fs.readdirSync(path.join(acc, 'plugins', 'cache')), []);
    assert.ok(fs.lstatSync(path.join(acc, '.tmp')).isDirectory());
    assert.equal(read(path.join(acc, 'auth.json')), 'secret');
    assert.equal(read(path.join(acc, 'memories', 'm.md')), 'mem');
    assert.deepEqual(snapshot(def), before);
  });

  test('an entry the account replaced by a real file or a link elsewhere is kept', () => {
    write(path.join(def, 'AGENTS.md'), 'rules');
    fs.mkdirSync(path.join(home, 'elsewhere'));
    const acc = newAccount('a');
    ensureCodexLinks(acc);
    fs.unlinkSync(path.join(acc, 'AGENTS.md'));
    write(path.join(acc, 'AGENTS.md'), 'own');
    fs.unlinkSync(path.join(acc, 'rules'));
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(acc, 'rules'));
    const r = makeCodexIndependent(acc, 'a', fakeProc({}));
    assert.ok(!r.removed.includes('AGENTS.md'));
    assert.ok(!r.removed.includes('rules'));
    assert.ok(!r.copied.includes('AGENTS.md'));
    assert.equal(read(path.join(acc, 'AGENTS.md')), 'own');
    assert.equal(fs.readlinkSync(path.join(acc, 'rules')), path.join(home, 'elsewhere'));
    assert.equal(isSharedCodexAccount(acc), false);
    assert.equal(read(path.join(def, 'AGENTS.md')), 'rules');
  });

  test('a whole-folder skills link from an earlier version is removed as one entry; a linked .tmp is not followed', () => {
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'sessions', 'x.jsonl'), 'x');
    fs.mkdirSync(path.join(def, '.tmp'));
    const acc = newAccount('legacy');
    ensureCodexLinks(acc);
    fs.rmSync(path.join(acc, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(def, 'skills'), path.join(acc, 'skills'));
    fs.rmSync(path.join(acc, '.tmp'), { recursive: true });
    fs.symlinkSync(path.join(def, '.tmp'), path.join(acc, '.tmp'));
    const before = snapshot(def);
    const r = makeCodexIndependent(acc, 'a', fakeProc({}));
    assert.ok(r.removed.includes('skills'));
    assert.ok(!r.removed.includes('skills/one'));
    assert.ok(!r.removed.includes('.tmp/rollout-maintenance.lock'));
    assert.ok(fs.lstatSync(path.join(acc, '.tmp')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(acc, 'skills')).isDirectory());
    assert.equal(read(path.join(acc, 'skills', 'one', 'SKILL.md')), '1');
    assert.deepEqual(snapshot(def), before);
  });

  test('a failed copy leaves the account shared: the sessions marker and the database links are still there', LINUX_ONLY, () => {
    if (process.getuid?.() === 0) return;   // root ignores directory permissions
    write(path.join(def, 'config.toml'), 'model = "m"\n');
    write(path.join(def, 'AGENTS.md'), 'rules');
    write(path.join(def, 'sessions', 'x.jsonl'), 'x');
    const acc = newAccount('half');
    ensureCodexLinks(acc);
    fs.chmodSync(path.join(def, 'AGENTS.md'), 0o000);   // copying AGENTS.md fails with EACCES after the config.toml seed
    try {
      assert.throws(() => makeCodexIndependent(acc, 'a', fakeProc({})), /EACCES/);
    } finally {
      fs.chmodSync(path.join(def, 'AGENTS.md'), 0o600);
    }
    assert.equal(isSharedCodexAccount(acc), true);
    assert.ok(fs.lstatSync(path.join(acc, 'state_5.sqlite')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(acc, 'history.jsonl')).isSymbolicLink());
    assert.equal(read(path.join(acc, 'config.toml')), 'model = "m"\n');   // already copied
  });

  test('refuses while the account is busy, like migrateCodexToShared; still shared', () => {
    write(path.join(def, 'config.toml'), 'model = "m"\n');
    const acc = newAccount('a');
    ensureCodexLinks(acc);
    const before = snapshot(acc);
    assert.throws(
      () => makeCodexIndependent(acc, 'a', fakeProc({ 7: { exe: CODEX_EXE, env: { CODEX_HOME: acc } } })),
      { message: t('share.busyCodex', { name: 'a' }) },
    );
    assert.equal(isSharedCodexAccount(acc), true);
    assert.deepEqual(snapshot(acc), before);
  });

  test('throws for the default dir and for an independent account; nothing written', () => {
    write(path.join(def, 'AGENTS.md'), 'rules');
    const acc = newAccount('a');
    write(path.join(acc, 'sessions', 'x.jsonl'), 'x');
    const proc = fakeProc({});
    const before = snapshot(home);
    assert.throws(() => makeCodexIndependent(def, 'default', proc), { message: t('unshare.default', { dir: def }) });
    assert.throws(() => makeCodexIndependent(acc, 'a', proc), { message: t('unshare.notShared', { dir: acc }) });
    assert.deepEqual(snapshot(home), before);
  });
});

describe('deleteCodexDir on a shared account', () => {
  test('removes the links only; the default content survives', async () => {
    write(path.join(def, 'sessions', '2026', 'x.jsonl'), 'x');
    write(path.join(def, 'AGENTS.md'), 'rules');
    write(path.join(def, 'state_5.sqlite'), 'db');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), '1');
    write(path.join(def, 'plugins', 'cache', 'p', 'f'), 'P');
    const acc = newAccount('a');
    ensureCodexLinks(acc);
    write(path.join(acc, 'auth.json'), 'secret');
    // No live daemon in the account (checkCodexSafeToDelete refuses otherwise)
    await deleteCodexDir(acc);
    assert.ok(!exists(acc));
    assert.equal(read(path.join(def, 'sessions', '2026', 'x.jsonl')), 'x');
    assert.equal(read(path.join(def, 'AGENTS.md')), 'rules');
    assert.equal(read(path.join(def, 'state_5.sqlite')), 'db');
    assert.equal(read(path.join(def, 'skills', 'one', 'SKILL.md')), '1');
    assert.equal(read(path.join(def, 'plugins', 'cache', 'p', 'f')), 'P');
    assert.ok(exists(path.join(def, 'history.jsonl')));
    assert.ok(exists(path.join(def, '.tmp')));
  });
});
