// Launches the cached VS Code with a disposable HOME, connects to it over the Chrome DevTools Protocol and hands a
// scenario a small driver API for the PlanSwap sidebar. Nothing under the real home is read or written: the editor
// gets its own HOME, XDG directories, extensions directory and (persistent, account-free) user-data directory, and
// `claude` / `codex` are kept off PATH so a usage check can only report "CLI missing".
import { runTests } from '@vscode/test-electron';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const VSCODE_VERSION = '1.107.0';
const PORT = 9333;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_SETTINGS = {
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false, 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'window.dialogStyle': 'custom', 'workbench.colorTheme': 'Default Dark Modern',
  // No automatic usage checks: the editor must never try to run a CLI against the fake accounts
  'planswap.claude.usageAutoRefresh': false, 'planswap.codex.usageAutoRefresh': false,
};

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * Runs `scenario(ctx)` against a fresh editor. `seed(home)` creates the fake accounts and returns whatever the
 * scenario needs as ctx.dirs. Artifacts (screenshots, report.json) go to .test-out/devhost/<name>/. Resolves to the
 * report; the editor is always closed and the temporary HOME removed.
 */
export async function runScenario({ name, seed, scenario, window }) {
  const out = path.join(root, '.test-out', 'devhost', name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'planswap-devhost-'));
  const report = { name, startedAt: new Date().toISOString(), steps: [], failures: [] };
  const dirs = seed(home);

  // Editor data: kept across runs so the window position survives; it holds settings and PlanSwap's small globalState,
  // never account data. Settings are rewritten on every run
  const userData = path.join(root, '.test-out', 'devhost-user-data');
  const settingsFile = path.join(userData, 'User', 'settings.json');
  fs.mkdirSync(path.join(userData, 'User', 'globalStorage'), { recursive: true });
  const writeSettings = (extra = {}) => fs.writeFileSync(settingsFile, JSON.stringify({ ...BASE_SETTINGS, ...extra }, null, 2));
  writeSettings();
  if (window) {
    // A test-mode exit never saves window state, so the position is written before every start
    const storageFile = path.join(userData, 'User', 'globalStorage', 'storage.json');
    const storage = fs.existsSync(storageFile) ? JSON.parse(fs.readFileSync(storageFile, 'utf8')) : {};
    storage.windowsState = { lastActiveWindow: { uiState: { mode: 'Normal', ...window } }, openedWindows: [] };
    fs.writeFileSync(storageFile, JSON.stringify(storage, null, 2));
  }
  for (const d of ['workspace', 'extensions']) fs.mkdirSync(path.join(home, d));
  // The switch writes claudeCode.environmentVariables and VS Code only accepts writes to registered settings, so a stub
  // extension declares it, as the real Claude Code extension does in a real editor
  const stub = path.join(home, 'extensions', 'stub-claude-code');
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({
    name: 'stub-claude-code', publisher: 'fake', version: '0.0.1', engines: { vscode: `^${VSCODE_VERSION}` },
    contributes: { configuration: { properties: { 'claudeCode.environmentVariables': { type: 'array', scope: 'machine', default: [] } } } },
  }));

  for (const key of Object.keys(process.env)) if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) process.env[key] = path.join(home, key);
  process.env.PATH = '/usr/local/bin:/usr/bin:/bin';

  const step = (label, ok, detail) => {
    report.steps.push({ label, ok, detail });
    if (!ok) report.failures.push(label);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  };
  const finish = () => fs.writeFileSync(path.join(home, 'done'), '');

  const editor = runTests({
    version: VSCODE_VERSION, extensionDevelopmentPath: root, extensionTestsPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'suite.cjs'),
    extensionTestsEnv: { PLANSWAP_TEST_HOME: home },
    launchArgs: [path.join(home, 'workspace'), '--user-data-dir', userData, '--extensions-dir', path.join(home, 'extensions'),
      '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`],
  });
  let browser;
  try {
    const until = Date.now() + 120_000;
    while (!(await portOpen()) && Date.now() < until) await sleep(500);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const { page, frame } = await findSidebar(browser);
    await sleep(1500);
    const ctx = makeContext({ page, frame, home, dirs, out, settingsFile, writeSettings, step });
    await scenario(ctx);
  } catch (err) {
    report.failures.push(`scenario: ${err.message}`);
    console.error(err);
  } finally {
    await browser?.close().catch(() => undefined);
    finish();
  }
  await editor.catch((err) => report.failures.push(`editor: ${err.message}`));
  fs.rmSync(home, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.failures.length ? 'FAILURES: ' + report.failures.join('; ') : 'all steps passed'}; artifacts in ${out}`);
  return report;
}

// The workbench page and the PlanSwap webview frame (its document holds #panel-claude)
async function findSidebar(browser, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      for (const frame of page.frames()) {
        if (await frame.evaluate(() => !!document.querySelector('#panel-claude .row')).catch(() => false)) return { page, frame };
      }
    }
    await sleep(500);
  }
  throw new Error('PlanSwap webview frame not found');
}

function makeContext({ page, frame, home, dirs, out, settingsFile, writeSettings, step }) {
  const stateFile = path.join(home, '.config', 'planswap', 'state.json');
  /** The visible page: recommendation card, non-recommendation banner title, rows with usage levels and toggles */
  const dump = () => frame.evaluate(() => {
    const mode = document.querySelector('.tab[aria-selected="true"]')?.id.replace('tab-', '');
    const panel = document.querySelector(`#panel-${mode}`);
    const card = panel.querySelector('.banner.recommend');
    return {
      mode, width: document.body.clientWidth,
      card: card && { title: card.querySelector('.banner-title').textContent, text: card.querySelector('.recommend-text').textContent,
        buttons: [...card.querySelectorAll('vscode-button')].map((b) => `${b.dataset.action}:${b.textContent.trim()}`) },
      banner: panel.querySelector('.banner:not(.recommend) .banner-title')?.textContent ?? null,
      rows: [...panel.querySelectorAll('.row')].map((r) => ({
        dir: r.dataset.dir, current: r.getAttribute('aria-current') === 'true', name: r.querySelector('.row-name')?.textContent,
        usage: [...r.querySelectorAll('.usage-window')].map((w) => `${w.querySelector('.usage-duration').textContent} ${w.querySelector('.usage-pct').textContent} ${w.querySelector('.usage-track').dataset.level}`),
        toggle: (() => { const t = r.querySelector('[data-action="recommendExclude"]'); return t && { icon: t.getAttribute('icon'), checked: t.shadowRoot?.querySelector('button')?.getAttribute('aria-checked') }; })(),
        actions: [...r.querySelectorAll('[data-action]')].map((a) => a.dataset.action),
      })),
    };
  });
  return {
    page, frame, home, dirs, out, step, sleep, dump,
    /** Screenshot of the sidebar document (scrolled to the top, mouse moved off the workbench) */
    shot: async (file) => {
      await page.mouse.move(1800, 900);
      await frame.evaluate(() => { document.querySelector('#app').scrollTop = 0; return Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))); });
      await frame.locator('body').screenshot({ path: path.join(out, file) });
    },
    /** Clicks the control with data-action=action in the row of dir */
    rowAction: async (dir, action) => {
      const rows = frame.locator('.row');
      for (let i = 0, n = await rows.count(); i < n; i++) if ((await rows.nth(i).getAttribute('data-dir')) === dir) return rows.nth(i).locator(`[data-action="${action}"]`).click();
      throw new Error(`row ${dir} not found`);
    },
    /** Clicks the sidebar tab */
    tab: (mode) => frame.locator(`#tab-${mode}`).click(),
    /** Polls dump() until pred holds (or ms pass); returns the last dump */
    waitFor: async (pred, ms = 10_000) => { const until = Date.now() + ms; let d; while (Date.now() < until) { d = await dump(); if (pred(d)) return d; await sleep(300); } return d; },
    /** Rewrites the editor's user settings (base settings plus extra); VS Code applies the file change at once */
    writeSettings,
    readSettings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
    readState: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    /** Texts of the workbench's notification toasts */
    notifications: () => page.evaluate(() => [...document.querySelectorAll('.notification-toast')].map((e) => e.innerText)),
  };
}
