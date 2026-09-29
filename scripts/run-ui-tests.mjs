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
const observed = ['not live', '非实时', 'no en tiempo real', 'リアルタイムではありません'];
const results = { cases: [], interactions: [], window: null, failures: [] };
let preview;
let context;
let page;
let profile;

const name = (locale, width) => `${locale}-${width}`;
const row = (mode, suffix) => `#panel-${mode} .row[data-dir="/fixture/.${mode}-${suffix}"]`;

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
  assert.match(data.usageText, /42%/);
  assert.ok(data.usageText.includes(observed[locales.indexOf(locale)]), `missing localized historical label at ${name(locale, width)}`);
  assert.match(data.usageText, /2026/);
  if (data.appWidth >= 340) {
    assert.ok(data.gridColumns >= 4, `wide grid did not activate at ${name(locale, width)}`);
    assert.ok(data.gridAreas.includes('usage usage actions'));
  } else {
    assert.ok(data.gridColumns <= 2, `narrow grid did not activate at ${name(locale, width)}`);
  }
  await page.screenshot({ path: path.join(output, `${name(locale, width)}-codex.png`) });
  results.cases.push({ locale, width, mode: 'codex', passed: true, ...data });
  await page.evaluate(({ locale, width }) => window.preview.apply({ locale, width, active: 'claude' }), { locale, width });
  const claude = await page.evaluate(() => {
    const app = document.querySelector('#app');
    const rows = [...document.querySelectorAll('#panel-claude .row')];
    return {
      rows: rows.length,
      visible: getComputedStyle(document.querySelector('#panel-claude')).display !== 'none',
      horizontalOverflow: app.scrollWidth > app.clientWidth || rows.some((item) => item.scrollWidth > item.clientWidth),
      usageCount: document.querySelectorAll('#panel-claude .row-usage').length,
    };
  });
  assert.deepEqual(claude, { rows: 3, visible: true, horizontalOverflow: false, usageCount: 0 });
  results.cases.push({ locale, width, mode: 'claude', passed: true, ...claude });
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
  await page.evaluate(() => window.preview.post({ type: 'state', state: window.preview.state() }));
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
}

try {
  await mkdir(output, { recursive: true });
  profile = await mkdtemp(path.join(os.tmpdir(), 'planswap-ui-'));
  preview = await startPreview();
  context = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: null, args: ['--start-fullscreen'],
  });
  page = context.pages()[0] ?? await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  const bounds = await cdp.send('Browser.getWindowBounds', { windowId });
  assert.equal(bounds.bounds.windowState, 'fullscreen', 'browser must be full-screen');
  await page.goto(preview.url);
  await page.waitForFunction(() => window.preview?.messages.some((message) => message.type === 'ready')
    && !!document.querySelector('#tab-claude') && window.preview.state()?.codex.accounts.length === 3);
  const display = await page.evaluate(() => ({
    screenWidth: screen.width, screenHeight: screen.height,
    viewportWidth: innerWidth, viewportHeight: innerHeight,
    zoomScale: visualViewport.scale, devicePixelRatio,
  }));
  assert.equal(bounds.bounds.width, display.screenWidth, 'full-screen window must fill the display width');
  assert.equal(bounds.bounds.height, display.screenHeight, 'full-screen window must fill the display height');
  assert.equal(display.viewportWidth, display.screenWidth, 'page must fill the display width');
  assert.equal(display.viewportHeight, display.screenHeight, 'page must fill the display height');
  assert.equal(display.zoomScale, 1, 'browser zoom must remain at 100%');
  results.window = { bounds: bounds.bounds, display, viewportEmulation: false };
  for (const locale of locales) for (const width of widths) await runCase(locale, width);
  await interactions();
  console.log(`UI preview passed: ${results.cases.length} layout cases, 20 Codex screenshots, ${results.interactions.length} interactions`);
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
