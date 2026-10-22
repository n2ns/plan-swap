// Code paths that depend on running inside a VS Code WSL window (a hook kind, codex-design.md section 4a). The parent
// process's cmdline is faked before the first currentServerKind() call, which then stays 'vscode' for this bundle.
// Temporary HOME throughout; nothing here signals a process.
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as path from 'node:path';
import {
  STATE_FILE, currentServerKind, installRcBlocks, migrateLegacyCodex, readSelectedDir, stateFileFor, writeSelectedDir,
} from '../src/codex/codexState';
import { collectDiagnostics } from '../src/diagnosticsCommand';
import { LINUX_ONLY, makeTempHome, read, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
before(() => {
  tmp = makeTempHome('codex-hook-editor');
  home = tmp.home;
  process.env.SHELL = '/bin/bash';
  const realRead = fs.readFileSync;
  mock.method(fsDefault, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === `/proc/${process.ppid}/cmdline`) {
      return `node\0${path.join(home, '.vscode-server', 'bin', 'fake', 'out', 'server-main.js')}\0--start-server\0`;
    }
    return (realRead as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync);
});
after(() => {
  mock.restoreAll();
  tmp.restore();
});

const clean = (): void => {
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
};

test('the fake parent makes this bundle a VS Code window', LINUX_ONLY, () => {
  assert.equal(currentServerKind(), 'vscode');
});

test('migrateLegacyCodex in a VS Code window copies the legacy selection to the shared state file', LINUX_ONLY, () => {
  clean();
  const bashrc = path.join(home, '.bashrc');
  const profile = path.join(home, '.profile');
  fs.writeFileSync(bashrc, 'x=1\n');
  fs.writeFileSync(profile, 'p=1\n');
  installRcBlocks();
  const toLegacy = (text: string): string => text.replace(/_planswap_/g, '_ai_switcher_').replace(/planswap/g, 'ai-switcher');
  const installedBashrc = read(bashrc);
  fs.writeFileSync(bashrc, toLegacy(installedBashrc));
  fs.writeFileSync(profile, toLegacy(read(profile)));
  const legacyState = path.join(home, '.config', 'ai-switcher', 'codex-home');
  const dir = path.join(home, '.codex-work');
  fs.mkdirSync(path.dirname(legacyState), { recursive: true });
  fs.writeFileSync(legacyState, dir);

  assert.equal(migrateLegacyCodex(), true);
  assert.equal(read(bashrc), installedBashrc);
  assert.equal(read(STATE_FILE()), dir, 'the shared file the rc blocks read holds the legacy selection');
  assert.equal(fs.existsSync(stateFileFor('vscode')), false, 'the editor keeps falling back to the shared file');
  assert.equal(readSelectedDir(), dir);
  assert.equal(fs.existsSync(legacyState), false);
});

test('diagnostics in a VS Code window: a stored own selection is pending even when management is incomplete', LINUX_ONLY, async () => {
  clean();
  const work = path.join(home, '.codex-work');
  writeSelectedDir(work, 'vscode');
  assert.equal(fs.existsSync(STATE_FILE()), false);
  const snapshot = await collectDiagnostics({
    store: { named: () => [] },
    codexStore: { named: () => [{ name: 'work', dir: work }] },
    extensionVersion: '0.2.0',
    versions: async () => [],
    check: () => ({ ok: true }),
    enabled: () => false,
    restart: () => ({ context: 'wsl', auto: false }),
  });
  assert.deepEqual(snapshot.codex.selected, { kind: 'named', number: 1 });
  assert.deepEqual(snapshot.codex.effective, { kind: 'default' });
  assert.equal(snapshot.codex.pending, true);
});
