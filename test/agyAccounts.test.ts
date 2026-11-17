// Saved agy accounts and the user-initiated switch, against an in-memory sign-in store and a temporary HOME
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgyAccounts, accountName, agyAccountsRoot } from '../src/agy/agyAccounts';
import { AgyError, type AgyErrorCode, type LiveStore } from '../src/agy/agyLogin';
import { POSIX_ONLY, assertMode, makeTempHome, type TempHome } from './helpers';

const doc = (email: string | undefined, refresh: string, access = `access-${refresh}`) =>
  ({ token: { access_token: access, token_type: 'Bearer', refresh_token: refresh }, auth_method: 'consumer', ...(email ? { id_token_email: email } : {}) });

class MemoryStore implements LiveStore {
  readonly kind = 'file' as const;
  writes: Array<Record<string, unknown>> = [];
  block?: AgyErrorCode;
  // A store that drops writes (the read-back then shows the old sign-in)
  ignoreWrites = false;
  constructor(public value?: string) {}
  async read(): Promise<string | undefined> { return this.value; }
  async write(d: Record<string, unknown>): Promise<void> {
    this.writes.push(d);
    if (!this.ignoreWrites) this.value = JSON.stringify(d);
  }
  async blocked(): Promise<AgyErrorCode | undefined> { return this.block; }
}

let tmp: TempHome;
let store: MemoryStore;
let accounts: AgyAccounts;
beforeEach(() => {
  tmp?.restore();
  tmp = makeTempHome('agy-accounts');
  store = new MemoryStore();
  accounts = new AgyAccounts(store, agyAccountsRoot(tmp.home));
});
after(() => tmp.restore());

const code = (c: AgyErrorCode) => (e: unknown) => e instanceof AgyError && e.code === c;
const signIn = (email: string | undefined, refresh: string, access?: string): void => { store.value = JSON.stringify(doc(email, refresh, access)); };

describe('sync', () => {
  test('not signed in: nothing saved', async () => {
    assert.deepEqual(await accounts.sync(), { signedIn: false, unrecognized: false });
    assert.deepEqual(accounts.list(), []);
  });
  test('a new sign-in is saved under a hash of its email, and becomes the current account', async () => {
    signIn('A@example.com', 'ra');
    const live = await accounts.sync();
    assert.equal(live.current, accountName('a@example.com'));
    const [a] = accounts.list();
    assert.equal(a.email, 'a@example.com');
    assert.ok(!a.dir.includes('example'), 'no address in the folder name');
    assert.deepEqual(a.login.doc, doc('A@example.com', 'ra'));
  });
  test('a renewed token replaces the saved copy of the same account', async () => {
    signIn('a@example.com', 'ra', 'old');
    await accounts.sync();
    signIn('a@example.com', 'ra', 'new');
    await accounts.sync();
    assert.equal(accounts.list().length, 1);
    assert.equal((accounts.list()[0].login.doc.token as { access_token: string }).access_token, 'new');
  });
  test('a sign-in without an email is not saved and is reported unrecognized', async () => {
    signIn(undefined, 'rx');
    assert.deepEqual(await accounts.sync(), { signedIn: true, unrecognized: true });
    assert.deepEqual(accounts.list(), []);
    store.value = 'garbage';
    assert.equal((await accounts.sync()).unrecognized, true);
  });
  test('a saved account is still recognized by its refresh token once agy drops the email', async () => {
    signIn('a@example.com', 'ra');
    await accounts.sync();
    signIn(undefined, 'ra');
    assert.equal((await accounts.sync()).current, accountName('a@example.com'));
  });
  test('POSIX: saved copies are private', POSIX_ONLY, async () => {
    signIn('a@example.com', 'ra');
    await accounts.sync();
    const [a] = accounts.list();
    assertMode(path.join(a.dir, 'credential.json'), '600');
    assertMode(a.dir, '700');
    assertMode(path.dirname(a.dir), '700');
  });
});

