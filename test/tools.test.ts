import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSharedInBackground, runTool } from '../src/tools';
import { LinkCheckNotices } from '../src/linkCheck';
import { setLocale, t } from '../src/i18n';
import { commands, env, window } from './stubs/vscode';
import { inLocale, MemoryMemento } from './helpers';

describe('re-link result messages', () => {
  after(() => setLocale('en'));
  const fixable = { report: { linked: ['sessions'], created: [], conflicts: [], refused: [] } };
  for (const locale of ['en', 'zh-cn'] as const) {
    for (const outcome of ['success', 'conflict', 'failure'] as const) {
      test(`${locale}: after Repair, ${outcome} reports completion accurately`, async (ctx) => {
        await inLocale(locale, async () => {
          const warning = ctx.mock.method(window, 'showWarningMessage', async (_m: string, ...items: string[]) => items.find((i) => i === t('linkCheck.repair')));
          const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
          await runTool('codex', 'sync', {
            codexDirs: () => ['/fixture/.codex-work'],
            codexShareOps: {
              isShared: () => true,
              defaultDir: () => '/fixture/.codex',
              check: () => fixable,
              refresh: () => {
                if (outcome === 'failure') throw new Error('Fixture failure');
                return { conflicts: outcome === 'conflict' ? ['settings'] : [], refused: [] };
              },
            },
          });
          // First the check's notification with Repair, then the repair's report
          assert.ok(String(warning.mock.calls[0].arguments[0]).includes('sessions'));
          if (outcome === 'success') {
            assert.equal(warning.mock.callCount(), 1);
            assert.equal(info.mock.calls[0].arguments[0], t('sync.done', { count: 1, vendor: 'Codex' }));
          } else {
            assert.equal(info.mock.callCount(), 0);
            const message = String(warning.mock.calls[1].arguments[0]);
            assert.ok(message.startsWith(t('sync.attempted', { count: 1, vendor: 'Codex' })));
            assert.ok(!message.includes(t('sync.done', { count: 1, vendor: 'Codex' })));
            assert.ok(message.includes(outcome === 'failure' ? 'Fixture failure' : 'settings'));
          }
        });
      });
    }
  }

  test('nothing wrong: reports all fine and repairs nothing', async (ctx) => {
    const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    let refreshed = 0;
    await runTool('codex', 'sync', {
      codexDirs: () => ['/fixture/.codex-a', '/fixture/.codex-b'],
      codexShareOps: {
        isShared: () => true,
        defaultDir: () => '/fixture/.codex',
        check: () => ({ report: { linked: [], created: [], conflicts: [], refused: ['config.toml'], noPrivilege: ['AGENTS.md'] } }),
        refresh: () => { refreshed++; return { conflicts: [], refused: [] }; },
      },
    });
    assert.equal(warning.mock.callCount(), 0);
    assert.equal(info.mock.calls[0].arguments[0], t('linkCheck.ok', { count: 2, vendor: 'Codex' }));
    assert.equal(refreshed, 0);
  });

  test('only entries kept as they are: all fine, with the notes', async (ctx) => {
    const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    await runTool('codex', 'sync', {
      codexDirs: () => ['/fixture/.codex-a'],
      labelOf: () => 'a',
      codexShareOps: {
        isShared: () => true, defaultDir: () => '/fixture/.codex', refresh: () => ({ conflicts: [], refused: [] }),
        check: () => ({ report: { linked: [], created: [], conflicts: ['AGENTS.md', 'rules'], elsewhere: ['rules'], refused: [] } }),
      },
    });
    assert.equal(warning.mock.callCount(), 0);
    const notes = [t('linkCheck.elsewhere', { list: 'rules' }), t('linkCheck.conflict', { list: 'AGENTS.md' })].join(t('common.listSep'));
    assert.equal(info.mock.calls[0].arguments[0], t('linkCheck.okNotes', { count: 1, vendor: 'Codex', list: t('sync.item', { name: 'a', notes }) }));
  });

  test('problems shown without choosing Repair change nothing', async (ctx) => {
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    let refreshed = 0;
    await runTool('codex', 'sync', {
      codexDirs: () => ['/fixture/.codex-a'],
      codexShareOps: { isShared: () => true, defaultDir: () => '/fixture/.codex', check: () => fixable, refresh: () => { refreshed++; return { conflicts: [], refused: [] }; } },
    });
    assert.equal(warning.mock.callCount(), 1);
    assert.deepEqual(warning.mock.calls[0].arguments.slice(1), [t('linkCheck.repair')]);
    assert.equal(refreshed, 0);
  });

  test('only problems a repair cannot fix: no Repair button, each marked, check errors listed', async (ctx) => {
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    await runTool('codex', 'sync', {
      codexDirs: () => ['/fixture/.codex-a', '/fixture/.codex-b'],
      labelOf: (_mode, dir) => dir.slice(-1),
      codexShareOps: {
        isShared: () => true,
        defaultDir: () => '/fixture/.codex',
        check: (dir) => {
          if (dir.endsWith('b')) throw new Error('Fixture check failure');
          return { report: { linked: [], created: [], conflicts: ['rules', 'hooks'], elsewhere: ['hooks'], refused: [], busy: ['history.jsonl'] } };
        },
        refresh: () => ({ conflicts: [], refused: [] }),
      },
    });
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(warning.mock.calls[0].arguments.length, 1);
    const sep = t('common.listSep');
    const lines = [
      t('sync.item', { name: 'a', notes: [t('linkCheck.busy', { list: 'history.jsonl' }), t('linkCheck.elsewhere', { list: 'hooks' }), t('linkCheck.conflict', { list: 'rules' })].join(sep) }),
      t('sync.item', { name: 'b', notes: t('linkCheck.error', { error: 'Fixture check failure' }) }),
    ];
    assert.equal(warning.mock.calls[0].arguments[0], t('linkCheck.foundNoFix', { vendor: 'Codex', list: lines.join(sep) }));
  });
});

