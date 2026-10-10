import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { usageColorsChanged, usageThresholds } from '../src/usageSettings';
import { statusBarSettings } from '../src/statusBar';
import { recommendationThreshold } from '../src/accountsPanel';
import { resetConfig, setConfig, updates } from './stubs/vscode';

afterEach(() => resetConfig());

test('shared colors ignore former per-surface settings and stay independent of recommendations and notifications', () => {
  resetConfig();
  for (const key of ['sidebar.warningThreshold', 'sidebar.errorThreshold', 'statusBar.warningThreshold', 'statusBar.errorThreshold']) setConfig('planswap', key, 90);
  setConfig('planswap', 'notifications.threshold', 80);
  assert.deepEqual(usageThresholds(), { warning: 30, error: 10 });
  assert.equal(recommendationThreshold(), 10);
  setConfig('planswap', 'usageWarningThreshold', 20);
  setConfig('planswap', 'usageErrorThreshold', 60);
  assert.deepEqual(usageThresholds(), { warning: 20, error: 60 });
  assert.equal(statusBarSettings().warningThreshold, 20);
  assert.equal(statusBarSettings().errorThreshold, 60);
  assert.equal(recommendationThreshold(), 10);
  assert.deepEqual(updates, [], 'reading shared colors never rewrites settings');
});

test('both shared settings trigger immediate refresh gates, unrelated settings do not', () => {
  for (const key of ['planswap.usageWarningThreshold', 'planswap.usageErrorThreshold']) {
    assert.equal(usageColorsChanged({ affectsConfiguration: (section) => section === key }), true);
  }
  for (const key of ['planswap.sidebar.recommendationThreshold', 'planswap.notifications.threshold', 'planswap.statusBar.products']) {
    assert.equal(usageColorsChanged({ affectsConfiguration: (section) => section === key }), false);
  }
});
