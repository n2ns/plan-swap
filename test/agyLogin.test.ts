// agy sign-in documents and the per-platform stores, with fake helper processes and a temporary HOME only
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgyError, WINCRED_BLOB_LIMIT, agyTokenFile, decodeLogin, encodeWincred, fileStore, keychainStore, liveStore, sameLogin,
  wincredStore, type Run, type RunResult,
} from '../src/agy/agyLogin';
import { POSIX_ONLY, assertMode, makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
before(() => { tmp = makeTempHome('agy-login'); });
after(() => tmp.restore());

// Fake documents: no real token ever appears in the tests
const idToken = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const doc = (refresh: string, extra: Record<string, unknown> = {}) => ({ token: { access_token: `access-${refresh}`, token_type: 'Bearer', refresh_token: refresh, expiry: '2026-11-17T13:00:00Z' }, auth_method: 'consumer', ...extra });

interface Call { file: string; args: string[]; input?: string }
function fakeRun(answer: (call: Call) => Partial<RunResult>): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (file, args, input) => {
    const call = { file, args, input };
    calls.push(call);
    return { code: 0, stdout: '', stderr: '', ...answer(call) };
  };
  return { run, calls };
}

describe('decodeLogin', () => {
  test('agy 1.5 documents name the account with id_token_email', () => {
    const login = decodeLogin(JSON.stringify(doc('r1', { id_token_email: 'Me@Example.com' })));
    assert.equal(login?.email, 'me@example.com');
    assert.equal(login?.refreshToken, 'r1');
  });
  test('older documents carry the email in the id_token payload', () => {
    assert.equal(decodeLogin(JSON.stringify(doc('r1', { id_token: idToken({ sub: '1', email: 'old@example.com' }) })))?.email, 'old@example.com');
  });
  test('the go-keyring base64 form (macOS) decodes to the same document', () => {
    const raw = 'go-keyring-base64:' + Buffer.from(JSON.stringify(doc('r1', { id_token_email: 'a@example.com' }))).toString('base64');
    assert.deepEqual(decodeLogin(raw)?.doc, doc('r1', { id_token_email: 'a@example.com' }));
  });
  test('a document without an email has no identity but is still a sign-in', () => {
    const login = decodeLogin(JSON.stringify(doc('r1')));
    assert.ok(login);
    assert.equal(login.email, undefined);
  });
  test('anything else is not a sign-in', () => {
    for (const raw of ['', 'not json', '[1]', '{}', '{"token":{}}', 'go-keyring-base64:!!!', JSON.stringify({ token: 'x' })]) {
      assert.equal(decodeLogin(raw), undefined, raw);
    }
  });
});

describe('sameLogin', () => {
  test('compares refresh tokens, and emails only when neither has one', () => {
    const a = decodeLogin(JSON.stringify(doc('r1', { id_token_email: 'a@example.com' })))!;
    assert.ok(sameLogin(a, decodeLogin(JSON.stringify(doc('r1')))!));
    assert.ok(!sameLogin(a, decodeLogin(JSON.stringify(doc('r2', { id_token_email: 'a@example.com' })))!));
    const noRefresh = (email: string) => ({ doc: {}, email });
    assert.ok(sameLogin(noRefresh('a@example.com'), noRefresh('a@example.com')));
    assert.ok(!sameLogin(noRefresh('a@example.com'), noRefresh('b@example.com')));
  });
});

describe('encodeWincred', () => {
  test('small documents are written as they are', () => {
    const d = doc('r1', { id_token: idToken({ email: 'a@example.com' }) });
    assert.deepEqual(JSON.parse(encodeWincred(d)), d);
  });
  test('an oversized id_token is replaced by id_token_email, as agy 1.5 writes it', () => {
    const d = doc('r1', { id_token: idToken({ email: 'a@example.com', pad: 'x'.repeat(WINCRED_BLOB_LIMIT) }) });
    const slim = JSON.parse(encodeWincred(d));
    assert.equal(slim.id_token, undefined);
    assert.equal(slim.id_token_email, 'a@example.com');
    assert.equal(slim.token.refresh_token, 'r1');
  });
  test('a document still too large is refused', () => {
    assert.throws(() => encodeWincred(doc('x'.repeat(WINCRED_BLOB_LIMIT))), (e: unknown) => e instanceof AgyError && e.code === 'tooLarge');
  });
});

