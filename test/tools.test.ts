import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkSharedInBackground, runTool } from '../src/tools';
import { LinkCheckNotices } from '../src/linkCheck';
import { ensureClaudeLinks, mirrorClaudeJson } from '../src/claudeShare';
import { ensureCodexLinks, isSharedCodexAccount } from '../src/codex/codexShare';
import { setLocale, t } from '../src/i18n';
import { commands, env, window } from './stubs/vscode';
import { inLocale, LINUX_ONLY, makeTempHome, MemoryMemento } from './helpers';

describe('Claude repair scope', LINUX_ONLY, () => {
  function fixture() {
    const tmp = makeTempHome('claude-repair');
    const def = path.join(tmp.home, '.claude');
    const proc = path.join(tmp.home, 'proc');
    fs.mkdirSync(proc);
    const source = path.join(tmp.home, '.claude.json');
    fs.writeFileSync(source, '{}');
    const dirs = ['a', 'b'].map((name) => path.join(tmp.home, `.claude-${name}`));
    for (const dir of dirs) {
      ensureClaudeLinks(dir, proc);
      mirrorClaudeJson(source, dir);
    }
    return { tmp, def, source, dirs };
  }

  test('absent optional targets and legacy todos do not prompt or write during background checks', async (ctx) => {
    const { tmp, def, dirs } = fixture();
    try {
      for (const name of ['tasks', 'uploads']) fs.rmdirSync(path.join(def, name));
      fs.symlinkSync(path.join(def, 'todos'), path.join(dirs[0], 'todos'));
      const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
      await checkSharedInBackground('claude', { claudeDirs: () => dirs, linkNotices: new LinkCheckNotices(new MemoryMemento()) });
      assert.equal(warning.mock.callCount(), 0);
      for (const name of ['tasks', 'uploads', 'todos']) assert.equal(fs.existsSync(path.join(def, name)), false);
      assert.equal(fs.lstatSync(path.join(dirs[0], 'todos')).isSymbolicLink(), true);
    } finally { tmp.restore(); }
  });

  test('independent history and cleaned plugin backups do not produce background repair notifications', async (ctx) => {
    const { tmp, def, dirs } = fixture();
    try {
      const acc = dirs[0];
      fs.unlinkSync(path.join(acc, 'file-history'));
      fs.mkdirSync(path.join(acc, 'file-history'));
      fs.writeFileSync(path.join(acc, 'file-history', 'snapshot'), 'own snapshot');
      fs.rmdirSync(path.join(def, 'file-history'));
      const backup = 'installed_plugins.set-aside.2026-08-01.example.json';
      fs.symlinkSync(path.join(def, 'plugins', backup), path.join(acc, 'plugins', backup));
      const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
      await checkSharedInBackground('claude', { claudeDirs: () => [acc], linkNotices: new LinkCheckNotices(new MemoryMemento()) });
      assert.equal(warning.mock.callCount(), 0);
      assert.equal(fs.existsSync(path.join(def, 'file-history')), false);
      assert.equal(fs.readFileSync(path.join(acc, 'file-history', 'snapshot'), 'utf8'), 'own snapshot');
      assert.equal(fs.lstatSync(path.join(acc, 'plugins', backup)).isSymbolicLink(), true);
    } finally { tmp.restore(); }
  });

  test('repairs only the listed account and entry, preserving optional absence and account-only MCP data', async (ctx) => {
    const { tmp, def, dirs } = fixture();
    try {
      fs.unlinkSync(path.join(dirs[0], 'rules'));
      fs.rmdirSync(path.join(def, 'tasks'));
      const ownInfo = JSON.stringify({ mcpServers: { personal: { command: 'personal' } }, projects: { '/own': { hasTrustDialogAccepted: true } }, oauthAccount: { emailAddress: 'fixture@example.test' } });
      for (const dir of dirs) fs.writeFileSync(path.join(dir, '.claude.json'), ownInfo);
      const warning = ctx.mock.method(window, 'showWarningMessage', async (_m: string, ...items: string[]) => items.find((i) => i === t('linkCheck.repair')));
      const info = ctx.mock.method(window, 'showInformationMessage', async () => undefined);
      await runTool('claude', 'sync', { claudeDirs: () => dirs });
      assert.equal(fs.readlinkSync(path.join(dirs[0], 'rules')), path.join(def, 'rules'));
      assert.equal(fs.existsSync(path.join(def, 'tasks')), false);
      for (const dir of dirs) assert.equal(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'), ownInfo);
      assert.equal(warning.mock.callCount(), 1);
      assert.equal(info.mock.calls[0].arguments[0], t('linkCheck.claudeRepaired', { count: 1 }));
    } finally { tmp.restore(); }
  });

  test('a mirror repair preserves account extras and does not initialize unrelated folders', async (ctx) => {
    const { tmp, def, source, dirs } = fixture();
    try {
      fs.rmdirSync(path.join(def, 'uploads'));
      fs.writeFileSync(source, JSON.stringify({ mcpServers: { shared: { command: 'shared' } } }));
      const personal = { mcpServers: { personal: { command: 'personal' } }, projects: { '/own': { hasTrustDialogAccepted: true } } };
      fs.writeFileSync(path.join(dirs[0], '.claude.json'), JSON.stringify(personal));
      const warning = ctx.mock.method(window, 'showWarningMessage', async (_m: string, ...items: string[]) => items.find((i) => i === t('linkCheck.repair')));
      ctx.mock.method(window, 'showInformationMessage', async () => undefined);
      await runTool('claude', 'sync', { claudeDirs: () => [dirs[0]] });
      assert.ok(String(warning.mock.calls[0].arguments[0]).includes('.claude.json (mcpServers)'));
      const actual = JSON.parse(fs.readFileSync(path.join(dirs[0], '.claude.json'), 'utf8'));
      assert.deepEqual(actual, { ...personal, mcpServers: { ...personal.mcpServers, shared: { command: 'shared' } } });
      assert.equal(fs.existsSync(path.join(def, 'uploads')), false);
    } finally { tmp.restore(); }
  });

  test('an account added while the Repair notification is open is not refreshed', async (ctx) => {
    const { tmp, def, dirs } = fixture();
    try {
      fs.unlinkSync(path.join(dirs[0], 'rules'));
      fs.unlinkSync(path.join(dirs[1], 'rules'));
      let registered = [dirs[0]];
      ctx.mock.method(window, 'showWarningMessage', async (_m: string, ...items: string[]) => {
        registered = dirs;
        return items.find((i) => i === t('linkCheck.repair'));
      });
      ctx.mock.method(window, 'showInformationMessage', async () => undefined);
      await runTool('claude', 'sync', { claudeDirs: () => registered });
      assert.equal(fs.readlinkSync(path.join(dirs[0], 'rules')), path.join(def, 'rules'));
      assert.equal(fs.existsSync(path.join(dirs[1], 'rules')), false);
    } finally { tmp.restore(); }
  });
});

describe('Codex optional theme checks', LINUX_ONLY, () => {
  test('unused themes are quiet, but existing themes with a missing account link still prompt', async (ctx) => {
    const tmp = makeTempHome('codex-theme-notice');
    try {
      const def = path.join(tmp.home, '.codex');
      const acc = path.join(tmp.home, '.codex-a');
      const proc = path.join(tmp.home, 'proc');
      fs.mkdirSync(proc);
      ensureCodexLinks(acc, {}, proc);
      fs.rmdirSync(path.join(def, 'themes'));
      const warning = ctx.mock.method(window, 'showWarningMessage', async () => undefined);
      const deps = {
        codexDirs: () => [acc], linkNotices: new LinkCheckNotices(new MemoryMemento()),
        codexShareOps: {
          defaultDir: () => def, isShared: isSharedCodexAccount,
          check: () => ({ report: ensureCodexLinks(acc, { check: true }, proc) }),
          refresh: () => assert.fail('background checks must not write'),
        },
      };
      await checkSharedInBackground('codex', deps);
      assert.equal(warning.mock.callCount(), 0);
      assert.equal(fs.existsSync(path.join(def, 'themes')), false);
      fs.mkdirSync(path.join(def, 'themes'));
      fs.writeFileSync(path.join(def, 'themes', 'custom.tmTheme'), 'fixture theme');
      fs.unlinkSync(path.join(acc, 'themes'));
      await checkSharedInBackground('codex', deps);
      assert.equal(warning.mock.callCount(), 1);
      assert.ok(String(warning.mock.calls[0].arguments[0]).includes('themes'));
    } finally { tmp.restore(); }
  });
});

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
    const state = new MemoryMemento();
    await state.update('links.fileLinks', true); // This fixture tests announcements after file-link capability is known.
    const notices = new LinkCheckNotices(state);
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
