import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startPreview } from './preview/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.test-out', 'ui');
const locales = ['en', 'zh-cn', 'zh-tw', 'es', 'ja'];
const widths = [200, 240, 280, 340, 420];
// Bar tooltip: what is left and what is used
const barTitle = {
  en: (left) => `${left}% left (${100 - left}% used)`, 'zh-cn': (left) => `剩余 ${left}%（已用 ${100 - left}%）`,
  'zh-tw': (left) => `剩餘 ${left}%（已用 ${100 - left}%）`,
  es: (left) => `${left}% restante (${100 - left}% usado)`, ja: (left) => `残り ${left}%（使用済み ${100 - left}%）`,
};
// Reset sentence in the bar's screen reader value: the short duration shown on the card plus the absolute date
const resetsIn = {
  en: (time, date) => `Resets in ${time} (${date})`, 'zh-cn': (time, date) => `${time}后重置（${date}）`,
  'zh-tw': (time, date) => `${time}後重設（${date}）`,
  es: (time, date) => `Se restablece en ${time} (${date})`, ja: (time, date) => `${time}後にリセット（${date}）`,
};
// Reference for the visible short duration (two largest units, zero unit left out, rounded up to the minute); runs in the page
const SHORT_RESET = `(seconds) => {
  const total = Math.max(1, Math.ceil((seconds * 1000 - Date.now()) / 60000));
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  const parts = Object.fromEntries(Object.entries(d ? { days: d, hours: h } : h ? { hours: h, minutes: m } : { minutes: m }).filter(([, n]) => n > 0));
  const lang = document.documentElement.lang;
  return new Intl.DurationFormat(lang, { style: lang === 'ja' || lang === 'zh-TW' ? 'short' : 'narrow' }).format(parts);
}`;
const exhausted = { en: 'Used up', 'zh-cn': '已用完', 'zh-tw': '已用完', es: 'Agotado', ja: '使い切り' };
const switchLabel = { en: 'Switch to this account', 'zh-cn': '切换到此账号', 'zh-tw': '切換到此帳號', es: 'Cambiar a esta cuenta', ja: 'このアカウントに切り替え' };
const refreshTitle = {
  en: 'Refresh usage limits of the current account', 'zh-cn': '刷新当前账号的用量额度', 'zh-tw': '重新整理目前帳號的用量額度',
  es: 'Actualizar los límites de uso de la cuenta actual', ja: '現在のアカウントの使用量の上限を更新',
};
const refreshAllTitle = {
  en: 'Refresh usage limits of all accounts', 'zh-cn': '刷新全部账号的用量额度', 'zh-tw': '重新整理全部帳號的用量額度',
  es: 'Actualizar los límites de uso de todas las cuentas', ja: 'すべてのアカウントの使用量の上限を更新',
};
const addLabel = { en: 'Add', 'zh-cn': '添加', 'zh-tw': '新增', es: 'Añadir', ja: '追加' };
const durations = { en: ['5-hour limit', '7-day limit'], 'zh-cn': ['5 小时额度', '7 天额度'], 'zh-tw': ['5 小時額度', '7 天額度'], es: ['Límite de 5 h', 'Límite de 7 días'], ja: ['5 時間の上限', '7 日間の上限'] };
const scopedDurations = {
  en: ['5-hour limit', '7-day limit', '7-day limit · Fable'],
  'zh-cn': ['5 小时额度', '7 天额度', '7 天额度 · Fable'],
  'zh-tw': ['5 小時額度', '7 天額度', '7 天額度 · Fable'],
  es: ['Límite de 5 h', 'Límite de 7 días', 'Límite de 7 días · Fable'],
  ja: ['5 時間の上限', '7 日間の上限', '7 日間の上限 · Fable'],
};
const remaining = {
  en: (percent) => `${percent}% remaining`,
  'zh-cn': (percent) => `剩余 ${percent}%`,
  'zh-tw': (percent) => `剩餘 ${percent}%`,
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

// Card structure of one provider page: no current badge or directory line, aria-current, visible Switch button,
// directory hover title, neutral plan tags outside the current card, flat current card and readable font sizes
async function cardChecks(mode, locale, width) {
  const data = await page.evaluate(({ mode }) => {
    const panel = document.querySelector(`#panel-${mode}`);
    const rows = [...panel.querySelectorAll('.row')];
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const info = (row) => {
      const pill = row.querySelector('.pill.plan');
      const button = row.querySelector('[data-action="switch"]');
      const style = getComputedStyle(row);
      return {
        dir: row.dataset.dir, title: row.title, avatarTitle: row.querySelector('.avatar').title, ariaCurrent: row.getAttribute('aria-current'),
        switchText: button?.textContent.trim() ?? null, switchTitle: button?.title ?? null,
        switchLabel: button?.shadowRoot?.querySelector('button')?.getAttribute('aria-label') ?? null,
        switchIcon: button?.getAttribute('icon') ?? null,
        switchSize: button ? `${rect(button).width}x${rect(button).height}` : null,
        switchVisible: !!button && rect(button).width > 0 && rect(button).height > 0,
        switchInside: !!button && rect(button).left >= rect(row).left && rect(button).right <= rect(row).right,
        pillBackground: pill && getComputedStyle(pill).backgroundColor, pillImage: pill && getComputedStyle(pill).backgroundImage,
        pillBorder: pill && getComputedStyle(pill).borderTopColor, pillText: pill && getComputedStyle(pill).color,
        boxShadow: style.boxShadow, backgroundImage: style.backgroundImage,
        actionsWrapHeight: rect(row.querySelector('.row-actions')).height,
        inlineActions: row.classList.contains('inline-actions'),
        // The tag group wraps under the name only when avatar + name (+ icon-only buttons) + tags cannot share the line
        tagsWrappedNeedlessly: (() => {
          const tags = row.querySelector('.row-tags');
          if (!tags || !tags.childElementCount || rect(tags).top < rect(row.querySelector('.row-title')).bottom) return false;
          const head = row.querySelector('.row-head');
          const inline = head.querySelector('.row-actions');
          const need = rect(row.querySelector('.avatar')).width + 8 + rect(row.querySelector('.row-name')).width
            + (inline ? 8 + rect(inline).width : 0) + 8 + rect(tags).width;
          return need <= rect(head).width;
        })(),
        // The hidden rename pencil takes no width: removing it must not move the tag group
        pencilNeutral: (() => {
          const tags = row.querySelector('.row-tags'); const pencil = row.querySelector('.rename-btn');
          if (!tags?.childElementCount || !pencil) return true;
          const before = rect(tags).top; pencil.style.display = 'none';
          const after = rect(tags).top; pencil.style.display = '';
          return Math.abs(before - after) < 1;
        })(),
        tagsRight: !row.querySelector('.row-tags')?.childElementCount
          || Math.abs(rect(row.querySelector('.row-tags')).right - rect(row.querySelector('.row-head')).right) <= 1,
        pillRightmost: !pill || rect(pill).top >= rect(row.querySelector('.row-title')).bottom
          || rect(pill).right >= rect(row.querySelector('.row-actions')).right - 1,
        actionsFromContentStart: Math.abs(rect(row.querySelector('.row-actions')).left - rect(row.querySelector('.avatar')).left) <= 1,
        actionsInNameLine: rect(row.querySelector('.row-actions')).top < rect(row.querySelector('.row-title')).bottom,
        textButtonsLeft: (() => {
          const first = row.querySelector('.row-btns > :first-child');
          return !first || Math.abs(rect(first).left - rect(row.querySelector('.row-actions')).left) <= 1;
        })(),
        iconsRight: (() => {
          const icons = row.querySelectorAll('.row-actions .icon-btn');
          return icons.length === 0 || Math.abs(rect(icons[icons.length - 1]).right - rect(row.querySelector('.row-actions')).right) <= 1;
        })(),
      };
    };
    return {
      currentIcons: panel.querySelectorAll('.current-icon, .avatar-badge').length,
      dirLines: panel.querySelectorAll('.row-dir').length,
      ariaCurrentRows: panel.querySelectorAll('.row[aria-current]').length,
      rows: rows.map(info),
      avatarSizes: [...panel.querySelectorAll('.avatar')].map((a) => `${rect(a).width}x${rect(a).height}`),
      defaultAvatar: panel.querySelector('.row[data-dir$="-default"], .row[data-dir$="/.claude"], .row[data-dir$="/.codex"]')?.querySelector('.avatar')?.getAttribute('aria-label') ?? null,
    };
  }, { mode });
  const where = `${mode} ${name(locale, width)}`;
  assert.equal(data.currentIcons, 0, `current badge or avatar badge present at ${where}`);
  assert.equal(data.dirLines, 0, `directory line present at ${where}`);
  assert.equal(data.ariaCurrentRows, 1, `exactly one aria-current row expected at ${where}`);
  assert.equal(new Set(data.avatarSizes).size, 1, `avatars differ in size at ${where}`);
  for (const row of data.rows) {
    const current = row.ariaCurrent === 'true';
    assert.equal(row.title, '', `the card itself has no tooltip at ${where}`);
    assert.equal(row.avatarTitle, row.dir, `avatar title is the directory at ${where}`);
    if (current) {
      assert.equal(row.boxShadow, 'none', `current card has a shadow at ${where}`);
      assert.equal(row.backgroundImage, 'none', `current card has a gradient at ${where}`);
      assert.equal(row.switchText, null, `current card has a Switch button at ${where}`);
    } else {
      assert.equal(row.ariaCurrent, null);
      assert.equal(row.switchText, '', `Switch button must have no visible text at ${where}`);
      assert.equal(row.switchTitle, switchLabel[locale], `Switch button tooltip at ${where}`);
      assert.equal(row.switchLabel, switchLabel[locale], `Switch button accessible name at ${where}`);
      assert.equal(row.switchIcon, 'arrow-swap', `Switch button icon at ${where}`);
      assert.equal(row.switchSize, '24x24', `Switch button size at ${where}`);
      assert.equal(row.switchVisible && row.switchInside, true, `Switch button hidden or outside the card at ${where}`);
    }
    // Every plan tag is a neutral outline, the current card's included
    if (row.pillBackground) {
      assert.equal(row.pillBackground, 'rgba(0, 0, 0, 0)', `plan tag is filled at ${where}`);
      assert.equal(row.pillImage, 'none');
    }
    // Without Switch / Log in, actions move to the name line; otherwise the two groups stay left and right
    assert.equal(row.actionsInNameLine, row.inlineActions, `button group line at ${where}`);
    assert.equal(row.pillRightmost, true, `plan tag is not at the right end of the name line at ${where}`);
    assert.equal(row.tagsWrappedNeedlessly, false, `tag group wrapped although it fits beside the name at ${where}`);
    assert.equal(row.tagsRight, true, `tag group is not right-aligned at ${where}`);
    assert.equal(row.pencilNeutral, true, `hidden rename pencil moves the tag group at ${where}`);
    if (row.switchText !== null) assert.equal(row.inlineActions, false);
    if (!row.inlineActions) assert.equal(row.actionsFromContentStart, true, `button line does not span the card at ${where}`);
    assert.equal(row.textButtonsLeft, true, `text buttons not on the left at ${where}`);
    assert.equal(row.iconsRight, true, `icon buttons not on the right at ${where}`);
  }
  // Tools: the buttons of one line are equally wide unless a label needs more (that button is then exactly as wide as its
  // label), and no label is cut off
  const tools = await page.evaluate((mode) => [...document.querySelectorAll(`#panel-${mode} .page-tools-row vscode-button`)]
    .filter((b) => !b.hidden).map((b) => {
      const r = b.getBoundingClientRect();
      const base = b.shadowRoot.querySelector('[part~="base"]');
      b.style.flex = 'none';
      const natural = b.getBoundingClientRect().width;
      b.style.flex = '';
      return { label: b.textContent.trim(), top: Math.round(r.top), width: r.width, natural, cut: !!base && base.scrollWidth > base.clientWidth + 1 };
    }), mode);
  const lines = Map.groupBy(tools, (b) => b.top);
  for (const line of lines.values()) {
    const narrowest = Math.min(...line.map((b) => b.width));
    for (const b of line.filter((b) => b.width > narrowest + 1)) {
      assert.ok(Math.abs(b.width - b.natural) <= 1, `tool button ${b.label} is wider than its line share without needing it at ${where}`);
    }
  }
  assert.deepEqual(tools.filter((b) => b.cut), [], `tool button label cut off at ${where}`);
  return data;
}

async function runCase(locale, width) {
  await page.evaluate(({ locale, width }) => window.preview.apply({ locale, width, active: 'codex' }), { locale, width });
  const data = await page.evaluate((shortReset) => {
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
      windows: [...usage.querySelectorAll('.usage-window')].map((item, index) => {
        const labels = item.querySelector('.usage-labels');
        const track = item.querySelector('.usage-track');
        const fill = item.querySelector('.usage-fill');
        const reset = item.querySelector('.usage-reset');
        const pct = item.querySelector('.usage-pct');
        const relative = eval(shortReset);
        return {
          text: labels.textContent,
          label: track.getAttribute('aria-label'), role: track.getAttribute('role'),
          value: track.getAttribute('aria-valuenow'), min: track.getAttribute('aria-valuemin'), max: track.getAttribute('aria-valuemax'),
          valueText: track.getAttribute('aria-valuetext'), fill: fill.style.width,
          fillRatio: rect(fill).width / rect(track).width,
          resetText: reset?.textContent,
          resetTitle: reset?.title, trackTitle: track.title,
          resetRelative: relative(usageState.windows[index].resetsAt),
          pctText: pct.textContent, pctTitle: pct.title, trackWidth: rect(track).width,
          pctBesideBar: rect(pct).top < rect(track).bottom && rect(pct).bottom > rect(track).top,
          numberColumn: !reset || Math.abs(rect(reset).right - rect(pct).right) <= 1,
          resetTime: new Date(usageState.windows[index].resetsAt * 1000).toLocaleString(document.documentElement.lang, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          }),
          resetVisible: !!reset && rect(reset).width > 0 && rect(reset).height > 0,
          resetInLabelLine: !!reset && labels.contains(reset) && rect(reset).bottom <= rect(track).top + 0.5
            && Math.abs(rect(reset).right - rect(labels).right) <= 1,
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
    };
  }, SHORT_RESET);
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
  assert.equal(data.usageTitle, '', 'only the bars have a tooltip');
  assert.equal(data.windows.length, 2);
  for (const [index, percent] of [58, 14].entries()) {
    const window = data.windows[index];
    assert.equal(window.role, 'progressbar');
    assert.equal(window.label, durations[locale][index]);
    assert.ok(window.text.includes(window.label));
    assert.equal(window.pctText, `${percent}%`);
    assert.equal(window.pctTitle, '');
    assert.equal(window.resetTitle, '');
    assert.equal(window.trackTitle, barTitle[locale](percent));
    const resetSentence = resetsIn[locale](window.resetRelative, window.resetTime);
    assert.equal(window.valueText, `${remaining[locale](percent)}, ${resetSentence}`);
    assert.equal(window.value, String(percent));
    assert.equal(window.min, '0');
    assert.equal(window.max, '100');
    assert.equal(window.fill, `${percent}%`);
    assert.ok(Math.abs(window.fillRatio - percent / 100) < 0.02);
    assert.equal(window.resetText, window.resetRelative);
    if (locale === 'zh-cn') assert.match(resetSentence, /^\d+(天|小时|分钟).*后重置（\d{1,2}月\d{1,2}日 \d{2}:\d{2}）$/);
    if (locale === 'zh-tw') assert.match(resetSentence, /^\d+ (天|小時|分鐘).*後重設（.+）$/);
    assert.ok(!data.usageText.includes(window.resetTime), `absolute reset time must stay out of the visible text at ${name(locale, width)}`);
    assert.equal(window.resetVisible, true);
    assert.equal(window.resetInLabelLine, true, `reset time must sit at the right of its window's label line at ${name(locale, width)}`);
    assert.equal(window.pctBesideBar, true, `percentage must sit beside the bar at ${name(locale, width)}`);
    assert.equal(window.numberColumn, true, `reset time and percentage are not right-aligned in one column at ${name(locale, width)}`);
    assert.equal(window.resetOverflow, false, `reset date overflow at ${name(locale, width)}`);
    assert.equal(window.resetActionsOverlap, false, `reset date overlaps actions at ${name(locale, width)}`);
    assert.equal(window.overlap, false, `usage labels overlap track at ${name(locale, width)}`);
    assert.equal(window.overflow, false, `usage window overflow at ${name(locale, width)}`);
  }
  assert.ok(Math.max(...data.windows.map((w) => w.trackWidth)) - Math.min(...data.windows.map((w) => w.trackWidth)) <= 1,
    `bars differ in length at ${name(locale, width)}`);
  await cardChecks('codex', locale, width);
  await shot(`${name(locale, width)}-codex.png`, 'codex');
  const usageLocator = page.locator(`${row('codex', 'work')} .row-usage`);
  const beforeHover = await usageLocator.boundingBox();
  await usageLocator.hover();
  assert.equal(await usageLocator.getAttribute('title'), null);
  assert.equal(await usageLocator.textContent(), data.usageText);
  assert.deepEqual(await usageLocator.boundingBox(), beforeHover, `usage moved on hover at ${name(locale, width)}`);
  await shot(`${name(locale, width)}-codex-hover.png`, 'codex');
  results.cases.push({ locale, width, mode: 'codex', passed: true, hoverPreserved: true, ...data });
  await page.evaluate(({ locale, width }) => window.preview.apply({ locale, width, active: 'claude' }), { locale, width });
  const measureClaude = () => page.evaluate((shortReset) => {
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
      windows: [...usage.querySelectorAll('.usage-window')].map((item, index) => {
        const labels = item.querySelector('.usage-labels');
        const track = item.querySelector('.usage-track');
        const reset = item.querySelector('.usage-reset');
        return {
          shown: item.checkVisibility({ contentVisibilityAuto: true }) && rect(item).height > 0,
          text: labels.textContent, label: track.getAttribute('aria-label'),
          first: item.querySelector('.usage-duration').textContent,
          value: track.getAttribute('aria-valuenow'),
          resetVisible: !!reset && rect(reset).width > 0 && rect(reset).height > 0,
          resetTitle: reset?.title, trackTitle: track.title,
          resetRelative: eval(shortReset)(usageState.windows[index].resetsAt),
          pctText: item.querySelector('.usage-pct').textContent, trackWidth: rect(track).width,
          resetActionsOverlap: !!reset && intersects(rect(reset), rect(actions)),
          resetText: reset?.textContent,
          overlap: intersects(rect(labels), rect(track)),
          overflow: item.scrollWidth > item.clientWidth || labels.scrollWidth > labels.clientWidth,
        };
      }),
    };
  }, SHORT_RESET);
  // Model-specific limits (sent while sidebar.showModelLimits is on) are shown right away, with no fold
  await cardChecks('claude', locale, width);
  await shot(`${name(locale, width)}-claude.png`, 'claude');
  const claude = await measureClaude();
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
    assert.equal(window.pctText, `${percent}%`);
    assert.equal(window.value, String(percent));
    assert.equal(window.resetVisible, true);
    assert.equal(window.resetText, window.resetRelative);
    assert.equal(window.resetTitle, '');
    assert.equal(window.trackTitle, barTitle[locale](percent));
    assert.equal(window.resetActionsOverlap, false, `claude reset date overlaps actions at ${name(locale, width)}`);
    assert.equal(window.overlap, false, `claude usage labels overlap track at ${name(locale, width)}`);
    assert.equal(window.overflow, false, `claude usage window overflow at ${name(locale, width)}`);
    assert.equal(window.shown, true);
  }
  // The host omits scoped windows while sidebar.showModelLimits is disabled.
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    for (const account of state.claude.accounts) {
      if (account.usage) account.usage.windows = account.usage.windows.filter((w) => !w.scope);
    }
    window.preview.post({ type: 'state', state });
  });
  assert.equal(await page.locator('#panel-claude details').count(), 0, 'no section folds');
  assert.equal(await page.locator('#panel-claude .row[data-dir="/fixture/.claude-work"] .usage-window').count(), 2);
  await shot(`${name(locale, width)}-claude-model-limits-hidden.png`, 'claude');
  // planswap.sidebar.showEmail off: the host sends hideEmail and no emails; no row shows an email or "Logged in" line
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    state.claude.hideEmail = true;
    for (const account of state.claude.accounts) delete account.email;
    window.preview.post({ type: 'state', state });
  });
  assert.equal(await page.locator('#panel-claude .row .row-sub').count(), 0, `email line hidden at ${name(locale, width)}`);
  assert.equal(await page.locator('#panel-claude .row .pill.plan').count() > 0, true, 'plan tags stay');
  await shot(`${name(locale, width)}-claude-email-hidden.png`, 'claude');
  results.cases.push({ locale, width, mode: 'claude', passed: true, ...claude });
}

