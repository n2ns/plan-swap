import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RecommendDismissals, RecommendExclusions, lowestRemaining, recommend } from '../src/recommend';
import type { AccountView } from '../src/protocol';
import { MemoryMemento } from './helpers';

type Window = NonNullable<AccountView['usage']>['windows'][number];

function row(name: string, windows: Window[] | undefined, extra: Partial<AccountView> = {}): AccountView {
  return {
    kind: name === 'default' ? 'default' : 'named', name, label: name, dir: `/home/u/.claude-${name}`, dirLabel: `~/.claude-${name}`,
    loggedIn: true, isCurrent: false, ...(windows ? { usage: { windows, checkedAt: 1_000 } } : {}), ...extra,
  };
}
const fiveHour = (usedPercent: number): Window => ({ usedPercent, windowMinutes: 300 });
const weekly = (usedPercent: number): Window => ({ usedPercent, windowMinutes: 10080 });
const model = (usedPercent: number): Window => ({ usedPercent, windowMinutes: 10080, scope: 'Fable' });

describe('lowestRemaining', () => {
  test('is the lowest remaining percentage of the general windows, model-specific windows left out', () => {
    assert.equal(lowestRemaining({ windows: [fiveHour(20), weekly(54), model(99)], checkedAt: 0 }), 46);
    assert.equal(lowestRemaining({ windows: [fiveHour(33.333)], checkedAt: 0 }), 100 - 33.333);
  });
  test('is undefined without an observation or without a general window', () => {
    assert.equal(lowestRemaining(undefined), undefined);
    assert.equal(lowestRemaining({ windows: [], checkedAt: 0 }), undefined);
    assert.equal(lowestRemaining({ windows: [model(10)], checkedAt: 0 }), undefined);
  });
});

describe('recommend', () => {
  test('never recommends a row signed in to the current row\'s identity', () => {
    const current = row('default', [fiveHour(95)], { isCurrent: true });
    const same = row('same', [fiveHour(10)]);
    const other = row('other', [fiveHour(50)]);
    const ids: Record<string, string | undefined> = { [current.dir]: 'id-a', [same.dir]: 'id-a', [other.dir]: 'id-b' };
    const identityOf = (dir: string) => ids[dir];
    assert.equal(recommend([current, same, other], 30, identityOf), other.dir);
    assert.equal(recommend([current, same], 30, identityOf), undefined);
    // Without an identity (signed out, API key) nothing matches
    ids[current.dir] = undefined;
    assert.equal(recommend([current, same, other], 30, identityOf), same.dir);
  });
  test('warning comparisons and candidate ranking use unrounded observations', () => {
    const other = row('other', [fiveHour(10)]);
    for (const used of [69.6, 69.996]) {
      assert.equal(recommend([row('default', [fiveHour(used)], { isCurrent: true }), other], 30), undefined);
    }
    assert.equal(recommend([row('default', [fiveHour(70)], { isCurrent: true }), other], 30), other.dir);
    const current = row('default', [fiveHour(80)], { isCurrent: true });
    const better = row('better', [fiveHour(49.996)]);
    const fresher = row('fresher', [fiveHour(50)]);
    fresher.usage!.checkedAt = 2_000;
    assert.equal(recommend([current, fresher, better], 30), better.dir, 'display rounding must not create a freshness tie');
  });
  test('nothing while the current account is above the warning threshold or has no observation', () => {
    const other = row('b', [fiveHour(10), weekly(10)]);
    assert.equal(recommend([row('default', [fiveHour(60), weekly(40)], { isCurrent: true }), other], 30), undefined);
    assert.equal(recommend([row('default', undefined, { isCurrent: true }), other], 30), undefined);
    assert.equal(recommend([row('default', [model(95)], { isCurrent: true }), other], 30), undefined);
    assert.equal(recommend([other], 30), undefined);
  });

  test('at or below the threshold, the account with the most left in its lowest general window wins', () => {
    const rows = [
      row('default', [fiveHour(20), weekly(75)], { isCurrent: true }),
      // 5-hour 80% left but the weekly window is used up: never recommended
      row('a', [fiveHour(20), weekly(100)]),
      // lowest 46%
      row('b', [fiveHour(28), weekly(54)]),
      // lowest 40%
      row('c', [fiveHour(60), weekly(20)]),
    ];
    assert.equal(recommend(rows, 30), '/home/u/.claude-b');
    assert.equal(recommend(rows, 25), '/home/u/.claude-b');
    assert.equal(recommend(rows, 24), undefined, 'current lowest 25% is above the threshold');
  });

  test('a candidate must be strictly better than the current account; a tie goes to the fresher observation', () => {
    const current = row('default', [fiveHour(70)], { isCurrent: true });
    assert.equal(recommend([current, row('a', [fiveHour(70)]), row('b', [fiveHour(72)])], 30), undefined);
    const older = row('a', [fiveHour(50)]);
    const newer = row('b', [fiveHour(50)]);
    newer.usage!.checkedAt = 2_000;
    assert.equal(recommend([current, older, newer], 30), newer.dir);
    assert.equal(recommend([current, newer, older], 30), newer.dir);
  });

  test('excluded accounts, the external directory, accounts without observation and model-only observations are skipped', () => {
    const current = row('default', [fiveHour(90)], { isCurrent: true });
    const excluded = row('work', [fiveHour(0)], { recommendExcluded: true });
    const external = row('<external>', [fiveHour(0)], { kind: 'external' });
    const unknown = row('u', undefined);
    const modelOnly = row('m', [model(0)]);
    const ok = row('ok', [fiveHour(50)]);
    assert.equal(recommend([current, excluded, external, unknown, modelOnly], 30), undefined);
    assert.equal(recommend([current, excluded, external, unknown, modelOnly, ok], 30), ok.dir);
  });

  test('a selected Codex account (pending restart) and an account whose limit is reported reached are skipped', () => {
    const current = row('default', [fiveHour(90)], { isCurrent: true });
    const selected = row('sel', [fiveHour(10)], { isSelected: true });
    const reached = row('reached', [fiveHour(20)]);
    reached.usage!.limitReached = true;
    const ok = row('ok', [fiveHour(50)]);
    assert.equal(recommend([current, selected, reached], 30), undefined);
    assert.equal(recommend([current, selected, reached, ok], 30), ok.dir);
  });

  test('an unavailable subscription is not recommended even with a healthy historical observation', () => {
    const current = row('default', [fiveHour(90)], { isCurrent: true });
    const unavailable = row('expired', [fiveHour(0)], { subscriptionUnavailable: true });
    const available = row('available', [fiveHour(40)]);
    assert.equal(recommend([current, unavailable], 30), undefined);
    assert.equal(recommend([current, unavailable, available], 30), available.dir);
    unavailable.subscriptionUnavailable = false;
    assert.equal(recommend([current, unavailable, available], 30), unavailable.dir);
  });

  test('the current account is never recommended, even when it is the only observation', () => {
    assert.equal(recommend([row('default', [fiveHour(95)], { isCurrent: true }), row('x', [fiveHour(95)])], 30), undefined);
  });
});

