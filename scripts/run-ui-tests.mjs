import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from './preview/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-out', 'ui');
const locales = ['en', 'zh-cn', 'es', 'ja'];
const widths = [200, 240, 280, 340, 420];
const observed = ['Last observed: ', '采集于 ', 'Última consulta: ', '取得日時: '];
const resets = { en: 'Resets: ', 'zh-cn': '重置时间：', es: 'Se restablece: ', ja: 'リセット日時: ' };
const durations = { en: ['5-hour limit', '7-day limit'], 'zh-cn': ['5 小时限额', '7 天限额'], es: ['Límite de 5 h', 'Límite de 7 días'], ja: ['5 時間の上限', '7 日間の上限'] };
const scopedDurations = {
  en: ['5-hour limit', '7-day limit', '7-day limit · Fable'],
  'zh-cn': ['5 小时限额', '7 天限额', '7 天限额 · Fable'],
  es: ['Límite de 5 h', 'Límite de 7 días', 'Límite de 7 días · Fable'],
  ja: ['5 時間の上限', '7 日間の上限', '7 日間の上限 · Fable'],
};
const modelLimits = { en: 'Model-specific limits (1)', 'zh-cn': '按模型限额（1）', es: 'Límites por modelo (1)', ja: 'モデル別の上限 (1)' };
const remaining = {
  en: (percent) => `${percent}% remaining`,
  'zh-cn': (percent) => `剩余 ${percent}%`,
  es: (percent) => `${percent}% restante`,
  ja: (percent) => `残り ${percent}%`,
};
const results = { cases: [], interactions: [], window: null, failures: [], consoleErrors: [] };
// Headless by default with a fixed 100% viewport; --headed opens a full-screen window on the display instead
const headed = process.argv.includes('--headed');
const HEADLESS_VIEWPORT = { width: 1920, height: 1080 };
let preview;
let context;
let page;
let profile;

const name = (locale, width) => `${locale}-${width}`;
const row = (mode, suffix) => `#panel-${mode} .row[data-dir="/fixture/.${mode}-${suffix}"]`;

// Screenshot only after the tab bar shows `mode` and the 120ms tab color transition has finished
async function shot(file, mode) {
  const tab = await page.evaluate(() => ({
    selected: document.querySelector('.tab[aria-selected="true"]')?.id,
    active: document.querySelector('.tab.is-active')?.id,
    shown: [...document.querySelectorAll('[role="tabpanel"]')].filter((el) => !el.hidden).map((el) => el.id),
  }));
  assert.deepEqual(tab, { selected: `tab-${mode}`, active: `tab-${mode}`, shown: [`panel-${mode}`] }, `tab bar does not match the ${mode} page for ${file}`);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.screenshot({ path: path.join(output, file) });
}