// Usage refresh icon buttons left of "+ Add": present with a title and aria-label, send the right tool message, stay inside
// the heading (wrapping below the title at narrow widths) without overlapping the title, each other or the Add toggle,
// and disappear when no account can be queried
async function refreshButtons(locale, width) {
  for (const mode of ['claude', 'codex']) {
    const where = `${mode} ${name(locale, width)}`;
    await page.evaluate(({ locale, width, mode }) => { window.preview.apply({ locale, width, active: mode }); window.preview.clearMessages(); }, { locale, width, mode });
    const tools = ['refreshUsage', 'refreshAllUsage'];
    const data = await page.evaluate(({ mode, tools }) => {
      const panel = document.querySelector(`#panel-${mode}`);
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const heading = panel.querySelector('.section-title');
      const parts = [heading.querySelector('.title-main'), ...tools.map((tool) => heading.querySelector(`[data-action="${tool}"]`)), heading.querySelector('.add-toggle')];
      const boxes = parts.map(rect);
      const buttons = tools.map((tool) => {
        const el = heading.querySelector(`[data-action="${tool}"]`);
        return {
          tool, tag: el.localName, icon: el.getAttribute('icon'), title: el.title, label: el.getAttribute('label'),
          inner: el.shadowRoot?.querySelector('button')?.getAttribute('aria-label') ?? null,
          order: parts.indexOf(el), visible: rect(el).width > 0 && rect(el).height > 0,
        };
      });
      const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
      const pairs = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (intersects(boxes[i], boxes[j])) pairs.push([i, j]);
      return {
        buttons, count: heading.querySelectorAll('.title-actions > [data-action^="refresh"]').length, pairs,
        outside: boxes.some((b) => b.left < sidebar.left - 1 || b.right > sidebar.right + 1),
        headingOverflow: heading.scrollWidth > heading.clientWidth,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        addIsLast: boxes[boxes.length - 1].right >= Math.max(...boxes.map((b) => b.right)) - 0.5,
        addAfterButtons: boxes[boxes.length - 1].left >= boxes[boxes.length - 2].right - 0.5 || boxes[boxes.length - 1].top >= boxes[boxes.length - 2].bottom - 0.5,
        headingHeight: rect(heading).height,
      };
    }, { mode, tools });
    await shot(`${name(locale, width)}-${mode}-refresh-buttons.png`, mode);
    assert.equal(data.count, tools.length, `refresh button count at ${where}`);
    for (const [index, button] of data.buttons.entries()) {
      const expected = button.tool === 'refreshUsage' ? refreshTitle[locale] : refreshAllTitle[locale];
      assert.equal(button.tag, 'vscode-toolbar-button');
      assert.equal(button.icon, button.tool === 'refreshUsage' ? 'refresh' : 'layers');
      assert.equal(button.title, expected, `title at ${where}`);
      assert.equal(button.label, expected, `label at ${where}`);
      assert.equal(button.inner, expected, `aria-label at ${where}`);
      assert.equal(button.visible, true, `${button.tool} hidden at ${where}`);
      assert.equal(button.order, index + 1);
    }
    assert.deepEqual(data.pairs, [], `heading parts overlap at ${where}`);
    assert.equal(data.outside, false, `heading part outside the sidebar at ${where}`);
    assert.equal(data.headingOverflow, false, `heading overflow at ${where}`);
    assert.equal(data.horizontalOverflow, false, `horizontal overflow at ${where}`);
    assert.equal(data.addAfterButtons, true, `Add toggle must follow the refresh buttons at ${where}`);
    if (width >= 340) assert.ok(data.headingHeight < 30, `heading wrapped at ${where}: ${JSON.stringify(data)}`);
    for (const tool of tools) {
      await page.locator(`#panel-${mode} .section-title [data-action="${tool}"]`).click();
    }
    assert.deepEqual(await page.evaluate(() => window.preview.messages), tools.map((tool) => ({ type: 'tool', mode, tool })), `tool messages at ${where}`);
    await page.evaluate(() => window.preview.clearMessages());
  }
  results.interactions.push(`${name(locale, width)}: refresh buttons present, labelled, inside the heading; clicks sent the tool messages`);
}

