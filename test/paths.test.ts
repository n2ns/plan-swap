import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as path from 'node:path';
import { setLocale, t } from '../src/i18n';
import {
  accountDir, checkSafeToDelete, claudeJsonPath, copySettingsStripped, defaultDir, deleteAccountDir,
  ensureAccountDir, formatClaudePlan, readAccountInfo, samePath, sameRealPath, scanAccountDirs,
  findSameDir, realPath, setClaudeSettingEnv, syncMcpServers,
} from '../src/paths';
import { assertTempHome, makeTempHome, assertMode, FILE_SYMLINKS, read, withEnv, type TempHome } from './helpers';

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
    withEnv({ CLAUDE_CONFIG_DIR: '   ' }, () => assert.equal(defaultDir(), def));
  });
  test('CLAUDE_CONFIG_DIR is used as is, surrounding spaces included, as Claude Code does', () => {
    withEnv({ CLAUDE_CONFIG_DIR: path.join(home, 'with space ') }, () =>
      assert.equal(defaultDir(), path.resolve(path.join(home, 'with space '))));
  });
  test('the info file is .claude-custom-oauth.json while Claude Code sees CLAUDE_CODE_CUSTOM_OAUTH_URL', () => {
    const acc = accountDir('oauth');
    assert.equal(claudeJsonPath(acc), path.join(acc, '.claude.json'));
    try {
      withEnv({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://auth.example' }, () => {
        assert.equal(claudeJsonPath(acc), path.join(acc, '.claude-custom-oauth.json'));
        assert.equal(claudeJsonPath(def), path.join(home, '.claude-custom-oauth.json'));
        // The setting can clear the inherited variable for Claude Code, or set it
        setClaudeSettingEnv({ set: [], cleared: ['CLAUDE_CODE_CUSTOM_OAUTH_URL'] });
        assert.equal(claudeJsonPath(acc), path.join(acc, '.claude.json'));
      });
      setClaudeSettingEnv({ set: ['CLAUDE_CODE_CUSTOM_OAUTH_URL'], cleared: [] });
      assert.equal(claudeJsonPath(acc), path.join(acc, '.claude-custom-oauth.json'));
    } finally {
      setClaudeSettingEnv({ set: [], cleared: [] });
    }
  });
  test('findSameDir prefers the same spelling and falls back to another spelling of the folder', () => {
    const a = path.join(home, 'find-a');
    const b = path.join(home, 'find-b');
    const alias = path.join(home, 'find-alias');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.symlinkSync(b, alias, 'junction');
    assert.equal(findSameDir([a, b], b), 1);
    assert.equal(findSameDir([a, b], alias), 1);
    assert.equal(findSameDir([alias, b], b), 1);
    assert.equal(findSameDir([a], b), -1);
    assert.equal(findSameDir([a], path.join(home, 'missing')), -1);
  });
  test('CLAUDE_CONFIG_DIR takes effect with trailing slash removed', () => {
    withEnv({ CLAUDE_CONFIG_DIR: path.join(home, '.claude-x') + '/' }, () =>
      assert.equal(defaultDir(), path.join(home, '.claude-x')));
  });
  test('accountDir', () => {
    assert.equal(accountDir('work'), path.join(home, '.claude-work'));
  });
  test('claudeJsonPath: in the home directory for the default dir without the variable, otherwise inside the dir', () => {
    assert.equal(claudeJsonPath(def), path.join(home, '.claude.json'));
    assert.equal(claudeJsonPath(def + '/'), path.join(home, '.claude.json'));
    assert.equal(claudeJsonPath(path.join(home, '.claude-a')), path.join(home, '.claude-a', '.claude.json'));
    withEnv({ CLAUDE_CONFIG_DIR: def }, () => assert.equal(claudeJsonPath(def), path.join(def, '.claude.json')));
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
      env: {
        ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_PROFILE: 'x', CLAUDE_CONFIG_DIR: 'x',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: 'x', ANTHROPIC_FEDERATION_RULE_ID: 'x', ANTHROPIC_ORGANIZATION_ID: 'x', KEEP: '1',
      },
      apiKeyHelper: 'x', forceLoginMethod: 'x', forceLoginOrgUUID: 'x', enabledPlugins: {}, extraKnownMarketplaces: {}, additionalMarketplaces: [],
      model: 'opus', permissions: { allow: ['Bash'] },
    }));
    const work = accountDir('work');
    ensureAccountDir(work);
    assertMode(work, '700');
    assert.equal(copySettingsStripped(def, work), true);
    // forceLoginOrgUUID only pre-selects an organization outside managed settings: kept
    assert.deepEqual(JSON.parse(read(path.join(work, 'settings.json'))), { env: { KEEP: '1' }, forceLoginOrgUUID: 'x', model: 'opus', permissions: { allow: ['Bash'] } });
    assertMode(path.join(work, 'settings.json'), '600');
    // One federation variable alone is no credential: kept
    const solo = accountDir('solo');
    ensureAccountDir(solo);
    fs.writeFileSync(path.join(def, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_ORGANIZATION_ID: 'o' } }));
    assert.equal(copySettingsStripped(def, solo), true);
    assert.deepEqual(JSON.parse(read(path.join(solo, 'settings.json'))), { env: { ANTHROPIC_ORGANIZATION_ID: 'o' } });
  });
  test('reads a settings.json saved with a byte order mark', () => {
    fs.writeFileSync(path.join(def, 'settings.json'), '﻿{"model":"opus","apiKeyHelper":"x"}');
    const bom = accountDir('bom');
    ensureAccountDir(bom);
    assert.equal(copySettingsStripped(def, bom), true);
    assert.deepEqual(JSON.parse(read(path.join(bom, 'settings.json'))), { model: 'opus' });
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
    withEnv({ CLAUDE_CONFIG_DIR: accountDir('work') + '/' }, () => {
      assert.ok(!scanAccountDirs().some((a) => a.name === 'work'));
      assert.ok(scanAccountDirs().some((a) => a.name === 'w2'));
    });
  });
});