async function runCase(locale, width) {
  await page.evaluate(({ locale, width }) => window.preview.apply({ locale, width, active: 'codex' }), { locale, width });
  const data = await page.evaluate(() => {
    const sidebar = document.querySelector('#sidebar');
    const app = document.querySelector('#app');
    const codex = document.querySelector('#panel-codex');
    const claude = document.querySelector('#panel-claude');
    const usageRow = codex.querySelector('.row[data-dir="/fixture/.codex-work"]');
    const usage = usageRow.querySelector('.row-usage');
    const actions = usageRow.querySelector('.row-actions');
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const rows = [...codex.querySelectorAll('.row'), ...claude.querySelectorAll('.row')];
    const usageState = window.preview.state().codex.accounts.find((a) => a.dir === '/fixture/.codex-work').usage;
    return {
      sidebarWidth: rect(sidebar).width, appWidth: rect(app).width,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      documentHeight: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight,
      zoomScale: visualViewport.scale, devicePixelRatio,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        || sidebar.scrollWidth > sidebar.clientWidth || app.scrollWidth > app.clientWidth
        || rows.some((item) => item.scrollWidth > item.clientWidth),
      codexRows: codex.querySelectorAll('.row').length,
      claudeRows: claude.querySelectorAll('.row').length,
      usageVisible: !!usage && rect(usage).width > 0 && rect(usage).height > 0,
      usageText: usage?.textContent ?? '',
      usageTitle: usage?.title ?? '',
      observedTime: new Date(window.preview.state().codex.accounts.find((a) => a.dir === '/fixture/.codex-work').usage.checkedAt)
        .toLocaleString(document.documentElement.lang),
      visibleTimestamp: !!usage?.querySelector('.usage-time'),
      windows: [...usage.querySelectorAll('.usage-window')].map((item, index) => {
        const labels = item.querySelector('.usage-labels');
        const track = item.querySelector('.usage-track');
        const fill = item.querySelector('.usage-fill');
        const reset = item.querySelector('.usage-reset');
        return {
          text: labels.textContent,
          label: track.getAttribute('aria-label'), role: track.getAttribute('role'),
          value: track.getAttribute('aria-valuenow'), min: track.getAttribute('aria-valuemin'), max: track.getAttribute('aria-valuemax'),
          valueText: track.getAttribute('aria-valuetext'), fill: fill.style.width,
          fillRatio: rect(fill).width / rect(track).width,
          resetText: reset?.textContent,
          resetTime: new Date(usageState.windows[index].resetsAt * 1000).toLocaleString(document.documentElement.lang, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          }),
          resetVisible: !!reset && rect(reset).width > 0 && rect(reset).height > 0,
          resetBelowTrack: !!reset && rect(reset).top >= rect(track).bottom,
          resetOverflow: !!reset && (reset.scrollWidth > reset.clientWidth || reset.scrollHeight > reset.clientHeight
            || rect(reset).right > rect(item).right + 1 || rect(reset).bottom > rect(item).bottom + 1),
          resetActionsOverlap: !!reset && intersects(rect(reset), rect(actions)),
          overlap: intersects(rect(labels), rect(track)),
          overflow: item.scrollWidth > item.clientWidth || labels.scrollWidth > labels.clientWidth
            || rect(fill).right > rect(track).right + 1,
        };
      }),
      emptyUsage: !!codex.querySelector('.row[data-dir="/fixture/.codex-empty"] .row-usage'),
      defaultUsage: !!codex.querySelector('.row[data-dir="/fixture/.codex"] .row-usage'),
      usageActionsOverlap: intersects(rect(usage), rect(actions)),
      gridAreas: getComputedStyle(usageRow).gridTemplateAreas,
      gridColumns: getComputedStyle(usageRow).gridTemplateColumns.split(' ').length,
    };
  });
  assert.ok(Math.abs(data.sidebarWidth - width) <= 2, `sidebar width ${data.sidebarWidth} at ${name(locale, width)}`);
  assert.equal(data.zoomScale, 1, `browser zoom changed at ${name(locale, width)}`);
  assert.ok(data.documentHeight <= data.viewportHeight && data.bodyHeight <= data.viewportHeight,
    `page extends below the viewport at ${name(locale, width)}`);
  assert.equal(data.horizontalOverflow, false, `horizontal overflow at ${name(locale, width)}`);
  assert.equal(data.codexRows, 3);
  assert.equal(data.claudeRows, 3);
  assert.equal(data.usageVisible, true);
  assert.equal(data.usageActionsOverlap, false, `usage overlaps actions at ${name(locale, width)}`);
  assert.equal(data.emptyUsage, false);
  assert.equal(data.defaultUsage, false);
  assert.equal(data.usageTitle, observed[locales.indexOf(locale)] + data.observedTime);
  assert.equal(data.visibleTimestamp, false);
  assert.ok(!data.usageText.includes(data.observedTime), `visible timestamp at ${name(locale, width)}`);
  assert.doesNotMatch(data.usageText + data.usageTitle, /not live|非实时|no en tiempo real|リアルタイムではありません/);
  assert.equal(data.windows.length, 2);
  for (const [index, percent] of [58, 14].entries()) {
    const window = data.windows[index];
    assert.equal(window.role, 'progressbar');
    assert.equal(window.label, durations[locale][index]);
    assert.ok(window.text.includes(window.label));
    assert.ok(window.text.includes(remaining[locale](percent)));
    assert.equal(window.valueText, remaining[locale](percent));
    assert.equal(window.value, String(percent));
    assert.equal(window.min, '0');
    assert.equal(window.max, '100');
    assert.equal(window.fill, `${percent}%`);
    assert.ok(Math.abs(window.fillRatio - percent / 100) < 0.02);
    assert.equal(window.resetText, resets[locale] + window.resetTime);
    if (locale === 'zh-cn') assert.match(window.resetText, /^重置时间：\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/);
    assert.ok(data.usageText.includes(window.resetTime));
    assert.equal(window.resetVisible, true);
    assert.equal(window.resetBelowTrack, true, `reset date above track at ${name(locale, width)}`);
    assert.equal(window.resetOverflow, false, `reset date overflow at ${name(locale, width)}`);
    assert.equal(window.resetActionsOverlap, false, `reset date overlaps actions at ${name(locale, width)}`);
    assert.equal(window.overlap, false, `usage labels overlap track at ${name(locale, width)}`);
    assert.equal(window.overflow, false, `usage window overflow at ${name(locale, width)}`);
  }
  if (data.appWidth >= 340) {
    assert.ok(data.gridColumns >= 4, `wide grid did not activate at ${name(locale, width)}`);
    assert.ok(data.gridAreas.includes('usage usage actions'));
  } else {
    assert.ok(data.gridColumns <= 2, `narrow grid did not activate at ${name(locale, width)}`);
  }
  await shot(`${name(locale, width)}-codex.png`, 'codex');
  const usageLocator = page.locator(`${row('codex', 'work')} .row-usage`);
  const beforeHover = await usageLocator.boundingBox();
  await usageLocator.hover();
  assert.equal(await usageLocator.getAttribute('title'), data.usageTitle);
  assert.equal(await usageLocator.textContent(), data.usageText);
  assert.deepEqual(await usageLocator.boundingBox(), beforeHover, `usage moved on hover at ${name(locale, width)}`);
  await shot(`${name(locale, width)}-codex-hover.png`, 'codex');
  results.cases.push({ locale, width, mode: 'codex', passed: true, hoverPreserved: true, ...data });
  await page.evaluate(({ locale, width }) => window.preview.apply({ locale, width, active: 'claude' }), { locale, width });
  const measureClaude = () => page.evaluate(() => {
    const app = document.querySelector('#app');
    const rows = [...document.querySelectorAll('#panel-claude .row')];
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const usageRow = document.querySelector('#panel-claude .row[data-dir="/fixture/.claude-work"]');
    const usage = usageRow.querySelector('.row-usage');
    const actions = usageRow.querySelector('.row-actions');
    const usageState = window.preview.state().claude.accounts.find((a) => a.dir === '/fixture/.claude-work').usage;
    return {
      rows: rows.length,
      visible: getComputedStyle(document.querySelector('#panel-claude')).display !== 'none',
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        || app.scrollWidth > app.clientWidth || rows.some((item) => item.scrollWidth > item.clientWidth),
      usageCount: document.querySelectorAll('#panel-claude .row-usage').length,
      usageVisible: !!usage && rect(usage).width > 0 && rect(usage).height > 0,
      usageActionsOverlap: intersects(rect(usage), rect(actions)),
      emptyUsage: !!document.querySelector('#panel-claude .row[data-dir="/fixture/.claude-empty"] .row-usage'),
      defaultUsage: !!document.querySelector('#panel-claude .row[data-dir="/fixture/.claude"] .row-usage'),
      moreOpen: usage.querySelector('details.usage-more')?.open ?? null,
      summaryText: usage.querySelector('.usage-more-summary')?.textContent ?? null,
      summaryVisible: (() => { const el = usage.querySelector('.usage-more-summary'); return !!el && rect(el).width > 0 && rect(el).height > 0; })(),
      summaryActionsOverlap: (() => { const el = usage.querySelector('.usage-more-summary'); return !!el && intersects(rect(el), rect(actions)); })(),
      windows: [...usage.querySelectorAll('.usage-window')].map((item, index) => {
        const labels = item.querySelector('.usage-labels');
        const track = item.querySelector('.usage-track');
        const reset = item.querySelector('.usage-reset');
        return {
          shown: item.checkVisibility({ contentVisibilityAuto: true }) && rect(item).height > 0,
          text: labels.textContent, label: track.getAttribute('aria-label'),
          first: labels.firstElementChild.textContent,
          value: track.getAttribute('aria-valuenow'),
          resetVisible: !!reset && rect(reset).width > 0 && rect(reset).height > 0,
          resetActionsOverlap: !!reset && intersects(rect(reset), rect(actions)),
          resetTime: new Date(usageState.windows[index].resetsAt * 1000).toLocaleString(document.documentElement.lang, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          }),
          resetText: reset?.textContent,
          overlap: intersects(rect(labels), rect(track)),
          overflow: item.scrollWidth > item.clientWidth || labels.scrollWidth > labels.clientWidth,
        };
      }),
    };
  });
  // Model-specific limits start collapsed: the general windows and the toggle show, the scoped window does not
  const collapsed = await measureClaude();
  assert.equal(collapsed.moreOpen, false, `model limits must start collapsed at ${name(locale, width)}`);
  assert.equal(collapsed.summaryText, modelLimits[locale]);
  assert.equal(collapsed.summaryVisible, true);
  assert.equal(collapsed.summaryActionsOverlap, false, `model-limit toggle overlaps actions at ${name(locale, width)}`);
  assert.deepEqual(collapsed.windows.map((w) => w.shown), [true, true, false]);
  assert.equal(collapsed.horizontalOverflow, false, `claude horizontal overflow (collapsed) at ${name(locale, width)}`);
  await shot(`${name(locale, width)}-claude.png`, 'claude');
  await page.click('#panel-claude .row[data-dir="/fixture/.claude-work"] .usage-more-summary');
  // The expanded state survives a re-render that replaces the row (another locale and back forces new DOM)
  const rerendered = await page.evaluate(({ locale, width }) => {
    const sel = '#panel-claude .row[data-dir="/fixture/.claude-work"] details.usage-more';
    const before = document.querySelector(sel);
    window.preview.apply({ locale: locale === 'en' ? 'ja' : 'en', width, active: 'claude' });
    window.preview.apply({ locale, width, active: 'claude' });
    return document.querySelector(sel) !== before;
  }, { locale, width });
  assert.equal(rerendered, true, `the row must be re-rendered at ${name(locale, width)}`);
  const claude = await measureClaude();
  assert.equal(claude.moreOpen, true, `model limits must stay expanded after a re-render at ${name(locale, width)}`);
  assert.equal(claude.rows, 3);
  assert.equal(claude.visible, true);
  assert.equal(claude.horizontalOverflow, false, `claude horizontal overflow at ${name(locale, width)}`);
  assert.equal(claude.usageCount, 1);
  assert.equal(claude.usageVisible, true);
  assert.equal(claude.usageActionsOverlap, false, `claude usage overlaps actions at ${name(locale, width)}`);
  assert.equal(claude.emptyUsage, false);
  assert.equal(claude.defaultUsage, false);
  assert.equal(claude.windows.length, 3);
  for (const [index, percent] of [58, 14, 75].entries()) {
    const window = claude.windows[index];
    assert.equal(window.label, scopedDurations[locale][index]);
    assert.equal(window.first, window.label, `aria-label differs from visible label at ${name(locale, width)}`);
    assert.ok(window.text.includes(remaining[locale](percent)));
    assert.equal(window.value, String(percent));
    assert.equal(window.resetVisible, true);
    assert.equal(window.resetText, resets[locale] + window.resetTime);
    assert.equal(window.resetActionsOverlap, false, `claude reset date overlaps actions at ${name(locale, width)}`);
    assert.equal(window.overlap, false, `claude usage labels overlap track at ${name(locale, width)}`);
    assert.equal(window.overflow, false, `claude usage window overflow at ${name(locale, width)}`);
    assert.equal(window.shown, true);
  }
  await shot(`${name(locale, width)}-claude-expanded.png`, 'claude');
  // Collapse again so the next case starts from the default
  await page.click('#panel-claude .row[data-dir="/fixture/.claude-work"] .usage-more-summary');
  assert.equal(await page.evaluate(() => document.querySelector('#panel-claude .row[data-dir="/fixture/.claude-work"] details.usage-more').open), false);
  results.cases.push({ locale, width, mode: 'claude', passed: true, ...claude });
}