async function refreshButtonVisibility() {
  for (const mode of ['claude', 'codex']) {
    await page.evaluate((mode) => window.preview.apply({ locale: 'en', width: 280, active: mode }), mode);
    const visible = () => page.locator(`#panel-${mode} .section-title [data-action^="refresh"]`).evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width > 0).map((el) => el.dataset.action));
    assert.deepEqual(await visible(), ['refreshUsage', 'refreshAllUsage']);
    // The current account cannot be queried: the current button goes ("all" stays while another account can be)
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      state[mode].accounts.find((a) => a.isCurrent).usageEligible = undefined;
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.deepEqual(await visible(), ['refreshAllUsage']);
    // No account can be queried
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      for (const account of state[mode].accounts) account.usageEligible = undefined;
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.deepEqual(await visible(), []);
    // Only an external directory can be queried: "all" covers registered accounts, so it stays hidden
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      const dir = `/fixture/.${mode}-external`;
      state[mode].accounts.push({ kind: 'external', name: '<external>', label: dir, dir, dirLabel: dir, loggedIn: true, usageEligible: true, isCurrent: false });
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.deepEqual(await visible(), []);
    // A disabled page shows no list heading buttons
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      for (const account of state[mode].accounts) account.usageEligible = true;
      state[mode].enabled = mode === 'claude';
      window.preview.post({ type: 'state', state });
    }, mode);
    if (mode === 'codex') assert.deepEqual(await visible(), []);
  }
  results.interactions.push('refresh buttons follow usageEligible: current button needs the current account, "all" any registered one on both pages');
}