describe('checkSafeToDelete / deleteAccountDir', () => {
  before(ensureScanFixtures);
  test('refuses the default directory (including one set via CLAUDE_CONFIG_DIR)', () => {
    withEnv({ CLAUDE_CONFIG_DIR: accountDir('work') }, () =>
      assert.equal(checkSafeToDelete(accountDir('work')), `Cannot delete the default account directory: ${accountDir('work')}`));
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

  test('protected info aliases are rejected before their payload is read', FILE_SYMLINKS, (ctx) => {
    setSource({ one });
    const a = mk('protected');
    const file = path.join(a, '.claude.json');
    const external = path.join(home, 'external-protected.json');
    fs.writeFileSync(external, '{}');
    const defaultAlias = path.join(def, 'security-settings.json');
    fs.symlinkSync(external, defaultAlias);
    const credentialAlias = path.join(a, '.credentials.json');
    const renamedCredential = path.join(home, 'renamed-credential.json');
    fs.writeFileSync(renamedCredential, '{}');
    fs.symlinkSync(renamedCredential, credentialAlias);
    const other = mk('other-credentials');
    const otherCredential = path.join(other, '.credentials.json');
    const externalOther = path.join(home, 'external-other.json');
    fs.writeFileSync(externalOther, '{}');
    fs.symlinkSync(externalOther, otherCredential);
    const targets = [src(), external, renamedCredential, otherCredential, path.join(def, 'security-default.json'),
      ...['.claude.json', '.claude-custom-oauth.json'].flatMap((name) => [path.join(home, name), path.join(def, name)]),
      path.join(home, '.credentials.json'), path.join(home, 'auth.json')];
    const created: string[] = [];
    for (const destination of targets) {
      if (!fs.existsSync(destination)) { fs.writeFileSync(destination, '{}'); created.push(destination); }
      fs.symlinkSync(destination, file);
      const originalRead = fsModule.readFileSync;
      const spy = ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        assert.ok(typeof candidate !== 'string' || candidate === src() || !sameRealPath(candidate, destination), 'protected target payload must not be opened');
        return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
      }) as typeof fs.readFileSync);
      try { assert.throws(() => syncMcpServers(src(), a), { message: t('mcp.unsafeTarget', { file }) }); }
      finally { spy.mock.restore(); fs.unlinkSync(file); }
    }
    for (const destination of created) fs.unlinkSync(destination);
    fs.unlinkSync(defaultAlias);
    fs.unlinkSync(credentialAlias);
  });

  test('neutral external aliases of other managed credentials and nested default hops are rejected', FILE_SYMLINKS, (ctx) => {
    setSource({ one });
    const a = mk('neutral-backing');
    const file = path.join(a, '.claude.json');
    const other = mk('neutral-owner');
    const external = path.join(home, 'neutral-backing.json'); fs.writeFileSync(external, '{}');
    const owner = path.join(other, '.credentials.json'); fs.symlinkSync(external, owner);
    const nested = path.join(def, 'security-rules', 'linked-rule.json');
    fs.mkdirSync(path.dirname(nested), { recursive: true }); fs.symlinkSync(external, nested);
    const originalRead = fsModule.readFileSync;
    const spy = ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.ok(typeof candidate !== 'string' || !sameRealPath(candidate, external), 'external protected payload must not be opened');
      return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
    }) as typeof fs.readFileSync);
    for (const destination of [external, nested]) {
      // The nested-default test must independently establish protection without the sibling credential alias.
      if (destination === nested) fs.unlinkSync(owner);
      fs.symlinkSync(destination, file);
      assert.throws(() => syncMcpServers(src(), a), { message: t('mcp.unsafeTarget', { file }) });
      if (destination === nested) {
        const alias = path.join(home, 'security-default-alias'); fs.symlinkSync(def, alias, 'junction');
        withEnv({ CLAUDE_CONFIG_DIR: alias }, () => {
          assert.throws(() => syncMcpServers(src(), a), { message: t('mcp.unsafeTarget', { file }) });
        });
        fs.unlinkSync(alias);
      }
      assert.ok(fs.lstatSync(file).isSymbolicLink()); fs.unlinkSync(file);
    }
    spy.mock.restore();
    assert.equal(read(external), '{}');
    fs.unlinkSync(nested); fs.rmdirSync(path.dirname(nested));
  });

  test('empty MCP sources remain a no-op even for protected info targets', FILE_SYMLINKS, () => {
    setSource({});
    const a = mk('empty-protected');
    const file = path.join(a, '.claude.json');
    const credential = path.join(a, '.credentials.json'); fs.writeFileSync(credential, '{}'); fs.symlinkSync(credential, file);
    assert.deepEqual(syncMcpServers(src(), a), { added: [], kept: [] });
    assert.equal(read(credential), '{}'); assert.ok(fs.lstatSync(file).isSymbolicLink());
  });

  test('hard-linked and dangling info targets are refused unchanged', FILE_SYMLINKS, () => {
    setSource({ one });
    const a = mk('hard-dangling');
    const file = path.join(a, '.claude.json');
    const external = path.join(home, 'hardlink-info.json');
    fs.writeFileSync(external, '{}');
    fs.linkSync(external, file);
    assert.throws(() => syncMcpServers(src(), a), { message: t('mcp.unsafeTarget', { file }) });
    assert.equal(read(external), '{}');
    fs.unlinkSync(file);
    const missing = path.join(home, 'missing-info.json');
    fs.symlinkSync(missing, file);
    assert.throws(() => syncMcpServers(src(), a), { message: t('mcp.unsafeTarget', { file }) });
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.ok(!fs.existsSync(missing));
  });

  test('a protected replacement before commit is rejected before comparison reads it', FILE_SYMLINKS, (ctx) => {
    setSource({ one });
    const a = mk('protected-race');
    const file = path.join(a, '.claude.json');
    const credential = path.join(a, '.credentials.json');
    fs.writeFileSync(file, '{}');
    fs.writeFileSync(credential, '{}');
    const originalRead = fsModule.readFileSync;
    ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.ok(typeof candidate !== 'string' || !sameRealPath(candidate, credential), 'credential payload must not be opened');
      return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
    }) as typeof fs.readFileSync);
    assert.throws(() => syncMcpServers(src(), a, () => {
      fs.unlinkSync(file); fs.symlinkSync(credential, file);
    }), { message: t('mcp.unsafeTarget', { file }) });
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(a).sort(), ['.claude.json', '.credentials.json']);
  });

  test('Windows rename retries revalidate a newly introduced credential alias before reading it', FILE_SYMLINKS, (ctx) => {
    setSource({ one });
    const a = mk('retry-protected');
    const file = path.join(a, '.claude.json');
    const credential = path.join(a, '.credentials.json');
    fs.writeFileSync(file, '{}'); fs.writeFileSync(credential, '{}');
    const originalRead = fsModule.readFileSync;
    ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.ok(typeof candidate !== 'string' || !sameRealPath(candidate, credential), 'retry must not open credentials');
      return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
    }) as typeof fs.readFileSync);
    const originalRename = fsModule.renameSync;
    let attempts = 0;
    ctx.mock.method(fsModule, 'renameSync', ((from: fs.PathLike, to: fs.PathLike) => {
      if (sameRealPath(String(to), file)) {
        attempts++;
        fs.unlinkSync(file); fs.symlinkSync(credential, file);
        throw Object.assign(new Error('synthetic lock'), { code: 'EPERM' });
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { assert.throws(() => syncMcpServers(src(), a), { message: t('mcp.unsafeTarget', { file }) }); }
    finally { Object.defineProperty(process, 'platform', platform); }
    assert.equal(attempts, 1);
    assert.ok(fs.lstatSync(file).isSymbolicLink());
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
    assert.throws(() => syncMcpServers(src(), f, () => fs.writeFileSync(file, rewritten)), { message: t('mcp.changed', { file: realPath(file) }) });
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
