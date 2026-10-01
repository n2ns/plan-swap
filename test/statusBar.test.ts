import { SHOW_MODEL_LIMITS_SETTING } from '../src/accountsPanel';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  StatusBar,
  backgroundIdFor, codexUsageParts, escapeMarkdown, liveCodexUsage, relativeReset, remainingOf, shortWindow,
  refreshLink, statusAccessibilityLabel, statusText, usageBar, usageTable, windowRow,
} from '../src/statusBar';
import { AccountStore } from '../src/accounts';
import { CodexAccountStore } from '../src/codex/codexStore';
import { LabelStore } from '../src/labels';
import { setLocale, type Locale } from '../src/i18n';
import { LINUX_ONLY, makeTempHome, MemoryMemento } from './helpers';
import { MarkdownString, resetConfig, setConfig, statusBarItems, StatusBarAlignment, ThemeColor, tooltipText } from './stubs/vscode';
import { installRcBlocks, writeSelectedDir } from '../src/codex/codexState';
import type { CodexUsageState } from '../src/codex/codexUsageMonitor';
import type { UsageResult } from '../src/codex/codexUsage';
import type { ClaudeUsageWindow } from '../src/claudeUsage';

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
      assert.equal(item.text.includes('Claude'), vendors.includes('claude'));
      assert.equal(item.text.includes('Codex'), vendors.includes('codex'));
      // One header row per vendor in a single table: the first is the table header, later ones are bold rows
      const tip = tooltipText(item.tooltip);
      assert.equal(tip === '' ? 0 : 1 + (tip.match(/^\| \*\*/gm)?.length ?? 0), vendors.length);
      assert.equal(item.backgroundColor, undefined);
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
    assert.equal(item.text, '$(dashboard) Codex');
    assert.match(tooltipText(item.tooltip), /^\| Not logged in \| \| \| \|\n\|:--\|:--\|--:\|--:\|\n\| _Pending: Work alias \(restart required\)_ \| \| \| \|$/);
    writeSelectedDir(dir);
    bar.update();
    assert.doesNotMatch(tooltipText(item.tooltip), /Pending:/);
  } finally { bar.dispose(); temp.restore(); }
});


const unescape = (lines: string[]): string[] => lines.map((l) => l.replace(/\\(.)/g, '$1'));