// Recommendation card and the per-row "exclude from recommendations" toggle. The host decides what is recommended; the
// page renders the card above the list with the account's general windows, when it was observed, and the actions
// (Claude: Switch and Open terminal; Codex: Open terminal only), and the toggle on every registered row with usage limits
const recommendTitle = { en: 'Recommended: Work', 'zh-cn': '推荐：Work', 'zh-tw': '推薦：Work', es: 'Recomendada: Work', ja: 'おすすめ：Work' };
const recommendSwitch = { en: 'Switch', 'zh-cn': '切换', 'zh-tw': '切換', es: 'Cambiar', ja: '切り替え' };
const recommendTerminal = { en: 'Terminal', 'zh-cn': '终端', 'zh-tw': '終端機', es: 'Terminal', ja: 'ターミナル' };
const excludeTitle = { en: 'Exclude from recommendations', 'zh-cn': '不参与推荐', 'zh-tw': '不參與推薦', es: 'Excluir de las recomendaciones', ja: 'おすすめから除外' };
const includeTitle = { en: 'Include in recommendations', 'zh-cn': '恢复参与推荐', 'zh-tw': '恢復參與推薦', es: 'Incluir en las recomendaciones', ja: 'おすすめに含める' };
const updatedNow = { en: 'Updated just now', 'zh-cn': '刚刚更新', 'zh-tw': '剛剛更新', es: 'Actualizado ahora mismo', ja: 'たった今更新' };
async function recommendation(locale, width) {
  for (const mode of ['claude', 'codex']) {
    const where = `${mode} ${name(locale, width)}`;
    await page.evaluate(({ locale, width, mode }) => {
      window.preview.apply({ locale, width, active: mode });
      window.preview.clearMessages();
      const state = structuredClone(window.preview.state());
      const tab = state[mode];
      const now = Math.floor(Date.now() / 1000);
      // The current account runs low (20% left in 5 hours); Work has 58% / 46% left and was observed just now
      tab.accounts.find((a) => a.isCurrent).usage = { windows: [{ usedPercent: 80, windowMinutes: 300, resetsAt: now + 3600 }, { usedPercent: 40, windowMinutes: 10080, resetsAt: now + 86400 }], checkedAt: Date.now() - 5000 };
      const work = tab.accounts.find((a) => a.dir === `/fixture/.${mode}-work`);
      work.usage.windows = work.usage.windows.map((w) => (w.windowMinutes === 10080 && !w.scope ? { ...w, usedPercent: 54 } : w));
      work.usage.checkedAt = Date.now() - 5000;
      tab.recommended = work.dir;
      window.preview.post({ type: 'state', state });
    }, { locale, width, mode });
    const data = await page.evaluate(({ mode }) => {
      const panel = document.querySelector(`#panel-${mode}`);
      const card = panel.querySelector('.banner.recommend');
      const rect = (el) => el.getBoundingClientRect();
      const sidebar = rect(document.querySelector('#sidebar'));
      const buttons = [...card.querySelectorAll('vscode-button')];
      return {
        cards: panel.querySelectorAll('.banner.recommend').length,
        dir: card.dataset.dir, role: card.getAttribute('role'), ariaLabel: card.getAttribute('aria-label'),
        textColor: getComputedStyle(card.querySelector('.recommend-text')).color,
        bannerTextColor: (() => { const probe = document.createElement('div'); probe.className = 'banner-text'; card.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })(),
        order: [...panel.querySelectorAll('.row')].map((r) => r.dataset.dir),
        title: card.querySelector('.banner-title').textContent, text: card.querySelector('.recommend-text').textContent,
        icon: card.querySelector('.banner-icon').getAttribute('name'),
        buttons: buttons.map((b) => ({ action: b.dataset.action, icon: b.getAttribute('icon'), label: b.textContent.trim(), secondary: b.hasAttribute('secondary'),
          inside: rect(b).left >= sidebar.left - 1 && rect(b).right <= sidebar.right + 1 && rect(b).bottom <= rect(card).bottom + 1,
          cut: (() => { const base = b.shadowRoot?.querySelector('[part~="base"]'); return !!base && base.scrollWidth > base.clientWidth + 1; })() })),
        aboveList: rect(card).bottom <= rect(panel.querySelector('.section-title')).top,
        afterBanners: [...panel.querySelectorAll('.page-top > *')].indexOf(card) === panel.querySelectorAll('.page-top > *').length - 1,
        overflow: card.scrollWidth > card.clientWidth + 1 || document.documentElement.scrollWidth > document.documentElement.clientWidth,
        textOverflow: card.querySelector('.recommend-text').scrollWidth > card.querySelector('.recommend-text').clientWidth + 1,
        toggles: [...panel.querySelectorAll('.row [data-action="recommendExclude"]')].map((el) => ({
          dir: el.closest('.row').dataset.dir, icon: el.getAttribute('icon'), title: el.title,
          role: el.shadowRoot?.querySelector('button')?.getAttribute('role') ?? null,
          checked: el.shadowRoot?.querySelector('button')?.getAttribute('aria-checked') ?? null,
          inActions: !!el.closest('.row-icons'),
        })),
      };
    }, { mode });
    assert.equal(data.cards, 1, `one recommendation card at ${where}`);
    assert.equal(data.dir, undefined, 'the card carries no data-dir, so focus restore never mistakes it for a row');
    assert.equal(data.role, 'region');
    assert.equal(data.ariaLabel, recommendTitle[locale]);
    assert.notEqual(data.textColor, data.bannerTextColor, `card text uses the more readable color at ${where}`);
    assert.deepEqual(data.order, [`/fixture/.${mode}`, `/fixture/.${mode}-work`, `/fixture/.${mode}-empty`], `list order unchanged at ${where}`);
    assert.equal(data.icon, 'lightbulb');
    assert.equal(data.title, recommendTitle[locale], `card title at ${where}`);
    const parts = data.text.split(' · ');
    assert.equal(parts.length, 3, `two general windows and the observation time at ${where}: ${data.text}`);
    assert.equal(parts[0], `${durations[locale][0]} ${remaining[locale](58)}`, `5-hour part at ${where}`);
    assert.equal(parts[1], `${durations[locale][1]} ${remaining[locale](46)}`, `7-day part at ${where}`);
    assert.equal(parts[2], updatedNow[locale], `observation time at ${where}`);
    assert.ok(!data.text.includes('Fable'), `model-specific windows stay out of the card at ${where}`);
    const expected = [{ action: 'switch', icon: 'arrow-swap', label: recommendSwitch[locale], secondary: false }, { action: 'terminal', icon: 'terminal', label: recommendTerminal[locale], secondary: true }];
    assert.deepEqual(data.buttons.map(({ action, icon, label, secondary }) => ({ action, icon, label, secondary })), expected, `card buttons at ${where}`);
    for (const b of data.buttons) {
      assert.equal(b.inside, true, `${b.action} button outside the card at ${where}`);
      assert.equal(b.cut, false, `${b.action} label cut off at ${where}`);
    }
    assert.equal(data.aboveList, true, `card must sit above the list heading at ${where}`);
    assert.equal(data.afterBanners, true, `card comes after the banners at ${where}`);
    assert.equal(data.overflow, false, `card overflow at ${where}`);
    assert.equal(data.textOverflow, false, `card text overflow at ${where}`);
    // Toggles on the registered rows with usage limits (Default and Work; Empty cannot be queried), none excluded yet
    assert.deepEqual(data.toggles, [`/fixture/.${mode}`, `/fixture/.${mode}-work`].map((dir) => ({ dir, icon: 'lightbulb', title: excludeTitle[locale], role: 'switch', checked: 'false', inActions: true })), `row toggles at ${where}`);
    await shot(`${name(locale, width)}-${mode}-recommend.png`, mode);
    // Card actions send the recommended account's directory
    for (const action of expected.map((b) => b.action)) await page.locator(`#panel-${mode} .banner.recommend [data-action="${action}"]`).click();
    assert.deepEqual(await page.evaluate(() => window.preview.messages), expected.map((b) => ({ type: b.action, mode, dir: `/fixture/.${mode}-work` })), `card messages at ${where}`);
    await page.evaluate(() => window.preview.clearMessages());
    // planswap.usageDisplay used: the card's figures show what is used
    await page.evaluate(() => window.preview.post({ type: 'state', state: { ...structuredClone(window.preview.state()), usageDisplay: 'used' } }));
    const usedText = await page.locator(`#panel-${mode} .banner.recommend .recommend-text`).textContent();
    assert.equal(usedText.split(' · ')[0], `${durations[locale][0]} ${usedLabel[locale](42)}`, `used display at ${where}`);
  }
}
const usedLabel = {
  en: (p) => `${p}% used`, 'zh-cn': (p) => `已用 ${p}%`, 'zh-tw': (p) => `已用 ${p}%`, es: (p) => `${p}% usado`, ja: (p) => `使用済み ${p}%`,
};

