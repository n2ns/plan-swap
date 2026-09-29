// scripts/test-guard.cjs: every test bundle refuses reg / powershell / pwsh / setx, on every platform, whatever the
// test does with node:test mocks. The probe commands below are read-only or help-only, so even a missing guard could not
// change the user environment; each call still checks for the guard first.
import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync as namedExecFileSync, spawnSync as namedSpawnSync } from 'node:child_process';
import * as util from 'node:util';

const guarded = (): boolean => !!(childProcess as unknown as { __planswapTestGuard?: boolean }).__planswapTestGuard;
const REFUSED = /tests must not run .* against the real user environment/;

function refused(label: string, call: () => unknown): void {
  assert.ok(guarded(), 'the guard is loaded before any probe runs');
  assert.throws(call, REFUSED, label);
}

const noop = (): void => {};
const QUERY = ['query', 'HKCU\\Environment', '/v', 'PLANSWAP_GUARD_PROBE'];
const PS = ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'];

function everyForm(): void {
  refused('execFileSync reg', () => childProcess.execFileSync('reg', QUERY));
  refused('execFileSync reg.exe by full path', () => childProcess.execFileSync('C:\\Windows\\System32\\reg.exe', QUERY));
  refused('execFileSync REG.EXE', () => childProcess.execFileSync('REG.EXE', QUERY));
  refused('named execFileSync import', () => namedExecFileSync('powershell.exe', PS));
  refused('execFile powershell', () => childProcess.execFile('powershell', PS, noop));
  refused('execFile pwsh without args', () => childProcess.execFile('/usr/bin/pwsh', noop));
  refused('spawnSync setx', () => childProcess.spawnSync('setx', ['/?']));
  refused('named spawnSync import', () => namedSpawnSync('setx.exe', ['/?']));
  refused('spawn pwsh.exe', () => childProcess.spawn('pwsh.exe', PS));
  refused('spawn with options only', () => childProcess.spawn('reg', { stdio: 'ignore' }));
  refused('spawnSync shell command line', () => childProcess.spawnSync('reg query HKCU\\Environment', { shell: true }));
  refused('spawn quoted shell command line', () =>
    childProcess.spawn('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "exit 0"', [], { shell: true }));
  refused('cmd.exe /c reg', () => childProcess.execFileSync('cmd.exe', ['/d', '/s', '/c', 'reg query HKCU\\Environment']));
  refused('execSync', () => childProcess.execSync('reg query HKCU\\Environment /v PLANSWAP_GUARD_PROBE'));
  refused('execSync with leading spaces', () => childProcess.execSync('   setx /?'));
  refused('exec', () => childProcess.exec('powershell -NoProfile -Command "exit 0"', noop));
  refused('promisified exec', () => util.promisify(childProcess.exec)('powershell -NoProfile -Command "exit 0"'));
  refused('promisified execFile', () => util.promisify(childProcess.execFile)('setx', ['/?']));
}

describe('process guard', () => {
  test('refuses reg, powershell, pwsh and setx in every child_process form', () => {
    everyForm();
  });

  test('survives node:test mocks being restored', () => {
    const fake = mock.method(childProcess, 'execFileSync', (() => 'mocked') as unknown as typeof childProcess.execFileSync);
    assert.equal(childProcess.execFileSync('reg', QUERY), 'mocked');
    assert.equal(fake.mock.callCount(), 1);
    mock.restoreAll();
    everyForm();
  });

  test('applies whatever process.platform says', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    for (const platform of ['win32', 'linux']) {
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        everyForm();
      } finally {
        Object.defineProperty(process, 'platform', realPlatform);
      }
    }
  });

  test('other programs still run', async () => {
    assert.equal(childProcess.execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }), 'ok');
    assert.equal(childProcess.spawnSync(process.execPath, ['-e', '0']).status, 0);
    const out = await util.promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("async")']);
    assert.equal(out.stdout, 'async');
    // Names that only start with a blocked one are not refused (they simply do not exist)
    const missing = childProcess.spawnSync('regedit-planswap-missing', []);
    assert.equal((missing.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
  });
});
