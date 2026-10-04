// Generic launcher: a disposable VS Code (cached by @vscode/test-electron) with its own HOME, connected over the Chrome
// DevTools Protocol, handing a scenario a small driver API. Knows nothing about the extension under test beyond what
// the project config (test/devhost/devhost.config.mjs) says. Nothing under the real home is read or written.
import { runTests } from '@vscode/test-electron';
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PORT = 9333;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Editor settings every run starts from; the project config adds its own
const EDITOR_SETTINGS = {
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false, 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'window.dialogStyle': 'custom', 'workbench.colorTheme': 'Default Dark Modern',
};

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * Runs `scenario(ctx)` in a fresh editor and resolves to the report. config: { vscodeVersion, extensionId,
 * focusCommand, frameSelector, settings, stubExtensions, seed }. Artifacts go to <outDir>; the editor is closed and
 * the temporary HOME removed in every case.
 */
export async function runScenario({ name, config, seed, scenario, window, outDir }) {
  const out = outDir;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devhost-'));
  const report = { name, startedAt: new Date().toISOString(), steps: [], failures: [] };
  const dirs = (seed ?? config.seed)(home);

  // Editor data: kept across runs (next to the cached editor; npm test wipes .test-out) so the window position
  // survives; it holds settings and the extension's globalState, never account data. Settings are rewritten every run
  const userData = path.join(root, '.vscode-test', 'devhost', 'user-data');
  const settingsFile = path.join(userData, 'User', 'settings.json');
  fs.mkdirSync(path.join(userData, 'User', 'globalStorage'), { recursive: true });
  const writeSettings = (extra = {}) => fs.writeFileSync(settingsFile, JSON.stringify({ ...EDITOR_SETTINGS, ...config.settings, ...extra }, null, 2));
  writeSettings();
  if (window) {
    // A test-mode exit never saves window state, so the position is written before every start
    const storageFile = path.join(userData, 'User', 'globalStorage', 'storage.json');
    const storage = fs.existsSync(storageFile) ? JSON.parse(fs.readFileSync(storageFile, 'utf8')) : {};
    storage.windowsState = { lastActiveWindow: { uiState: { mode: 'Normal', ...window } }, openedWindows: [] };
    fs.writeFileSync(storageFile, JSON.stringify(storage, null, 2));
  }
  for (const d of ['workspace', 'extensions']) fs.mkdirSync(path.join(home, d));
  // VS Code only writes registered settings: stub extensions declare the settings of extensions that are not installed
  for (const [id, manifest] of Object.entries(config.stubExtensions ?? {})) {
    const dir = path.join(home, 'extensions', id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, publisher: 'stub', version: '0.0.1', engines: { vscode: `^${config.vscodeVersion}` }, ...manifest }));
  }

  for (const key of Object.keys(process.env)) if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
  for (const key of config.clearEnv ?? []) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) process.env[key] = path.join(home, key);
  // System directories only: project CLIs are not reachable from the editor
  process.env.PATH = '/usr/local/bin:/usr/bin:/bin';

  let failures = 0;
  let capture = async () => undefined;
  const step = (label, ok, detail) => {
    report.steps.push({ label, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
    if (!ok) { report.failures.push(label); return capture(`fail-${++failures}`); }
    return Promise.resolve();
  };

  const editor = runTests({
    version: config.vscodeVersion, extensionDevelopmentPath: root,
    extensionTestsPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'suite.cjs'),
    extensionTestsEnv: { DEVHOST_HOME: home, DEVHOST_EXTENSION_ID: config.extensionId, DEVHOST_FOCUS_COMMAND: config.focusCommand },
    launchArgs: [path.join(home, 'workspace'), '--user-data-dir', userData, '--extensions-dir', path.join(home, 'extensions'),
      '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`],
  });
  let browser;
  try {
    const until = Date.now() + 120_000;
    while (!(await portOpen()) && Date.now() < until) await sleep(500);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const { page, frame } = await findFrame(browser, config.frameSelector);
    await sleep(1500);
    const shot = async (file) => {
      await page.mouse.move(1800, 900);
      await frame.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
      await frame.locator('body').screenshot({ path: path.join(out, file) });
    };
    // On a failed step: the webview as it looks and reads at that moment
    capture = async (base) => {
      try {
        await shot(`${base}.png`);
        fs.writeFileSync(path.join(out, `${base}.txt`), await frame.evaluate(() => document.body.innerText));
      } catch { /* the page may be gone */ }
    };
    const ctx = {
      page, frame, home, dirs, out, step, sleep, shot,
      /** Polls fn() until pred holds (or ms pass); returns the last value */
      waitFor: async (fn, pred, ms = 10_000) => { const until = Date.now() + ms; let v; while (Date.now() < until) { v = await fn(); if (pred(v)) return v; await sleep(300); } return v; },
      /** Rewrites the editor's user settings (base plus extra); VS Code applies the file change at once */
      writeSettings,
      readSettings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
      /** A JSON file under the disposable HOME */
      readHomeJson: (rel) => JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')),
      /** Texts of the workbench's notification toasts */
      notifications: () => page.evaluate(() => [...document.querySelectorAll('.notification-toast')].map((e) => e.innerText)),
    };
    await scenario(ctx);
  } catch (err) {
    report.failures.push(`scenario: ${err.message}`);
    console.error(`FAIL scenario threw: ${err.stack ?? err.message}`);
    await capture('fail-thrown');
  } finally {
    await browser?.close().catch(() => undefined);
    fs.writeFileSync(path.join(home, 'done'), '');
  }
  await editor.catch((err) => report.failures.push(`editor: ${err.message}`));
  fs.rmSync(home, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.failures.length ? 'FAILURES: ' + report.failures.join('; ') : 'all steps passed'}; artifacts in ${out}`);
  return report;
}

// The workbench page and the webview frame whose document matches selector
async function findFrame(browser, selector, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      for (const frame of page.frames()) {
        if (await frame.evaluate((s) => !!document.querySelector(s), selector).catch(() => false)) return { page, frame };
      }
    }
    await sleep(500);
  }
  throw new Error(`webview frame matching ${selector} not found`);
}
