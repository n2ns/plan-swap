import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { usageTimeoutMs } from '../src/extension';
import { resetConfig, setConfig } from './stubs/vscode';

afterEach(() => resetConfig());

test('usageTimeoutMs: defaults are 30 s for Claude and 15 s for Codex', () => {
  assert.equal(usageTimeoutMs('claude'), 30_000);
  assert.equal(usageTimeoutMs('codex'), 15_000);
});

test('usageTimeoutMs: a configured value is used within the manifest range and clamped outside it', () => {
  setConfig('planswap', 'claude.usageTimeoutSeconds', 60);
  setConfig('planswap', 'codex.usageTimeoutSeconds', 45);
  assert.equal(usageTimeoutMs('claude'), 60_000);
  assert.equal(usageTimeoutMs('codex'), 45_000);
  setConfig('planswap', 'claude.usageTimeoutSeconds', 1);
  setConfig('planswap', 'codex.usageTimeoutSeconds', 1);
  assert.equal(usageTimeoutMs('claude'), 10_000);
  assert.equal(usageTimeoutMs('codex'), 5_000);
  setConfig('planswap', 'claude.usageTimeoutSeconds', 999);
  assert.equal(usageTimeoutMs('claude'), 120_000);
});

test('usageTimeoutMs: a value that is not a number falls back to the default', () => {
  setConfig('planswap', 'claude.usageTimeoutSeconds', 'x');
  setConfig('planswap', 'codex.usageTimeoutSeconds', Number.NaN);
  assert.equal(usageTimeoutMs('claude'), 30_000);
  assert.equal(usageTimeoutMs('codex'), 15_000);
});
