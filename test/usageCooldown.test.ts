import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE_COOLDOWN_MS, UsageCooldown } from '../src/usageCooldown';

test('lastQueried gives the start of the last query of an account', () => {
  let now = 1_000_000;
  const cooldown = new UsageCooldown(() => now);
  assert.equal(cooldown.lastQueried('/a'), undefined);
  cooldown.mark('/a');
  now += 5_000;
  cooldown.mark('/a');
  assert.equal(cooldown.lastQueried('/a'), 1_005_000);
  assert.equal(cooldown.lastQueried('/b'), undefined);
});

test('an account may be queried again only after the cooldown since its last query', () => {
  let now = 1_000_000;
  const cooldown = new UsageCooldown(() => now);
  assert.equal(cooldown.remaining('/a'), 0, 'never queried');
  cooldown.mark('/a');
  now += 20_000;
  assert.equal(cooldown.remaining('/a'), USAGE_COOLDOWN_MS - 20_000);
  assert.equal(cooldown.remaining('/b'), 0, 'per account');
  now += USAGE_COOLDOWN_MS;
  assert.equal(cooldown.remaining('/a'), 0);
  cooldown.mark('/a');
  assert.equal(cooldown.remaining('/a/'), USAGE_COOLDOWN_MS, 'equivalent spellings of a directory share one entry');
});

test('a check time from elsewhere counts when it is newer; a future time is ignored', () => {
  let now = 1_000_000;
  const cooldown = new UsageCooldown(() => now, 60_000);
  assert.equal(cooldown.remaining('/a', now - 10_000), 50_000, 'refreshed by another window');
  cooldown.mark('/a');
  now += 30_000;
  assert.equal(cooldown.remaining('/a', now - 50_000), 30_000, 'the newer of the two');
  assert.equal(cooldown.remaining('/a', now + 5_000), 30_000, 'a time in the future does not extend it');
  now += 30_000;
  assert.equal(cooldown.remaining('/a', now + 5_000), 0);
});
