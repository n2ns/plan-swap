// Windows spellings of paths and terminal profiles; process.platform is switched per test, everything else is pure
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { tildify } from '../src/platform';
import { isWslProfile, windowsAccountEnv } from '../src/terminalShell';
import { linuxClaudeCommand } from '../src/commands';
import { linuxCodexCommand } from '../src/codex/codexCommands';
import { makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
before(() => { tmp = makeTempHome('winpaths'); });
after(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  tmp.restore();
});

describe('tildify', () => {
  test('shortens the home directory; on Windows also when only the case differs', () => {
    const home = os.homedir();
    const acc = path.join(home, '.claude-a');
    assert.equal(tildify(acc), `~${path.sep}.claude-a`);
    assert.equal(tildify(home), '~');
    const upper = acc.toUpperCase();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    assert.equal(tildify(upper), upper);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.equal(tildify(upper), `~${path.sep}.CLAUDE-A`);
    assert.equal(tildify(home + 'x'), home + 'x');
    Object.defineProperty(process, 'platform', realPlatform);
  });
});

describe('isWslProfile', () => {
  test('detected distributions and wsl.exe / System32 bash.exe profiles count; PowerShell, cmd and Git Bash do not', () => {
    assert.equal(isWslProfile('Ubuntu (WSL)'), true);
    assert.equal(isWslProfile('Ubuntu-24.04 (WSL) '), true);
    assert.equal(isWslProfile('PowerShell'), false);
    assert.equal(isWslProfile('Command Prompt'), false);
    const profiles = {
      Mine: { path: 'C:\\Windows\\System32\\wsl.exe' },
      Old: { path: ['C:\\Windows\\Sysnative\\bash.exe', 'C:\\Windows\\System32\\bash.exe'] },
      'Git Bash': { path: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      Gone: null,
    };
    assert.equal(isWslProfile('Mine', profiles), true);
    assert.equal(isWslProfile('Old', profiles), true);
    assert.equal(isWslProfile('Git Bash', profiles), false);
    assert.equal(isWslProfile('Gone', profiles), false);
  });
});

describe('windowsAccountEnv', () => {
  const exe = 'C:\\Users\\a\\.vscode\\extensions\\anthropic.claude-code-2.1.300-win32-x64\\resources\\native-binary\\claude.exe';
  const folder = exe.slice(0, exe.lastIndexOf('\\'));
  test('appends the bundled CLI folder to the host Path under its own spelling; nothing to set gives undefined', () => {
    assert.deepEqual(windowsAccountEnv({ CLAUDE_CONFIG_DIR: 'C:\\Users\\a\\.claude-w' }, exe, {}, { Path: 'C:\\Windows' }),
      { CLAUDE_CONFIG_DIR: 'C:\\Users\\a\\.claude-w', Path: `C:\\Windows;${folder}` });
    assert.deepEqual(windowsAccountEnv({ CODEX_HOME: null }, exe, {}, {}), { CODEX_HOME: null, Path: folder });
    assert.deepEqual(windowsAccountEnv({ CLAUDE_CONFIG_DIR: 'C:\\a' }, undefined, {}, { Path: 'C:\\Windows' }), { CLAUDE_CONFIG_DIR: 'C:\\a' });
    assert.equal(windowsAccountEnv({}, undefined, {}, { Path: 'C:\\Windows' }), undefined);
  });
  test('keeps a PATH from terminal.integrated.env.windows, resolving its ${env:NAME} references from the host', () => {
    const env = { Path: 'C:\\Windows', TOOLS: 'D:\\t' };
    assert.deepEqual(windowsAccountEnv({}, exe, { PATH: '${env:path};${env:TOOLS};D:\\x;${env:NONE}' }, env),
      { Path: `C:\\Windows;D:\\t;D:\\x;;${folder}` });
    assert.deepEqual(windowsAccountEnv({}, exe, { path: null }, env), { Path: folder });
  });
});

describe('linuxClaudeCommand', () => {
  test('sets the account folder, or unsets it without one, and appends the bundled CLI folder through env', () => {
    assert.equal(linuxClaudeCommand("/h/.claude-it's", '/x/native-binary/claude'),
      `env CLAUDE_CONFIG_DIR='/h/.claude-it'\\''s' PATH="$PATH":'/x/native-binary' claude`);
    assert.equal(linuxClaudeCommand(undefined, '/x/native-binary/claude'), `env -u CLAUDE_CONFIG_DIR PATH="$PATH":'/x/native-binary' claude`);
    assert.equal(linuxClaudeCommand('/h/.claude-a', undefined), `env CLAUDE_CONFIG_DIR='/h/.claude-a' claude`);
    assert.equal(linuxClaudeCommand(undefined, undefined), 'env -u CLAUDE_CONFIG_DIR claude');
  });
});

describe('linuxCodexCommand', () => {
  test('sets or removes CODEX_HOME and appends the bundled CLI folder through env', () => {
    assert.equal(linuxCodexCommand('/h/.codex-a', '/x/bin/linux-x86_64/codex'), `env CODEX_HOME='/h/.codex-a' PATH="$PATH":'/x/bin/linux-x86_64' codex`);
    assert.equal(linuxCodexCommand(undefined, '/x/bin/linux-x86_64/codex'), `env -u CODEX_HOME PATH="$PATH":'/x/bin/linux-x86_64' codex`);
    assert.equal(linuxCodexCommand('/h/.codex-a', undefined), `env CODEX_HOME='/h/.codex-a' codex`);
    assert.equal(linuxCodexCommand(undefined, undefined), 'env -u CODEX_HOME codex');
  });
});
