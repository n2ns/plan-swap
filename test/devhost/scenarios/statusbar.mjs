// The status bar item (Features 3): text, warning/error background, tooltip, products, alignment, enabled, used display.
import * as sb from '../sidebar.mjs';

export async function run(ctx) {
  const { step, writeSettings, sleep } = ctx;
  await sb.waitFor(ctx, (x) => x.rows.length === 5);
  // Automatic checks are off (config): the Codex figure must still come from the stored observation
  const codexAuto = {};
  const item = (opts) => ctx.waitFor(() => sb.statusItem(ctx, opts), (v) => /Codex \d+%/.test(v?.text ?? ''), 20_000);

  let s = await item();
  await step('text: shortest general window of each product, remaining', s?.text === 'Claude 20% · Codex 15%', s);
  await step('right-aligned by default', s?.left === false);
  await step('warning color at or below 30% left', s?.kind === 'warning-kind', s?.kind);
  s = await item({ hover: true });
  await step('tooltip: one block per product with email, plan and windows', !!s?.tooltip && /default@fake\.invalid/.test(s.tooltip) && /codex-default@fake\.invalid/.test(s.tooltip) && /5[- ]hour|5h/i.test(s.tooltip), s?.tooltip?.slice(0, 200));

  writeSettings({ ...codexAuto, 'planswap.statusBar.errorThreshold': 25 });
  s = await ctx.waitFor(() => sb.statusItem(ctx), (v) => v?.kind === 'error-kind');
  await step('error threshold 25: error color (15% left is at or below it)', s?.kind === 'error-kind', s?.kind);

  writeSettings({ ...codexAuto, 'planswap.usageDisplay': 'used' });
  s = await ctx.waitFor(() => sb.statusItem(ctx), (v) => v?.text === 'Claude 80% · Codex 85%');
  await step('usageDisplay used: percentages flip, color still follows what is left', s?.text === 'Claude 80% · Codex 85%' && s?.kind === 'warning-kind', s);

  writeSettings({ ...codexAuto, 'planswap.statusBar.products': 'claude' });
  s = await ctx.waitFor(() => sb.statusItem(ctx), (v) => v?.text === 'Claude 20%');
  await step('products claude: Codex dropped', s?.text === 'Claude 20%', s?.text);

  writeSettings({ ...codexAuto, 'planswap.statusBar.alignment': 'left' });
  s = await ctx.waitFor(() => sb.statusItem(ctx), (v) => v?.left === true);
  await step('alignment left', s?.left === true);

  writeSettings({ ...codexAuto, 'planswap.statusBar.enabled': false });
  s = await ctx.waitFor(() => sb.statusItem(ctx), (v) => v === null);
  await step('enabled off: item hidden', s === null);
  writeSettings(codexAuto);
  s = await ctx.waitFor(() => sb.statusItem(ctx), (v) => v?.text === 'Claude 20% · Codex 15%' && v.left === false);
  await step('defaults restored', s?.text === 'Claude 20% · Codex 15%' && s?.left === false);
  await sleep(500);
  await ctx.page.screenshot({ path: `${ctx.out}/01-workbench.png` });
}
