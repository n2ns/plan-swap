import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RecommendExclusions, lowestRemaining, recommend } from '../src/recommend';
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
    assert.equal(lowestRemaining({ windows: [fiveHour(33.333)], checkedAt: 0 }), 66.67);
  });
  test('is undefined without an observation or without a general window', () => {
    assert.equal(lowestRemaining(undefined), undefined);
    assert.equal(lowestRemaining({ windows: [], checkedAt: 0 }), undefined);
    assert.equal(lowestRemaining({ windows: [model(10)], checkedAt: 0 }), undefined);
  });
});

describe('recommend', () => {
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
