// Data-safety regressions from the audit: deletion of a folder that contains the default account, the settings.json
// identity guard, busy guards of the merge-back steps, compare-then-rename, deep links before a delete, BOMs in
// .claude.json and the copy-to-link upgrade
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fsModule from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import {
  accountDir, checkSafeToDelete, deleteAccountDir, readAccountInfo, realPath, realPathInside, scanAccountDirs, syncMcpServers,
} from '../src/paths';
import { checkCodexSafeToDelete, codexAccountDir, deleteCodexDir, scanCodexDirs } from '../src/codex/codexPaths';
import { ensureClaudeLinks, linkEntry, mirrorClaudeJson } from '../src/claudeShare';
import { ensureCodexLinks } from '../src/codex/codexShare';
import { renameReplacing, unlinkLinks } from '../src/platform';
import { assertTempHome, FILE_SYMLINKS, makeTempHome, onWindows, SHARING, read, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;

before(() => {
  tmp = makeTempHome('audit');
  home = tmp.home;
  setLocale('en');
});
after(() => tmp.restore());

beforeEach(() => {
  assertTempHome(home);
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
});

const write = (f: string, content: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
// Directory links as junctions: no privilege needed on Windows, the type is ignored elsewhere
const junction = (target: string, link: string): void => fs.symlinkSync(target, link, 'junction');
const BOM = '﻿';

describe('deletion refuses a folder that contains the default account', () => {
  test('realPathInside: strictly below after resolving links; siblings with a common prefix are not inside', () => {
    const outer = path.join(home, 'outer');
    fs.mkdirSync(path.join(outer, 'inner'), { recursive: true });
    fs.mkdirSync(path.join(home, 'outer2'));
    assert.equal(realPathInside(outer, path.join(outer, 'inner')), true);
    assert.equal(realPathInside(outer, outer), false);
    assert.equal(realPathInside(outer, path.join(home, 'outer2')), false);
    assert.equal(realPathInside(path.join(outer, 'inner'), outer), false);
    junction(path.join(outer, 'inner'), path.join(home, 'alias'));
    assert.equal(realPathInside(outer, path.join(home, 'alias')), true);
    if (onWindows) assert.equal(realPathInside(outer.toUpperCase(), path.join(outer, 'inner')), true);
  });

  test('Codex: ~/.codex is a junction into ~/.codex-foo, which is neither listed nor deleted', async () => {
    const foo = codexAccountDir('foo');
    write(path.join(foo, 'real', 'auth.json'), '{}');
    const def = path.join(home, '.codex');
    junction(path.join(foo, 'real'), def);
    fs.mkdirSync(codexAccountDir('bar'));
    assert.equal(checkCodexSafeToDelete(foo), t('del.containsDefault', { default: def, dir: foo }));
    await assert.rejects(deleteCodexDir(foo), { message: t('del.containsDefault', { default: def, dir: foo }) });
    assert.equal(read(path.join(foo, 'real', 'auth.json')), '{}');
    assert.deepEqual(scanCodexDirs().map((a) => a.name), ['bar']);
    assert.equal(checkCodexSafeToDelete(codexAccountDir('bar')), undefined);
  });

  test('Claude: CLAUDE_CONFIG_DIR inside ~/.claude-foo keeps that folder from being listed or deleted', async () => {
    const foo = accountDir('foo');
    const inner = path.join(foo, 'inner');
    write(path.join(inner, 'settings.json'), '{}');
    fs.mkdirSync(accountDir('bar'));
    process.env.CLAUDE_CONFIG_DIR = inner;
    try {
      assert.equal(checkSafeToDelete(foo), t('del.containsDefault', { default: inner, dir: foo }));
      await assert.rejects(deleteAccountDir(foo), { message: t('del.containsDefault', { default: inner, dir: foo }) });
      assert.equal(read(path.join(inner, 'settings.json')), '{}');
      assert.deepEqual(scanAccountDirs().map((a) => a.name), ['bar']);
      assert.equal(checkSafeToDelete(accountDir('bar')), undefined);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

describe('ensureClaudeLinks settings.json identity guard', SHARING, () => {
  test('a settings.json link is replaced by a stripped copy once the default settings gain identity keys', () => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'settings.json'), JSON.stringify({ model: 'x' }));
    const acc = accountDir('a');
    fs.mkdirSync(acc, { mode: 0o700 });
    assert.ok(ensureClaudeLinks(acc).linked.includes('settings.json'));
    assert.ok(fs.lstatSync(path.join(acc, 'settings.json')).isSymbolicLink());

    const withKey = JSON.stringify({ model: 'x', apiKeyHelper: 'h', env: { ANTHROPIC_API_KEY: 'k', FOO: '1' } });
    write(path.join(def, 'settings.json'), withKey);
    const r = ensureClaudeLinks(acc);
    assert.ok(r.refused.includes('settings.json'));
    const st = fs.lstatSync(path.join(acc, 'settings.json'));
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.deepEqual(JSON.parse(read(path.join(acc, 'settings.json'))), { model: 'x', env: { FOO: '1' } });
    assert.equal(read(path.join(def, 'settings.json')), withKey);
    // The account's own settings stay as they are on the next run
    write(path.join(acc, 'settings.json'), '{"model":"own"}');
    assert.ok(ensureClaudeLinks(acc).refused.includes('settings.json'));
    assert.equal(read(path.join(acc, 'settings.json')), '{"model":"own"}');
  });
});

// Fake /proc: <root>/<pid>/exe (link) and <root>/<pid>/environ
function fakeProc(procs: Record<number, { exe: string; env: Record<string, string> }>): string {
  const root = path.join(home, 'fakeproc');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'self'), { recursive: true });
  for (const [pid, { exe, env }] of Object.entries(procs)) {
    write(path.join(root, pid, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    fs.symlinkSync(exe, path.join(root, pid, 'exe'));
  }
  return root;
}
const CODEX_EXE = '/opt/codex/codex';

describe('busy guards of the merge-back steps', SHARING, () => {
  test('ensureClaudeLinks leaves a real history.jsonl alone while the caller reports the account busy', () => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'history.jsonl'), '{"a":1}\n');
    const acc = accountDir('h');
    fs.mkdirSync(acc, { mode: 0o700 });
    const proc = fakeProc({});
    ensureClaudeLinks(acc, proc);
    fs.unlinkSync(path.join(acc, 'history.jsonl'));
    write(path.join(acc, 'history.jsonl'), '{"b":2}\n');
    let calls = 0;
    const r = ensureClaudeLinks(acc, proc, { busy: () => (calls++, true) });
    assert.deepEqual(r.busy, ['history.jsonl']);
    assert.equal(calls, 1);
    assert.equal(read(path.join(acc, 'history.jsonl')), '{"b":2}\n');
    assert.equal(read(path.join(def, 'history.jsonl')), '{"a":1}\n');
    const later = ensureClaudeLinks(acc, proc, { busy: () => false });
    assert.equal(later.busy, undefined);
    assert.ok(later.linked.includes('history.jsonl'));
    assert.equal(read(path.join(def, 'history.jsonl')), '{"a":1}\n{"b":2}\n');
  });

  test('ensureCodexLinks leaves real history / session index files alone while Codex uses the account', () => {
    const def = path.join(home, '.codex');
    fs.mkdirSync(def, { mode: 0o700 });
    write(path.join(def, 'history.jsonl'), '{"d":1}\n');
    write(path.join(def, 'session_index.jsonl'), '{"s":1}\n');
    const acc = codexAccountDir('a');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureCodexLinks(acc, {}, fakeProc({}));
    const replace = (): void => {
      for (const [f, c] of [['history.jsonl', '{"a":1}\n'], ['session_index.jsonl', '{"i":1}\n']]) {
        fs.rmSync(path.join(acc, f), { force: true });
        write(path.join(acc, f), c);
      }
    };
    const untouched = (r: ReturnType<typeof ensureCodexLinks>): void => {
      assert.deepEqual([...(r.busy ?? [])].sort(), ['history.jsonl', 'session_index.jsonl']);
      assert.ok(!r.linked.includes('history.jsonl') && !r.conflicts.includes('history.jsonl'));
      assert.ok(fs.lstatSync(path.join(acc, 'history.jsonl')).isFile());
      assert.equal(read(path.join(acc, 'history.jsonl')), '{"a":1}\n');
      assert.equal(read(path.join(acc, 'session_index.jsonl')), '{"i":1}\n');
      assert.equal(read(path.join(def, 'history.jsonl')), '{"d":1}\n');
      assert.equal(read(path.join(def, 'session_index.jsonl')), '{"s":1}\n');
    };
    replace();
    // A codex process with this CODEX_HOME
    untouched(ensureCodexLinks(acc, {}, fakeProc({ 7: { exe: CODEX_EXE, env: { CODEX_HOME: acc } } })));
    // The caller's own check (the account's terminal is open)
    let calls = 0;
    untouched(ensureCodexLinks(acc, { busy: () => (calls++, true) }, fakeProc({})));
    assert.equal(calls, 1);
    // Not busy: merged back and relinked as before
    const r = ensureCodexLinks(acc, { busy: () => false }, fakeProc({}));
    assert.equal(r.busy, undefined);
    assert.deepEqual(r.linked.filter((n) => n.endsWith('.jsonl')).sort(), ['history.jsonl', 'session_index.jsonl']);
    assert.equal(read(path.join(def, 'history.jsonl')), '{"d":1}\n{"a":1}\n');
    assert.equal(read(path.join(def, 'session_index.jsonl')), '{"s":1}\n{"i":1}\n');
  });
});

describe('renameReplacing re-checks before every attempt', () => {
  const busyOnce = (): { calls: string[]; rename: (a: string, b: string) => void } => {
    const calls: string[] = [];
    return {
      calls,
      rename: (a, b) => {
        calls.push(`${a}>${b}`);
        if (calls.length === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
    };
  };

  test('a change noticed before a retry stops without renaming', () => {
    const r = busyOnce();
    let checks = 0;
    assert.equal(renameReplacing('a', 'b', 'win32', r.rename, () => ++checks === 1), false);
    assert.equal(checks, 2);
    assert.deepEqual(r.calls, ['a>b']);
  });

  test('unchanged: renamed after the retry; a check that fails first never renames; Linux stays one attempt', () => {
    const r = busyOnce();
    let checks = 0;
    assert.equal(renameReplacing('a', 'b', 'win32', r.rename, () => (checks++, true)), true);
    assert.equal(checks, 2);
    assert.equal(r.calls.length, 2);
    const never = busyOnce();
    assert.equal(renameReplacing('a', 'b', 'win32', never.rename, () => false), false);
    assert.deepEqual(never.calls, []);
    const linux = busyOnce();
    assert.throws(() => renameReplacing('a', 'b', 'linux', linux.rename, () => true), /EBUSY/);
    assert.equal(linux.calls.length, 1);
  });

  test('mirrorClaudeJson and syncMcpServers still refuse a write made before the commit', () => {
    const def = path.join(home, '.claude');
    fs.mkdirSync(def);
    const from = path.join(home, '.claude.json');
    write(from, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('a');
    const file = path.join(acc, '.claude.json');
    write(file, '{"x":1}');
    const cli = (): void => fs.writeFileSync(file, '{"x":2}');
    assert.throws(() => mirrorClaudeJson(from, acc, cli), { message: t('mcp.changed', { file: realPath(file) }) });
    assert.equal(read(file), '{"x":2}');
    assert.throws(() => syncMcpServers(from, acc, () => fs.writeFileSync(file, '{"x":3}')), { message: t('mcp.changed', { file: realPath(file) }) });
    assert.equal(read(file), '{"x":3}');
    assert.deepEqual(fs.readdirSync(acc), ['.claude.json']);
  });
});

describe('unlinkLinks walks the whole tree', () => {
  // Removes the links anywhere below; runs with the Windows behavior on every platform (Linux links unlink the same way)
  test('a junction deep below the account is removed without touching its target', () => {
    const victim = path.join(home, 'victim');
    write(path.join(victim, 'keep.txt'), 'keep');
    const acc = path.join(home, 'acc');
    const deep = path.join(acc, 'a', 'b', 'c', 'd', 'e', 'f');
    write(path.join(deep, 'own.txt'), 'own');
    junction(victim, path.join(deep, 'j'));
    junction(victim, path.join(acc, 'top'));
    unlinkLinks(acc, 'win32');
    assert.ok(!exists(path.join(deep, 'j')));
    assert.ok(!exists(path.join(acc, 'top')));
    assert.equal(read(path.join(deep, 'own.txt')), 'own');
    assert.equal(read(path.join(victim, 'keep.txt')), 'keep');
    // Off Windows (the platform default) nothing happens: rm never follows links there
    junction(victim, path.join(deep, 'j'));
    unlinkLinks(acc, 'linux');
    assert.ok(exists(path.join(deep, 'j')));
  });

  test('deleteAccountDir and deleteCodexDir keep the default content behind a deep junction', async () => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'projects', 'p.jsonl'), 'p');
    const acc = accountDir('deep');
    const deep = path.join(acc, 'x', 'y', 'z', 'w');
    fs.mkdirSync(deep, { recursive: true });
    junction(path.join(def, 'projects'), path.join(deep, 'projects'));
    await deleteAccountDir(acc);
    assert.ok(!exists(acc));
    assert.equal(read(path.join(def, 'projects', 'p.jsonl')), 'p');

    const cdef = path.join(home, '.codex');
    write(path.join(cdef, 'sessions', 's.jsonl'), 's');
    const cacc = codexAccountDir('deep');
    const cdeep = path.join(cacc, 'x', 'y', 'z', 'w');
    fs.mkdirSync(cdeep, { recursive: true });
    junction(path.join(cdef, 'sessions'), path.join(cdeep, 'sessions'));
    await deleteCodexDir(cacc);
    assert.ok(!exists(cacc));
    assert.equal(read(path.join(cdef, 'sessions', 's.jsonl')), 's');
  });
});

describe('.claude.json with a UTF-8 byte order mark', () => {
  const oauth = { oauthAccount: { emailAddress: 'bom@example.com', organizationType: 'claude_pro' } };

  test('readAccountInfo reads it', () => {
    const acc = accountDir('b');
    write(path.join(acc, '.claude.json'), BOM + JSON.stringify(oauth));
    assert.deepEqual(readAccountInfo(acc), { email: 'bom@example.com', plan: 'Pro', loggedIn: true });
  });

  test('syncMcpServers and mirrorClaudeJson accept a target with a BOM and keep its keys', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    const from = path.join(home, '.claude.json');
    write(from, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('b');
    const file = path.join(acc, '.claude.json');
    write(file, BOM + JSON.stringify({ ...oauth, mcpServers: {} }));
    assert.deepEqual(syncMcpServers(from, acc).added, ['a']);
    assert.deepEqual(JSON.parse(read(file)), { ...oauth, mcpServers: { a: { command: 'a' } } });

    write(from, JSON.stringify({ mcpServers: { b: { command: 'b' } } }));
    write(file, BOM + JSON.stringify(oauth));
    assert.deepEqual(mirrorClaudeJson(from, acc).changed, ['mcpServers']);
    assert.deepEqual(JSON.parse(read(file)), { ...oauth, mcpServers: { b: { command: 'b' } } });
  });
});

describe('linkEntry copy-to-link upgrade (Windows)', { skip: (!onWindows && 'Windows only') || FILE_SYMLINKS.skip }, () => {
  test('the copy becomes a link, with no temporary name left', () => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'settings.json'), '{"m":1}');
    const acc = accountDir('w');
    write(path.join(acc, 'settings.json'), '{"m":1}');
    assert.equal(linkEntry(path.join(acc, 'settings.json'), path.join(def, 'settings.json')), 'linked');
    assert.ok(fs.lstatSync(path.join(acc, 'settings.json')).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(acc), ['settings.json']);
  });

  test('a failed link creation keeps the copy', () => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'settings.json'), '{"m":1}');
    const acc = accountDir('w');
    const copy = path.join(acc, 'settings.json');
    write(copy, '{"m":1}');
    const real = fsModule.symlinkSync;
    const m = mock.method(fsModule, 'symlinkSync', ((target: fs.PathLike, link: fs.PathLike, type?: fs.symlink.Type) => {
      if (String(link).startsWith(`${copy}.planswap-`)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      real(target, link, type);
    }) as typeof fs.symlinkSync);
    try {
      assert.throws(() => linkEntry(copy, path.join(def, 'settings.json')), /EIO/);
    } finally {
      m.mock.restore();
    }
    const st = fs.lstatSync(copy);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(read(copy), '{"m":1}');
    assert.deepEqual(fs.readdirSync(acc), ['settings.json']);
  });
});