async function recommendationToggle() {
  for (const mode of ['claude', 'codex']) {
    await page.evaluate((mode) => { window.preview.apply({ locale: 'en', width: 280, active: mode }); window.preview.clearMessages(); }, mode);
    const toggle = page.locator(`${row(mode, 'work')} [data-action="recommendExclude"]`);
    await toggle.click();
    assert.deepEqual(await page.evaluate(() => window.preview.messages), [{ type: 'recommendExclude', mode, dir: `/fixture/.${mode}-work`, excluded: true }]);
    await page.evaluate((mode) => {
      window.preview.clearMessages();
      const state = structuredClone(window.preview.state());
      state[mode].accounts.find((a) => a.dir === `/fixture/.${mode}-work`).recommendExcluded = true;
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.deepEqual(await toggle.evaluate((el) => ({ icon: el.getAttribute('icon'), title: el.title, checked: el.shadowRoot.querySelector('button').getAttribute('aria-checked') })),
      { icon: 'lightbulb-empty', title: includeTitle.en, checked: 'true' }, `${mode} excluded row toggle`);
    await shot(`${mode}-recommend-excluded.png`, mode);
    await toggle.click();
    assert.deepEqual(await page.evaluate(() => window.preview.messages), [{ type: 'recommendExclude', mode, dir: `/fixture/.${mode}-work`, excluded: false }]);
    // planswap.sidebar.showRecommendation off: no card and no toggles, the other row buttons stay
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      state[mode].hideRecommendation = true;
      state[mode].recommended = `/fixture/.${mode}-work`;
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.equal(await page.locator(`#panel-${mode} .banner.recommend`).count(), 0, `${mode} card hidden by the setting`);
    assert.equal(await page.locator(`#panel-${mode} [data-action="recommendExclude"]`).count(), 0, `${mode} toggles hidden by the setting`);
    assert.equal(await page.locator(`${row(mode, 'work')} [data-action="terminal"]`).count(), 1);
    // A recommended directory missing from the list shows no card; one whose windows the display settings all hid
    // (the host then sends an empty window list with the time) still shows the card with the observation time only,
    // and the row shows no usage block
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      delete state[mode].hideRecommendation;
      state[mode].recommended = `/fixture/.${mode}-gone`;
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.equal(await page.locator(`#panel-${mode} [data-action="recommendExclude"]`).count(), 2, `${mode} toggles back without the setting`);
    assert.equal(await page.locator(`#panel-${mode} .banner.recommend`).count(), 0, `${mode} unknown recommended dir`);
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      const work = state[mode].accounts.find((a) => a.dir === `/fixture/.${mode}-work`);
      work.usage = { windows: [], checkedAt: Date.now() };
      state[mode].recommended = work.dir;
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.equal(await page.locator(`#panel-${mode} .banner.recommend`).count(), 1, `${mode} card without visible windows`);
    assert.equal(await page.locator(`#panel-${mode} .banner.recommend .recommend-text`).textContent(), updatedNow.en);
    assert.equal(await page.locator(`${row(mode, 'work')} .row-usage`).count(), 0, `${mode} row shows no empty usage block`);
  }
  results.interactions.push('recommendation toggle sends excluded true/false, reflects the host mark, and the setting hides the card and the toggles');
}

// The card's observation time is refreshed every minute without a state push (a push with the same content does not
// re-render). The fake clock is installed last, since it would freeze the page's Date.now for the earlier checks
async function updatedAgoTicks() {
  await page.clock.install();
  await page.evaluate(() => {
    window.preview.apply({ locale: 'en', width: 280, active: 'claude' });
    const state = structuredClone(window.preview.state());
    const current = state.claude.accounts.find((a) => a.isCurrent);
    current.usage = { windows: [{ usedPercent: 80, windowMinutes: 300 }], checkedAt: Date.now() };
    const work = state.claude.accounts.find((a) => a.dir === '/fixture/.claude-work');
    work.usage.checkedAt = Date.now() - 30_000;
    state.claude.recommended = work.dir;
    window.preview.post({ type: 'state', state });
  });
  const time = page.locator('#panel-claude .banner.recommend .recommend-updated');
  assert.equal(await time.textContent(), updatedNow.en);
  await page.clock.runFor(60_000);
  assert.equal(await time.textContent(), 'Updated 1 minute ago', 'the time text ticks without a state push');
  // The same state pushed again keeps the DOM (no re-render) and the ticked text
  await page.evaluate(() => window.preview.post({ type: 'state', state: structuredClone(window.preview.state()) }));
  assert.equal(await time.textContent(), 'Updated 1 minute ago');
  await page.clock.runFor(9 * 60_000);
  assert.equal(await time.textContent(), 'Updated 10 minutes ago');
  results.interactions.push('recommendation observation time ticks every minute without a state push');

  // The windows' time until reset and the bars' screen reader reset sentence tick too (no state push, no re-render)
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    const work = state.claude.accounts.find((a) => a.dir === '/fixture/.claude-work');
    work.usage.windows[0].resetsAt = Math.floor(Date.now() / 1000) + 90 * 60;
    window.preview.post({ type: 'state', state });
  });
  const resetTime = page.locator(`${row('claude', 'work')} .usage-window`).first().locator('.usage-reset-time');
  const track = page.locator(`${row('claude', 'work')} .usage-window`).first().locator('.usage-track');
  const relative = (seconds) => page.evaluate(([shortReset, s]) => eval(shortReset)(s), [SHORT_RESET, seconds]);
  const resetsAt = Number(await track.getAttribute('data-resets-at'));
  const beforeText = await resetTime.textContent();
  assert.equal(beforeText, await relative(resetsAt));
  assert.ok((await track.getAttribute('aria-valuetext')).includes(beforeText));
  const marker = await page.evaluate(() => { document.querySelector('#panel-claude .row-usage').dataset.marker = 'kept'; return 'kept'; });
  await page.clock.runFor(60_000);
  const after = await resetTime.textContent();
  assert.equal(after, await relative(resetsAt), 'the reset time ticks without a state push');
  assert.notEqual(after, beforeText, 'a minute later the text differs');
  assert.ok((await track.getAttribute('aria-valuetext')).includes(after), 'the screen reader reset sentence ticks too');
  assert.ok((await track.getAttribute('aria-valuetext')).startsWith('58% remaining, '), 'the static part of the value stays');
  assert.equal(await page.evaluate(() => document.querySelector('#panel-claude .row-usage').dataset.marker), marker, 'the DOM was refreshed in place, not rebuilt');
  results.interactions.push('window reset times and screen reader reset sentences tick every minute in place');
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
    text: item.querySelector('.usage-pct').textContent,
    fill: item.querySelector('.usage-fill').style.width,
  })));
  for (const [index, percent] of [100, 0].entries()) {
    assert.equal(values[index].value, String(percent));
    assert.equal(values[index].fill, `${percent}%`);
    assert.equal(values[index].text, `${percent}%`);
  }
  const flags = await page.locator(`${row('codex', 'work')} .usage-window`).evaluateAll((windows) => windows.map((item) => {
    const track = item.querySelector('.usage-track');
    const reset = getComputedStyle(item.querySelector('.usage-reset'));
    return { flag: item.querySelector('.usage-flag')?.textContent ?? null, level: track.dataset.level, valueText: track.getAttribute('aria-valuetext'),
      image: getComputedStyle(track).backgroundImage, resetWeight: reset.fontWeight, resetColor: reset.color,
      pctColor: getComputedStyle(item.querySelector('.usage-pct')).color };
  }));
  assert.equal(flags[0].flag, null);
  assert.equal(flags[0].level, 'ok');
  assert.equal(flags[1].flag, null, 'a window at 0% remaining has no separate used-up tag');
  assert.equal(flags[1].level, 'empty');
  assert.ok(flags[1].valueText.includes(exhausted.en), 'the used-up state stays in the progress bar value text');
  assert.match(flags[1].image, /repeating-linear-gradient/, 'the empty track is hatched');
  assert.equal(flags[1].resetWeight, '700', 'a used-up window shows its reset time in bold');
  assert.equal(flags[1].resetColor, flags[1].pctColor, 'a used-up window shows its reset time in the error color');
  assert.notEqual(flags[0].resetWeight, '700');
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