describe('pure helpers', () => {
  test('usageBar is always ten cells wide and follows the remaining share', () => {
    for (let r = 0; r <= 100; r++) assert.equal([...usageBar(r)].length, 10, `${r}%`);
    assert.equal(usageBar(100), '██████████');
    assert.equal(usageBar(97), '██████████');
    assert.equal(usageBar(58), '██████░░░░');
    assert.equal(usageBar(50), '█████░░░░░');
    assert.equal(usageBar(1), '█░░░░░░░░░', 'a window with something left is never drawn empty');
    assert.equal(usageBar(0), '░░░░░░░░░░');
    assert.equal(usageBar(-5), '░░░░░░░░░░');
    assert.equal(usageBar(140), '██████████');
  });

  test('remainingOf rounds down and stays within 0..100', () => {
    assert.equal(remainingOf({ usedPercent: 42.5 }), 57);
    assert.equal(remainingOf({ usedPercent: 3 }), 97);
    assert.equal(remainingOf({ usedPercent: 100 }), 0);
    assert.equal(remainingOf({ usedPercent: 99.5 }), 0);
    assert.equal(remainingOf({ usedPercent: 0 }), 100);
  });

  test('shortWindow picks the shortest general window, ignores model scopes, falls back to the first general one', () => {
    assert.equal(shortWindow<ClaudeUsageWindow>([]), undefined);
    assert.equal(shortWindow([{ windowMinutes: 10080, usedPercent: 1 }, { windowMinutes: 300, usedPercent: 2 }])?.usedPercent, 2);
    assert.equal(shortWindow([{ windowMinutes: 45, scope: 'Fable', usedPercent: 9 }, { windowMinutes: 10080, usedPercent: 1 }])?.usedPercent, 1);
    assert.equal(shortWindow([{ windowMinutes: 45, scope: 'Fable', usedPercent: 9 }]), undefined);
    assert.equal(shortWindow([{ usedPercent: 5 }, { usedPercent: 6 }])?.usedPercent, 5, 'no durations: the first window');
    assert.equal(shortWindow([{ usedPercent: 5 }, { windowMinutes: 10080, usedPercent: 6 }])?.usedPercent, 6, 'a known duration beats an unknown one');
  });

  test('backgroundIdFor: error at 10% or less, warning at 30% or less, otherwise none', () => {
    assert.equal(backgroundIdFor(undefined), undefined);
    assert.equal(backgroundIdFor(100), undefined);
    assert.equal(backgroundIdFor(31), undefined);
    assert.equal(backgroundIdFor(30), 'statusBarItem.warningBackground');
    assert.equal(backgroundIdFor(11), 'statusBarItem.warningBackground');
    assert.equal(backgroundIdFor(10), 'statusBarItem.errorBackground');
    assert.equal(backgroundIdFor(0), 'statusBarItem.errorBackground');
  });

  test('relativeReset is a short two-unit duration in the UI language', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    const at = (ms: number): number => Math.floor((now + ms) / 1000);
    assert.equal(relativeReset(at(5 * 60_000), now), '5m');
    assert.equal(relativeReset(at(5 * 60_000 - 30_000), now), '5m', 'rounded up to the minute');
    assert.equal(relativeReset(at(2 * 3600_000), now), '2h', 'a zero unit is left out');
    assert.equal(relativeReset(at(5 * 3600_000 + 20 * 60_000), now), '5h 20m');
    assert.equal(relativeReset(at(3 * 86400_000), now), '3d');
    assert.equal(relativeReset(at(2 * 86400_000 + 5 * 3600_000 + 59 * 60_000), now), '2d 5h', 'days show hours, not minutes');
    assert.equal(relativeReset(at(-1000), now), '1m', 'never negative');
    const twoDaysFive = at(2 * 86400_000 + 5 * 3600_000);
    try {
      setLocale('zh-cn');
      assert.equal(relativeReset(twoDaysFive, now), '2天5小时');
      assert.equal(relativeReset(at(3 * 86400_000), now), '3天');
      setLocale('ja');
      assert.equal(relativeReset(twoDaysFive, now), '2 日 5 時間');
      setLocale('es');
      assert.equal(relativeReset(twoDaysFive, now), '2d 5h');
    } finally { setLocale('en'); }
  });

  test('statusText and the screen reader label carry product names and the short window only', () => {
    assert.equal(statusText([{ product: 'Claude', remaining: 97 }, { product: 'Codex', remaining: 82 }]), 'Claude 97% · Codex 82%');
    assert.equal(statusText([{ product: 'Claude' }, { product: 'Codex', remaining: 0 }]), 'Claude · Codex 0%');
    assert.equal(statusAccessibilityLabel([{ product: 'Claude', remaining: 97 }, { product: 'Codex' }]), 'PlanSwap: Claude 97% left, Codex');
  });

  test('escapeMarkdown neutralizes links, emphasis, icons, table pipes and line breaks', () => {
    const evil = '[x](command:evil) **b** _i_ $(trash) <b>\nnext';
    const escaped = escapeMarkdown(evil);
    assert.ok(!escaped.includes('\n'));
    assert.ok(!/(^|[^\\])[[\]()*_$<>]/.test(escaped), escaped);
    assert.equal(escaped.replace(/\\(.)/g, '$1'), evil.replace('\n', ' '));
    assert.equal(escapeMarkdown('a|b'), 'a\\|b', 'a pipe cannot end a table cell');
  });
});

