import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ConfigurationGroup {
  id: string;
  title: string;
  order: number;
  properties: Record<string, Record<string, unknown>>;
}
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const groups = manifest.contributes.configuration as ConfigurationGroup[];

test('five ordered groups contain exactly the 25 unique settings in their intended sections', () => {
  const expected = [
    ['planswap', ['language', 'usageDisplay', 'usageWarningThreshold', 'usageErrorThreshold', 'usageAutoRefreshCurrentOnly', 'notifications.enabled', 'notifications.threshold']],
    ['planswap.sidebar', ['sidebar.shortFormat', 'sidebar.showEmail', 'sidebar.showFiveHourLimit', 'sidebar.showWeeklyLimit', 'sidebar.showModelLimits', 'sidebar.showRecommendation', 'sidebar.recommendationThreshold']],
    ['planswap.statusBar', ['statusBar.enabled', 'statusBar.products', 'statusBar.alignment']],
    ['planswap.accounts', ['claude.confirmSwitch', 'claude.usageAutoRefresh', 'claude.usageRefreshMinutes', 'codex.usageAutoRefresh', 'codex.usageRefreshMinutes']],
    ['planswap.advanced', ['usageCheckIntervalSeconds', 'claude.usageTimeoutSeconds', 'codex.usageTimeoutSeconds']],
  ] as const;
  assert.deepEqual(groups.map((group) => group.id), expected.map(([id]) => id));
  for (const [index, [id, keys]] of expected.entries()) {
    const group = groups[index];
    assert.equal(group.order, index, id);
    assert.deepEqual(Object.keys(group.properties), keys.map((key) => `planswap.${key}`), id);
    assert.deepEqual(Object.values(group.properties).map((setting) => setting.order), keys.map((_, i) => i), id);
  }
  const keys = groups.flatMap((group) => Object.keys(group.properties));
  assert.equal(keys.length, 25);
  assert.equal(new Set(keys).size, 25);
  assert.deepEqual(groups.map((group) => Object.keys(group.properties).length), [7, 7, 3, 5, 3]);
});

test('shared colors use 30 / 10 and independent recommendation and notification defaults stay 10 / 20', () => {
  const settings = Object.assign({}, ...groups.map((group) => group.properties)) as Record<string, Record<string, unknown>>;
  for (const [key, value] of [['usageWarningThreshold', 30], ['usageErrorThreshold', 10], ['sidebar.recommendationThreshold', 10]] as const) {
    const setting = settings[`planswap.${key}`];
    assert.deepEqual({ default: setting.default, minimum: setting.minimum, maximum: setting.maximum, scope: setting.scope },
      { default: value, minimum: 0, maximum: 100, scope: 'application' });
  }
  assert.equal(settings['planswap.notifications.threshold'].default, 20);
});

test('account descriptions identify Claude and Codex in every manifest locale', () => {
  const accounts = groups.find((group) => group.id === 'planswap.accounts')!;
  for (const suffix of ['', '.zh-cn', '.zh-tw', '.es', '.ja']) {
    const strings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `package.nls${suffix}.json`), 'utf8'));
    assert.equal(typeof strings['config.group.accounts'], 'string');
    for (const [key, setting] of Object.entries(accounts.properties)) {
      const descriptionKey = String(setting.description).slice(1, -1);
      assert.ok(strings[descriptionKey].startsWith(key.includes('.claude.') ? 'Claude' : 'Codex'), `${suffix}: ${key}`);
    }
  }
});

test('Advanced contains only the scheduler period and query timeouts with their existing setting contracts', () => {
  const advanced = groups.find((group) => group.id === 'planswap.advanced');
  assert.ok(advanced);
  assert.equal(advanced.title, '%config.group.advanced%');
  assert.ok(groups.filter((group) => group !== advanced).every((group) => group.order < advanced.order));
  const contracts = {
    'planswap.usageCheckIntervalSeconds': { default: 120, minimum: 30, maximum: 600 },
    'planswap.claude.usageTimeoutSeconds': { default: 30, minimum: 10, maximum: 120 },
    'planswap.codex.usageTimeoutSeconds': { default: 15, minimum: 5, maximum: 120 },
  };
  assert.deepEqual(Object.keys(advanced.properties).sort(), Object.keys(contracts).sort());
  for (const [key, expected] of Object.entries(contracts)) {
    assert.equal(groups.filter((group) => key in group.properties).length, 1, `${key} is contributed once`);
    const setting: Record<string, unknown> = advanced.properties[key];
    assert.deepEqual({ type: setting.type, scope: setting.scope, default: setting.default, minimum: setting.minimum, maximum: setting.maximum },
      { type: 'number', scope: 'application', ...expected }, `${key} retains its contract`);
  }
});

test('sidebar short format is an application setting disabled by default', () => {
  const setting = groups.find((group) => group.id === 'planswap.sidebar')!.properties['planswap.sidebar.shortFormat'];
  assert.deepEqual({ type: setting.type, default: setting.default, scope: setting.scope },
    { type: 'boolean', default: false, scope: 'application' });
});