// The add form starts collapsed behind the "+ Add" toggle; focusAdd expands and focuses it; Escape and a successful add collapse it.
// The Tools section is always shown
// planswap.usageDisplay used: bars, percentages, screen reader values and the bar tooltip show what is used, in every
// locale and width; the level (color) still follows what is left
const usedTitle = {
  en: (used) => `${used}% used (${100 - used}% left)`, 'zh-cn': (used) => `已用 ${used}%（剩余 ${100 - used}%）`,
  'zh-tw': (used) => `已用 ${used}%（剩餘 ${100 - used}%）`,
  es: (used) => `${used}% usado (${100 - used}% restante)`, ja: (used) => `使用済み ${used}%（残り ${100 - used}%）`,
};
async function usedDisplay() {
  for (const locale of locales) {
    for (const width of widths) {
      await page.evaluate(({ locale, width }) => {
        window.preview.apply({ locale, width, active: 'codex' });
        window.preview.post({ type: 'state', state: { ...structuredClone(window.preview.state()), usageDisplay: 'used' } });
      }, { locale, width });
      const windows = await page.locator(`${row('codex', 'work')} .usage-window`).evaluateAll((items) => items.map((item) => {
        const track = item.querySelector('.usage-track');
        return {
          level: track.dataset.level, value: track.getAttribute('aria-valuenow'), title: track.title,
          fill: item.querySelector('.usage-fill').style.width, pct: item.querySelector('.usage-pct').textContent,
          overflow: item.scrollWidth > item.clientWidth,
        };
      }));
      const where = `used display ${name(locale, width)}`;
      assert.deepEqual(windows.map((w) => w.level), ['ok', 'warn'], `levels follow what is left at ${where}`);
      for (const [index, used] of [42, 86].entries()) {
        assert.deepEqual(windows[index], { level: windows[index].level, value: String(used), title: usedTitle[locale](used), fill: `${used}%`, pct: `${used}%`, overflow: false }, where);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `horizontal overflow at ${where}`);
      await shot(`${name(locale, width)}-codex-used.png`, 'codex');
    }
  }
  results.interactions.push('usageDisplay used: bars, percentages and tooltips show what is used in every locale and width; colors follow what is left');

  // planswap.usageWarningThreshold / usageErrorThreshold move the color levels (remaining 58% and 14%)
  const levels = async (thresholds) => {
    await page.evaluate((thresholds) => {
      window.preview.apply({ locale: 'en', width: 280, active: 'codex' });
      window.preview.post({ type: 'state', state: { ...structuredClone(window.preview.state()), usageThresholds: thresholds } });
    }, thresholds);
    return page.locator(`${row('codex', 'work')} .usage-track`).evaluateAll((tracks) => tracks.map((t) => t.dataset.level));
  };
  assert.deepEqual(await levels({ warning: 30, error: 10 }), ['ok', 'warn']);
  assert.deepEqual(await levels({ warning: 60, error: 20 }), ['warn', 'low']);
  assert.deepEqual(await levels({ warning: 10, error: 30 }), ['ok', 'low'], 'error wins over warning');
  await shot('codex-thresholds.png', 'codex');
  results.interactions.push('sidebar thresholds move the bar colors; error wins over warning');

  await page.evaluate(() => {
    window.preview.apply({ locale: 'en', width: 280, active: 'codex' });
    const state = structuredClone(window.preview.state());
    state.usageThresholds = { warning: 30, error: 10 };
    state.codex.accounts.find((a) => a.dir === '/fixture/.codex-work').usage.windows =
      [69.6, 69.996, 70, 89.6, 89.996, 90, 99.996, 100].map((usedPercent) => ({ usedPercent, windowMinutes: 300 }));
    window.preview.post({ type: 'state', state });
  });
  assert.deepEqual(await page.locator(`${row('codex', 'work')} .usage-track`).evaluateAll((tracks) => tracks.map((t) => t.dataset.level)),
    ['ok', 'ok', 'warn', 'warn', 'warn', 'low', 'low', 'empty'], 'color and exhaustion compare unrounded observations');
  results.interactions.push('fractional observations above warning, error and exhaustion boundaries retain their raw color levels');
}

