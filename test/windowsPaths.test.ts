// Windows spellings of paths and terminal profiles; process.platform is switched per test, everything else is pure
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { tildify } from '../src/accountsPanel';
import { isWslProfile } from '../src/terminalShell';
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