describe('Codex usage limits in the tooltip', () => {
  const now = Date.now();
  const ok: CodexUsageState = {
    checking: false,
    result: { ok: true, usage: { windows: [{ usedPercent: 42, windowMinutes: 300, resetsAt: Math.floor(now / 1000) + 3600 }, { usedPercent: 7, windowMinutes: 10080 }], limitReached: false, checkedAt: now } },
  };

  test('windowRow and usageTable build one aligned table for all products: headers hold email, plan and refresh, rows hold window, bar, percent, reset', () => {
    const rows = [windowRow({ usedPercent: 42, windowMinutes: 300, resetsAt: Math.floor(now / 1000) + 3600 }, 0, now), windowRow({ usedPercent: 100, windowMinutes: 10080 }, 1, now), windowRow({ usedPercent: 3 }, 2, now)];
    assert.equal(rows[0], '| 5h | ██████░░░░ | 58% | $(clock) 1h |');
    assert.equal(rows[1], '| 7d | ░░░░░░░░░░ | 0% $(warning) Used up | |');
    assert.equal(rows[2], '| \\#3 | ██████████ | 97% | |');
    const link = refreshLink('planswap.claude.refreshUsage');
    assert.equal(link, '[$(refresh)](command:planswap.claude.refreshUsage "Refresh usage limits")');
    assert.equal(
      usageTable([
        { identity: 'me@example.com', plan: 'Max 5x', refresh: link, rows: rows.slice(0, 1), notes: [] },
        { identity: 'b@example.com', plan: 'Plus', rows: rows.slice(1, 2), notes: ['_Checking_'] },
        { identity: 'API key', rows: [], notes: [] },
      ]),
      [
        `| me@example\\.com | | | Max 5x ${link} |`, '|:--|:--|--:|--:|', rows[0],
        '| **b@example\\.com** | | | **Plus** |', rows[1], '| _Checking_ | | | |',
        '| **API key** | | | |',
      ].join('\n'),
      'one table for all products: later headers are bold rows, notes are rows',
    );
    assert.equal(usageTable([{ identity: 'me@example.com', rows: [], notes: [] }]), '| me@example\\.com | | | |\n|:--|:--|--:|--:|');
  });

  test('codexUsageParts: short window first, reached note, checking note', () => {
    const parts = codexUsageParts({ checking: false, result: { ok: true, usage: { windows: [{ usedPercent: 7, windowMinutes: 10080 }, { usedPercent: 42, windowMinutes: 300 }], limitReached: false, checkedAt: now } } }, now);
    assert.deepEqual(parts.rows.map((r) => r.split(' | ')[0]), ['| 5h', '| 7d']);
    assert.deepEqual(parts.notes, []);
    const reached = codexUsageParts({ checking: true, result: { ok: true, usage: { windows: [{ usedPercent: 100, windowMinutes: 45 }], limitReached: true, checkedAt: now } } }, now);
    assert.deepEqual(reached.rows, ['| 45 min | ░░░░░░░░░░ | 0% $(warning) Used up | |']);
    assert.deepEqual(reached.notes, ['_$(warning) Usage limit reached_', '_Checking usage limits…_']);
  });

  test('codexUsageParts: one short failure text for every reason; signed out and no state say nothing', () => {
    assert.deepEqual(codexUsageParts(undefined), { rows: [], notes: [] });
    assert.deepEqual(codexUsageParts({ checking: false, result: { ok: false, reason: 'notLoggedIn' } }), { rows: [], notes: [] });
    for (const result of [{ ok: false, reason: 'cliMissing' }, { ok: false, reason: 'timeout' }, { ok: false, reason: 'failed', detail: '[x](command:evil)' }, { ok: false, reason: 'authExpired' }] as UsageResult[]) {
      assert.deepEqual(codexUsageParts({ checking: false, result }), { rows: [], notes: ['_Usage check failed_'] }, result.ok ? '' : result.reason);
    }
    assert.deepEqual(codexUsageParts({ checking: true }).notes, ['_Checking usage limits…_']);
  });

  test('the failure note follows the locale', () => {
    try {
      setLocale('zh-cn');
      assert.deepEqual(codexUsageParts({ checking: false, result: { ok: false, reason: 'noRateLimits' } }).notes, ['_用量查询失败_']);
    } finally { setLocale('en'); }
  });

  test('liveCodexUsage drops windows past their reset and observations older than a day', () => {
    const usage = { windows: [{ usedPercent: 10, windowMinutes: 300, resetsAt: Math.floor(now / 1000) - 5 }, { usedPercent: 20, windowMinutes: 10080 }], limitReached: false, checkedAt: now - 1000 };
    assert.deepEqual(liveCodexUsage(usage, now)?.windows, [{ usedPercent: 20, windowMinutes: 10080 }]);
    assert.equal(liveCodexUsage({ ...usage, checkedAt: now - 25 * 3600_000 }, now), undefined);
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

    test('a signed-in effective account shows its limits; the only link is the trusted refresh after the plan', () => {
      fs.writeFileSync(path.join(temp.home, '.codex', 'auth.json'), '{}');
      const { bar, item } = make();
      try {
        bar.setCodexUsage(ok);
        const tip = item.tooltip as MarkdownString;
        assert.ok(tip instanceof MarkdownString);
        assert.equal(tip.supportThemeIcons, true);
        assert.deepEqual(tip.isTrusted, { enabledCommands: ['planswap.claude.refreshUsage', 'planswap.codex.refreshUsage'] });
        assert.ok(!tip.value.includes(path.join(temp.home, '.codex')));
        assert.match(tooltipText(tip), /^\| default \| \| \| \[\$\(refresh\)\]\(command:planswap\.codex\.refreshUsage "Refresh usage limits"\) \|\n\|:--\|:--\|--:\|--:\|\n\| 5h \| ██████░░░░ \| 58% \| \$\(clock\) 1h \|\n\| 7d \|/);
        // The status bar text states the product and the short window only, never the account
        assert.equal(item.text, '$(dashboard) Codex 58%');
        assert.equal(item.name, 'PlanSwap');
        assert.equal(item.accessibilityInformation?.label, 'PlanSwap: Codex 58% left');
        assert.equal(item.backgroundColor, undefined);
      } finally { bar.dispose(); }
    });

    test('a cached failure shows the short failure line in the current locale', () => {
      fs.writeFileSync(path.join(temp.home, '.codex', 'auth.json'), '{}');
      const { bar, item } = make();
      const expected: Record<Locale, string> = { en: 'Usage check failed', 'zh-cn': '用量查询失败', es: 'Error al consultar el uso', ja: '使用量の確認に失敗' };
      try {
        bar.setCodexUsage({ checking: false, result: { ok: false, reason: 'noRateLimits' } });
        for (const locale of Object.keys(expected) as Locale[]) {
          setLocale(locale);
          bar.update();
          assert.equal(tooltipText(item.tooltip), `| default | | | ${refreshLink('planswap.codex.refreshUsage')} |\n|:--|:--|--:|--:|\n| _${expected[locale]}_ | | | |`, locale);
          assert.equal(item.text, '$(dashboard) Codex', 'no usage, no number');
        }
      } finally { setLocale('en'); bar.dispose(); }
    });

    test('a signed-out account shows no usage', () => {
      fs.rmSync(path.join(temp.home, '.codex', 'auth.json'), { force: true });
      const { bar, item } = make();
      try {
        bar.setCodexUsage(ok);
        assert.equal(tooltipText(item.tooltip), '| Not logged in | | | |\n|:--|:--|--:|--:|');
        assert.equal(item.text, '$(dashboard) Codex');
      } finally { bar.dispose(); }
    });

    test('an API key account shows "API key" as its first line, no plan, no number and no usage', () => {
      fs.writeFileSync(path.join(temp.home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }));
      const { bar, item } = make();
      try {
        bar.setCodexUsage(ok);
        assert.equal(item.text, '$(dashboard) Codex');
        assert.equal(tooltipText(item.tooltip), '| API key | | | |\n|:--|:--|--:|--:|');
      } finally { bar.dispose(); }
    });

    test('an alias with markdown is escaped, never rendered as a link (it is the first line only when there is no email)', async () => {
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
        assert.match(tooltipText(item.tooltip), /^\| \[x\]\(command:workbench\.action\.quit\) \|/);
        assert.ok(!value.includes('](command:workbench.action.quit)'));
        assert.ok(!item.text.includes('[x]'), 'the account label is not in the status bar text');
      } finally {
        delete process.env.CODEX_HOME;
        bar.dispose();
        await state.update('codex.labels', {});
      }
    });

    test('an email with markdown and table pipes is escaped, never a link or an extra cell', () => {
      fs.writeFileSync(path.join(temp.home, '.codex', 'auth.json'), JSON.stringify({
        tokens: { id_token: `x.${Buffer.from(JSON.stringify({ email: '[x](command:evil)|b@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })).toString('base64url')}.y` },
      }));
      const { bar, item } = make();
      try {
        bar.setCodexUsage(ok);
        const value = (item.tooltip as MarkdownString).value;
        assert.ok(!value.includes('](command:evil)') && !/[^\\]\|b@/.test(value));
        assert.match(value.split('\n')[0], /^\| \\\[x\\\]\\\(command:evil\\\)\\\|b@example\\\.com \| \| \| Plus \[\$\(refresh\)\]\(command:planswap\.codex\.refreshUsage "[^"]*"\) \|$/);
      } finally { bar.dispose(); }
    });
  });
});