async function restartControls(locale, width) {
  await page.evaluate(({ locale, width }) => window.preview.apply({ locale, width, active: 'codex' }), { locale, width });
  for (const restart of [
    { context: 'wsl', auto: true },
    { context: 'wsl', auto: false },
    { context: 'local', auto: false, userEnv: true },
    { context: 'remote', auto: false },
  ]) {
    await page.evaluate((restart) => {
      const state = structuredClone(window.preview.state());
      state.codex.restart = restart;
      state.codex.pendingDir = 'Work';
      window.preview.post({ type: 'state', state });
    }, restart);
    assert.equal(await page.locator('#panel-codex .banner').count(), 1);
    assert.equal(await page.locator('#panel-codex .banner vscode-button').count(), 0);
    assert.equal(await page.locator('.tools[role="toolbar"] vscode-toolbar-button').count(), 5);
    assert.equal(await page.locator('[data-action="restartServer"], vscode-icon[name="server-process"]').count(), 0);
    const overflow = await page.evaluate(() => {
      const sidebar = document.querySelector('#sidebar');
      const banner = document.querySelector('#panel-codex .banner');
      return sidebar.scrollWidth > sidebar.clientWidth || banner.scrollWidth > banner.clientWidth;
    });
    assert.equal(overflow, false, `pending banner overflow at ${name(locale, width)}`);
    await shot(`${name(locale, width)}-pending-${restart.context}-${restart.auto}.png`, 'codex');
  }
  await page.evaluate(() => window.preview.clearMessages());
  await page.locator(`${row('codex', 'work')} [data-action="switch"]`).click();
  assert.deepEqual(await page.evaluate(() => window.preview.messages),
    [{ type: 'switch', mode: 'codex', dir: '/fixture/.codex-work' }]);
  results.interactions.push(`${name(locale, width)}: restart controls absent in automatic/manual contexts; switch request preserved`);
}

