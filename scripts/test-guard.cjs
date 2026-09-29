// Loaded first in every test bundle (esbuild banner in run-tests.mjs), on every platform.
// On Windows the product code reads and writes the real user-level CODEX_HOME through reg / powershell.exe / setx
// (codexWindows' default runner, windowsStartTimes' probe). Tests inject their own runners; this guard makes sure a
// missed injection fails loudly instead of touching the real user environment. It replaces the child_process functions
// by direct assignment, so mock.restoreAll() (which only undoes node:test mocks) cannot remove it.
'use strict';
const childProcess = require('node:child_process');
const path = require('node:path');
const util = require('node:util');

if (!childProcess.__planswapTestGuard) {
  const BLOCKED = /^(reg|powershell|pwsh|setx)(\.exe)?$/i;

  // First token of a shell command line, quotes removed ("C:\Windows\System32\reg.exe" query ... -> reg.exe)
  const firstToken = (command) => {
    const s = String(command).trimStart();
    const m = /^"([^"]*)"|^'([^']*)'|^(\S+)/.exec(s);
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  };
  // Both separators: a Windows path must be recognized when the tests run on Linux too
  const base = (file) => path.win32.basename(String(file).replace(/^["']+|["']+$/g, ''));
  const blocked = (file) => BLOCKED.test(base(file));

  const refuse = (what) => {
    throw new Error(`tests must not run ${what} against the real user environment (scripts/test-guard.cjs)`);
  };

  // execFile-style call: (file, args?, options?, ...)
  const checkFile = (file, args, options) => {
    const argv = Array.isArray(args) ? args : [];
    const opts = Array.isArray(args) ? options : args;
    const shell = opts && typeof opts === 'object' && opts.shell;
    if (blocked(file) || (shell && blocked(firstToken(file)))) refuse(file);
    // cmd.exe /c <command>: the command it runs counts as well
    if (/^cmd(\.exe)?$/i.test(base(file))) {
      const i = argv.findIndex((a) => /^\/[ck]$/i.test(String(a)));
      if (i >= 0 && blocked(firstToken(argv.slice(i + 1).join(' ').replace(/^"+/, '')))) refuse(argv.slice(i + 1).join(' '));
    }
  };
  // exec-style call: (command, options?, ...), always through a shell
  const checkCommand = (command) => {
    if (blocked(firstToken(command))) refuse(command);
  };

  // The arguments are passed on exactly as received (node parses optional arguments by position and type); the
  // util.promisify variant of exec / execFile is guarded too
  const wrap = (name, check) => {
    const real = childProcess[name];
    const guarded = function guarded(...callArgs) {
      check(callArgs);
      return real.apply(this, callArgs);
    };
    const custom = real[util.promisify.custom];
    if (typeof custom === 'function') {
      guarded[util.promisify.custom] = function guardedPromise(...callArgs) {
        check(callArgs);
        return custom.apply(this, callArgs);
      };
    }
    childProcess[name] = guarded;
  };
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn']) wrap(name, (a) => checkFile(a[0], a[1], a[2]));
  for (const name of ['execSync', 'exec']) wrap(name, (a) => checkCommand(a[0]));
  Object.defineProperty(childProcess, '__planswapTestGuard', { value: true });
}