describe('fileStore (Linux / WSL)', () => {
  test('reads nothing before agy signed in, then writes atomically with private modes', async () => {
    const file = agyTokenFile(tmp.home);
    const store = fileStore(file, fakeRun(() => ({ code: 1 })).run);
    assert.equal(await store.read(), undefined);
    await store.write(doc('r1', { id_token_email: 'a@example.com' }));
    assert.deepEqual(JSON.parse((await store.read())!), doc('r1', { id_token_email: 'a@example.com' }));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['antigravity-oauth-token'], 'no temporary file is left');
    assertMode(file, '600');
  });
  test('POSIX: a new agy folder is private', POSIX_ONLY, async () => {
    const file = path.join(tmp.home, 'fresh', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    await fileStore(file, fakeRun(() => ({})).run).write(doc('r1'));
    assertMode(path.dirname(file), '700');
  });
  test('switching is refused when the Secret Service holds agy\'s item', async () => {
    const found = fakeRun(() => ({ stdout: "([objectpath '/org/freedesktop/secrets/collection/login/7'], @ao [])" }));
    const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    assert.equal(await fileStore(agyTokenFile(tmp.home), found.run, bus).blocked(), 'linuxKeyring');
    assert.equal(found.calls[0].file, 'gdbus');
    assert.ok(found.calls[0].args.includes("{'service': 'gemini', 'username': 'antigravity'}"));
    assert.equal(await fileStore(agyTokenFile(tmp.home), fakeRun(() => ({ stdout: '(@ao [], @ao [])' })).run, bus).blocked(), undefined);
  });
  test('a keyring lookup that fails is not taken for file mode while a session bus exists', async () => {
    const file = agyTokenFile(tmp.home);
    const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    // go-keyring talks to D-Bus itself, so a missing gdbus says nothing about where agy keeps its sign-in
    const missing = fakeRun(() => ({ code: null, stderr: 'spawn gdbus ENOENT' }));
    assert.equal(await fileStore(file, missing.run, bus).blocked(), 'keyringUnknown');
    const timeout = fakeRun(() => ({ code: null, stderr: '' }));
    assert.equal(await fileStore(file, timeout.run, bus).blocked(), 'keyringUnknown');
    const other = fakeRun(() => ({ code: 1, stderr: 'Error: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: denied' }));
    assert.equal(await fileStore(file, other.run, bus).blocked(), 'keyringUnknown');
  });
  test('no Secret Service, or no session bus at all, is file mode', async () => {
    const file = agyTokenFile(tmp.home);
    const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    const noService = fakeRun(() => ({ code: 1, stderr: 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files' }));
    assert.equal(await fileStore(file, noService.run, bus).blocked(), undefined);
    const noBus = fakeRun(() => ({ code: null, stderr: 'spawn gdbus ENOENT' }));
    assert.equal(await fileStore(file, noBus.run, { XDG_RUNTIME_DIR: path.join(tmp.home, 'no-runtime') }).blocked(), undefined);
    assert.equal(noBus.calls.length, 0, 'without a session bus nothing is started');
  });
});

describe('keychainStore (macOS)', () => {
  test('reads the item through security, missing item = not signed in', async () => {
    const value = 'go-keyring-base64:' + Buffer.from('{}').toString('base64');
    const ok = fakeRun(() => ({ stdout: `${value}\n` }));
    assert.equal(await keychainStore(ok.run).read(), value);
    assert.deepEqual(ok.calls[0], { file: '/usr/bin/security', args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], input: undefined });
    assert.equal(await keychainStore(fakeRun(() => ({ code: 44 })).run).read(), undefined);
    await assert.rejects(keychainStore(fakeRun(() => ({ code: 51 })).run).read(), (e: unknown) => e instanceof AgyError && e.code === 'readFailed');
  });
  test('writes the go-keyring form on stdin, never as an argument', async () => {
    const w = fakeRun(() => ({}));
    await keychainStore(w.run).write(doc('r1'));
    assert.deepEqual(w.calls[0].args, ['-i']);
    const line = w.calls[0].input!;
    assert.match(line, /^add-generic-password -U -s gemini -a antigravity -w "go-keyring-base64:[A-Za-z0-9+/=]+"\n$/);
    const encoded = /"go-keyring-base64:([^"]+)"/.exec(line)![1];
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), doc('r1'));
    // security -i may exit 0 and report the error on stderr only
    await assert.rejects(keychainStore(fakeRun(() => ({ stderr: 'error' })).run).write(doc('r1')), (e: unknown) => e instanceof AgyError && e.code === 'writeFailed');
  });
});

describe('wincredStore (Windows)', () => {
  test('reads the credential blob through PowerShell; none = not signed in', async () => {
    const r = fakeRun(() => ({ stdout: '=' + Buffer.from('{"token":{}}').toString('base64') }));
    assert.equal(await wincredStore(r.run).read(), '{"token":{}}');
    assert.equal(r.calls[0].file, 'powershell.exe');
    assert.match(r.calls[0].args.at(-1)!, /\[PlanSwapCred\]::Read\('gemini:antigravity'\)/);
    assert.equal(await wincredStore(fakeRun(() => ({ stdout: '' })).run).read(), undefined);
    await assert.rejects(wincredStore(fakeRun(() => ({ code: 1 })).run).read(), (e: unknown) => e instanceof AgyError && e.code === 'readFailed');
  });
  test('writes the bare JSON on stdin as base64', async () => {
    const w = fakeRun(() => ({}));
    await wincredStore(w.run).write(doc('r1'));
    assert.deepEqual(JSON.parse(Buffer.from(w.calls[0].input!, 'base64').toString('utf8')), doc('r1'));
    assert.ok(!w.calls[0].args.join(' ').includes('r1'), 'the document is not in the arguments');
    await assert.rejects(wincredStore(fakeRun(() => ({ code: 1 })).run).write(doc('r1')), (e: unknown) => e instanceof AgyError && e.code === 'writeFailed');
  });
});

test('liveStore picks the store agy reads on each platform', () => {
  const { run } = fakeRun(() => ({}));
  assert.equal(liveStore('linux', run, tmp.home).kind, 'file');
  assert.equal(liveStore('darwin', run, tmp.home).kind, 'keychain');
  assert.equal(liveStore('win32', run, tmp.home).kind, 'wincred');
});
