// A VS Code server outside WSL (a Remote-SSH host with the same ~/.vscode-server layout) is no hook kind: the parent
// process's cmdline is faked as in codexHookEditor.test.ts, but WSL_DISTRO_NAME is unset before the first
// currentServerKind() call, which then stays 'unknown' for this bundle. Temporary HOME throughout.
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as path from 'node:path';
import { currentServerKind } from '../src/codex/codexState';
import { LINUX_ONLY, makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
let savedDistro: string | undefined;
before(() => {
  tmp = makeTempHome('codex-hook-non-wsl');
  savedDistro = process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_DISTRO_NAME;
  const realRead = fs.readFileSync;
  mock.method(fsDefault, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === `/proc/${process.ppid}/cmdline`) {
      return `node\0${path.join(tmp.home, '.vscode-server', 'bin', 'fake', 'out', 'server-main.js')}\0--start-server\0`;
    }
    return (realRead as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync);
});
after(() => {
  mock.restoreAll();
  if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
  else process.env.WSL_DISTRO_NAME = savedDistro;
  tmp.restore();
});

test('a VS Code server outside WSL uses the shared selection file', LINUX_ONLY, () => {
  assert.equal(currentServerKind(), 'unknown');
});
