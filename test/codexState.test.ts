import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale } from '../src/i18n';
import {
  RC_BEGIN, RC_END, STATE_FILE, effectiveDir, installRcBlocks, preCheck, rcBlock, rcStatus, readSelectedDir,
  migrateLegacyCodex, removeRcBlockFrom, removeRcBlocks, selfCheck, writeSelectedDir, disableWindows, selfCheckWindows,
} from '../src/codex/codexState';
import type { Runner } from '../src/codex/codexWindows';
import { assertTempHome, makeTempHome, assertMode, LINUX_ONLY, read, withEnv, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
let bashrc: string;
let profile: string;

before(() => {
  tmp = makeTempHome('codex-state');
  home = tmp.home;
  bashrc = path.join(home, '.bashrc');
  profile = path.join(home, '.profile');
  process.env.SHELL = '/bin/bash';
});
after(() => tmp.restore());

const bashrcOrig = `# ~/.bashrc
export FOO=1
case $- in
    *i*) ;;
      *) return;;
esac
alias ll='ls -l'
`;
const profileOrig = `# ~/.profile
if [ -n "$BASH_VERSION" ]; then
    if [ -f "$HOME/.bashrc" ]; then
	. "$HOME/.bashrc"
    fi
fi
`;

describe('state file', () => {
  test('missing → undefined', () => {
    assertTempHome(home);
    assert.equal(STATE_FILE(), path.join(home, '.config', 'planswap', 'codex-home'));
    assert.equal(readSelectedDir(), undefined);
  });
  test('atomic write: resolved path, 0600, directory 0700, no temp file left', () => {
    writeSelectedDir(path.join(home, 'foo/../.codex-a'));
    assert.equal(readSelectedDir(), path.join(home, '.codex-a'));
    assertMode(STATE_FILE(), '600');
    assertMode(path.dirname(STATE_FILE()), '700');
    assert.deepEqual(fs.readdirSync(path.dirname(STATE_FILE())), ['codex-home']);
  });
  test('writing undefined → empty file → reads as undefined; blank content is also undefined', () => {
    writeSelectedDir(path.join(home, '.codex-a'));
    writeSelectedDir(undefined);
    assert.equal(read(STATE_FILE()), '');
    assert.equal(readSelectedDir(), undefined);
    fs.writeFileSync(STATE_FILE(), '  \n');
    assert.equal(readSelectedDir(), undefined);
  });
  test('effectiveDir uses the extension host CODEX_HOME, default directory when empty', () => {
    withEnv({ CODEX_HOME: undefined }, () => assert.equal(effectiveDir(), path.join(home, '.codex')));
    withEnv({ CODEX_HOME: home + '/x/../.codex-z' }, () => assert.equal(effectiveDir(), path.join(home, '.codex-z')));
    withEnv({ CODEX_HOME: '' }, () => assert.equal(effectiveDir(), path.join(home, '.codex')));
  });
});

// In-memory HKCU\Environment behind the reg / powershell.exe runner of codexWindows
function fakeUserEnv(initial: Record<string, string> = {}, fail: { set?: boolean } = {}): { vars: Map<string, string>; run: Runner } {
  const vars = new Map(Object.entries(initial));
  const run: Runner = (_file, _args, env) => {
    const name = env?.PLANSWAP_ENV_NAME ?? '';
    // A read passes only the name; it prints the value as base64 of its UTF-8 bytes
    if (env && !('PLANSWAP_ENV_VALUE' in env)) return Buffer.from(vars.get(name) ?? '', 'utf8').toString('base64') + '\r\n';
    if (fail.set) throw new Error('powershell refused');
    if (env?.PLANSWAP_ENV_VALUE) vars.set(name, env.PLANSWAP_ENV_VALUE);
    else vars.delete(name);
    return '';
  };
  return { vars, run };
}

describe('Windows user environment', () => {
  test('the self-check writes, reads back and removes a scratch variable; CODEX_HOME is never touched', () => {
    const env = fakeUserEnv({ CODEX_HOME: 'C:\\mine' });
    const r = selfCheckWindows(env.run);
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /^PLANSWAP_SELF_CHECK=planswap-/);
    assert.deepEqual([...env.vars], [['CODEX_HOME', 'C:\\mine']]);
    assert.equal(selfCheckWindows(fakeUserEnv({}, { set: true }).run).ok, false);
  });

  test('disable removes CODEX_HOME only while it points at an account directory', () => {
    writeSelectedDir(path.join(home, '.codex-a'));
    const managed = fakeUserEnv({ CODEX_HOME: path.join(home, '.codex-a') });
    disableWindows(managed.run);
    assert.equal(managed.vars.has('CODEX_HOME'), false);
    assert.equal(fs.existsSync(STATE_FILE()), false);
    // The user replaced the value after enabling: it stays, the state file still goes
    writeSelectedDir(path.join(home, '.codex-a'));
    const mine = fakeUserEnv({ CODEX_HOME: 'D:\\my-codex' });
    disableWindows(mine.run);
    assert.equal(mine.vars.get('CODEX_HOME'), 'D:\\my-codex');
    assert.equal(fs.existsSync(STATE_FILE()), false);
  });
});

