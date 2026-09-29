// Pure helpers with injected runners: nothing here calls a real Windows API, and nothing writes outside a temporary HOME
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { setLocale } from '../src/i18n';
import {
  comparablePath, copyLink, createLink, isSupportedPlatform, parseStartTimes, pidAlive, renameReplacing, stripBom, windowsStartTimes,
} from '../src/platform';
import { decodeEnvOutput, getUserCodexHome, getUserEnv, setUserCodexHome, setUserEnv } from '../src/codex/codexWindows';
import { manualRestartMessages } from '../src/codex/codexCommands';
import { LINUX_ONLY, makeTempHome, type TempHome } from './helpers';

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

  test('createLink and copyLink create symlinks on Linux', LINUX_ONLY, () => {
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

  test('renameReplacing retries a refused replace only on Windows', () => {
    const refusing = (failures: number, code = 'EPERM'): { calls: number; rename: (a: string, b: string) => void } => {
      const r = {
        calls: 0,
        rename: (): void => {
          if (r.calls++ < failures) throw Object.assign(new Error(code), { code });
        },
      };
      return r;
    };
    const twice = refusing(2);
    renameReplacing('a', 'b', 'win32', twice.rename);
    assert.equal(twice.calls, 3);
    const always = refusing(99, 'EBUSY');
    assert.throws(() => renameReplacing('a', 'b', 'win32', always.rename), /EBUSY/);
    assert.equal(always.calls, 9);
    const other = refusing(1, 'ENOENT');
    assert.throws(() => renameReplacing('a', 'b', 'win32', other.rename), /ENOENT/);
    assert.equal(other.calls, 1);
    const linux = refusing(1);
    assert.throws(() => renameReplacing('a', 'b', 'linux', linux.rename), /EPERM/);
    assert.equal(linux.calls, 1);
  });

  test('stripBom removes only a leading byte order mark', () => {
    assert.equal(stripBom('﻿{"a":1}'), '{"a":1}');
    assert.equal(stripBom('{"a":"﻿"}'), '{"a":"﻿"}');
    assert.equal(stripBom(''), '');
  });

  test('start-time probe: parsing, validated pids and failure', () => {
    assert.deepEqual([...parseStartTimes('29368 134351739525860505\r\n\r\nnoise\r\n7 1\r\n')], [[29368, '134351739525860505'], [7, '1']]);
    let script = '';
    const times = windowsStartTimes([12, -1, 1.5, 34], (s) => {
      script = s;
      return '12 100\r\n';
    });
    assert.deepEqual([...(times ?? [])], [[12, '100']]);
    assert.match(script, /^Get-Process -Id 12,34 /);
    assert.deepEqual([...(windowsStartTimes([], () => { throw new Error('not called'); }) ?? [])], []);
    assert.equal(windowsStartTimes([5], () => { throw new Error('no powershell'); }), undefined);
  });
});

describe('codexWindows', () => {
  test('getUserEnv decodes base64 UTF-8 output, so non-ASCII paths survive any code page', () => {
    const value = 'C:\\Users\\张三 b\\.codex-work';
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    assert.equal(decodeEnvOutput(b64 + '\r\n'), value);
    assert.equal(decodeEnvOutput('\r\n'), undefined);
    let call: { file: string; args: string[]; env?: Record<string, string> } | undefined;
    assert.equal(getUserEnv('CODEX_HOME', (file, args, env) => ((call = { file, args, env }), b64)), value);
    assert.equal(call?.file, 'powershell.exe');
    assert.ok(!call?.args.join(' ').includes('CODEX_HOME'));
    assert.deepEqual(call?.env, { PLANSWAP_ENV_NAME: 'CODEX_HOME' });
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
    assert.deepEqual(calls[0].env, { PLANSWAP_ENV_NAME: 'CODEX_HOME', PLANSWAP_ENV_VALUE: 'C:\\x\\.codex-a' });
    assert.deepEqual(calls[1].env, { PLANSWAP_ENV_NAME: 'CODEX_HOME', PLANSWAP_ENV_VALUE: '' });
  });

  test('other variables are read and written by name', () => {
    let named: Record<string, string> | undefined;
    const b64 = Buffer.from('C:\\t\\x').toString('base64');
    assert.equal(getUserEnv('PLANSWAP_SELF_CHECK', (_f, _a, e) => ((named = e), b64)), 'C:\\t\\x');
    assert.deepEqual(named, { PLANSWAP_ENV_NAME: 'PLANSWAP_SELF_CHECK' });
    let env: Record<string, string> | undefined;
    setUserEnv('PLANSWAP_SELF_CHECK', undefined, (_f, _a, e) => ((env = e), ''));
    assert.deepEqual(env, { PLANSWAP_ENV_NAME: 'PLANSWAP_SELF_CHECK', PLANSWAP_ENV_VALUE: '' });
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