async function usageEndpoints() {
  await page.evaluate(() => {
    window.preview.apply({ locale: 'en', width: 200, active: 'codex' });
    const state = structuredClone(window.preview.state());
    const account = state.codex.accounts.find((a) => a.dir === '/fixture/.codex-work');
    account.usage.windows[0].usedPercent = 0;
    account.usage.windows[1].usedPercent = 100;
    window.preview.post({ type: 'state', state });
  });
  const values = await page.locator(`${row('codex', 'work')} .usage-window`).evaluateAll((windows) => windows.map((item) => ({
    value: item.querySelector('.usage-track').getAttribute('aria-valuenow'),
    text: item.querySelector('.usage-labels').textContent,
    fill: item.querySelector('.usage-fill').style.width,
  })));
  for (const [index, percent] of [100, 0].entries()) {
    assert.equal(values[index].value, String(percent));
    assert.equal(values[index].fill, `${percent}%`);
    assert.ok(values[index].text.includes(remaining.en(percent)));
  }
  await shot('en-200-usage-endpoints.png', 'codex');
  results.interactions.push('usage endpoints display 100% and 0% remaining for 0% and 100% used');
}

async function resetDateStates() {
  await page.evaluate(() => {
    window.preview.apply({ locale: 'en', width: 200, active: 'codex' });
    const state = structuredClone(window.preview.state());
    const account = state.codex.accounts.find((a) => a.dir === '/fixture/.codex-work');
    delete account.usage.windows[0].resetsAt;
    window.preview.post({ type: 'state', state });
  });
  const windows = page.locator(`${row('codex', 'work')} .usage-window`);
  assert.equal(await windows.count(), 2);
  assert.equal(await windows.nth(0).locator('.usage-reset').count(), 0);
  assert.equal(await windows.nth(0).locator('.usage-track').getAttribute('aria-valuenow'), '58');
  assert.equal(await windows.nth(1).locator('.usage-reset').count(), 1);
  const remainingWindow = await windows.nth(1).textContent();
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    const account = state.codex.accounts.find((a) => a.dir === '/fixture/.codex-work');
    // Model the refreshed host payload after the first window expired and was filtered out by the host.
    account.usage.windows = account.usage.windows.slice(1);
    window.preview.post({ type: 'state', state });
  });
  assert.equal(await windows.count(), 1);
  assert.equal(await windows.nth(0).textContent(), remainingWindow);
  assert.equal(await windows.nth(0).locator('.usage-track').getAttribute('aria-valuenow'), '14');
  assert.equal(await windows.nth(0).locator('.usage-reset').count(), 1);
  results.interactions.push('missing reset date preserves its bar; refreshed host state removes only the expired window');
}