describe('rcBlock', () => {
  test('exact content', () => {
    const expect = `# >>> planswap codex >>>
if [ -r "$HOME/.config/planswap/codex-home" ]; then
  _planswap_codex_home="$(cat "$HOME/.config/planswap/codex-home" 2>/dev/null)"
  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then
    export CODEX_HOME="$_planswap_codex_home"
  else
    unset CODEX_HOME
  fi
  unset _planswap_codex_home
fi
# <<< planswap codex <<<
`;
    assert.equal(rcBlock(), expect);
  });
});

describe('installRcBlocks / removeRcBlocks / rcStatus', LINUX_ONLY, () => {
  // Each test sets up the rc files it needs, so none depends on what an earlier one left behind
  const writeOrig = (): void => {
    fs.rmSync(bashrc, { force: true });
    fs.rmSync(profile, { force: true });
    fs.writeFileSync(bashrc, bashrcOrig, { mode: 0o600 });
    fs.writeFileSync(profile, profileOrig, { mode: 0o644 });
    fs.chmodSync(bashrc, 0o600);
    fs.chmodSync(profile, 0o644);
  };
  before(writeOrig);
  test('rcStatus is all false before install', () => {
    writeOrig();
    assert.deepEqual(rcStatus(), [
      { file: profile, hasBlock: false, broken: false, hasUserExport: false },
      { file: bashrc, hasBlock: false, broken: false, hasUserExport: false },
    ]);
  });
  test('bashrc block before the guard, profile block appended at the end, modes preserved', () => {
    writeOrig();
    installRcBlocks();
    const b = read(bashrc);
    assert.ok(b.indexOf(RC_BEGIN) >= 0 && b.indexOf(RC_END) > b.indexOf(RC_BEGIN) && b.indexOf('case $- in') > b.indexOf(RC_END));
    assert.equal(b, '# ~/.bashrc\nexport FOO=1\n\n' + rcBlock() + 'case $- in\n    *i*) ;;\n      *) return;;\nesac\nalias ll=\'ls -l\'\n');
    assertMode(bashrc, '600');
    assert.equal(read(profile), profileOrig + '\n' + rcBlock());
    assertMode(profile, '644');
    assert.deepEqual(rcStatus().map((s) => s.hasBlock), [true, true]);
  });
  test('idempotent', () => {
    writeOrig();
    installRcBlocks();
    const b = read(bashrc);
    const p = read(profile);
    installRcBlocks();
    assert.equal(read(bashrc), b);
    assert.equal(read(profile), p);
    assert.equal(b.split(RC_BEGIN).length, 2);
  });
  test('removal restores exactly; no-op without a block', () => {
    writeOrig();
    installRcBlocks();
    removeRcBlocks();
    assert.equal(read(bashrc), bashrcOrig);
    assert.equal(read(profile), profileOrig);
    assertMode(bashrc, '600');
    removeRcBlocks();
    assert.equal(read(bashrc), bashrcOrig);
  });
  test('blank line before guard / guard on line 1 / guard on line 2: install then remove restores exactly', () => {
    for (const orig of [
      'a=1\n\ncase $- in\n  *i*) ;;\n  *) return;;\nesac\n',
      'case $- in\n  *i*) ;;\n  *) return;;\nesac\nb=2\n',
      '\ncase $- in\n  *i*) ;;\n  *) return;;\nesac\n',
    ]) {
      fs.writeFileSync(bashrc, orig);
      installRcBlocks();
      const b = read(bashrc);
      assert.ok(b.includes(RC_END + '\ncase $- in'), 'the guard follows the block on its own line');
      removeRcBlocks();
      assert.equal(read(bashrc), orig);
    }
  });
  test('appends without a guard; only the missing newline when the trailing one is missing; creates a missing file with 0644', () => {
    fs.writeFileSync(bashrc, 'export A=1');
    fs.rmSync(profile, { force: true });
    installRcBlocks();
    assert.equal(read(bashrc), 'export A=1\n' + rcBlock());
    assert.equal(read(profile), rcBlock());
    assertMode(profile, '644');
    removeRcBlocks();
    assert.equal(read(bashrc), 'export A=1');
    assert.equal(read(profile), '');
  });
  test('round trip restores the original bytes with or without a trailing newline', () => {
    for (const [b, p] of [['x=1', 'p'], ['x=1\n', 'p\n'], ['x=1\n\n', 'p\n\n'], ['', ''], ['\n', '\n']]) {
      fs.writeFileSync(bashrc, b);
      fs.writeFileSync(profile, p);
      installRcBlocks();
      assert.deepEqual(rcStatus().map((s) => s.hasBlock), [true, true]);
      removeRcBlocks();
      assert.equal(read(bashrc), b, JSON.stringify(b));
      assert.equal(read(profile), p, JSON.stringify(p));
    }
  });
  test('removal after a CRLF conversion also drops the blank line added at install time', () => {
    fs.writeFileSync(bashrc, 'x=1\n');
    fs.writeFileSync(profile, 'p\n');
    installRcBlocks();
    fs.writeFileSync(profile, read(profile).replace(/\n/g, '\r\n'));
    removeRcBlocks();
    assert.equal(read(profile), 'p\r\n');
  });
  test('rcStatus: counts the user\'s own export, not the one inside the block', () => {
    fs.writeFileSync(bashrc, '  export CODEX_HOME=/x\n');
    fs.writeFileSync(profile, rcBlock());
    const s = rcStatus();
    assert.equal(s[1].hasUserExport, true);
    assert.equal(s[0].hasUserExport, false);
    assert.equal(s[0].hasBlock, true);
    fs.rmSync(profile);
    assert.deepEqual(rcStatus()[0], { file: profile, hasBlock: false, broken: false, hasUserExport: false });
  });
  test('missing END: removeRcBlocks throws and changes neither file; both broken → messages combined', () => {
    const brokenText = 'a=1\n' + RC_BEGIN + '\nexport CODEX_HOME=/x\nb=2\n';
    fs.writeFileSync(bashrc, brokenText, { mode: 0o600 });
    fs.writeFileSync(profile, 'p=1\n\n' + rcBlock());
    assert.throws(() => removeRcBlocks(), { message: `Marker block is incomplete (missing end marker); please check ${bashrc} manually` });
    assert.equal(read(bashrc), brokenText);
    assert.equal(read(profile), 'p=1\n\n' + rcBlock());
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
    fs.writeFileSync(profile, RC_BEGIN + '\n');
    assert.throws(() => removeRcBlocks(), (e: unknown) => e instanceof Error && e.message.includes(bashrc) && e.message.includes(profile));
  });
  test('both installed, END removed from ~/.profile → throws and ~/.bashrc is unchanged byte for byte', () => {
    fs.writeFileSync(bashrc, bashrcOrig);
    fs.writeFileSync(profile, profileOrig);
    installRcBlocks();
    const b = read(bashrc);
    const p = read(profile).replace(RC_END + '\n', '');
    fs.writeFileSync(profile, p);
    assert.throws(() => removeRcBlocks(), { message: `Marker block is incomplete (missing end marker); please check ${profile} manually` });
    assert.equal(read(bashrc), b);
    assert.equal(read(profile), p);
  });
  test('removeRcBlockFrom: single file, symlinked ~/.bashrc stays a symlink, target mode kept; missing END → throws unchanged', () => {
    fs.rmSync(bashrc, { force: true });
    const realBashrc = path.join(home, 'dotfiles', 'bashrc');
    fs.mkdirSync(path.dirname(realBashrc), { recursive: true });
    fs.writeFileSync(realBashrc, bashrcOrig, { mode: 0o640 });
    fs.symlinkSync(realBashrc, bashrc);
    fs.writeFileSync(profile, profileOrig);
    installRcBlocks();
    const p = read(profile);
    removeRcBlockFrom(bashrc);
    assert.ok(fs.lstatSync(bashrc).isSymbolicLink());
    assert.equal(read(realBashrc), bashrcOrig);
    assertMode(realBashrc, '640');
    assert.equal(read(profile), p, 'the other file is not touched');
    assert.deepEqual(fs.readdirSync(path.dirname(realBashrc)), ['bashrc']);
    removeRcBlockFrom(bashrc);
    assert.equal(read(realBashrc), bashrcOrig);
    const broken = 'a=1\n' + RC_BEGIN + '\n';
    fs.writeFileSync(realBashrc, broken);
    assert.throws(() => removeRcBlockFrom(bashrc), { message: `Marker block is incomplete (missing end marker); please check ${bashrc} manually` });
    assert.equal(read(realBashrc), broken);
    fs.unlinkSync(bashrc);
    fs.rmSync(path.dirname(realBashrc), { recursive: true });
    fs.writeFileSync(bashrc, 'x\n');
  });
  test('a dangling symlinked rc file is never replaced by a regular file', () => {
    fs.writeFileSync(bashrc, 'x\n');
    const saved = read(bashrc);
    fs.rmSync(profile, { force: true });
    fs.symlinkSync(path.join(home, 'dotfiles', 'missing-profile'), profile);
    assert.throws(() => installRcBlocks(), {
      message: `${profile} is a symbolic link whose target does not exist; fix the link before retrying`,
    });
    assert.ok(fs.lstatSync(profile).isSymbolicLink());
    assert.ok(!fs.existsSync(profile));
    assert.equal(rcStatus()[0].hasBlock, false);
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
    fs.unlinkSync(profile);
    fs.writeFileSync(profile, 'y\n');
    fs.writeFileSync(bashrc, saved);
  });
  test('removes every marker block', () => {
    fs.writeFileSync(bashrc, 'a=1\n\n' + rcBlock() + 'mid\n\n' + rcBlock() + rcBlock() + 'z=9\n');
    fs.writeFileSync(profile, rcBlock() + rcBlock());
    removeRcBlocks();
    assert.equal(read(bashrc), 'a=1\nmid\nz=9\n');
    assert.equal(read(profile), '');
  });
  test('atomic write: no temp file left, mode preserved, symlink writes go to the real target', () => {
    fs.writeFileSync(bashrc, 'x=1\n');
    fs.chmodSync(bashrc, 0o640);
    fs.rmSync(profile, { force: true });
    const realProfile = path.join(home, 'dotfiles', 'profile');
    fs.mkdirSync(path.dirname(realProfile), { recursive: true });
    fs.writeFileSync(realProfile, 'p=1\n', { mode: 0o600 });
    fs.symlinkSync(realProfile, profile);
    const inoBefore = fs.statSync(realProfile).ino;
    installRcBlocks();
    assertMode(bashrc, '640');
    assert.ok(fs.lstatSync(profile).isSymbolicLink());
    assert.equal(read(realProfile), 'p=1\n\n' + rcBlock());
    assertMode(realProfile, '600');
    assert.notEqual(fs.statSync(realProfile).ino, inoBefore, 'rename replaced the target inode');
    const leftovers = [...fs.readdirSync(home), ...fs.readdirSync(path.dirname(realProfile))].filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    removeRcBlocks();
    assert.ok(fs.lstatSync(profile).isSymbolicLink());
    assert.equal(read(realProfile), 'p=1\n');
    assertMode(realProfile, '600');
    assert.equal(read(bashrc), 'x=1\n');
    fs.unlinkSync(profile);
    fs.rmSync(path.dirname(realProfile), { recursive: true });
    fs.writeFileSync(profile, 'y\n');
    fs.chmodSync(bashrc, 0o644);
  });
  test('EACCES without read permission is thrown, not swallowed', { skip: process.getuid?.() === 0 ? 'root is not restricted by permissions' : false }, () => {
    fs.writeFileSync(bashrc, 'x\n');
    fs.chmodSync(bashrc, 0o000);
    try {
      assert.throws(() => rcStatus(), { code: 'EACCES' });
      assert.throws(() => preCheck(), { code: 'EACCES' });
      assert.throws(() => installRcBlocks(), { code: 'EACCES' });
      assert.throws(() => removeRcBlocks(), { code: 'EACCES' });
    } finally {
      fs.chmodSync(bashrc, 0o644);
    }
  });
});

