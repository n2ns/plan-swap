import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import {
  accountDir, checkSafeToDelete, claudeJsonPath, copySettingsStripped, defaultDir, deleteAccountDir,
  ensureAccountDir, formatClaudePlan, readAccountInfo, samePath, sameRealPath, scanAccountDirs,
  syncMcpServers,
} from '../src/paths';
import { assertTempHome, makeTempHome, assertMode, FILE_SYMLINKS, read, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
let def: string;

before(() => {
  tmp = makeTempHome('paths');
  home = tmp.home;
  def = path.join(home, '.claude');
  fs.mkdirSync(def, { recursive: true });
});
after(() => tmp.restore());

describe('formatClaudePlan', () => {
  test('combines plan name and multiplier', () => {
    assert.equal(formatClaudePlan('claude_max', 'default_claude_max_20x'), 'Max 20x');
    assert.equal(formatClaudePlan('claude_max', 'default_claude_max_5x'), 'Max 5x');
    assert.equal(formatClaudePlan('bar', 'x_3x'), 'Bar 3x');
  });
  test('maps known plan names', () => {
    assert.equal(formatClaudePlan('claude_pro', undefined), 'Pro');
    assert.equal(formatClaudePlan('claude_team'), 'Team');
    assert.equal(formatClaudePlan('team'), 'Team');
    assert.equal(formatClaudePlan('claude_enterprise'), 'Enterprise');
    assert.equal(formatClaudePlan('enterprise'), 'Enterprise');
  });
  test('unknown type: strips the claude_ prefix and capitalizes', () => {
    assert.equal(formatClaudePlan('claude_foo'), 'Foo');
  });
  test('tier without multiplier → plan name only; multiplier only → multiplier only', () => {
    assert.equal(formatClaudePlan('claude_pro', 'default'), 'Pro');
    assert.equal(formatClaudePlan(undefined, 'default_claude_max_20x'), '20x');
  });
  test('both empty → undefined', () => {
    assert.equal(formatClaudePlan(undefined, undefined), undefined);
    assert.equal(formatClaudePlan('', ''), undefined);
  });
});

describe('samePath / sameRealPath', () => {
  test('samePath normalizes trailing slashes and . / .. but does not resolve symlinks', () => {
    const link = path.join(home, 'same-link');
    fs.symlinkSync(def, link, 'junction');
    try {
      assert.ok(samePath(def, def + '/'));
      assert.ok(samePath(def, path.join(home, 'x', '..', '.claude')));
      assert.ok(!samePath(def, path.join(home, '.claude-a')));
      assert.ok(!samePath(def, link));
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('sameRealPath resolves symlinks; missing paths fall back to path.resolve', () => {
    const link = path.join(home, 'real-link');
    fs.symlinkSync(def, link, 'junction');
    try {
      assert.ok(sameRealPath(def, link + '/'));
      assert.ok(sameRealPath(path.join(home, 'missing'), path.join(home, 'missing') + '/'));
      assert.ok(!sameRealPath(def, path.join(home, 'missing')));
    } finally {
      fs.unlinkSync(link);
    }
  });
});

describe('defaultDir / accountDir / claudeJsonPath', () => {
  test('defaultDir defaults to ~/.claude; blank CLAUDE_CONFIG_DIR falls back', () => {
    assertTempHome(home);
    assert.equal(defaultDir(), def);
    process.env.CLAUDE_CONFIG_DIR = '   ';
    assert.equal(defaultDir(), def);
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  test('CLAUDE_CONFIG_DIR takes effect with trailing slash removed', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude-x') + '/';
    assert.equal(defaultDir(), path.join(home, '.claude-x'));
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  test('accountDir', () => {
    assert.equal(accountDir('work'), path.join(home, '.claude-work'));
  });
  test('claudeJsonPath: in the home directory for the default dir without the variable, otherwise inside the dir', () => {
    assert.equal(claudeJsonPath(def), path.join(home, '.claude.json'));
    assert.equal(claudeJsonPath(def + '/'), path.join(home, '.claude.json'));
    assert.equal(claudeJsonPath(path.join(home, '.claude-a')), path.join(home, '.claude-a', '.claude.json'));
    process.env.CLAUDE_CONFIG_DIR = def;
    assert.equal(claudeJsonPath(def), path.join(def, '.claude.json'));
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  test('claudeJsonPath: explicit → always inside the dir, even for the default dir without the variable', () => {
    assert.equal(claudeJsonPath(def, true), path.join(def, '.claude.json'));
    assert.equal(claudeJsonPath(def, false), path.join(home, '.claude.json'));
    assert.equal(claudeJsonPath(path.join(home, '.claude-a'), true), path.join(home, '.claude-a', '.claude.json'));
  });
});

describe('readAccountInfo', () => {
  const mk = (name: string): string => {
    const d = path.join(home, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  test('no files → not logged in', () => {
    assert.deepEqual(readAccountInfo(mk('.claude-r0')), { email: undefined, plan: undefined, loggedIn: false });
  });
  test('email + plan', () => {
    const d = mk('.claude-r1');
    fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fake@example.com', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' } }));
    assert.deepEqual(readAccountInfo(d), { email: 'fake@example.com', plan: 'Max 20x', loggedIn: true });
  });
  test('organizationType only', () => {
    const d = mk('.claude-r2');
    fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'p@example.com', organizationType: 'claude_pro' } }));
    assert.deepEqual(readAccountInfo(d), { email: 'p@example.com', plan: 'Pro', loggedIn: true });
  });
  test('email only, no plan fields', () => {
    const d = mk('.claude-r3');
    fs.writeFileSync(path.join(d, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@b.c"}}');
    assert.deepEqual(readAccountInfo(d), { email: 'a@b.c', plan: undefined, loggedIn: true });
  });
  test('truncated JSON / null does not throw', () => {
    const d = mk('.claude-r4');
    fs.writeFileSync(path.join(d, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@b.c"');
    assert.deepEqual(readAccountInfo(d), { email: undefined, plan: undefined, loggedIn: false });
    fs.writeFileSync(path.join(d, '.claude.json'), 'null');
    assert.deepEqual(readAccountInfo(d), { email: undefined, plan: undefined, loggedIn: false });
  });
  test('only the credentials file exists → loggedIn (content not read)', () => {
    const d = mk('.claude-r5');
    fs.writeFileSync(path.join(d, '.credentials.json'), 'not json at all');
    assert.deepEqual(readAccountInfo(d), { email: undefined, plan: undefined, loggedIn: true });
  });
  test('default directory reads ~/.claude.json', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'd@example.com' } }));
    assert.equal(readAccountInfo(def).email, 'd@example.com');
    fs.rmSync(path.join(home, '.claude.json'));
  });
  test('default directory with explicit → reads ~/.claude/.claude.json instead of ~/.claude.json', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'home@example.com' } }));
    fs.writeFileSync(path.join(def, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'inner@example.com' } }));
    assert.equal(readAccountInfo(def, true).email, 'inner@example.com');
    assert.equal(readAccountInfo(def).email, 'home@example.com');
    fs.rmSync(path.join(home, '.claude.json'));
    fs.rmSync(path.join(def, '.claude.json'));
  });
  test('identity from accountUuid + organizationUuid', () => {
    const d = mk('.claude-id1');
    fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'i@example.com', accountUuid: 'acct-1', organizationUuid: 'org-1', organizationType: 'claude_pro' } }));
    assert.deepEqual(readAccountInfo(d), { email: 'i@example.com', plan: 'Pro', loggedIn: true, identity: 'claude:acct-1\norg-1' });
  });
  test('identity requires both uuids as non-empty strings', () => {
    const d = mk('.claude-id2');
    const write = (oauth: unknown): void => fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: oauth }));
    write({ emailAddress: 'i@example.com', accountUuid: 'acct-2' });
    assert.deepEqual(readAccountInfo(d), { email: 'i@example.com', plan: undefined, loggedIn: true });
    write({ emailAddress: 'i@example.com', organizationUuid: 'org-2', accountUuid: '' });
    assert.equal(readAccountInfo(d).identity, undefined);
    write({ emailAddress: 'i@example.com', accountUuid: 7, organizationUuid: 'org-2' });
    assert.equal(readAccountInfo(d).identity, undefined);
  });
  test('oauthAccount not an object → no identity', () => {
    const d = mk('.claude-id3');
    fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: 'acct-3', accountUuid: 'acct-3', organizationUuid: 'org-3' }));
    assert.deepEqual(readAccountInfo(d), { email: undefined, plan: undefined, loggedIn: false });
  });
  test('same account in different organizations → different identity', () => {
    const a = mk('.claude-id4a');
    const b = mk('.claude-id4b');
    fs.writeFileSync(path.join(a, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-4', organizationUuid: 'org-a' } }));
    fs.writeFileSync(path.join(b, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-4', organizationUuid: 'org-b' } }));
    const ia = readAccountInfo(a).identity;
    assert.ok(ia);
    assert.notEqual(ia, readAccountInfo(b).identity);
  });
});

describe('copySettingsStripped', () => {
  test('strips sensitive keys and writes with 0600', () => {
    fs.writeFileSync(path.join(def, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: 'x', KEEP: '1' },
      apiKeyHelper: 'x', forceLoginMethod: 'x', forceLoginOrgUUID: 'x', enabledPlugins: {}, extraKnownMarketplaces: {}, additionalMarketplaces: [],
      model: 'opus', permissions: { allow: ['Bash'] },
    }));
    const work = accountDir('work');
    ensureAccountDir(work);
    assertMode(work, '700');
    assert.equal(copySettingsStripped(def, work), true);
    assert.deepEqual(JSON.parse(read(path.join(work, 'settings.json'))), { env: { KEEP: '1' }, model: 'opus', permissions: { allow: ['Bash'] } });
    assertMode(path.join(work, 'settings.json'), '600');
  });
  test('does not overwrite an existing target', () => {
    const work = accountDir('work');
    fs.writeFileSync(path.join(work, 'settings.json'), '{"mine":1}');
    assert.equal(copySettingsStripped(def, work), false);
    assert.equal(read(path.join(work, 'settings.json')), '{"mine":1}');
  });
  test('source missing / invalid JSON / not an object → false', () => {
    const w2 = accountDir('w2');
    ensureAccountDir(w2);
    assert.equal(copySettingsStripped(path.join(home, 'nope'), w2), false);
    fs.writeFileSync(path.join(def, 'settings.json'), '{bad');
    assert.equal(copySettingsStripped(def, w2), false);
    fs.writeFileSync(path.join(def, 'settings.json'), '[1]');
    assert.equal(copySettingsStripped(def, w2), false);
    assert.ok(!fs.existsSync(path.join(w2, 'settings.json')));
  });
  test('env stripped empty keeps an empty object', () => {
    const w2 = accountDir('w2');
    fs.writeFileSync(path.join(def, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    assert.equal(copySettingsStripped(def, w2), true);
    assert.deepEqual(JSON.parse(read(path.join(w2, 'settings.json'))), { env: {} });
  });
});

// Entries shared by the scan and deletion tests; created on demand so each describe works on its own
function ensureScanFixtures(): void {
  for (const d of [accountDir('work'), accountDir('w2'), path.join(home, '.claude-bad name'), path.join(home, '.claude-'), path.join(home, 'other')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(path.join(home, '.claude-file'))) fs.writeFileSync(path.join(home, '.claude-file'), '');
  try {
    fs.lstatSync(path.join(home, '.claude-link'));
  } catch {
    fs.symlinkSync(accountDir('work'), path.join(home, '.claude-link'), 'junction');
  }
}

describe('scanAccountDirs', () => {
  before(ensureScanFixtures);
  test('filters symlinks, files, invalid names', () => {
    const names = scanAccountDirs().map((a) => a.name);
    assert.ok(names.includes('work') && names.includes('w2'), String(names));
    for (const bad of ['link', 'file', 'bad name', '']) assert.ok(!names.includes(bad), `must not include "${bad}"`);
    assert.equal(scanAccountDirs().find((a) => a.name === 'work')?.dir, accountDir('work'));
  });
  test('excludes the default directory pointed to by CLAUDE_CONFIG_DIR (realpath comparison)', () => {
    process.env.CLAUDE_CONFIG_DIR = accountDir('work') + '/';
    assert.ok(!scanAccountDirs().some((a) => a.name === 'work'));
    assert.ok(scanAccountDirs().some((a) => a.name === 'w2'));
    delete process.env.CLAUDE_CONFIG_DIR;
  });
});

describe('checkSafeToDelete / deleteAccountDir', () => {
  before(ensureScanFixtures);
  test('refuses the default directory (including one set via CLAUDE_CONFIG_DIR)', () => {
    process.env.CLAUDE_CONFIG_DIR = accountDir('work');
    try {
      assert.equal(checkSafeToDelete(accountDir('work')), `Cannot delete the default account directory: ${accountDir('work')}`);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    assert.match(checkSafeToDelete(def) ?? '', /format|default account directory/);
  });
  test('refuses symlinks, the home directory itself, outside home, .. escape, invalid names, files, missing', () => {
    assert.equal(checkSafeToDelete(path.join(home, '.claude-link')), `Directory is a symbolic link; refusing to delete: ${path.join(home, '.claude-link')}`);
    assert.match(checkSafeToDelete(home) ?? '', /not a direct child of the home directory/);
    assert.equal(checkSafeToDelete('/tmp/.claude-x'), `Directory is not a direct child of the home directory: ${path.resolve('/tmp/.claude-x')}`);
    assert.match(checkSafeToDelete(path.join(home, '..', '.claude-x')) ?? '', /not a direct child of the home directory/);
    assert.equal(checkSafeToDelete(path.join(home, 'other')), `Directory name does not match the .claude-<name> format: ${path.join(home, 'other')}`);
    assert.equal(checkSafeToDelete(path.join(home, '.claude-file')), `Path is not a directory: ${path.join(home, '.claude-file')}`);
    assert.equal(checkSafeToDelete(path.join(home, '.claude-gone')), `Directory does not exist: ${path.join(home, '.claude-gone')}`);
  });
  test('a valid directory passes', () => {
    assert.equal(checkSafeToDelete(accountDir('w2')), undefined);
  });
  test('deleteAccountDir refuses a symlink without touching its target; deletes a valid directory', async () => {
    await assert.rejects(deleteAccountDir(path.join(home, '.claude-link')), /symbolic link/);
    assert.ok(fs.existsSync(accountDir('work')));
    await deleteAccountDir(accountDir('w2'));
    assert.ok(!fs.existsSync(accountDir('w2')));
  });
});

describe('syncMcpServers', () => {
  const src = (): string => path.join(home, 'mcp-source.json');
  const setSource = (servers: unknown): void => fs.writeFileSync(src(), JSON.stringify({ oauthAccount: { emailAddress: 'x@y' }, mcpServers: servers }));
  const mk = (n: string): string => {
    const d = accountDir('mcp-' + n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const target = (d: string): Record<string, unknown> => JSON.parse(read(path.join(d, '.claude.json')));
  const one = { type: 'stdio', command: 'npx', args: ['-y', 'one'], env: {} };
  const two = { type: 'http', url: 'https://example.com/mcp' };

  test('missing target → created 0600 with only mcpServers', () => {
    setSource({ one, two });
    const a = mk('a');
    assert.deepEqual(syncMcpServers(src(), a), { added: ['one', 'two'], kept: [] });
    assert.deepEqual(target(a), { mcpServers: { one, two } });
    assertMode(path.join(a, '.claude.json'), '600');
  });

  test('merges into an existing file: adds missing, skips identical, keeps differing, removes nothing, keeps other keys and mode', () => {
    setSource({ one, two });
    const b = mk('b');
    const file = path.join(b, '.claude.json');
    const own = { type: 'stdio', command: 'own' };
    fs.writeFileSync(file, JSON.stringify({ userID: 'u', mcpServers: { one, two: own, mine: own } }), { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    assert.deepEqual(syncMcpServers(src(), b), { added: [], kept: ['two'] });
    setSource({ one, two, three: two });
    assert.deepEqual(syncMcpServers(src(), b), { added: ['three'], kept: ['two'] });
    assert.deepEqual(target(b), { userID: 'u', mcpServers: { one, two: own, mine: own, three: two } });
    assertMode(file, '640');
    assert.deepEqual(fs.readdirSync(b), ['.claude.json']);
  });

  test('no source servers (missing file, invalid JSON, empty) → nothing written', () => {
    const c = mk('c');
    assert.deepEqual(syncMcpServers(path.join(home, 'nope.json'), c), { added: [], kept: [] });
    fs.writeFileSync(src(), '{ half');
    assert.deepEqual(syncMcpServers(src(), c), { added: [], kept: [] });
    setSource({});
    assert.deepEqual(syncMcpServers(src(), c), { added: [], kept: [] });
    assert.ok(!fs.existsSync(path.join(c, '.claude.json')));
  });

  test('target that is not a JSON object → throws and is left unchanged', () => {
    setSource({ one });
    const d = mk('d');
    for (const text of ['{ half', '[]']) {
      fs.writeFileSync(path.join(d, '.claude.json'), text);
      assert.throws(() => syncMcpServers(src(), d), /Not a valid JSON object/);
      assert.equal(read(path.join(d, '.claude.json')), text);
    }
  });

  test('a symlinked target is written through, keeping the link', FILE_SYMLINKS, () => {
    setSource({ one });
    const e = mk('e');
    const real = path.join(home, 'real-claude.json');
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, path.join(e, '.claude.json'));
    assert.deepEqual(syncMcpServers(src(), e).added, ['one']);
    assert.ok(fs.lstatSync(path.join(e, '.claude.json')).isSymbolicLink());
    assert.deepEqual(JSON.parse(read(real)), { mcpServers: { one } });
  });

  test('the default dir is never written', () => {
    setSource({ one });
    assert.deepEqual(syncMcpServers(src(), def), { added: [], kept: [] });
    assert.ok(!fs.existsSync(path.join(def, '.claude.json')));
  });

  test('a target rewritten by the CLI between read and rename is left unchanged and reported', () => {
    setSource({ one });
    const f = mk('f');
    const file = path.join(f, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ userID: 'u' }));
    const rewritten = JSON.stringify({ userID: 'u', numStartups: 2 });
    assert.throws(() => syncMcpServers(src(), f, () => fs.writeFileSync(file, rewritten)), { message: t('mcp.changed', { file }) });
    assert.equal(read(file), rewritten);
    assert.deepEqual(fs.readdirSync(f), ['.claude.json']);
    assert.deepEqual(syncMcpServers(src(), f), { added: ['one'], kept: [] });
    assert.deepEqual(target(f), { userID: 'u', numStartups: 2, mcpServers: { one } });
  });
});

describe('checkSafeToDelete in zh-cn', () => {
  after(() => setLocale('en'));
  test('reasons follow the locale', () => {
    setLocale('zh-cn');
    assert.equal(checkSafeToDelete('/tmp/.claude-x'), `目录不是用户主目录的直接子目录：${path.resolve('/tmp/.claude-x')}`);
    assert.equal(checkSafeToDelete(path.join(home, '.claude-gone')), `目录不存在：${path.join(home, '.claude-gone')}`);
  });
});
