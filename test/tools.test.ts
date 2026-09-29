import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../src/tools';
import { setLocale, t } from '../src/i18n';
import { window } from './stubs/vscode';
import { inLocale } from './helpers';

describe('re-link result messages', () => {
  after(() => setLocale('en'));
  for (const locale of ['en', 'zh-cn'] as const) {
    for (const outcome of ['success', 'conflict', 'failure'] as const) {
      test(`${locale}: ${outcome} reports completion accurately`, async (ctx) => {
        await inLocale(locale, async () => {
          const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
          const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
          await runTool('codex', 'sync', {
            codexDirs: () => ['/fixture/.codex-work'],
            codexShareOps: {
              isShared: () => true,
              refresh: () => {
                if (outcome === 'failure') throw new Error('Fixture failure');
                return { conflicts: outcome === 'conflict' ? ['settings'] : [], refused: [] };
              },
            },
          });
          if (outcome === 'success') {
            assert.equal(warning.mock.callCount(), 0);
            assert.equal(info.mock.calls[0].arguments[0], t('sync.done', { count: 1, vendor: 'Codex' }));
          } else {
            assert.equal(info.mock.callCount(), 0);
            const message = String(warning.mock.calls[0].arguments[0]);
            assert.ok(message.startsWith(t('sync.attempted', { count: 1, vendor: 'Codex' })));
            assert.ok(!message.includes(t('sync.done', { count: 1, vendor: 'Codex' })));
            assert.ok(message.includes(outcome === 'failure' ? 'Fixture failure' : 'settings'));
          }
        });
      });
    }
  }
});