describe('migrateLegacyCodex (pre-rename ai-switcher setup)', LINUX_ONLY, () => {
  const toLegacy = (text: string): string => text.replace(/_planswap_/g, '_ai_switcher_').replace(/planswap/g, 'ai-switcher');
  const legacyState = (): string => path.join(home, '.config', 'ai-switcher', 'codex-home');
  let installedBashrc: string;
  let installedProfile: string;

  /** Writes the rc files as 0.1.x installed them (the current install with the old names) and the legacy state file */
  const setup = (legacySelected: string | undefined): void => {
    fs.rmSync(STATE_FILE(), { force: true });
    fs.rmSync(path.dirname(legacyState()), { recursive: true, force: true });
    fs.writeFileSync(bashrc, bashrcOrig, { mode: 0o600 });
    fs.chmodSync(bashrc, 0o600);
    fs.writeFileSync(profile, profileOrig, { mode: 0o644 });
    fs.chmodSync(profile, 0o644);
    installRcBlocks();
    installedBashrc = read(bashrc);
    installedProfile = read(profile);
    fs.writeFileSync(bashrc, toLegacy(installedBashrc));
    fs.writeFileSync(profile, toLegacy(installedProfile));
    if (legacySelected !== undefined) {
      fs.mkdirSync(path.dirname(legacyState()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(legacyState(), legacySelected, { mode: 0o600 });
    }
  };
  after(() => {
    fs.rmSync(STATE_FILE(), { force: true });
    fs.rmSync(path.dirname(legacyState()), { recursive: true, force: true });
    fs.writeFileSync(bashrc, bashrcOrig);
    fs.writeFileSync(profile, profileOrig);
  });

  test('replaces the legacy blocks in place, keeps the selected account and modes, deletes the legacy state file', () => {
    const dir = path.join(home, '.codex-work');
    setup(dir);
    assert.deepEqual(rcStatus().map((s) => [s.hasBlock, s.hasUserExport]), [[false, true], [false, true]]);
    assert.equal(preCheck().ok, false);
    assert.equal(migrateLegacyCodex(), true);
    assert.equal(read(bashrc), installedBashrc);
    assert.equal(read(profile), installedProfile);
    assertMode(bashrc, '600');
    assertMode(profile, '644');
    assert.equal(readSelectedDir(), dir);
    assertMode(STATE_FILE(), '600');
    assert.equal(fs.existsSync(path.dirname(legacyState())), false);
    assert.deepEqual(rcStatus().map((s) => [s.hasBlock, s.hasUserExport]), [[true, false], [true, false]]);
    assert.equal(preCheck().ok, true);
    // Idempotent: nothing left to migrate
    assert.equal(migrateLegacyCodex(), false);
    assert.equal(read(bashrc), installedBashrc);
  });
  test('an empty legacy state file (default account) becomes an empty state file', () => {
    setup('');
    assert.equal(migrateLegacyCodex(), true);
    assert.equal(read(STATE_FILE()), '');
    assert.equal(readSelectedDir(), undefined);
  });
  test('a missing legacy state file leaves the state file missing; the rc blocks are still migrated', () => {
    setup(undefined);
    assert.equal(migrateLegacyCodex(), true);
    assert.equal(fs.existsSync(STATE_FILE()), false);
    assert.equal(read(bashrc), installedBashrc);
  });
  test('an existing current state file is not overwritten', () => {
    setup(path.join(home, '.codex-old'));
    writeSelectedDir(path.join(home, '.codex-new'));
    assert.equal(migrateLegacyCodex(), true);
    assert.equal(readSelectedDir(), path.join(home, '.codex-new'));
    assert.equal(fs.existsSync(legacyState()), false);
  });
  test('a legacy block without its end marker throws and changes nothing', () => {
    setup(path.join(home, '.codex-work'));
    const broken = read(bashrc).replace('# <<< ai-switcher codex <<<\n', '');
    fs.writeFileSync(bashrc, broken);
    const legacyProfile = read(profile);
    assert.throws(() => migrateLegacyCodex(), /\.bashrc/);
    assert.equal(read(bashrc), broken);
    assert.equal(read(profile), legacyProfile);
    assert.equal(fs.existsSync(STATE_FILE()), false);
    assert.equal(fs.existsSync(legacyState()), true);
  });
  test('without a legacy block nothing changes, even when a legacy state file exists', () => {
    setup(path.join(home, '.codex-work'));
    fs.writeFileSync(bashrc, installedBashrc);
    fs.writeFileSync(profile, installedProfile);
    assert.equal(migrateLegacyCodex(), false);
    assert.equal(fs.existsSync(legacyState()), true);
    assert.equal(fs.existsSync(STATE_FILE()), false);
  });
  test('a legacy block added by an old version next to a current block is dropped with its blank line; removal still restores exactly', () => {
    setup('');
    // What 0.1.x does in a file that already has the current block: before the guard after a blank line (.bashrc),
    // appended after a blank line (.profile)
    const guard = installedBashrc.indexOf('case $- in');
    fs.writeFileSync(bashrc, installedBashrc.slice(0, guard) + '\n' + toLegacy(rcBlock()) + installedBashrc.slice(guard));
    fs.writeFileSync(profile, installedProfile + '\n' + toLegacy(rcBlock()));
    assert.equal(migrateLegacyCodex(), true);
    assert.equal(read(bashrc), installedBashrc);
    assert.equal(read(profile), installedProfile);
    removeRcBlocks();
    assert.equal(read(bashrc), bashrcOrig);
    assert.equal(read(profile), profileOrig);
  });
  test('missing rc files are skipped', () => {
    setup('');
    fs.rmSync(profile);
    assert.equal(migrateLegacyCodex(), true);
    assert.equal(fs.existsSync(profile), false);
    assert.equal(read(bashrc), installedBashrc);
    fs.writeFileSync(profile, profileOrig);
  });
});

describe('preCheck', LINUX_ONLY, () => {
  before(() => {
    fs.writeFileSync(bashrc, 'x\n');
    fs.writeFileSync(profile, 'y\n');
  });
  test('bash + no conflicts → ok', () => {
    withEnv({ SHELL: '/bin/bash' }, () => assert.deepEqual(preCheck(), { ok: true, reasons: [] }));
  });
  test('SHELL not bash / unset → refused', () => {
    withEnv({ SHELL: '/usr/bin/zsh' }, () => {
      const r = preCheck();
      assert.equal(r.ok, false);
      assert.equal(r.reasons.length, 1);
      assert.match(r.reasons[0], /zsh/);
    });
    withEnv({ SHELL: undefined }, () => {
      const r = preCheck();
      assert.equal(r.ok, false);
      assert.equal(r.reasons[0], 'Login shell is not bash (current SHELL=unset); only bash is supported');
    });
  });
  test('.bash_profile / .bash_login not sourcing .bashrc → refused', () => {
    fs.writeFileSync(bashrc, 'x\n');
    fs.writeFileSync(profile, 'y\n');
    fs.writeFileSync(path.join(home, '.bash_profile'), 'echo hi\n');
    let r = preCheck();
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /bash_profile/);
    fs.writeFileSync(path.join(home, '.bash_profile'), '. ~/.bashrc\n');
    assert.equal(preCheck().ok, true);
    // A comment mentioning .bashrc does not source it
    fs.writeFileSync(path.join(home, '.bash_profile'), '# sources ~/.bashrc\necho hi\n');
    r = preCheck();
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /bash_profile/);
    fs.writeFileSync(path.join(home, '.bash_profile'), '# header\n[ -f ~/.bashrc ] && . ~/.bashrc\n');
    assert.equal(preCheck().ok, true);
    fs.writeFileSync(path.join(home, '.bash_login'), 'nothing\n');
    r = preCheck();
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /bash_login/);
    fs.rmSync(path.join(home, '.bash_login'));
    fs.rmSync(path.join(home, '.bash_profile'));
  });
  test('user export in both files → two reasons', () => {
    fs.writeFileSync(profile, 'export CODEX_HOME=/a\n');
    fs.writeFileSync(bashrc, 'export CODEX_HOME=/b\n');
    const r = preCheck();
    assert.equal(r.ok, false);
    assert.equal(r.reasons.length, 2);
  });
  test('broken: BEGIN without END, the export after it counts as outside the block', () => {
    fs.writeFileSync(bashrc, 'a=1\n' + RC_BEGIN + '\nexport CODEX_HOME=/x\n');
    fs.writeFileSync(profile, rcBlock() + RC_BEGIN + '\n');
    const s = rcStatus();
    assert.deepEqual(s[1], { file: bashrc, hasBlock: true, broken: true, hasUserExport: true });
    assert.deepEqual(s[0], { file: profile, hasBlock: true, broken: true, hasUserExport: false });
    const r = preCheck();
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, [
      `Marker block is incomplete; please fix ${profile} manually`,
      `Marker block is incomplete; please fix ${bashrc} manually`,
      `${bashrc} already has your own export CODEX_HOME, which conflicts`,
    ]);
    fs.writeFileSync(bashrc, rcBlock());
    fs.writeFileSync(profile, 'x\n');
    assert.deepEqual(rcStatus()[1], { file: bashrc, hasBlock: true, broken: false, hasUserExport: false });
    assert.equal(preCheck().ok, true);
  });
});

