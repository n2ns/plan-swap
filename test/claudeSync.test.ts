// syncClaudeAccount (src/claudeSync.ts): the three-way sync of a shared account's info file and MCP sign-ins with the
// default account, in a temporary HOME
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsModule from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { setLocale, t } from '../src/i18n';
import { syncClaudeAccount } from '../src/claudeSync';
import { accountDir, realPath } from '../src/paths';
import { assertMode, assertTempHome, FILE_SYMLINKS, makeTempHome, read, type TempHome, withEnv } from './helpers';

let tmp: TempHome;
let home: string;
let def: string;

before(() => {
  tmp = makeTempHome('sync');
  home = tmp.home;
  def = path.join(home, '.claude');
  setLocale('en');
});
after(() => tmp.restore());

// Fresh default dir and no account dirs before each test
beforeEach(() => {
  assertTempHome(home);
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
  fs.mkdirSync(def, { mode: 0o700 });
});

const write = (f: string, content: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

describe('syncClaudeAccount', () => {
  const src = (): string => path.join(home, '.claude.json');
  const info = (dir: string): Record<string, any> => JSON.parse(read(path.join(dir, '.claude.json')));
  const STRIPE = { type: 'http', url: 'https://mcp.stripe.com/' };

  test('full sync merges both ways, keeps other keys and modes, records the base and skips unchanged files', () => {
    write(src(), JSON.stringify({
      oauthAccount: { emailAddress: 'def@x' },
      mcpServers: { a: { command: 'a' }, b: { command: 'b' } },
      projects: { '/p': { allowedTools: ['X'], hasTrustDialogAccepted: true, history: ['secret'] } },
    }));
    fs.chmodSync(src(), 0o640);
    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'acc@x' },
      mcpServers: { b: { command: 'own' }, c: { command: 'c' } },
      projects: { '/p': { allowedTools: [], lastCost: 3 }, '/q': { allowedTools: ['Q'] } },
    }));
    fs.chmodSync(path.join(acc, '.claude.json'), 0o640);
    // No base yet: nothing is removed, the account in use wins a differing server
    const r = syncClaudeAccount(src(), acc, 'full', { inUse: true });
    assert.deepEqual(r.changed, ['mcpServers', 'projects:/p']);
    assert.deepEqual(r.defaultChanged, ['mcpServers', 'projects:/q']);
    const data = info(acc);
    const defData = JSON.parse(read(src()));
    assert.deepEqual(data.mcpServers, { b: { command: 'own' }, c: { command: 'c' }, a: { command: 'a' } });
    assert.deepEqual(defData.mcpServers, { a: { command: 'a' }, b: { command: 'own' }, c: { command: 'c' } });
    assert.deepEqual(data.oauthAccount, { emailAddress: 'acc@x' });
    assert.deepEqual(defData.oauthAccount, { emailAddress: 'def@x' });
    assert.deepEqual(data.projects['/p'], { allowedTools: ['X'], lastCost: 3, hasTrustDialogAccepted: true });
    assert.deepEqual(defData.projects['/p'], { allowedTools: ['X'], hasTrustDialogAccepted: true, history: ['secret'] });
    assert.deepEqual(defData.projects['/q'], { allowedTools: ['Q'] });
    assertMode(path.join(acc, '.claude.json'), '640');
    assertMode(src(), '640');
    assertMode(path.join(acc, '.planswap-sync.json'), '600');
    assert.ok(!read(path.join(acc, '.planswap-sync.json')).includes('own'), 'the base holds hashes only');

    // In sync → no write
    const texts = [read(src()), read(path.join(acc, '.claude.json')), read(path.join(acc, '.planswap-sync.json'))];
    assert.deepEqual(syncClaudeAccount(src(), acc), { changed: [], defaultChanged: [] });
    assert.deepEqual([read(src()), read(path.join(acc, '.claude.json')), read(path.join(acc, '.planswap-sync.json'))], texts);
  });

  test('a change on either side since the last sync survives, removals included, and the account wins a conflict', () => {
    write(src(), JSON.stringify({ mcpServers: { keep: { command: 'k' }, dropByAccount: { command: 'd' }, dropByDefault: { command: 'e' }, both: { command: 'old' } } }));
    const acc = accountDir('a');
    fs.mkdirSync(acc);
    syncClaudeAccount(src(), acc);
    // The default gains a project server and loses one; the account changes one, removes one and adds one
    const defData = JSON.parse(read(src()));
    delete defData.mcpServers.dropByDefault;
    defData.mcpServers.both = { command: 'default' };
    defData.projects = { '/w': { mcpServers: { stripe: STRIPE } } };
    write(src(), JSON.stringify(defData));
    const accData = info(acc);
    delete accData.mcpServers.dropByAccount;
    accData.mcpServers.both = { command: 'account' };
    accData.mcpServers.added = { command: 'a' };
    write(path.join(acc, '.claude.json'), JSON.stringify(accData));
    syncClaudeAccount(src(), acc);
    const expected = { keep: { command: 'k' }, both: { command: 'account' }, added: { command: 'a' } };
    for (const data of [JSON.parse(read(src())), info(acc)]) {
      assert.deepEqual(data.mcpServers, expected);
      assert.deepEqual(data.projects['/w'].mcpServers, { stripe: STRIPE });
    }
  });

  test('without a base a value differing on both sides takes the side in use, and nothing is removed', () => {
    // Before this version the account's copy was a mirror; the default changed a server and removed one meanwhile
    const defaults = { api: { url: 'v2' }, keep: { command: 'k' } };
    write(src(), JSON.stringify({ mcpServers: defaults }));
    const idle = accountDir('idle');
    write(path.join(idle, '.claude.json'), JSON.stringify({ mcpServers: { api: { url: 'v1' }, gone: { command: 'g' } } }));
    assert.deepEqual(syncClaudeAccount(src(), idle, 'check'), { changed: ['mcpServers'], quiet: [] });
    syncClaudeAccount(src(), idle);
    const expected = { api: { url: 'v2' }, gone: { command: 'g' }, keep: { command: 'k' } };
    assert.deepEqual(info(idle).mcpServers, expected);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, expected);
    // The account in use (the outgoing account of a switch) holds the latest value
    write(src(), JSON.stringify({ mcpServers: defaults }));
    const used = accountDir('used');
    write(path.join(used, '.claude.json'), JSON.stringify({ mcpServers: { api: { url: 'v1' } } }));
    assert.deepEqual(syncClaudeAccount(src(), used, 'check', { inUse: true }), { changed: ['mcpServers'], quiet: [] });
    syncClaudeAccount(src(), used, 'full', { inUse: true });
    assert.deepEqual(info(used).mcpServers, { api: { url: 'v1' }, keep: { command: 'k' } });
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { api: { url: 'v1' }, keep: { command: 'k' } });
  });

  test('a server the default gained while the account was current survives switching away (regression)', () => {
    write(src(), JSON.stringify({ projects: { '/w': { mcpServers: {} } } }));
    const acc = accountDir('current');
    fs.mkdirSync(acc);
    syncClaudeAccount(src(), acc);
    // `claude mcp add` in a plain terminal writes into the default account meanwhile
    write(src(), JSON.stringify({ projects: { '/w': { mcpServers: { stripe: STRIPE } } } }));
    // The check of the current account lists it; switching away keeps it in the default
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check'), { changed: ['projects:/w'], quiet: [] });
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).projects['/w'].mcpServers, { stripe: STRIPE });
    assert.deepEqual(info(acc).projects['/w'].mcpServers, { stripe: STRIPE });
  });

  test('pull writes only the selected groups into the account, never the default, and check lists them read only', () => {
    write(src(), JSON.stringify({
      mcpServers: { added: { command: 'new' } },
      hasCompletedOnboarding: true,
      projects: { '/selected': { allowedTools: ['shared'], hasTrustDialogAccepted: true }, '/unselected': { allowedTools: ['default'] }, '/trust': { hasTrustDialogAccepted: true } },
    }));
    const acc = accountDir('repair');
    write(path.join(acc, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'account@fixture' },
      mcpServers: { own: { command: 'own' } },
      projects: { '/selected': { allowedTools: ['own'], lastCost: 1 }, '/unselected': { allowedTools: ['account'] } },
    }));
    const sourceBefore = read(src());
    const accountBefore = read(path.join(acc, '.claude.json'));
    const checked = syncClaudeAccount(src(), acc, 'check');
    assert.deepEqual(checked, { changed: ['mcpServers', 'projects:/selected', 'projects:/unselected', 'projects:/trust', 'hasCompletedOnboarding'], quiet: ['projects:/trust'] });
    assert.equal(read(path.join(acc, '.claude.json')), accountBefore);
    assert.ok(!exists(path.join(acc, '.planswap-sync.json')));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'pull', { groups: ['mcpServers', 'projects:/selected'] }).changed, ['mcpServers', 'projects:/selected']);
    const data = info(acc);
    assert.deepEqual(data.mcpServers, { own: { command: 'own' }, added: { command: 'new' } });
    // Without a base the arrays are united
    assert.deepEqual(data.projects['/selected'], { allowedTools: ['own', 'shared'], lastCost: 1, hasTrustDialogAccepted: true });
    assert.deepEqual(data.projects['/unselected'], { allowedTools: ['account'] });
    assert.equal(data.hasCompletedOnboarding, undefined);
    assert.equal(read(src()), sourceBefore);
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check', { groups: ['mcpServers', 'projects:/selected'] }).changed, []);
    // The default still lacks 'own': the next full sync still gives it, nothing is lost
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { added: { command: 'new' }, own: { command: 'own' } });
    assert.deepEqual(JSON.parse(read(src())).projects['/selected'].allowedTools, ['own', 'shared']);
  });

  test('the .mcp.json enable / disable lists are one item, so opposing states never mix', () => {
    write(src(), JSON.stringify({ projects: { '/p': { enabledMcpjsonServers: ['s'], disabledMcpjsonServers: [] } } }));
    const acc = accountDir('pair');
    fs.mkdirSync(acc);
    syncClaudeAccount(src(), acc);
    // The account disables the server afterwards: the pair moves as a whole
    const data = info(acc);
    data.projects['/p'].enabledMcpjsonServers = [];
    data.projects['/p'].disabledMcpjsonServers = ['s'];
    write(path.join(acc, '.claude.json'), JSON.stringify(data));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).projects['/p'], { enabledMcpjsonServers: [], disabledMcpjsonServers: ['s'] });
  });

  test('MCP sign-ins sync both ways and every other credential key stays untouched', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ claudeAiOauth: { accessToken: 'default-login' }, mcpOAuth: { 'stripe|1': { accessToken: 'd1' } } }));
    fs.chmodSync(defCred, 0o600);
    const acc = accountDir('auth');
    const accCred = path.join(acc, '.credentials.json');
    write(accCred, JSON.stringify({ claudeAiOauth: { accessToken: 'account-login' }, mcpOAuth: { 'notion|2': { accessToken: 'n2' } }, mcpOAuthClientConfig: { 'notion|2': { clientSecret: 'cs' } } }));
    fs.chmodSync(accCred, 0o600);
    syncClaudeAccount(src(), acc);
    const both = { 'stripe|1': { accessToken: 'd1' }, 'notion|2': { accessToken: 'n2' } };
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuth, both);
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth, { 'notion|2': { accessToken: 'n2' }, 'stripe|1': { accessToken: 'd1' } });
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuthClientConfig, { 'notion|2': { clientSecret: 'cs' } });
    assert.deepEqual(JSON.parse(read(defCred)).claudeAiOauth, { accessToken: 'default-login' });
    assert.deepEqual(JSON.parse(read(accCred)).claudeAiOauth, { accessToken: 'account-login' });
    assertMode(defCred, '600');
    assertMode(accCred, '600');
    for (const token of ['d1', 'n2', 'cs', 'login']) assert.ok(!read(path.join(acc, '.planswap-sync.json')).includes(token));

    // A token refreshed by the account reaches the default; a refresh the account lacks is a quiet check group
    const accData = JSON.parse(read(accCred));
    accData.mcpOAuth['stripe|1'] = { accessToken: 'd1-refreshed' };
    write(accCred, JSON.stringify(accData));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check'), { changed: [], quiet: [] });
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuth['stripe|1'], { accessToken: 'd1-refreshed' });
    const defData = JSON.parse(read(defCred));
    defData.mcpOAuth['stripe|1'] = { accessToken: 'd1-again' };
    defData.mcpOAuth['linear|3'] = { accessToken: 'l3' };
    write(defCred, JSON.stringify(defData));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check'), { changed: ['mcpOAuth:stripe|1', 'mcpOAuth:linear|3'], quiet: ['mcpOAuth:stripe|1'] });
    // A sign-in missing on one side is no removal: it comes back from the other side
    syncClaudeAccount(src(), acc);
    const signedOut = JSON.parse(read(accCred));
    delete signedOut.mcpOAuth['linear|3'];
    write(accCred, JSON.stringify(signedOut));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(defCred)).mcpOAuth['linear|3'], { accessToken: 'l3' });
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth['linear|3'], { accessToken: 'l3' });
  });

  test('a credentials file rewritten by a new Claude sign-in gets the sign-ins back instead of removing them everywhere', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: { 'stripe|1': { accessToken: 'd1' }, 'notion|2': { accessToken: 'n2' } } }));
    const acc = accountDir('relogin');
    const accCred = path.join(acc, '.credentials.json');
    write(accCred, JSON.stringify({ claudeAiOauth: { accessToken: 'old-login' } }));
    syncClaudeAccount(src(), acc);
    assert.equal(Object.keys(JSON.parse(read(accCred)).mcpOAuth).length, 2);
    // Signing out and in again leaves a fresh file with the Claude sign-in only; one new authorization before the switch
    write(accCred, JSON.stringify({ claudeAiOauth: { accessToken: 'new-login' }, mcpOAuth: { 'linear|3': { accessToken: 'l3' } } }));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(Object.keys(JSON.parse(read(defCred)).mcpOAuth).sort(), ['linear|3', 'notion|2', 'stripe|1']);
    assert.deepEqual(JSON.parse(read(accCred)).claudeAiOauth, { accessToken: 'new-login' });
    assert.deepEqual(Object.keys(JSON.parse(read(accCred)).mcpOAuth).sort(), ['linear|3', 'notion|2', 'stripe|1']);
  });

  test('a recreated info file or another default dir makes the base unknown, so nothing is removed', () => {
    write(src(), JSON.stringify({ firstStartTime: 'd', mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    const acc = accountDir('recreated');
    write(path.join(acc, '.claude.json'), JSON.stringify({ firstStartTime: 'y1' }));
    syncClaudeAccount(src(), acc);
    // The account's info file is deleted and Claude Code creates a new one with a single trusted project
    write(path.join(acc, '.claude.json'), JSON.stringify({ firstStartTime: 'y2', projects: { '/w': { hasTrustDialogAccepted: true } } }));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' }, b: { command: 'b' } });
    assert.deepEqual(info(acc).mcpServers, { a: { command: 'a' }, b: { command: 'b' } });
    // Removals work again once the new file is synced
    const data = info(acc);
    delete data.mcpServers.b;
    write(path.join(acc, '.claude.json'), JSON.stringify(data));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });

    // A base recorded against another default dir does not apply
    const base = JSON.parse(read(path.join(acc, '.planswap-sync.json')));
    write(path.join(acc, '.planswap-sync.json'), JSON.stringify({ ...base, defaultDir: path.join(home, 'elsewhere') }));
    const own = info(acc);
    delete own.mcpServers.a;
    write(path.join(acc, '.claude.json'), JSON.stringify(own));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });
    assert.equal(JSON.parse(read(path.join(acc, '.planswap-sync.json'))).defaultDir, realPath(def));
  });

  test('an info file that gains its firstStartTime on Claude Code\'s first start keeps its base', () => {
    write(src(), JSON.stringify({ firstStartTime: 'd', mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    const acc = accountDir('first-start');
    fs.mkdirSync(acc);
    // Adding the account creates its info file without firstStartTime; Claude Code adds one at its first start
    syncClaudeAccount(src(), acc);
    assert.equal(info(acc).firstStartTime, undefined);
    const data = info(acc);
    data.firstStartTime = 'y';
    delete data.mcpServers.b;
    write(path.join(acc, '.claude.json'), JSON.stringify(data));
    syncClaudeAccount(src(), acc, 'full', { inUse: true });
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });
    assert.deepEqual(info(acc).mcpServers, { a: { command: 'a' } });
    // A file recorded with a firstStartTime and now without one is another file
    write(path.join(acc, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    syncClaudeAccount(src(), acc);
    assert.deepEqual(info(acc).mcpServers, { a: { command: 'a' } });
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' } });
  });

  test('sign-ins are not synced while either credentials file is missing, and none is created', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: { 'stripe|1': { accessToken: 'd1' } } }));
    const acc = accountDir('signed-out');
    fs.mkdirSync(acc);
    assert.deepEqual(syncClaudeAccount(src(), acc, 'check').changed, []);
    syncClaudeAccount(src(), acc);
    assert.ok(!exists(path.join(acc, '.credentials.json')));
    fs.rmSync(defCred);
    write(path.join(acc, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'notion|2': { accessToken: 'n2' } } }));
    syncClaudeAccount(src(), acc);
    assert.ok(!exists(defCred));
  });

  test('macOS layout (sign-ins in the Keychain, no credentials files): MCP servers and project keys still sync both ways', () => {
    write(src(), JSON.stringify({ oauthAccount: { emailAddress: 'def@x' }, mcpServers: { a: { command: 'a' } }, projects: { '/p': { allowedTools: ['X'] } } }));
    const acc = accountDir('keychain');
    write(path.join(acc, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'acc@x' }, mcpServers: { b: { command: 'b' } } }));
    const r = syncClaudeAccount(src(), acc, 'full', { inUse: true });
    assert.deepEqual(r.changed, ['mcpServers', 'projects:/p']);
    assert.deepEqual(r.defaultChanged, ['mcpServers']);
    assert.deepEqual(info(acc).mcpServers, { b: { command: 'b' }, a: { command: 'a' } });
    assert.deepEqual(info(acc).projects['/p'], { allowedTools: ['X'] });
    assert.deepEqual(JSON.parse(read(src())).mcpServers, { a: { command: 'a' }, b: { command: 'b' } });
    assert.ok(!exists(path.join(acc, '.credentials.json')));
    assert.ok(!exists(path.join(def, '.credentials.json')));
  });

  test('a linked or multiply linked credentials file is refused without writing', FILE_SYMLINKS, () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: {} }));
    const acc = accountDir('alias');
    fs.mkdirSync(acc);
    const accCred = path.join(acc, '.credentials.json');
    fs.symlinkSync(defCred, accCred);
    assert.throws(() => syncClaudeAccount(src(), acc), { message: t('mcp.unsafeTarget', { file: accCred }) });
    fs.unlinkSync(accCred);
    // A hard link makes both names unsafe; the default's is checked first
    fs.linkSync(defCred, accCred);
    assert.throws(() => syncClaudeAccount(src(), acc, 'check'), { message: t('mcp.unsafeTarget', { file: defCred }) });
    assert.equal(read(defCred), JSON.stringify({ mcpOAuth: {} }));
  });

  test('a credentials commit waits for Claude Code\'s storage lock, takes over a stale one and refuses a held one', () => {
    write(src(), '{}');
    const defCred = path.join(def, '.credentials.json');
    write(defCred, JSON.stringify({ mcpOAuth: { 'stripe|1': { accessToken: 'd1' } } }));
    const acc = accountDir('locked');
    const accCred = path.join(acc, '.credentials.json');
    write(accCred, '{}');
    const lock = path.join(acc, '.storage-write.lock');
    fs.mkdirSync(lock);
    // Another process (a Claude Code credentials write) releases the lock while the commit waits for it
    spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 200)", lock], { stdio: 'ignore' });
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth, { 'stripe|1': { accessToken: 'd1' } });
    assert.ok(!exists(lock));
    fs.rmSync(path.join(acc, '.planswap-sync.json'));
    write(accCred, '{}');
    fs.mkdirSync(lock);
    assert.throws(() => syncClaudeAccount(src(), acc), { message: t('mcp.changed', { file: accCred }) });
    assert.equal(read(accCred), '{}');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    syncClaudeAccount(src(), acc);
    assert.deepEqual(JSON.parse(read(accCred)).mcpOAuth, { 'stripe|1': { accessToken: 'd1' } });
    assert.ok(!exists(lock));
    assert.ok(!exists(path.join(def, '.storage-write.lock')));
  });

  test('an empty group selection does not read any file', (ctx) => {
    const readSpy = ctx.mock.method(fsModule, 'readFileSync', () => { throw new Error('unexpected read'); });
    assert.deepEqual(syncClaudeAccount(src(), accountDir('empty'), 'pull', { groups: [] }), { changed: [] });
    assert.equal(readSpy.mock.callCount(), 0);
  });

  test('missing account info is created 0600; bad files throw without writing; the default dir is a no-op', () => {
    write(src(), JSON.stringify({ mcpServers: { m: { command: 'm' } } }));
    const b = accountDir('b');
    fs.mkdirSync(b);
    syncClaudeAccount(src(), b);
    assertMode(path.join(b, '.claude.json'), '600');
    assert.deepEqual(info(b).mcpServers, { m: { command: 'm' } });

    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), '[1]');
    assert.throws(() => syncClaudeAccount(src(), acc), /Not a valid JSON object/);
    assert.equal(read(path.join(acc, '.claude.json')), '[1]');
    write(path.join(acc, '.claude.json'), '{}');
    write(src(), '{ half');
    assert.throws(() => syncClaudeAccount(src(), acc), /default account's info file/);
    assert.equal(read(path.join(acc, '.claude.json')), '{}');

    write(src(), JSON.stringify({ mcpServers: { a: {} } }));
    assert.deepEqual(syncClaudeAccount(src(), def).changed, []);
    assert.ok(!exists(path.join(def, '.claude.json')));
  });

  test('a credential alias as account info is refused in every mode without reading it', FILE_SYMLINKS, (ctx) => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('protected');
    const file = path.join(acc, '.claude.json');
    const credential = path.join(def, '.credentials.json');
    write(credential, '{"synthetic":true}');
    fs.mkdirSync(acc);
    fs.symlinkSync(credential, file);
    const originalRead = fsModule.readFileSync;
    ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.notEqual(String(candidate), credential, 'credential payload must not be opened');
      return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
    }) as typeof fs.readFileSync);
    for (const mode of ['full', 'pull', 'check', 'fill'] as const) {
      assert.throws(() => syncClaudeAccount(src(), acc, mode), { message: t('mcp.unsafeTarget', { file }) });
    }
    assert.ok(fs.lstatSync(file).isSymbolicLink());
  });

  test('neutral sibling credential aliases and nested default links are refused in every mode', FILE_SYMLINKS, (ctx) => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('neutral-backing'); fs.mkdirSync(acc);
    const file = path.join(acc, '.claude.json');
    const other = accountDir('neutral-owner'); fs.mkdirSync(other);
    const external = path.join(home, 'neutral-external.json'); write(external, '{}');
    const owner = path.join(other, '.credentials.json'); fs.symlinkSync(external, owner);
    const nested = path.join(def, 'rules', 'linked-rule.json');
    fs.mkdirSync(path.dirname(nested), { recursive: true }); fs.symlinkSync(external, nested);
    const originalRead = fsModule.readFileSync;
    const spy = ctx.mock.method(fsModule, 'readFileSync', ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.notEqual(String(candidate), external, 'protected external payload must not be opened');
      return Reflect.apply(originalRead, fsModule, [candidate, ...args]);
    }) as typeof fs.readFileSync);
    for (const destination of [external, nested]) {
      if (destination === nested) fs.unlinkSync(owner);
      fs.symlinkSync(destination, file);
      for (const mode of ['full', 'check'] as const) {
        assert.throws(() => syncClaudeAccount(src(), acc, mode), { message: t('mcp.unsafeTarget', { file }) });
        if (destination === nested) {
          const alias = path.join(home, 'default-info-alias'); fs.symlinkSync(def, alias, 'junction');
          withEnv({ CLAUDE_CONFIG_DIR: alias }, () => {
            assert.throws(() => syncClaudeAccount(src(), acc, mode), { message: t('mcp.unsafeTarget', { file }) });
          });
          fs.unlinkSync(alias);
        }
      }
      assert.ok(fs.lstatSync(file).isSymbolicLink()); fs.unlinkSync(file);
    }
    spy.mock.restore(); assert.equal(read(external), '{}');
  });

  test('safe external info links still sync and an original target replaced by a credential alias is refused', FILE_SYMLINKS, () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('external'); fs.mkdirSync(acc);
    const file = path.join(acc, '.claude.json');
    const external = path.join(home, 'external-info.json'); write(external, '{}');
    fs.symlinkSync(external, file);
    assert.deepEqual(syncClaudeAccount(src(), acc).changed, ['mcpServers']);
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    write(external, '{}');
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    const credential = path.join(acc, '.credentials.json'); write(credential, '{}');
    assert.throws(() => syncClaudeAccount(src(), acc, 'full', { beforeCommit: () => {
      if (!fs.lstatSync(external).isSymbolicLink()) { fs.unlinkSync(external); fs.symlinkSync(credential, external); }
    } }), { message: t('mcp.unsafeTarget', { file }) });
    assert.equal(read(credential), '{}');
    assert.ok(fs.lstatSync(external).isSymbolicLink());
    assert.ok(!fs.readdirSync(home).some((name) => name.includes('.planswap-') && name.endsWith('.tmp')));
  });

  test('a file rewritten by the CLI between read and rename is left unchanged and the next run converges', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('race');
    const file = path.join(acc, '.claude.json');
    write(file, JSON.stringify({ userID: 'u' }));
    const rewritten = JSON.stringify({ userID: 'u', numStartups: 2 });
    assert.throws(() => syncClaudeAccount(src(), acc, 'full', { beforeCommit: () => fs.writeFileSync(file, rewritten) }), { message: t('mcp.changed', { file: realPath(file) }) });
    assert.equal(read(file), rewritten);
    assert.deepEqual(fs.readdirSync(acc), ['.claude.json']);
    assert.deepEqual(syncClaudeAccount(src(), acc).changed, ['mcpServers']);
    assert.deepEqual(JSON.parse(read(file)), { userID: 'u', numStartups: 2, mcpServers: { a: { command: 'a' } } });

    // The default rewritten meanwhile: refused as well, the account stays as it was
    write(path.join(acc, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' }, own: { command: 'o' } } }));
    const defRewritten = JSON.stringify({ mcpServers: { a: { command: 'a' } }, numStartups: 5 });
    assert.throws(() => syncClaudeAccount(src(), acc, 'full', { beforeCommit: () => fs.writeFileSync(src(), defRewritten) }), { message: t('mcp.changed', { file: realPath(src()) }) });
    assert.equal(read(src()), defRewritten);
  });

  test('an info file commit waits for Claude Code\'s config lock, takes over a stale one and refuses a held one', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('config-lock');
    const file = path.join(acc, '.claude.json');
    write(file, '{}');
    const lock = `${file}.lock`;
    fs.mkdirSync(lock);
    // Another process (a Claude Code config write) releases the lock while the commit waits for it
    spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 200)", lock], { stdio: 'ignore' });
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, ['a']);
    assert.ok(!exists(lock));
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    fs.mkdirSync(lock);
    assert.throws(() => syncClaudeAccount(src(), acc, 'fill'), { message: t('mcp.changed', { file: realPath(file) }) });
    assert.deepEqual(info(acc).mcpServers, { a: { command: 'a' } });
    assert.ok(exists(lock));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, ['b']);
    assert.ok(!exists(lock));

    // The default's own lock guards its commit
    write(file, JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' }, own: { command: 'o' } } }));
    const defBefore = read(src());
    fs.mkdirSync(`${src()}.lock`);
    assert.throws(() => syncClaudeAccount(src(), acc, 'full'), { message: t('mcp.changed', { file: realPath(src()) }) });
    assert.equal(read(src()), defBefore);
    fs.rmSync(`${src()}.lock`, { recursive: true });
    syncClaudeAccount(src(), acc, 'full');
    assert.deepEqual(Object.keys(info(home).mcpServers).sort(), ['a', 'b', 'own']);
    assert.ok(!exists(`${src()}.lock`));
  });

  test('a linked info file commit also holds the config lock of its target', FILE_SYMLINKS, () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('linked-lock'); fs.mkdirSync(acc);
    const file = path.join(acc, '.claude.json');
    const external = path.join(home, 'linked-info.json'); write(external, '{}');
    fs.symlinkSync(external, file);
    fs.mkdirSync(`${external}.lock`);
    assert.throws(() => syncClaudeAccount(src(), acc, 'fill'), { message: t('mcp.changed', { file: realPath(external) }) });
    assert.equal(read(external), '{}');
    assert.ok(!exists(`${file}.lock`));
    fs.rmSync(`${external}.lock`, { recursive: true });
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, ['a']);
    assert.ok(!exists(`${file}.lock`) && !exists(`${external}.lock`));
  });

  test('a dangling default info link is refused', FILE_SYMLINKS, () => {
    const acc = accountDir('a');
    write(path.join(acc, '.claude.json'), JSON.stringify({ mcpServers: { a: {} } }));
    fs.symlinkSync(path.join(home, 'gone.json'), src());
    assert.throws(() => syncClaudeAccount(src(), acc), { message: t('mcp.unsafeTarget', { file: src() }) });
    assert.ok(fs.lstatSync(src()).isSymbolicLink());
  });

  test('fill adds only the default MCP servers the account lacks, and writes nothing else', (ctx) => {
    const defText = JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { missing: { command: 'm' }, differs: { command: 'default' } },
      projects: { '/p': { hasTrustDialogAccepted: true, mcpServers: { proj: { command: 'p' } } } },
    });
    write(src(), defText);
    const defCred = JSON.stringify({ mcpOAuth: { 'missing|0123456789abcdef': { accessToken: 'synthetic' } } });
    write(path.join(def, '.credentials.json'), defCred);
    const acc = accountDir('fill');
    const file = path.join(acc, '.claude.json');
    write(file, JSON.stringify({ oauthAccount: { emailAddress: 'a@x' }, mcpServers: { differs: { command: 'own' }, extra: { command: 'e' } } }));
    fs.chmodSync(file, 0o640);
    write(path.join(acc, '.credentials.json'), '{}');
    // The credentials files are never read
    const credentials = [path.join(def, '.credentials.json'), path.join(acc, '.credentials.json')].map((f) => path.resolve(f));
    const reads: string[] = [];
    const realRead = fs.readFileSync;
    ctx.mock.method(fsModule, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      reads.push(path.resolve(String(file)));
      return (realRead as (...a: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync);
    const r = syncClaudeAccount(src(), acc, 'fill');
    ctx.mock.restoreAll();
    assert.ok(reads.length > 0, 'the read spy saw the info file reads');
    assert.deepEqual(reads.filter((f) => credentials.includes(f)), []);
    assert.deepEqual(r, { changed: ['mcpServers'], added: ['missing'] });
    assert.deepEqual(info(acc), {
      oauthAccount: { emailAddress: 'a@x' },
      mcpServers: { differs: { command: 'own' }, extra: { command: 'e' }, missing: { command: 'm' } },
    });
    assertMode(file, '640');
    assert.equal(read(src()), defText, 'the default info file is never written');
    assert.equal(read(path.join(def, '.credentials.json')), defCred);
    assert.equal(read(path.join(acc, '.credentials.json')), '{}');
    // Nothing left to add: no write at all
    const texts = [read(file), read(path.join(acc, '.planswap-sync.json'))];
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill'), { changed: [], added: [] });
    assert.deepEqual([read(file), read(path.join(acc, '.planswap-sync.json'))], texts);
  });

  test('fill does not re-add a server removed from the account after a sync, and adds one the default gained since', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('removed');
    const file = path.join(acc, '.claude.json');
    write(file, '{}');
    // Removed after a full sync
    syncClaudeAccount(src(), acc);
    write(file, JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, []);
    // Removed after a fill (fill records the base too)
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, ['b']);
    write(file, JSON.stringify({ mcpServers: {} }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, []);
    // Changed in the default after the account removed it: the account wins, still not re-added
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a2' }, b: { command: 'b' } } }));
    assert.deepEqual(syncClaudeAccount(src(), acc, 'fill').added, []);
    assert.deepEqual(info(acc), { mcpServers: {} });
    // Pull, unlike fill, changes and removes servers the account has
    const other = accountDir('pull');
    write(src(), JSON.stringify({ mcpServers: { x: { command: 'x' }, y: { command: 'y' } } }));
    write(path.join(other, '.claude.json'), '{}');
    syncClaudeAccount(src(), other);
    write(src(), JSON.stringify({ mcpServers: { y: { command: 'y2' } } }));
    assert.deepEqual(syncClaudeAccount(src(), other, 'fill').added, []);
    assert.deepEqual(info(other).mcpServers, { x: { command: 'x' }, y: { command: 'y' } });
    syncClaudeAccount(src(), other, 'pull', { groups: ['mcpServers'] });
    assert.deepEqual(info(other).mcpServers, { y: { command: 'y2' } });
  });

  test('fill refuses an account info file changed since it was read and leaves it unchanged', () => {
    write(src(), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('fill-race');
    const file = path.join(acc, '.claude.json');
    write(file, JSON.stringify({ userID: 'u' }));
    const rewritten = JSON.stringify({ userID: 'u', numStartups: 2 });
    assert.throws(() => syncClaudeAccount(src(), acc, 'fill', { beforeCommit: () => fs.writeFileSync(file, rewritten) }), { message: t('mcp.changed', { file: realPath(file) }) });
    assert.equal(read(file), rewritten);
    assert.deepEqual(fs.readdirSync(acc), ['.claude.json']);
  });

  test('onboarding keys are added only to a signed-in account that lacks them', () => {
    write(src(), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.286', githubRepoPaths: { 'o/r': ['/r'] } }));
    // Signed out: its first-start onboarding is how it signs in, so nothing is added
    const out = accountDir('out');
    write(path.join(out, '.claude.json'), JSON.stringify({ userID: 'u' }));
    assert.deepEqual(syncClaudeAccount(src(), out).changed, []);
    assert.equal(Object.hasOwn(info(out), 'hasCompletedOnboarding'), false);

    // Signed in by email in the info file
    const byEmail = accountDir('mail');
    write(path.join(byEmail, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
    assert.deepEqual(syncClaudeAccount(src(), byEmail).changed, ['hasCompletedOnboarding', 'lastOnboardingVersion']);
    const data = info(byEmail);
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.lastOnboardingVersion, '2.1.286');
    assert.equal(Object.hasOwn(data, 'githubRepoPaths'), false, 'githubRepoPaths is not synced');

    // Signed in by the credentials file; a value of its own is kept
    const byFile = accountDir('file');
    write(path.join(byFile, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: false, mcpServers: {} }));
    write(path.join(byFile, '.credentials.json'), '{}');
    assert.deepEqual(syncClaudeAccount(src(), byFile).changed, ['lastOnboardingVersion']);
    assert.equal(info(byFile).hasCompletedOnboarding, false);
    assert.equal(read(path.join(byFile, '.credentials.json')), '{}');
  });
});
