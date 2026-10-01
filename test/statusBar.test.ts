import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLAUDE_REFRESH_ALL_USAGE_COMMAND, CLAUDE_REFRESH_USAGE_COMMAND, REFRESH_USAGE_COMMAND, StatusBar, claudeUsageLines, usageLines } from '../src/statusBar';
import { AccountStore } from '../src/accounts';
import { CodexAccountStore } from '../src/codex/codexStore';
import { LabelStore } from '../src/labels';
import { setLocale, type Locale } from '../src/i18n';
import { makeTempHome, MemoryMemento } from './helpers';
import { MarkdownString, statusBarItems, StatusBarAlignment, tooltipText } from './stubs/vscode';
import { installRcBlocks, writeSelectedDir } from '../src/codex/codexState';
import type { CodexUsageState } from '../src/codex/codexUsageMonitor';
import type { UsageResult } from '../src/codex/codexUsage';

before(() => setLocale('en'));

for (const vendors of [[], ['claude'], ['codex'], ['claude', 'codex']]) {
  test(`status bar shows only configured vendors: ${vendors.join(',') || 'none'}`, () => {
    const temp = makeTempHome('status-bar');
    const state = new MemoryMemento();
    for (const vendor of vendors) fs.mkdirSync(path.join(temp.home, `.${vendor}`));
    const bar = new StatusBar(new AccountStore(state), new LabelStore(state, 'claude.labels'),
      { store: new CodexAccountStore(state), labels: new LabelStore(state, 'codex.labels') });
    try {
      const item = statusBarItems.at(-1)!;
      assert.equal(item.alignment, StatusBarAlignment.Right);
      assert.equal(item.visible, vendors.length > 0);
      assert.equal(item.text.includes('Claude:'), vendors.includes('claude'));
      assert.equal(item.text.includes('Codex:'), vendors.includes('codex'));
      assert.equal(tooltipText(item.tooltip).includes('Claude:'), vendors.includes('claude'));
      assert.equal(tooltipText(item.tooltip).includes('Codex:'), vendors.includes('codex'));
      assert.equal(item.command, 'workbench.view.extension.planswap');
    } finally { bar.dispose(); temp.restore(); }
  });
}

test('Codex status keeps effective account and reports pending selection with aliases', async () => {
  const temp = makeTempHome('status-pending');
  const state = new MemoryMemento();
  const store = new CodexAccountStore(state);
  const dir = path.join(temp.home, '.codex');
  const selected = path.join(temp.home, '.codex-work');
  fs.mkdirSync(dir);
  fs.mkdirSync(selected);
  await store.add({ name: 'work', dir: selected });
  await state.update('codex.labels', { work: 'Work alias' });
  writeSelectedDir(selected);
  // A pending selection is only reported while Codex switching is enabled (Windows: the state file above)
  if (process.platform !== 'win32') installRcBlocks();
  const bar = new StatusBar(new AccountStore(state), new LabelStore(state, 'claude.labels'),
    { store, labels: new LabelStore(state, 'codex.labels') });
  try {
    const item = statusBarItems.at(-1)!;
    assert.equal(item.text, '$(account) Codex: default');
    assert.match(tooltipText(item.tooltip), /Pending: Work alias \(restart required\)/);
    writeSelectedDir(dir);
    bar.update();
    assert.doesNotMatch(tooltipText(item.tooltip), /Pending:/);
  } finally { bar.dispose(); temp.restore(); }
});

