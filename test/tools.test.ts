import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../src/tools';
import { setLocale, t } from '../src/i18n';
import { commands, window } from './stubs/vscode';
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

describe('usage refresh tools from the panel buttons', () => {
  const run = async (ctx: { mock: { method: typeof import('node:test').mock.method } }, mode: 'claude' | 'codex', tool: 'refreshUsage' | 'refreshAllUsage'): Promise<unknown[]> => {
    const exec = ctx.mock.method(commands, 'executeCommand', async () => undefined);
    await runTool(mode, tool, {});
    return exec.mock.calls.map((c) => c.arguments[0]);
  };

  test('refreshUsage runs the product\'s own command', async (ctx) => {
    assert.deepEqual(await run(ctx, 'claude', 'refreshUsage'), ['planswap.claude.refreshUsage']);
    assert.deepEqual(await run(ctx, 'codex', 'refreshUsage'), ['planswap.codex.refreshUsage']);
  });

  test('refreshAllUsage exists for Claude only; a Codex message is ignored', async (ctx) => {
    assert.deepEqual(await run(ctx, 'claude', 'refreshAllUsage'), ['planswap.claude.refreshAllUsage']);
    assert.deepEqual(await run(ctx, 'codex', 'refreshAllUsage'), []);
  });
});
