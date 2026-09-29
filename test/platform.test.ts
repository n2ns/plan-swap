// Pure helpers with injected runners: nothing here calls a real Windows API, and nothing writes outside a temporary HOME
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { setLocale } from '../src/i18n';
import { comparablePath, copyLink, createLink, imageRunning, isSupportedPlatform, parseTasklistCsv, pidAlive } from '../src/platform';
import { getUserCodexHome, parseRegQuery, setUserCodexHome } from '../src/codex/codexWindows';
import { manualRestartMessages } from '../src/codex/codexCommands';
import { makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
before(() => {
  setLocale('en');
  tmp = makeTempHome('platform');
});
after(() => tmp.restore());

describe('platform', () => {
  test('supported platforms are Linux and Windows only', () => {
    assert.equal(isSupportedPlatform('linux'), true);
    assert.equal(isSupportedPlatform('win32'), true);
    assert.equal(isSupportedPlatform('darwin'), false);
  });

  test('comparablePath ignores case only on Windows', () => {
    assert.equal(comparablePath('/A/b', 'linux'), path.resolve('/A/b'));
    assert.equal(comparablePath('/A/b', 'win32'), path.resolve('/A/b').toLowerCase());
  });

  test('createLink and copyLink create symlinks on Linux', () => {
    const target = path.join(tmp.home, 'target');
    fs.mkdirSync(target);
    const link = path.join(tmp.home, 'link');
    createLink(target, link, 'linux');
    assert.equal(fs.readlinkSync(link), target);
    const copy = path.join(tmp.home, 'copy');
    copyLink(link, copy, 'linux');
    assert.equal(fs.readlinkSync(copy), target);
  });

  test('pidAlive probes without signalling', () => {
    assert.equal(pidAlive(process.pid), true);
    // A pid that certainly no longer exists: a child that has already exited
    const done = spawnSync(process.execPath, ['-e', '0']);
    assert.equal(pidAlive(done.pid), false);
  });

  test('tasklist parsing and the fail-safe image probe', () => {
    const out = '"codex.exe","1234","Console","1","50,000 K"\r\n"Other.exe","5","Console","1","1 K"\r\n';
    assert.deepEqual(parseTasklistCsv(out), ['codex.exe', 'other.exe']);
    assert.equal(imageRunning('codex.exe', () => out), true);
    assert.equal(imageRunning('codex.exe', () => 'INFO: No tasks are running which match the specified criteria.\r\n'), false);
    assert.equal(imageRunning('codex.exe', () => { throw new Error('no tasklist'); }), true);
  });
});

describe('codexWindows', () => {
  test('parseRegQuery reads REG_SZ and REG_EXPAND_SZ values', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    CODEX_HOME    REG_SZ    C:\\Users\\a b\\.codex-work\r\n\r\n';
    assert.equal(parseRegQuery(out), 'C:\\Users\\a b\\.codex-work');
    assert.equal(parseRegQuery(out.replace('REG_SZ', 'REG_EXPAND_SZ')), 'C:\\Users\\a b\\.codex-work');
    assert.equal(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.'), undefined);
  });

  test('getUserCodexHome treats a failing query as unset', () => {
    assert.equal(getUserCodexHome(() => { throw new Error('exit 1'); }), undefined);
  });

  test('setUserCodexHome passes the value through the environment, not the command line', () => {
    const calls: Array<{ file: string; args: string[]; env?: Record<string, string> }> = [];
    setUserCodexHome('C:\\x\\.codex-a', (file, args, env) => (calls.push({ file, args, env }), ''));
    setUserCodexHome(undefined, (file, args, env) => (calls.push({ file, args, env }), ''));
    assert.equal(calls[0].file, 'powershell.exe');
    assert.ok(!calls[0].args.join(' ').includes('.codex-a'));
    assert.deepEqual(calls[0].env, { PLANSWAP_CODEX_HOME: 'C:\\x\\.codex-a' });
    assert.deepEqual(calls[1].env, { PLANSWAP_CODEX_HOME: '' });
  });
});

describe('Windows restart guidance', () => {
  test('a local Windows editor gets the quit-and-relaunch guidance', () => {
    const m = manualRestartMessages('unknown', undefined, true);
    assert.match(m.hint, /Start menu/);
    assert.ok(m.required.includes(m.hint));
    assert.ok(m.switchConfirm.includes(m.hint));
  });

  test('every language substitutes the hint', () => {
    for (const lang of ['zh-cn', 'es', 'ja'] as const) {
      setLocale(lang);
      const m = manualRestartMessages('unknown', undefined, true);
      assert.ok(m.required.includes(m.hint) && m.switchConfirm.includes(m.hint), lang);
      assert.ok(!m.required.includes('{hint}'), lang);
    }
    setLocale('en');
  });
});
