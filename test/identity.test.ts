import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { identityGroupsKey, sameIdentityGroups } from '../src/identity';

interface Entry { dir: string; identity?: string }
const e = (dir: string, identity?: string): Entry => ({ dir, identity });

describe('sameIdentityGroups', () => {
  test('no duplicates → no groups', () => {
    assert.deepEqual(sameIdentityGroups([]), []);
    assert.deepEqual(sameIdentityGroups([e('/a', 'x'), e('/b', 'y'), e('/c')]), []);
  });
  test('one pair', () => {
    const a = e('/a', 'x');
    const c = e('/c', 'x');
    assert.deepEqual(sameIdentityGroups([a, e('/b', 'y'), c]), [[a, c]]);
  });
  test('two groups ordered by their first member', () => {
    const list = [e('/a', 'y'), e('/b', 'x'), e('/c', 'x'), e('/d', 'y')];
    const groups = sameIdentityGroups(list);
    assert.deepEqual(groups.map((g) => g.map((m) => m.dir)), [['/a', '/d'], ['/b', '/c']]);
  });
  test('three members keep input order', () => {
    const groups = sameIdentityGroups([e('/c', 'x'), e('/a', 'x'), e('/b', 'x')]);
    assert.deepEqual(groups.map((g) => g.map((m) => m.dir)), [['/c', '/a', '/b']]);
  });
  test('entries without an identity are ignored, including empty strings', () => {
    assert.deepEqual(sameIdentityGroups([e('/a'), e('/b'), e('/c', ''), e('/d', '')]), []);
    const groups = sameIdentityGroups([e('/a'), e('/b', 'x'), e('/c'), e('/d', 'x')]);
    assert.deepEqual(groups.map((g) => g.map((m) => m.dir)), [['/b', '/d']]);
  });
});

describe('identityGroupsKey', () => {
  test('empty → empty string', () => {
    assert.equal(identityGroupsKey([]), '');
  });
  test('stable and insensitive to group and member order', () => {
    const k1 = identityGroupsKey([[e('/a'), e('/d')], [e('/b'), e('/c')]]);
    const k2 = identityGroupsKey([[e('/c'), e('/b')], [e('/d'), e('/a')]]);
    assert.equal(k1, k2);
    assert.equal(k1, identityGroupsKey([[e('/a'), e('/d')], [e('/b'), e('/c')]]));
  });
  test('different situations → different keys', () => {
    const k1 = identityGroupsKey([[e('/a'), e('/b')]]);
    assert.notEqual(k1, identityGroupsKey([[e('/a'), e('/c')]]));
    assert.notEqual(k1, identityGroupsKey([[e('/a'), e('/b'), e('/c')]]));
    assert.notEqual(identityGroupsKey([[e('/a'), e('/b')], [e('/c'), e('/d')]]), identityGroupsKey([[e('/a'), e('/b'), e('/c'), e('/d')]]));
  });
  test('never contains identity values', () => {
    const groups = sameIdentityGroups([e('/a', 'codex:SECRET-USER\nSECRET-WS'), e('/b', 'codex:SECRET-USER\nSECRET-WS')]);
    const key = identityGroupsKey(groups);
    assert.ok(key.includes('/a') && key.includes('/b'));
    assert.ok(!key.includes('SECRET'));
  });
});