describe('RecommendExclusions', () => {
  test('marks are stored as a name list per vendor and cleared with the account', async () => {
    const memento = new MemoryMemento();
    const claude = new RecommendExclusions(memento, 'claude.recommendExcluded');
    const codex = new RecommendExclusions(memento, 'codex.recommendExcluded');
    assert.equal(claude.has('work'), false);
    await claude.set('work', true);
    await claude.set('default', true);
    assert.equal(claude.has('work'), true);
    assert.equal(codex.has('work'), false, 'vendors do not share marks');
    assert.deepEqual(memento.get('claude.recommendExcluded'), ['work', 'default']);
    const writes = memento.updates;
    await claude.set('work', true);
    assert.deepEqual(memento.get('claude.recommendExcluded'), ['work', 'default'], 'a repeated mark writes nothing');
    await claude.remove('absent');
    assert.equal(memento.updates, writes, 'clearing an absent mark writes nothing');
    await claude.remove('work');
    assert.equal(claude.has('work'), false);
    await claude.set('default', false);
    assert.equal(memento.get('claude.recommendExcluded'), undefined, 'an empty list leaves no entry');
  });

  test('a malformed state value reads as no marks', () => {
    const memento = new MemoryMemento();
    memento.data.set('claude.recommendExcluded', { work: true });
    assert.equal(new RecommendExclusions(memento, 'claude.recommendExcluded').has('work'), false);
    memento.data.set('claude.recommendExcluded', ['work', 3]);
    assert.equal(new RecommendExclusions(memento, 'claude.recommendExcluded').has('work'), true);
  });
});

describe('RecommendDismissals', () => {
  const current = (used: number) => row('default', [fiveHour(used)], { isCurrent: true });
  test('hides only the closed pair of current and recommended account', async () => {
    const memento = new MemoryMemento();
    const d = new RecommendDismissals(memento, 'claude.recommendDismissed');
    assert.equal(d.hides('/a', '/b'), false);
    await d.dismiss('/a', '/b');
    assert.deepEqual(memento.data.get('claude.recommendDismissed'), { current: '/a', recommended: '/b' });
    assert.equal(d.hides('/a', '/b'), true);
    assert.equal(d.hides('/a', '/c'), false, 'another recommended account');
    assert.equal(d.hides('/x', '/b'), false, 'another current account');
    const writes = memento.updates;
    await d.dismiss('/a', '/b');
    assert.equal(memento.updates, writes, 'closing the same card again writes nothing');
    await d.dismiss('/a', '/c');
    assert.equal(d.hides('/a', '/b'), false, 'only the last closed card is remembered');
  });
  test('is released once its current account is observed above the threshold, and only then', async () => {
    const memento = new MemoryMemento();
    const d = new RecommendDismissals(memento, 'codex.recommendDismissed');
    const cur = current(95);
    await d.dismiss(cur.dir, '/b');
    const writes = memento.updates;
    await d.releaseRecovered([cur], 10);
    await d.releaseRecovered([row('default', undefined, { isCurrent: true })], 10);
    await d.releaseRecovered([], 10);
    assert.equal(memento.updates, writes, 'still low, unobserved or absent: nothing is written');
    assert.equal(d.hides(cur.dir, '/b'), true);
    await d.releaseRecovered([current(80)], 10);
    assert.equal(d.hides(cur.dir, '/b'), false);
    assert.equal(memento.data.has('codex.recommendDismissed'), false);
  });
  test('an unreadable stored value hides nothing', () => {
    const memento = new MemoryMemento();
    memento.data.set('claude.recommendDismissed', { current: 1, recommended: '/b' });
    assert.equal(new RecommendDismissals(memento, 'claude.recommendDismissed').hides('1', '/b'), false);
  });
});
