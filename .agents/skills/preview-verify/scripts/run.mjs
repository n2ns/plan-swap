// node .agents/skills/preview-verify/scripts/run.mjs <check> [--widths=200,240] [--locales=en,ja] [--no-build]
// Builds the project, serves the synthetic Webview preview in-process, opens one headless page with a fixed viewport
// at 100% zoom and runs one check module (test/preview/checks/<check>.mjs or a path to a .mjs file) once per
// locale x sidebar width. Prints only the step lines and the summary; exit code 1 when any step failed. The browser
// and the server are always closed, also on errors, so nothing is left behind.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(skillDir, '..', '..', '..');
const checksDir = path.join(root, 'test', 'preview', 'checks');
const LOCALES = ['en', 'zh-cn', 'zh-tw', 'es', 'ja'];
const WIDTHS = [200, 240, 280, 340, 420];
const VIEWPORT = { width: 1920, height: 1080 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const checks = fs.existsSync(checksDir) ? fs.readdirSync(checksDir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort() : [];
if (!target || target === 'list') {
  console.log(checks.length ? checks.join('\n') : `no checks under ${checksDir}`);
  process.exit(target ? 0 : 1);
}
// A name resolves to the project's checks; a .mjs path (for example a throwaway check in a scratchpad) is used as is
const checkPath = target.endsWith('.mjs') ? path.resolve(target) : path.join(checksDir, `${target}.mjs`);
if (!fs.existsSync(checkPath)) {
  console.error(`unknown check ${target}; available: ${checks.join(', ') || 'none'}`);
  process.exit(1);
}
const name = path.basename(checkPath, '.mjs');
const list = (flag, all) => args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3).split(',').filter(Boolean) ?? all;
const locales = list('locales', LOCALES);
const widths = list('widths', WIDTHS).map(Number);
const bad = [...locales.filter((l) => !LOCALES.includes(l)), ...widths.filter((w) => !Number.isInteger(w) || w < 180 || w > 1000)];
if (bad.length) {
  console.error(`invalid --locales/--widths values: ${bad.join(', ')}`);
  process.exit(1);
}

if (!args.includes('--no-build')) {
  const build = spawnSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const { run } = await import(pathToFileURL(checkPath).href);
const { startPreview } = await import(pathToFileURL(path.join(root, 'scripts', 'preview', 'server.mjs')).href);
const out = path.join(root, '.test-out', 'preview', name);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const report = { name, startedAt: new Date().toISOString(), locales, widths, steps: [], failures: [] };

let preview;
let browser;
let page;
let failures = 0;
const shot = async (file) => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.locator('#sidebar').screenshot({ path: path.join(out, file) });
};
// On a failed step: the sidebar as it looks and reads at that moment
const capture = async (base) => {
  try {
    await shot(`${base}.png`);
    fs.writeFileSync(path.join(out, `${base}.txt`), await page.evaluate(() => document.body.innerText));
  } catch { /* the page may be gone */ }
};
try {
  preview = await startPreview();
  // --disable-gpu: the checks cover layout, not hardware-accelerated rendering
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => report.failures.push(`page error: ${error.message}`));
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204 }));
  await page.goto(preview.url);
  await page.waitForFunction(() => window.preview?.messages.some((m) => m.type === 'ready') && !!document.querySelector('#tab-claude'));

  for (const locale of locales) {
    for (const width of widths) {
      const where = `${locale}-${width}`;
      const step = (label, ok, detail) => {
        report.steps.push({ where, label, ok, detail });
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${where} ${label}${detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
        if (!ok) { report.failures.push(`${where} ${label}`); return capture(`fail-${++failures}`); }
        return Promise.resolve();
      };
      const ctx = {
        page, locale, width, out, step, shot, sleep,
        /**
         * Resets the preview to this locale and width (and `active` tab when given), lets `mutate(state)` change a deep
         * clone of the synthetic state in the page, posts it and waits for the page to render. `mutate` is serialized
         * into the page: it must be self-contained
         */
        apply: async (mutate, active) => {
          await page.evaluate(({ locale, width, active, src }) => {
            window.preview.apply({ locale, width, active });
            const state = structuredClone(window.preview.state());
            new Function(`return (${src})`)()(state);
            window.preview.post({ type: 'state', state });
          }, { locale, width, active, src: mutate.toString() });
          await sleep(150);
        },
      };
      await run(ctx);
    }
  }
} catch (err) {
  report.failures.push(`check: ${err.message}`);
  console.error(`FAIL check threw: ${err.stack ?? err.message}`);
  if (page) await capture('fail-thrown');
} finally {
  await browser?.close().catch(() => undefined);
  await preview?.close().catch(() => undefined);
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.failures.length ? 'FAILURES: ' + report.failures.join('; ') : 'all steps passed'}; artifacts in ${out}`);
process.exit(report.failures.length ? 1 : 0);