async function interactions() {
  await page.evaluate(() => { window.preview.apply({ locale: 'en', width: 420, active: 'claude' }); window.preview.clearMessages(); });
  await page.locator('#tab-codex').click();
  assert.deepEqual(await page.evaluate(() => window.preview.messages), [{ type: 'setTab', mode: 'codex' }]);
  results.interactions.push('tab switch sent setTab');

  await page.evaluate(() => window.preview.clearMessages());
  await page.locator(`${row('codex', 'work')} [data-action="switch"]`).click();
  assert.deepEqual(await page.evaluate(() => window.preview.messages),
    [{ type: 'switch', mode: 'codex', dir: '/fixture/.codex-work' }]);
  results.interactions.push('switch sent exact account directory');

  await page.evaluate(() => window.preview.clearMessages());
  await page.locator(`${row('codex', 'work')} [data-action="rename"]`).click();
  const input = page.locator(`${row('codex', 'work')} .rename-field input`);
  await input.fill('Renamed Work');
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    state.codex.accounts[0].email = 'updated@example.test';
    window.preview.post({ type: 'state', state });
  });
  assert.equal(await input.inputValue(), 'Renamed Work');
  assert.equal(await input.evaluate((el) => el === document.activeElement || el.getRootNode().activeElement === el), true);
  results.interactions.push('state push preserved rename input and focus');
  await input.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.preview.messages),
    [{ type: 'rename', mode: 'codex', dir: '/fixture/.codex-work', label: 'Renamed Work' }]);
  await page.evaluate(() => window.preview.post({ type: 'renameResult', mode: 'codex', dir: '/fixture/.codex-work' }));
  results.interactions.push('rename sent exact message and accepted host result');

  await page.evaluate(() => window.preview.clearMessages());
  await page.locator(`${row('codex', 'work')} [data-action="remove"]`).click();
  await page.locator(`${row('codex', 'work')} [data-action="confirmCancel"]`).click();
  assert.deepEqual(await page.evaluate(() => window.preview.messages), []);
  results.interactions.push('remove cancel sent no remove message');

  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    for (const account of state.codex.accounts) delete account.usage;
    window.preview.post({ type: 'state', state });
  });
  assert.equal(await page.locator('#panel-codex .row-usage').count(), 0);
  results.interactions.push('host state without usage removed historical rows');

  for (const mode of ['claude', 'codex']) {
    await page.evaluate((mode) => window.preview.apply({ locale: 'en', width: 420, active: mode }), mode);
    await page.locator(`${row(mode, 'work')} [data-action="rename"]`).click();
    const rename = page.locator(`${row(mode, 'work')} .rename-field input`);
    await rename.fill('');
    const add = page.locator(`#panel-${mode} .add vscode-textfield input`);
    await add.fill('fresh');
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      state[mode].accounts[0].email = 'another@example.test';
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.equal(await add.evaluate((el) => el.getRootNode().activeElement === el), true, `${mode} add input lost focus to rename`);
    await page.keyboard.type('-account');
    assert.equal(await add.inputValue(), 'fresh-account');
    assert.equal(await rename.inputValue(), '');
    await shot(`${mode}-focus-preserved.png`, mode);
    results.interactions.push(`${mode} state rebuild preserved add focus while an invalid rename stayed open`);
    await rename.press('Escape');
  }
}