async function addFormAndTools() {
  for (const mode of ['claude', 'codex']) {
    await page.evaluate((mode) => { window.preview.apply({ locale: 'en', width: 280, active: mode }); window.preview.clearMessages(); }, mode);
    const panel = `#panel-${mode}`;
    const toggle = page.locator(`${panel} .add-toggle`);
    const form = page.locator(`${panel} .add`);
    const field = page.locator(`${panel} .add vscode-textfield input`);
    const fieldFocused = () => field.evaluate((el) => el.getRootNode().activeElement === el);
    assert.equal(await form.isVisible(), false, `${mode} add form must start collapsed`);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal((await toggle.textContent()).trim(), addLabel.en);
    assert.equal(await toggle.getAttribute('aria-label'), 'Add account');
    // The toggle sits at the right end of the list heading
    const placement = await page.evaluate((panel) => {
      const title = document.querySelector(`${panel} .section-title`).getBoundingClientRect();
      const toggle = document.querySelector(`${panel} .add-toggle`).getBoundingClientRect();
      const count = document.querySelector(`${panel} .count`).getBoundingClientRect();
      return { right: toggle.right <= title.right + 1 && toggle.left > count.right, sameLine: Math.abs((toggle.top + toggle.bottom) / 2 - (title.top + title.bottom) / 2) < 6 };
    }, panel);
    assert.deepEqual(placement, { right: true, sameLine: true }, `${mode} toggle placement`);

    await toggle.click();
    assert.equal(await form.isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await fieldFocused(), true, `${mode} toggle must focus the field`);
    await page.keyboard.press('Escape');
    assert.equal(await form.isVisible(), false, `${mode} Escape must collapse the form`);
    assert.equal(await toggle.evaluate((el) => el === document.activeElement), true, `${mode} Escape must return the focus to the toggle`);

    // The host's focusAdd expands a collapsed form and focuses the field
    await page.evaluate((mode) => window.preview.post({ type: 'focusAdd', mode }), mode);
    assert.equal(await form.isVisible(), true);
    assert.equal(await fieldFocused(), true, `${mode} focusAdd must focus the field`);
    // A state push keeps the open form and its focus (the form is never re-created)
    await field.fill('fresh2');
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      state[mode].accounts[0].email = 'pushed@example.test';
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.equal(await fieldFocused(), true, `${mode} state push must keep the add focus`);
    assert.equal(await field.inputValue(), 'fresh2');

    // A host error keeps the form open and shows the message; a success collapses it, clears the input and refocuses the toggle
    await page.evaluate(() => window.preview.clearMessages());
    await field.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.preview.messages), [{ type: 'add', mode, name: 'fresh2', shared: true }]);
    await page.evaluate((mode) => window.preview.post({ type: 'addResult', mode, error: 'Failed to create account directory: test' }), mode);
    assert.equal(await form.isVisible(), true);
    assert.match(await page.locator(`${panel} .add .help`).textContent(), /Failed to create account directory: test/);
    await page.evaluate((mode) => window.preview.post({ type: 'addResult', mode }), mode);
    assert.equal(await form.isVisible(), false, `${mode} a successful add must collapse the form`);
    assert.equal(await field.inputValue(), '');
    assert.equal(await toggle.evaluate((el) => el === document.activeElement), true);

    // Tools: always shown, Re-link follows the shared-account rule
    assert.equal(await page.locator(`${panel} .page-tools-row`).isVisible(), true);
    assert.equal(await page.locator(`${panel} .page-tools-row vscode-button:visible`).count(), 4);
    await page.evaluate((mode) => {
      const state = structuredClone(window.preview.state());
      for (const a of state[mode].accounts) if (a.kind === 'named') a.shared = false;
      window.preview.post({ type: 'state', state });
    }, mode);
    assert.equal(await page.locator(`${panel} .page-tools-row vscode-button:visible`).count(), 3, `${mode} Re-link must hide without shared accounts`);
    await shot(`${mode}-add-tools.png`, mode);
    results.interactions.push(`${mode}: add form collapsed by default, expands on toggle/focusAdd, collapses on Escape/success; Tools always shown, Re-link rule intact`);
  }
}

