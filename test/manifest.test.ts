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
    const setting = advanced.properties[key];
    assert.deepEqual({ type: setting.type, scope: setting.scope, default: setting.default, minimum: setting.minimum, maximum: setting.maximum },
      { type: 'number', scope: 'application', ...expected }, `${key} retains its contract`);
  }
});