describe('Codex usage limits in the tooltip', () => {
  const now = Date.now();
  const ok: CodexUsageState = {
    checking: false,
    result: { ok: true, usage: { windows: [{ usedPercent: 42, windowMinutes: 300, resetsAt: Math.floor(now / 1000) + 3600 }, { usedPercent: 7, windowMinutes: 10080 }], limitReached: false, checkedAt: now } },
  };

  test('usageLines: windows with durations, reached flag, checked / checking lines', () => {
    const lines = usageLines(ok);
    assert.match(lines[0], /^5h: 42% used, resets /);
    assert.equal(lines[1], '7d: 7% used');
    assert.match(lines[2], /^Checked /);
    const reached = usageLines({ checking: true, result: { ok: true, usage: { windows: [{ usedPercent: 100, windowMinutes: 45 }], limitReached: true, checkedAt: now } } });
    assert.deepEqual(reached, ['45 min: 100% used', 'Usage limit reached', 'Checking usage limits…']);
    assert.deepEqual(usageLines({ checking: false, result: { ok: true, usage: { windows: [{ usedPercent: 3 }], limitReached: false, checkedAt: now } } }).slice(0, 1), ['#1: 3% used']);
  });

  test('usageLines: failures say why; signed out and no state say nothing', () => {
    assert.deepEqual(usageLines(undefined), []);
    assert.deepEqual(usageLines({ checking: false, result: { ok: false, reason: 'notLoggedIn' } }), []);
    assert.deepEqual(usageLines({ checking: false, result: { ok: false, reason: 'cliMissing' } }), ['Usage limits unavailable: the codex command was not found.']);
    assert.deepEqual(usageLines({ checking: false, result: { ok: false, reason: 'timeout' } }), ['Usage limits unavailable: codex did not answer in time.']);
    assert.deepEqual(usageLines({ checking: false, result: { ok: false, reason: 'failed', detail: 'boom (1)' } }), ['Usage limits unavailable: boom (1)']);
    assert.deepEqual(usageLines({ checking: true }), ['Checking usage limits…']);
  });

  test('usageLines localizes generated reasons while preserving raw details and external errors', () => {
    const cases: Array<[UsageResult, string]> = [
      [{ ok: false, reason: 'homeMismatch', detail: '/other/.codex' }, '无法获取用量额度：codex 返回了不同的账号目录：/other/.codex'],
      [{ ok: false, reason: 'noRateLimits' }, '无法获取用量额度：响应中没有用量额度。'],
      [{ ok: false, reason: 'protocolTooLong' }, '无法获取用量额度：响应中的协议行过长。'],
      [{ ok: false, reason: 'exited', detail: '3' }, '无法获取用量额度：codex 在响应前已退出（3）。'],
      [{ ok: false, reason: 'exited', detail: 'SIGTERM' }, '无法获取用量额度：codex 在响应前已退出（SIGTERM）。'],
      [{ ok: false, reason: 'exited' }, '无法获取用量额度：codex 在响应前已退出（退出状态未知）。'],
      [{ ok: false, reason: 'unknownError', detail: '-32603' }, '无法获取用量额度：未知错误 (-32603)'],
      [{ ok: false, reason: 'unknownError' }, '无法获取用量额度：未知错误'],
      [{ ok: false, reason: 'failed', detail: 'no rate limits in the response (-32603)' }, '无法获取用量额度：no rate limits in the response (-32603)'],
    ];
    try {
      setLocale('zh-cn');
      for (const [result, expected] of cases) assert.deepEqual(usageLines({ checking: false, result }), [expected]);
    } finally { setLocale('en'); }
  });

  describe('rendered tooltip', () => {
    let temp: ReturnType<typeof makeTempHome>;
    let state: MemoryMemento;
    let store: CodexAccountStore;
    before(async () => {
      temp = makeTempHome('status-usage');
      state = new MemoryMemento();
      store = new CodexAccountStore(state);
      fs.mkdirSync(path.join(temp.home, '.codex'));
    });
    after(() => temp.restore());
    const make = (): { bar: StatusBar; item: (typeof statusBarItems)[number] } => {
      const bar = new StatusBar(new AccountStore(state), new LabelStore(state, 'claude.labels'), { store, labels: new LabelStore(state, 'codex.labels') });
      return { bar, item: statusBarItems.at(-1)! };
    };

    test('a signed-in effective account shows its limits and the only trusted command is the refresh link', () => {
      fs.writeFileSync(path.join(temp.home, '.codex', 'auth.json'), '{}');
      const { bar, item } = make();
      try {
        bar.setCodexUsage(ok);
        const tip = item.tooltip as MarkdownString;
        assert.ok(tip instanceof MarkdownString);
        assert.deepEqual(tip.isTrusted, { enabledCommands: [CLAUDE_REFRESH_USAGE_COMMAND, CLAUDE_REFRESH_ALL_USAGE_COMMAND, REFRESH_USAGE_COMMAND] });
        assert.match(tooltipText(tip), /5h: 42% used, resets /);
        assert.ok(tip.value.includes(`(command:${REFRESH_USAGE_COMMAND})`));
        // The status bar text itself stays short
        assert.equal(item.text, '$(account) Codex: default');
      } finally { bar.dispose(); }
    });

    test('a cached generated failure follows locale changes when the tooltip is updated', () => {
      fs.writeFileSync(path.join(temp.home, '.codex', 'auth.json'), '{}');
      const { bar, item } = make();
      const expected: Record<Locale, string> = {
        en: 'Usage limits unavailable: the response contained no usage limits.',
        'zh-cn': '无法获取用量额度：响应中没有用量额度。',
        es: 'Límites de uso no disponibles: la respuesta no contenía límites de uso.',
        ja: '使用量の上限を取得できません: 応答に使用量の上限が含まれていません。',
      };
      try {
        bar.setCodexUsage({ checking: false, result: { ok: false, reason: 'noRateLimits' } });
        for (const locale of Object.keys(expected) as Locale[]) {
          setLocale(locale);
          bar.update();
          assert.ok(tooltipText(item.tooltip).includes(expected[locale]), locale);
        }
      } finally { setLocale('en'); bar.dispose(); }
    });

    test('a signed-out account shows no usage and no refresh link', () => {
      fs.rmSync(path.join(temp.home, '.codex', 'auth.json'), { force: true });
      const { bar, item } = make();
      try {
        bar.setCodexUsage(ok);
        assert.doesNotMatch(tooltipText(item.tooltip), /% used/);
        assert.ok(!(item.tooltip as MarkdownString).value.includes('command:'));
      } finally { bar.dispose(); }
    });

    test('an alias with markdown is escaped, never rendered as a link', async () => {
      const dir = path.join(temp.home, '.codex-evil');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
      await store.add({ name: 'evil', dir });
      await state.update('codex.labels', { evil: '[x](command:workbench.action.quit)' });
      process.env.CODEX_HOME = dir;
      const { bar, item } = make();
      try {
        bar.setCodexUsage(ok);
        const value = (item.tooltip as MarkdownString).value;
        assert.match(tooltipText(item.tooltip), /Codex: \[x\]\(command:workbench\.action\.quit\)/);
        assert.ok(!value.includes('](command:workbench.action.quit)'));
      } finally {
        delete process.env.CODEX_HOME;
        bar.dispose();
        await state.update('codex.labels', {});
      }
    });
  });
});

test('usageLines: an expired sign-in asks to sign in again', () => {
  assert.deepEqual(usageLines({ checking: false, result: { ok: false, reason: 'authExpired' } }), ['Usage limits unavailable: the sign-in has expired; sign in to this account again.']);
});