try {
  await mkdir(output, { recursive: true });
  profile = await mkdtemp(path.join(os.tmpdir(), 'planswap-ui-'));
  preview = await startPreview();
  context = await chromium.launchPersistentContext(profile, headed
    ? { headless: false, viewport: null, args: ['--start-fullscreen', '--disable-gpu'] }
    : { headless: true, viewport: HEADLESS_VIEWPORT, deviceScaleFactor: 1, args: ['--disable-gpu'] });
  page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (error) => results.consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') results.consoleErrors.push(message.text());
  });
  let bounds;
  if (headed) {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    bounds = await cdp.send('Browser.getWindowBounds', { windowId });
    assert.equal(bounds.bounds.windowState, 'fullscreen', 'browser must be full-screen');
  }
  // The synthetic page has no favicon; avoid an unrelated browser request warning.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
  await page.goto(preview.url);
  assert.equal(page.url(), preview.url);
  assert.equal(await page.title(), 'PlanSwap synthetic Webview preview');
  await page.waitForFunction(() => window.preview?.messages.some((message) => message.type === 'ready')
    && !!document.querySelector('#tab-claude') && window.preview.state()?.codex.accounts.length === 3);
  const display = await page.evaluate(() => ({
    screenWidth: screen.width, screenHeight: screen.height,
    viewportWidth: innerWidth, viewportHeight: innerHeight,
    zoomScale: visualViewport.scale, devicePixelRatio,
  }));
  if (headed) {
    assert.equal(bounds.bounds.width, display.screenWidth, 'full-screen window must fill the display width');
    assert.equal(bounds.bounds.height, display.screenHeight, 'full-screen window must fill the display height');
    assert.equal(display.viewportWidth, display.screenWidth, 'page must fill the display width');
    assert.equal(display.viewportHeight, display.screenHeight, 'page must fill the display height');
  } else {
    assert.equal(display.viewportWidth, HEADLESS_VIEWPORT.width, 'page must fill the headless viewport width');
    assert.equal(display.viewportHeight, HEADLESS_VIEWPORT.height, 'page must fill the headless viewport height');
    assert.equal(display.devicePixelRatio, 1, 'headless pages render at device scale 1');
  }
  assert.equal(display.zoomScale, 1, 'browser zoom must remain at 100%');
  results.window = { headless: !headed, bounds: bounds?.bounds, display, viewportEmulation: !headed };
  for (const locale of locales) for (const width of widths) await runCase(locale, width);
  for (const locale of locales) for (const width of widths) await restartControls(locale, width);
  await usageEndpoints();
  await resetDateStates();
  await interactions();
  assert.deepEqual(results.consoleErrors, [], 'preview console must have no errors or warnings');
  console.log(`UI preview passed: ${results.cases.length} layout cases, 121 Codex screenshots, ${results.interactions.length} interactions`);
} catch (error) {
  results.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  console.error(results.failures[0]);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await context?.close();
  await preview?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
