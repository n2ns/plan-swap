// Per-editor Codex selection (codex-design.md section 4a): the per-kind state files, the server-env-setup hook block,
// the rc block that leaves an inherited CODEX_HOME alone, the upgrade of blocks written by earlier versions and the
// self-check under an inherited value. Temporary HOME throughout; nothing here signals a process.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HOOK_KINDS, RC_BEGIN, RC_END, STATE_FILE, hookBlock, hookFileFor, installRcBlocks, preCheck, rcBlock, readSelectedDir,
  removeLinuxState, removeRcBlocks, selfCheck, stateFileFor, upgradeRcBlocks, watchedStateFiles, writeSelectedDir,
  writeSelection,
} from '../src/codex/codexState';
import { LINUX_ONLY, RC_FILES, assertTempHome, makeTempHome, read, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
before(() => {
  tmp = makeTempHome('codex-editor-state');
  home = tmp.home;
  process.env.SHELL = '/bin/bash';
});
after(() => tmp.restore());

const bashrc = (): string => path.join(home, '.bashrc');
const profile = (): string => path.join(home, '.profile');
const clean = (): void => {
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
};

// Sources `file` in a fresh shell with the given environment and prints CODEX_HOME ("unset" when absent)
function codexHomeAfterSourcing(shell: string, file: string, extraEnv: Record<string, string>): string {
  const r = spawnSync(shell, ['-c', '. "$1"; printf %s "${CODEX_HOME-unset}"', shell, file], {
    env: { HOME: home, PATH: process.env.PATH ?? '', ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

describe('state files per editor kind', () => {
  afterEach(clean);

  test('hook kinds have their own file, the others share STATE_FILE', () => {
    assertTempHome(home);
    assert.deepEqual([...HOOK_KINDS], ['vscodium', 'vscode']);
    assert.equal(stateFileFor('vscodium'), path.join(home, '.config', 'planswap', 'codex-home.vscodium'));
    assert.equal(stateFileFor('vscode'), path.join(home, '.config', 'planswap', 'codex-home.vscode'));
    assert.equal(stateFileFor('antigravity'), STATE_FILE());
    assert.equal(stateFileFor('unknown'), STATE_FILE());
    assert.deepEqual(watchedStateFiles('vscodium'), [stateFileFor('vscodium'), STATE_FILE()]);
    assert.deepEqual(watchedStateFiles('unknown'), [STATE_FILE()]);
  });

  test('a hook kind reads its own file and falls back to the shared one; writes never touch the other files', () => {
    const a = path.join(home, '.codex-a');
    const b = path.join(home, '.codex-b');
    writeSelectedDir(a, 'unknown');
    assert.equal(readSelectedDir('unknown'), a);
    assert.equal(readSelectedDir('vscodium'), a, 'no own file yet: the shared selection');
    assert.equal(readSelectedDir('vscode'), a);
    writeSelectedDir(path.join(home, 'x', '..', '.codex-b'), 'vscodium');
    assert.equal(readSelectedDir('vscodium'), b);
    assert.equal(readSelectedDir('vscode'), a, 'the other editor keeps its selection');
    assert.equal(readSelectedDir('unknown'), a, 'the shared file is not written');
    assert.equal(read(STATE_FILE()), a);
    // An empty own file is the default account, not the shared selection
    writeSelectedDir(undefined, 'vscodium');
    assert.equal(read(stateFileFor('vscodium')), '');
    assert.equal(readSelectedDir('vscodium'), undefined);
    assert.equal(readSelectedDir('unknown'), a);
    assert.deepEqual(fs.readdirSync(path.dirname(STATE_FILE())).sort(), ['codex-home', 'codex-home.vscodium']);
  });

  test('removeLinuxState deletes the shared and every per-editor file', () => {
    writeSelectedDir(path.join(home, '.codex-a'), 'unknown');
    writeSelectedDir(path.join(home, '.codex-a'), 'vscodium');
    writeSelectedDir(undefined, 'vscode');
    removeLinuxState();
    assert.deepEqual(fs.readdirSync(path.dirname(STATE_FILE())), []);
    removeLinuxState(); // nothing left: no error
  });
});

describe('server-env-setup hook block', LINUX_ONLY, () => {
  afterEach(clean);

  test('writeSelection of a hook kind installs the block once, keeps the user content and writes only its own file', () => {
    const dir = path.join(home, '.codex-a');
    const hook = hookFileFor('vscodium');
    assert.equal(hook, path.join(home, '.vscodium-server', 'server-env-setup'));
    fs.mkdirSync(path.dirname(hook));
    fs.writeFileSync(hook, 'export FOO=1\n');
    writeSelection(dir, undefined, 'vscodium');
    assert.equal(read(hook), 'export FOO=1\n\n' + hookBlock('vscodium'));
    assert.equal(readSelectedDir('vscodium'), dir);
    assert.equal(fs.existsSync(STATE_FILE()), false);
    assert.equal(fs.existsSync(hookFileFor('vscode')), false);
    // A second switch does not add a second block
    writeSelection(undefined, undefined, 'vscodium');
    assert.equal(read(hook), 'export FOO=1\n\n' + hookBlock('vscodium'));
    assert.equal(readSelectedDir('vscodium'), undefined);
    // A missing data folder and file are created (the editor's server runs from that folder, so it normally exists)
    writeSelection(dir, undefined, 'vscode');
    assert.equal(read(hookFileFor('vscode')), hookBlock('vscode'));
    assert.equal((fs.statSync(hookFileFor('vscode')).mode & 0o777).toString(8), '644');
    assert.equal(readSelectedDir('vscode'), dir);
    assert.equal(readSelectedDir('vscodium'), undefined);
  });

  test('writeSelection of another kind writes the shared file and no hook', () => {
    const dir = path.join(home, '.codex-a');
    writeSelection(dir, undefined, 'unknown');
    writeSelection(dir, undefined, 'antigravity');
    assert.equal(read(STATE_FILE()), dir);
    assert.deepEqual(fs.readdirSync(home), ['.config']);
  });

  test('sourced by sh: the own file selects the directory, an empty file ~/.codex, a missing file nothing', () => {
    const dir = path.join(home, '.codex-a');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(home, '.codex'));
    const hook = hookFileFor('vscodium');
    fs.mkdirSync(path.dirname(hook));
    fs.writeFileSync(hook, hookBlock('vscodium'));
    assert.equal(codexHomeAfterSourcing('sh', hook, {}), 'unset');
    writeSelectedDir(dir, 'vscodium');
    assert.equal(codexHomeAfterSourcing('sh', hook, {}), dir);
    assert.equal(codexHomeAfterSourcing('sh', hook, { CODEX_HOME: '/elsewhere' }), dir, 'the hook decides for its editor');
    writeSelectedDir(undefined, 'vscodium');
    assert.equal(codexHomeAfterSourcing('sh', hook, {}), path.join(home, '.codex'));
    fs.rmSync(dir, { recursive: true });
    writeSelectedDir(dir, 'vscodium');
    assert.equal(codexHomeAfterSourcing('sh', hook, {}), path.join(home, '.codex'), 'a missing directory counts as default');
  });

  test('the block is byte-stable and names only the own state file', () => {
    assert.equal(hookBlock('vscode'), `# >>> planswap codex >>>
if [ -r "$HOME/.config/planswap/codex-home.vscode" ]; then
  _planswap_codex_home="$(cat "$HOME/.config/planswap/codex-home.vscode" 2>/dev/null)"
  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then
    export CODEX_HOME="$_planswap_codex_home"
  else
    export CODEX_HOME="$HOME/.codex"
  fi
  unset _planswap_codex_home
fi
# <<< planswap codex <<<
`);
  });
});

describe('rc block and an inherited CODEX_HOME', LINUX_ONLY, () => {
  afterEach(clean);

  test('fills in the shared selection only when the shell inherited no value', () => {
    const a = path.join(home, '.codex-a');
    const b = path.join(home, '.codex-b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const file = path.join(home, 'block.sh');
    fs.writeFileSync(file, rcBlock());
    assert.equal(codexHomeAfterSourcing('bash', file, {}), 'unset', 'no state file');
    writeSelectedDir(b, 'unknown');
    assert.equal(codexHomeAfterSourcing('bash', file, {}), b);
    assert.equal(codexHomeAfterSourcing('bash', file, { CODEX_HOME: a }), a, 'the inherited value (server hook, user) wins');
    writeSelectedDir(undefined, 'unknown');
    assert.equal(codexHomeAfterSourcing('bash', file, {}), 'unset', 'an empty shared file no longer unsets anything');
    assert.equal(codexHomeAfterSourcing('bash', file, { CODEX_HOME: a }), a);
    writeSelectedDir(b, 'unknown');
    assert.equal(codexHomeAfterSourcing('sh', file, { CODEX_HOME: '' }), b, 'an empty inherited value counts as unset; POSIX sh accepts the block');
  });

  test('preCheck reports a user export or a broken block in the current editor hook file only', () => {
    fs.writeFileSync(bashrc(), 'case $- in\n    *i*) ;;\n      *) return;;\nesac\n');
    fs.writeFileSync(profile(), '. "$HOME/.bashrc"\n');
    const hook = hookFileFor('vscode');
    fs.mkdirSync(path.dirname(hook));
    fs.writeFileSync(hook, 'export CODEX_HOME=/mine\n');
    assert.deepEqual(preCheck(undefined, 'vscodium'), { ok: true, reasons: [] });
    assert.deepEqual(preCheck(undefined, 'unknown'), { ok: true, reasons: [] });
    const r = preCheck(undefined, 'vscode');
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, [`${hook} already has your own export CODEX_HOME, which conflicts`]);
    // The block's own export line is not the user's; a block without its end marker is reported as broken
    fs.writeFileSync(hook, hookBlock('vscode'));
    assert.deepEqual(preCheck(undefined, 'vscode'), { ok: true, reasons: [] });
    fs.writeFileSync(hook, hookBlock('vscode').split('\n').filter((l) => l !== RC_END).join('\n'));
    assert.deepEqual(preCheck(undefined, 'vscode').reasons, [`Marker block is incomplete; please fix ${hook} manually`]);
  });

  test('removeRcBlocks also strips the hook blocks and restores the original bytes', () => {
    fs.writeFileSync(bashrc(), 'x=1\n');
    fs.writeFileSync(profile(), 'p=1\n');
    installRcBlocks();
    for (const kind of HOOK_KINDS) {
      fs.mkdirSync(path.dirname(hookFileFor(kind)), { recursive: true });
      fs.writeFileSync(hookFileFor(kind), 'export FOO=1\n');
      writeSelection(path.join(home, '.codex-a'), undefined, kind);
      assert.ok(read(hookFileFor(kind)).includes(RC_BEGIN));
    }
    removeRcBlocks();
    assert.equal(read(bashrc()), 'x=1\n');
    assert.equal(read(profile()), 'p=1\n');
    for (const kind of HOOK_KINDS) assert.equal(read(hookFileFor(kind)), 'export FOO=1\n');
    // A damaged hook block blocks the whole removal, as a damaged rc block does
    installRcBlocks();
    fs.writeFileSync(hookFileFor('vscodium'), RC_BEGIN + '\n');
    assert.throws(() => removeRcBlocks(), /missing end marker/);
    assert.equal(read(bashrc()), 'x=1\n\n' + rcBlock());
  });
});

// The block written by 0.1.4 - 0.3.12, which unset an inherited CODEX_HOME
const OLD_BLOCK = [
  RC_BEGIN,
  'if [ -r "$HOME/.config/planswap/codex-home" ]; then',
  '  _planswap_codex_home="$(cat "$HOME/.config/planswap/codex-home" 2>/dev/null)"',
  '  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then',
  '    export CODEX_HOME="$_planswap_codex_home"',
  '  else',
  '    unset CODEX_HOME',
  '  fi',
  '  unset _planswap_codex_home',
  'fi',
  RC_END,
  '',
].join('\n');

describe('upgradeRcBlocks', RC_FILES, () => {
  afterEach(clean);

  test('replaces an older block in place in both files and leaves everything else as it was', () => {
    assertTempHome(home);
    const guard = 'case $- in\n    *i*) ;;\n      *) return;;\nesac\nalias ll=1\n';
    fs.writeFileSync(bashrc(), 'export FOO=1\n\n' + OLD_BLOCK + guard);
    fs.writeFileSync(profile(), 'p=1\n\n' + OLD_BLOCK);
    fs.chmodSync(profile(), 0o600);
    assert.equal(upgradeRcBlocks(), true);
    assert.equal(read(bashrc()), 'export FOO=1\n\n' + rcBlock() + guard);
    assert.equal(read(profile()), 'p=1\n\n' + rcBlock());
    if (process.platform !== 'win32') assert.equal((fs.statSync(profile()).mode & 0o777).toString(8), '600');
    assert.equal(upgradeRcBlocks(), false, 'current blocks are left alone');
    assert.equal(read(bashrc()), 'export FOO=1\n\n' + rcBlock() + guard);
    // Removal after the upgrade restores the original bytes
    removeRcBlocks();
    assert.equal(read(bashrc()), 'export FOO=1\n' + guard);
    assert.equal(read(profile()), 'p=1\n');
  });

  test('missing files and files without a block are untouched; a block without its end marker throws', () => {
    assert.equal(upgradeRcBlocks(), false);
    fs.writeFileSync(bashrc(), 'x=1\n');
    assert.equal(upgradeRcBlocks(), false);
    assert.equal(read(bashrc()), 'x=1\n');
    fs.writeFileSync(profile(), OLD_BLOCK.split('\n').filter((l) => l !== RC_END).join('\n'));
    fs.writeFileSync(bashrc(), OLD_BLOCK);
    assert.throws(() => upgradeRcBlocks(), /missing end marker/);
    assert.equal(read(bashrc()), OLD_BLOCK, 'nothing is written when any file is damaged');
  });
});

describe('self-check under an inherited CODEX_HOME (real bash -i -l)', LINUX_ONLY, () => {
  const configDir = (): string => path.dirname(STATE_FILE());
  before(() => {
    fs.writeFileSync(bashrc(), 'case $- in\n    *i*) ;;\n      *) return;;\nesac\n');
    fs.writeFileSync(profile(), 'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n');
    installRcBlocks();
  });
  after(clean);

  test('passes although this host has its own CODEX_HOME, and restores the shared file', () => {
    writeSelectedDir(path.join(home, '.codex-orig'), 'unknown');
    const saved = process.env;
    process.env = { HOME: home, PATH: saved.PATH, SHELL: '/bin/bash', TERM: 'dumb', LANG: 'C.UTF-8', CODEX_HOME: path.join(home, '.codex-host') } as NodeJS.ProcessEnv;
    let r: ReturnType<typeof selfCheck>;
    try {
      r = selfCheck();
    } finally {
      process.env = saved;
    }
    assert.ok(r.ok, r.detail);
    assert.equal(readSelectedDir('unknown'), path.join(home, '.codex-orig'));
    assert.deepEqual(fs.readdirSync(configDir()), ['codex-home']);
  });
});
