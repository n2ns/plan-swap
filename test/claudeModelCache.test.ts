import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeModelCache, CLAUDE_MODEL_CACHE_KEY } from '../src/claudeModelCache';
import { MemoryMemento } from './helpers';

test('refreshes the keyless lists in the background, keeps a fresh cloud list a day and every list it loaded', async () => {
  const memento = new MemoryMemento();
  let now = 1_000;
  const cache = new ClaudeModelCache(memento, () => now);
  const calls: Array<{ url: string; key: string; timeout?: number }> = [];
  let ollamaRunning = false;
  const fake = async (url: string, key: string, timeout?: number): Promise<string[]> => {
    calls.push({ url, key, timeout });
    if (url.includes('11434') && !ollamaRunning) throw new Error('not running');
    return url.includes('openrouter') ? ['b/model', 'a/model'] : ['local-model'];
  };
  assert.equal(await cache.refreshPublic(fake), true);
  assert.deepEqual(calls.map((c) => [c.url, c.key, c.timeout]).sort(), [
    ['http://localhost:11434/v1', '', 3_000], ['https://openrouter.ai/api/v1', '', 15_000],
  ]);
  assert.deepEqual(cache.get('openrouter'), ['b/model', 'a/model']);
  assert.equal(cache.get('ollama'), undefined, 'a server that is not running leaves nothing');
  assert.deepEqual(cache.get('deepseek'), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(cache.get('kimi'), undefined);
  assert.equal(cache.get('custom'), undefined);

  calls.length = 0;
  now += 60 * 60 * 1000;
  ollamaRunning = true;
  assert.equal(await cache.refreshPublic(fake), true);
  assert.equal(calls.some((c) => c.url.includes('openrouter')), false, 'a cloud list younger than a day is kept');
  assert.deepEqual(cache.get('ollama'), ['local-model']);
  assert.equal(await cache.refreshPublic(fake), false, 'an unchanged local list is not a change');

  now += 24 * 60 * 60 * 1000;
  calls.length = 0;
  await cache.refreshPublic(fake);
  assert.equal(calls.some((c) => c.url.includes('openrouter')), true, 'a day-old cloud list is refetched');

  await cache.set('kimi', ['kimi-model']);
  await cache.set('custom', ['never']);
  await cache.set('deepseek', ['never']);
  await cache.set('zai', []);
  assert.deepEqual(cache.get('kimi'), ['kimi-model']);
  assert.deepEqual(cache.get('deepseek'), ['deepseek-flash', 'deepseek-v4-pro']);
  const stored = memento.data.get(CLAUDE_MODEL_CACHE_KEY) as Record<string, unknown>;
  assert.equal(CLAUDE_MODEL_CACHE_KEY, 'claude.modelCache');
  assert.equal(JSON.stringify(stored).includes('never'), false);
  assert.equal('zai' in stored, false);
  assert.equal(memento.data.has('codex.modelCache'), false);
});

test('a malformed stored entry is ignored', () => {
  const memento = new MemoryMemento();
  memento.data.set(CLAUDE_MODEL_CACHE_KEY, { kimi: { models: [1], fetchedAt: 1 }, zai: { models: ['m'] } });
  const cache = new ClaudeModelCache(memento);
  assert.equal(cache.get('kimi'), undefined);
  assert.equal(cache.get('zai'), undefined);
});