describe('background link check', () => {
  const ops = (report: Record<string, string[]>) => ({
    isShared: () => true, defaultDir: () => '/fixture/.codex', refresh: () => ({ conflicts: [], refused: [] }),
    check: () => ({ report: { linked: [], created: [], conflicts: [], refused: [], ...report } }),
  });

  test('stays quiet about problems Repair cannot fix, and announces a repairable one once', async (ctx) => {
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    const notices = new LinkCheckNotices(new MemoryMemento());
    const deps = (report: Record<string, string[]>) => ({ codexDirs: () => ['/fixture/.codex-a'], codexShareOps: ops(report), linkNotices: notices });
    await checkSharedInBackground('codex', deps({ conflicts: ['rules', 'hooks'], elsewhere: ['hooks'], busy: ['history.jsonl'] }));
    assert.equal(warning.mock.callCount(), 0);
    await checkSharedInBackground('codex', deps({ linked: ['agents'], conflicts: ['rules'] }));
    assert.equal(warning.mock.callCount(), 1);
    // The notification lists every problem, the unrepairable one too
    assert.ok(String(warning.mock.calls[0].arguments[0]).includes('rules'));
    await checkSharedInBackground('codex', deps({ linked: ['agents'], conflicts: ['rules', 'x'] }));
    assert.equal(warning.mock.callCount(), 1, 'a new unrepairable problem does not announce the same repairable one again');
  });

  test('a check failure is not announced', async (ctx) => {
    const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
    await checkSharedInBackground('codex', {
      codexDirs: () => ['/fixture/.codex-a'], linkNotices: new LinkCheckNotices(new MemoryMemento()),
      codexShareOps: { ...ops({}), check: () => { throw new Error('boom'); } },
    });
    assert.equal(warning.mock.callCount(), 0);
  });
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

  test('refreshAllUsage runs the product\'s own refresh-all command', async (ctx) => {
    assert.deepEqual(await run(ctx, 'claude', 'refreshAllUsage'), ['planswap.claude.refreshAllUsage']);
    assert.deepEqual(await run(ctx, 'codex', 'refreshAllUsage'), ['planswap.codex.refreshAllUsage']);
  });
});

describe('user guide button', () => {
  test('opens the guide in the UI language; English has no suffix', async (ctx) => {
    const open = ctx.mock.method(env, 'openExternal', async () => true);
    const expected = { en: 'user-guide.md', 'zh-cn': 'user-guide.zh-cn.md', 'zh-tw': 'user-guide.zh-tw.md', es: 'user-guide.es.md', ja: 'user-guide.ja.md' } as const;
    try {
      for (const [locale, file] of Object.entries(expected) as Array<[keyof typeof expected, string]>) {
        setLocale(locale);
        await runTool('claude', 'openHelp', {});
        assert.equal(String(open.mock.calls.at(-1)?.arguments[0]), `https://github.com/n2ns/plan-swap/blob/main/docs/${file}`, locale);
      }
    } finally { setLocale('en'); }
  });
});