describe('selfCheck (real bash -i -l, clean environment)', LINUX_ONLY, () => {
  // selfCheck's internal spawnSync takes no env argument and only inherits process.env; during the call, process.env
  // is replaced with a minimal env -i style environment (HOME is the temp dir) so outer variables such as CODEX_HOME do not leak into the login shell
  const inCleanEnv = <T,>(fn: () => T): T => {
    const saved = process.env;
    process.env = { HOME: home, PATH: saved.PATH, SHELL: '/bin/bash', TERM: 'dumb', LANG: 'C.UTF-8' } as NodeJS.ProcessEnv;
    try {
      return fn();
    } finally {
      process.env = saved;
    }
  };
  before(() => {
    fs.writeFileSync(bashrc, bashrcOrig, { mode: 0o600 });
    fs.writeFileSync(profile, profileOrig, { mode: 0o644 });
    installRcBlocks();
  });
  test('passes, restores the state file (trimmed + resolved, 0600) and cleans up its temp directory', () => {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_FILE(), '  ' + home + '/.codex-orig\n', { mode: 0o644 });
    const r = inCleanEnv(selfCheck);
    assert.ok(r.ok, 'selfCheck failed: ' + r.detail);
    assert.match(r.detail, /^CODEX_HOME=/);
    assert.equal(read(STATE_FILE()), home + '/.codex-orig');
    assertMode(STATE_FILE(), '600');
    assert.deepEqual(fs.readdirSync(path.dirname(STATE_FILE())), ['codex-home']);
    // The login shell printed the temporary directory selfCheck created; it must be gone (other test files run
    // selfCheck concurrently, so the temp dir listing cannot be compared as a whole)
    const used = r.detail.slice('CODEX_HOME='.length);
    assert.ok(path.basename(used).startsWith('.selfcheck-') && path.dirname(used) === path.dirname(STATE_FILE()), used);
    assert.ok(!fs.existsSync(used), 'temporary directory left behind: ' + used);
  });
  test('state file originally missing → still missing after the self-check', () => {
    fs.rmSync(STATE_FILE(), { force: true });
    const r = inCleanEnv(selfCheck);
    assert.ok(r.ok, r.detail);
    assert.equal(fs.existsSync(STATE_FILE()), false);
  });
  test('state file originally blank → restored as empty', () => {
    fs.writeFileSync(STATE_FILE(), '  \n');
    const r = inCleanEnv(selfCheck);
    assert.ok(r.ok, r.detail);
    assert.equal(read(STATE_FILE()), '');
    assert.equal(readSelectedDir(), undefined);
  });
  test('fails when the marker block is missing, with bash noise filtered', () => {
    removeRcBlocks();
    const r = inCleanEnv(selfCheck);
    assert.equal(r.ok, false);
    assert.match(r.detail, /CODEX_HOME in the login shell is ""/);
    assert.ok(!r.detail.includes('cannot set terminal process group'));
    assert.ok(!r.detail.includes('no job control in this shell'));
  });
  test('login-shell output such as a sudo hint is never taken for the value', () => {
    removeRcBlocks();
    const saved = read(profile);
    fs.writeFileSync(profile, 'echo \'To run a command as administrator (user "root"), use "sudo <command>".\'\necho \'See "man sudo_root" for details.\'\n' + saved);
    try {
      const r = inCleanEnv(selfCheck);
      assert.equal(r.ok, false);
      assert.match(r.detail, /CODEX_HOME in the login shell is ""/);
    } finally {
      fs.writeFileSync(profile, saved);
    }
  });
});

describe('codexState in zh-cn', LINUX_ONLY, () => {
  before(() => {
    fs.writeFileSync(bashrc, 'a=1\n' + RC_BEGIN + '\n');
    fs.writeFileSync(profile, 'y\n');
    process.env.SHELL = '/usr/bin/zsh';
  });
  after(() => {
    setLocale('en');
    process.env.SHELL = '/bin/bash';
    fs.writeFileSync(bashrc, 'x\n');
  });
  test('preCheck and removeRcBlocks messages follow the locale', () => {
    setLocale('zh-cn');
    assert.deepEqual(preCheck().reasons, [
      '登录 shell 不是 bash（当前 SHELL=/usr/bin/zsh），仅支持 bash',
      `标记块不完整，请手工修复 ${bashrc}`,
    ]);
    assert.throws(() => removeRcBlocks(), { message: `标记块不完整（缺少结束标记），请手工检查 ${bashrc}` });
  });
});