// Footer groups (info+help | reload+restart | star) and the Switch button / row shortcuts that must send exactly one switch
async function footerAndSwitch() {
  await page.evaluate(() => { window.preview.apply({ locale: 'en', width: 200, active: 'codex' }); window.preview.clearMessages(); });
  const footer = await page.evaluate(() => [...document.querySelectorAll('.tools[role="toolbar"] > *')].map((el) => el.getAttribute('role') === 'separator' ? '|' : el.getAttribute('icon')));
  assert.deepEqual(footer, ['info', 'book', '|', 'refresh', 'debug-restart', '|', 'star-empty']);

  const button = page.locator(`${row('codex', 'work')} [data-action="switch"]`);
  await button.dblclick();
  assert.deepEqual(await page.evaluate(() => window.preview.messages), [{ type: 'switch', mode: 'codex', dir: '/fixture/.codex-work' }], 'double-clicking Switch sends one request');
  // A card double-click within 500ms of a Switch button click is the same gesture and is ignored
  await page.waitForTimeout(600);
  await page.evaluate(() => window.preview.clearMessages());
  // Clicked on the card's own padding: the name can wrap at 200px and its centre then lands on the rename pencil
  await page.locator(row('codex', 'work')).dblclick({ position: { x: 4, y: 4 } });
  assert.deepEqual(await page.evaluate(() => window.preview.messages), [{ type: 'switch', mode: 'codex', dir: '/fixture/.codex-work' }], 'double-clicking the card switches once');
  await page.evaluate(() => window.preview.clearMessages());
  await page.locator(row('codex', 'work')).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.preview.messages), [{ type: 'switch', mode: 'codex', dir: '/fixture/.codex-work' }], 'Enter on the card switches once');
  results.interactions.push('footer groups divided; Switch button, card double-click and Enter each send one switch');
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

  await usedDisplay();
  await addFormAndTools();
  await footerAndSwitch();

  for (const mode of ['claude', 'codex']) {
    await page.evaluate((mode) => window.preview.apply({ locale: 'en', width: 420, active: mode }), mode);
    await page.locator(`${row(mode, 'work')} [data-action="rename"]`).click();
    const rename = page.locator(`${row(mode, 'work')} .rename-field input`);
    await rename.fill('');
    await page.locator(`#panel-${mode} .add-toggle`).click();
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
    // --disable-gpu: the hosted Linux runner failed GPU initialization right before screenshot capture; the checks cover
    // layout and interaction, not hardware-accelerated rendering
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
  for (const locale of locales) for (const width of widths) await refreshButtons(locale, width);
  for (const locale of locales) for (const width of widths) await recommendation(locale, width);
  await recommendationToggle();
  await refreshButtonVisibility();
  await usageEndpoints();
  await resetDateStates();
  await interactions();
  await updatedAgoTicks();
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