describe('both products in the status bar', LINUX_ONLY, () => {
  const NOW_MS = Date.now();
  const iso = (ms: number): string => new Date(ms).toISOString();
  let temp: ReturnType<typeof makeTempHome>;
  before(() => {
    temp = makeTempHome('status-both');
    fs.mkdirSync(path.join(temp.home, '.claude'));
    fs.mkdirSync(path.join(temp.home, '.codex'));
    fs.writeFileSync(path.join(temp.home, '.codex', 'auth.json'), '{}');
  });
  after(() => { temp.restore(); resetConfig(); });

  const writeClaude = (limits: Array<Record<string, unknown>>, signedIn = true): void => {
    fs.writeFileSync(path.join(temp.home, '.claude.json'), JSON.stringify(signedIn ? {
      oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'acct-1', organizationUuid: 'org-1', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_5x' },
      cachedUsageUtilization: { fetchedAtMs: NOW_MS - 60_000, accountUuid: 'acct-1', utilization: { limits } },
    } : {}));
  };
  const session = (percent: number, ms = 2 * 3600_000): Record<string, unknown> => ({ kind: 'session', percent, resets_at: iso(NOW_MS + ms) });
  const weekly = (percent: number): Record<string, unknown> => ({ kind: 'weekly_all', percent, resets_at: iso(NOW_MS + 3 * 86400_000) });
  const scoped = (percent: number): Record<string, unknown> => ({ kind: 'weekly_scoped', percent, resets_at: iso(NOW_MS + 3 * 86400_000), scope: { model: { display_name: 'Fable' } } });
  const codexOk = (used5h: number, used7d: number): CodexUsageState => ({
    checking: false,
    result: { ok: true, usage: { windows: [
      { usedPercent: used5h, windowMinutes: 300, resetsAt: Math.floor(NOW_MS / 1000) + 3600 },
      { usedPercent: used7d, windowMinutes: 10080, resetsAt: Math.floor(NOW_MS / 1000) + 5 * 86400 },
    ], limitReached: false, checkedAt: NOW_MS } },
  });
  const make = (): { bar: StatusBar; item: (typeof statusBarItems)[number] } => {
    const memento = new MemoryMemento();
    const bar = new StatusBar(new AccountStore(memento), new LabelStore(memento, 'claude.labels'),
      { store: new CodexAccountStore(memento), labels: new LabelStore(memento, 'codex.labels') });
    return { bar, item: statusBarItems.at(-1)! };
  };
  const color = (item: (typeof statusBarItems)[number]): string | undefined => (item.backgroundColor as ThemeColor | undefined)?.id;

  test('two accounts, healthy: product names with short-window percentages, no background, one table per product', () => {
    resetConfig();
    writeClaude([session(3), weekly(40), scoped(95)]);
    const { bar, item } = make();
    try {
      bar.setClaudeUsage({ checking: false });
      bar.setCodexUsage(codexOk(18, 50));
      assert.equal(item.text, '$(dashboard) Claude 97% · Codex 82%');
      assert.equal(color(item), undefined);
      const tip = tooltipText(item.tooltip);
      assert.match(tip, /^\| me@example\.com \| \| \| Max 5x \[\$\(refresh\)\]\(command:planswap\.claude\.refreshUsage "Refresh usage limits"\) \|\n\|:--\|:--\|--:\|--:\|\n\| 5h \| ██████████ \| 97% \| \$\(clock\) 2h \|\n\| 7d \| ██████░░░░ \| 60% \| \$\(clock\) 3d \|\n\| \*\*default\*\* \| \| \| \*\*\[\$\(refresh\)\]\(command:planswap\.codex\.refreshUsage "Refresh usage limits"\)\*\* \|\n\| 5h \| ████████░░ \| 82% \| \$\(clock\) 1h \|\n\| 7d \| █████░░░░░ \| 50% \| \$\(clock\) 5d \|$/);
      assert.ok(!tip.includes('Fable') && !tip.includes('Per model'), 'model-specific windows are off by default');
      assert.ok(!/Checked|Lowest|\.claude[/\\]|\.codex[/\\]|---|used\b/i.test(tip), 'no account name, path, checked line, lowest line, rule or used values');
      assert.deepEqual(tip.match(/\(command:[^ )]+/g), ['(command:planswap.claude.refreshUsage', '(command:planswap.codex.refreshUsage'], 'only the two refresh links');
      assert.deepEqual((item.tooltip as MarkdownString).isTrusted, { enabledCommands: ['planswap.claude.refreshUsage', 'planswap.codex.refreshUsage'] });
    } finally { bar.dispose(); }
  });

  test('the sidebar model-specific setting does not change the status bar', () => {
    writeClaude([session(3), weekly(40), scoped(100)]);
    setConfig('planswap', SHOW_MODEL_LIMITS_SETTING, true);
    const { bar, item } = make();
    try {
      bar.setClaudeUsage({ checking: false });
      let tip = tooltipText(item.tooltip);
      assert.ok(!tip.includes('Fable'));
      assert.ok(!tip.includes('Per model'));
      assert.equal(item.text, '$(dashboard) Claude 97% · Codex');
      assert.equal(color(item), undefined, 'a used-up model window does not count');
      setConfig('planswap', SHOW_MODEL_LIMITS_SETTING, false);
      bar.update();
      tip = tooltipText(item.tooltip);
      assert.ok(!tip.includes('Fable'));
    } finally { bar.dispose(); resetConfig(); }
  });

  test('5h healthy but 7d used up: the text shows the 5h number, the background is the error color and the row carries the warning', () => {
    writeClaude([session(3), weekly(100)]);
    const { bar, item } = make();
    try {
      bar.setClaudeUsage({ checking: false });
      bar.setCodexUsage(codexOk(18, 50));
      assert.equal(item.text, '$(dashboard) Claude 97% · Codex 82%');
      assert.equal(color(item), 'statusBarItem.errorBackground');
      const tip = tooltipText(item.tooltip);
      assert.ok(!tip.includes('Lowest'));
      assert.match(tip, /\| 7d \| ░░░░░░░░░░ \| 0% \$\(warning\) Used up \| \$\(clock\) 3d \|/);
    } finally { bar.dispose(); }
  });

  test('a Codex window drives the warning color across products', () => {
    writeClaude([session(3), weekly(40)]);
    const { bar, item } = make();
    try {
      bar.setClaudeUsage({ checking: false });
      bar.setCodexUsage(codexOk(18, 75));
      assert.equal(color(item), 'statusBarItem.warningBackground');
      bar.setCodexUsage(codexOk(18, 91));
      assert.equal(color(item), 'statusBarItem.errorBackground');
    } finally { bar.dispose(); }
  });

  test('Codex without a usage result shows its first line only; signed-out Claude shows no usage', () => {
    writeClaude([], false);
    const { bar, item } = make();
    try {
      bar.setClaudeUsage({ checking: false });
      assert.equal(item.text, '$(dashboard) Claude · Codex');
      assert.equal(color(item), undefined);
      assert.equal(tooltipText(item.tooltip), '| Not logged in | | | |\n|:--|:--|--:|--:|\n| **default** | | | |');
      assert.equal(item.accessibilityInformation?.label, 'PlanSwap: Claude, Codex');
    } finally { bar.dispose(); }
  });

  test('checking and failed refreshes are one short italic line below the rows', () => {
    writeClaude([session(3)]);
    const { bar, item } = make();
    try {
      bar.setClaudeUsage({ checking: true });
      assert.match(tooltipText(item.tooltip), /^\| me@example\.com [^\n]*\n[^\n]*\n\| 5h [^\n]*\n\| _Checking usage limits…_ \| \| \| \|\n\| \*\*/);
      bar.setClaudeUsage({ checking: false, failure: { dir: path.join(temp.home, '.claude'), reason: 'timeout' } });
      assert.match(tooltipText(item.tooltip), /\| 5h [^\n]*\n\| _Usage check failed_ \| \| \| \|\n\| \*\*/);
      bar.setClaudeUsage({ checking: false, failure: { dir: path.join(temp.home, '.other'), reason: 'timeout' } });
      assert.ok(!tooltipText(item.tooltip).includes('failed'), 'a failure of another directory is not shown');
    } finally { bar.dispose(); }
  });

  test('a Claude sign-in without an email shows the account label as its first line', () => {
    fs.writeFileSync(path.join(temp.home, '.claude', '.credentials.json'), '{}');
    fs.writeFileSync(path.join(temp.home, '.claude.json'), '{}');
    const { bar, item } = make();
    try {
      assert.match(tooltipText(item.tooltip), /^\| default \| \| \| \|\n\|:--\|:--\|--:\|--:\|\n\| \*\*/);
    } finally { bar.dispose(); fs.rmSync(path.join(temp.home, '.claude', '.credentials.json'), { force: true }); }
  });
});
