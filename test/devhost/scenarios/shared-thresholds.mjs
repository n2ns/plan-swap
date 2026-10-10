// Shared colors and independent recommendations in a disposable editor with fake accounts.
import * as sb from '../sidebar.mjs';

export async function run(ctx) {
  const { dirs, step, writeSettings } = ctx;
  const current = (view) => view.rows.find((row) => row.dir === dirs.claudeDefault);
  let view = await sb.waitFor(ctx, (v) => v.rows.length === 5 && !v.card);
  await step('default recommendation 10%: no card while the current Claude account has 20% left', !view.card && current(view).usage[0].includes('20%'));
  let status = await ctx.waitFor(() => sb.statusItem(ctx), (item) => item?.kind === 'warning-kind');
  await step('default shared warning 30%: current Claude bar and aggregate status bar warn', current(view).usage[0].endsWith(' warn') && status.kind === 'warning-kind');

  writeSettings({ 'planswap.sidebar.recommendationThreshold': 20 });
  view = await sb.waitFor(ctx, (v) => v.card?.title === 'Recommended: work');
  await step('recommendation at exactly 20% is inclusive', !!view.card && current(view).usage[0].endsWith(' warn'));
  writeSettings({ 'planswap.sidebar.recommendationThreshold': 19.99 });
  view = await sb.waitFor(ctx, (v) => !v.card);
  await step('lowering only recommendation hides its card, leaving warning color', !view.card && current(view).usage[0].endsWith(' warn'));

  writeSettings({ 'planswap.usageWarningThreshold': 5, 'planswap.usageErrorThreshold': 3 });
  view = await sb.waitFor(ctx, (v) => current(v).usage[0].endsWith(' ok'));
  status = await ctx.waitFor(() => sb.statusItem(ctx), (item) => item?.kind === null);
  await step('shared color change updates sidebar and status bar without reload', current(view).usage[0].endsWith(' ok') && status.kind === null && !view.card);

  writeSettings({ 'planswap.usageWarningThreshold': 5, 'planswap.usageErrorThreshold': 25 });
  view = await sb.waitFor(ctx, (v) => current(v).usage[0].endsWith(' low'));
  status = await ctx.waitFor(() => sb.statusItem(ctx), (item) => item?.kind === 'error-kind');
  await step('error wins above warning in both surfaces; recommendation remains off at its 10% default', current(view).usage[0].endsWith(' low') && status.kind === 'error-kind' && !view.card);
  await sb.shot(ctx, '01-shared-error.png');

  writeSettings({
    'planswap.sidebar.warningThreshold': 100, 'planswap.sidebar.errorThreshold': 100,
    'planswap.statusBar.warningThreshold': 100, 'planswap.statusBar.errorThreshold': 100,
  });
  view = await sb.waitFor(ctx, (v) => current(v).usage[0].endsWith(' warn') && !v.card);
  status = await ctx.waitFor(() => sb.statusItem(ctx), (item) => item?.kind === 'warning-kind');
  await step('former color settings are ignored, shared defaults and independent recommendation remain', current(view).usage[0].endsWith(' warn') && status.kind === 'warning-kind' && !view.card);

  writeSettings({ 'planswap.sidebar.showEmail': false });
  view = await sb.waitFor(ctx, (v) => v.rows.every((row) => row.email === null));
  status = await sb.statusItem(ctx, { hover: true });
  await step('email setting hides both vendors in the status bar tooltip', !/default@fake\.invalid|codex-default@fake\.invalid/.test(status?.tooltip ?? '') && !!status?.tooltip);
  await sb.shot(ctx, '02-emails-hidden.png');
  writeSettings();
}
