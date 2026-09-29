import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityWarnings, type IdentitySource, type Vendor } from '../src/identityWarnings';
import { setLocale } from '../src/i18n';

interface FakeSource extends IdentitySource {
  list: Array<{ dir: string; label: string }>;
  ids: Map<string, string>;
  failAccounts: boolean;
  failIdentity: boolean;
}

function source(vendor: Vendor, list: Array<{ dir: string; label: string }>, ids: Record<string, string>): FakeSource {
  const s: FakeSource = {
    vendor,
    list,
    ids: new Map(Object.entries(ids)),
    failAccounts: false,
    failIdentity: false,
    accounts: () => {
      if (s.failAccounts) throw new Error('accounts failed');
      return s.list;
    },
    identityOf: (dir) => {
      if (s.failIdentity) throw new Error('identity failed');
      return s.ids.get(dir);
    },
  };
  return s;
}

const accts = [
  { dir: '/h/.claude', label: 'Default' },
  { dir: '/h/.claude-work', label: 'Work' },
  { dir: '/h/.claude-home', label: 'Home' },
  { dir: '/h/.claude-other', label: 'Other' },
];

function setup(...sources: FakeSource[]): { w: IdentityWarnings; msgs: string[] } {
  const msgs: string[] = [];
  return { w: new IdentityWarnings(sources, (m) => msgs.push(m)), msgs };
}

before(() => {
  setLocale('en');
});

describe('IdentityWarnings', () => {
  test('no duplicates → no warning', () => {
    const s = source('Claude', accts, { '/h/.claude': 'id-a', '/h/.claude-work': 'id-b', '/h/.claude-home': 'id-c' });
    const { w, msgs } = setup(s);
    w.check();
    assert.deepEqual(msgs, []);
  });

  test('one duplicate pair → one warning naming both labels and the vendor, without the identity', () => {
    const s = source('Claude', accts, { '/h/.claude': 'secret-identity-x', '/h/.claude-work': 'secret-identity-x', '/h/.claude-home': 'id-c' });
    const { w, msgs } = setup(s);
    w.check();
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /Claude/);
    assert.ok(msgs[0].includes('Default, Work'), msgs[0]);
    assert.ok(!msgs[0].includes('Home'));
    assert.ok(!msgs[0].includes('secret-identity-x'));
  });

  test('repeated check with the same situation → no new warning', () => {
    const s = source('Codex', accts, { '/h/.claude': 'x', '/h/.claude-work': 'x' });
    const { w, msgs } = setup(s);
    w.check();
    w.check();
    w.check();
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /Codex/);
  });

  test('a new second group → only the new group is warned', () => {
    const s = source('Claude', accts, { '/h/.claude': 'x', '/h/.claude-work': 'x', '/h/.claude-home': 'y', '/h/.claude-other': 'z' });
    const { w, msgs } = setup(s);
    w.check();
    assert.equal(msgs.length, 1);
    s.ids.set('/h/.claude-other', 'y');
    w.check();
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1].includes('Home, Other'), msgs[1]);
    assert.ok(!msgs[1].includes('Default') && !msgs[1].includes('Work'), msgs[1]);
  });

  test('a resolved group that recurs is warned again', () => {
    const s = source('Claude', accts, { '/h/.claude': 'x', '/h/.claude-work': 'x' });
    const { w, msgs } = setup(s);
    w.check();
    s.ids.set('/h/.claude-work', 'y');
    w.check();
    assert.equal(msgs.length, 1);
    s.ids.set('/h/.claude-work', 'x');
    w.check();
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1].includes('Default, Work'));
  });

  test('a group gaining a member is a new situation', () => {
    const s = source('Claude', accts, { '/h/.claude': 'x', '/h/.claude-work': 'x' });
    const { w, msgs } = setup(s);
    w.check();
    s.ids.set('/h/.claude-home', 'x');
    w.check();
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1].includes('Default, Work, Home'), msgs[1]);
  });

  test('vendors are tracked independently', () => {
    const ids = { '/h/.claude': 'x', '/h/.claude-work': 'x' };
    const claude = source('Claude', accts, ids);
    const codex = source('Codex', accts, ids);
    const { w, msgs } = setup(claude, codex);
    w.check();
    assert.equal(msgs.length, 2);
    assert.match(msgs[0], /Claude/);
    assert.match(msgs[1], /Codex/);
    w.check();
    assert.equal(msgs.length, 2);
    // Resolving only Claude and recurring it warns Claude again, Codex stays quiet
    claude.ids.set('/h/.claude-work', 'y');
    w.check();
    claude.ids.set('/h/.claude-work', 'x');
    w.check();
    assert.equal(msgs.length, 3);
    assert.match(msgs[2], /Claude/);
  });

  test('a throwing identityOf or accounts skips that vendor only and check does not throw', () => {
    const ids = { '/h/.claude': 'x', '/h/.claude-work': 'x' };
    const claude = source('Claude', accts, ids);
    const codex = source('Codex', accts, ids);
    claude.failIdentity = true;
    const { w, msgs } = setup(claude, codex);
    assert.doesNotThrow(() => w.check());
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /Codex/);

    claude.failIdentity = false;
    codex.failAccounts = true;
    assert.doesNotThrow(() => w.check());
    assert.equal(msgs.length, 2);
    assert.match(msgs[1], /Claude/);
  });

  test('accounts without identity are ignored', () => {
    const s = source('Claude', accts, { '/h/.claude-work': 'x' });
    const { w, msgs } = setup(s);
    w.check();
    assert.deepEqual(msgs, []);
    s.ids.set('/h/.claude', '');
    s.ids.set('/h/.claude-home', '');
    w.check();
    assert.deepEqual(msgs, []);
  });
});