describe('switchTo', () => {
  const twoAccounts = async (): Promise<{ a: string; b: string }> => {
    signIn('b@example.com', 'rb');
    await accounts.sync();
    signIn('a@example.com', 'ra');
    await accounts.sync();
    return { a: accountName('a@example.com'), b: accountName('b@example.com') };
  };

  test('saves the current sign-in first, writes the target and checks it read back', async () => {
    const { a, b } = await twoAccounts();
    // agy renewed A's tokens since it was saved
    signIn('a@example.com', 'ra', 'renewed');
    assert.equal(await accounts.switchTo(b), 'switched');
    assert.deepEqual(JSON.parse(store.value!), doc('b@example.com', 'rb'));
    assert.equal((accounts.find(a)!.login.doc.token as { access_token: string }).access_token, 'renewed');
    assert.equal((await accounts.sync()).current, b);
  });
  test('switching to the current account writes nothing', async () => {
    const { a } = await twoAccounts();
    assert.equal(await accounts.switchTo(a), 'already');
    assert.equal(store.writes.length, 0);
  });
  test('an unrecognized sign-in is never overwritten', async () => {
    const { b } = await twoAccounts();
    signIn(undefined, 'rx');
    await assert.rejects(accounts.switchTo(b), code('unrecognized'));
    assert.equal(store.writes.length, 0);
  });
  test('a store agy would not read is refused before anything is written', async () => {
    const { b } = await twoAccounts();
    store.block = 'linuxKeyring';
    await assert.rejects(accounts.switchTo(b), code('linuxKeyring'));
    assert.equal(store.writes.length, 0);
  });
  test('a read-back that is not the target fails and puts the previous sign-in back', async () => {
    const { b } = await twoAccounts();
    store.ignoreWrites = true;
    await assert.rejects(accounts.switchTo(b), code('verifyFailed'));
    assert.deepEqual(store.writes.map((w) => (w.token as { refresh_token: string }).refresh_token), ['rb', 'ra']);
  });
  test('switching from a signed-out agy works and needs nothing to restore', async () => {
    const { b } = await twoAccounts();
    store.value = undefined;
    assert.equal(await accounts.switchTo(b), 'switched');
    assert.deepEqual(JSON.parse(store.value!), doc('b@example.com', 'rb'));
  });
  test('an unknown account is refused', async () => {
    await assert.rejects(accounts.switchTo('g000000000000'), code('unknownAccount'));
    await assert.rejects(accounts.switchTo('../escape'), code('unknownAccount'));
  });
});

describe('remove', () => {
  test('deletes only PlanSwap\'s copy; the signed-in account is refused', async () => {
    signIn('b@example.com', 'rb');
    await accounts.sync();
    signIn('a@example.com', 'ra');
    await accounts.sync();
    await assert.rejects(accounts.remove(accountName('a@example.com')), code('removeCurrent'));
    const before = store.value;
    await accounts.remove(accountName('b@example.com'));
    assert.deepEqual(accounts.list().map((x) => x.email), ['a@example.com']);
    assert.equal(store.value, before, 'agy\'s sign-in is untouched');
    assert.equal(fs.existsSync(path.join(agyAccountsRoot(tmp.home), accountName('b@example.com'))), false);
  });
});

describe('review fixes', () => {
  test('two switches started at once never report a switch that did not stick (slow helper processes)', async () => {
    // Every read and write of the store takes a moment, like a Keychain or Credential Manager process
    const slow = new MemoryStore();
    const delay = () => new Promise((r) => setTimeout(r, 15));
    const store2: LiveStore = {
      kind: 'keychain',
      read: async () => { await delay(); return slow.value; },
      write: async (d) => { await delay(); await slow.write(d); },
      blocked: async () => undefined,
    };
    const acc = new AgyAccounts(store2, agyAccountsRoot(tmp.home));
    for (const [email, r] of [['c@example.com', 'rc'], ['b@example.com', 'rb'], ['a@example.com', 'ra']]) {
      slow.value = JSON.stringify(doc(email, r));
      await acc.sync();
    }
    const results = await Promise.allSettled([
      acc.switchTo(accountName('b@example.com')),
      new Promise((r) => setTimeout(r, 10)).then(() => acc.switchTo(accountName('c@example.com'))),
    ]);
    const live = JSON.parse(slow.value!).id_token_email;
    const reported = results.map((r, i) => (r.status === 'fulfilled' && r.value === 'switched' ? ['b@example.com', 'c@example.com'][i] : undefined)).filter(Boolean);
    assert.equal(reported.at(-1), live, `last reported switch ${JSON.stringify(results)} vs live ${live}`);
  });

  test('a renewed sign-in without an email keeps its saved account usable', async () => {
    signIn('a@example.com', 'ra');
    await accounts.sync();
    signIn(undefined, 'ra', 'renewed');
    assert.equal((await accounts.sync()).current, accountName('a@example.com'));
    assert.deepEqual(accounts.list().map((a) => a.email), ['a@example.com']);
    assert.equal((await accounts.sync()).unrecognized, false);
  });
});
