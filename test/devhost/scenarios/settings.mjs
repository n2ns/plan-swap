// Display settings and language (Features 2, 11): language switch without reload, usage display, hidden email and
// windows, model-specific windows, sidebar thresholds. Each change is applied through the settings file.
import * as sb from '../sidebar.mjs';

export async function run(ctx) {
  const { dirs, step, writeSettings, sleep } = ctx;
  let d = await sb.waitFor(ctx, (x) => x.rows.length === 5);
  const work = (x) => x.rows.find((r) => r.dir === dirs.claudeWork);
  await step('defaults: English title, emails, 5-hour and 7-day windows, no model window', d.listTitle === 'All accounts' && work(d).email === 'work@fake.invalid' && work(d).usage.length === 2, work(d).usage);

  writeSettings({ 'planswap.language': 'zh-cn' });
  d = await sb.waitFor(ctx, (x) => x.listTitle === '全部账号');
  await step('language zh-cn applies without reload', d.listTitle === '全部账号' && work(d).usage[0].startsWith('5 小时额度'), { title: d.listTitle, usage: work(d).usage });
  await sb.shot(ctx, '01-zh-cn.png');
  writeSettings({ 'planswap.language': 'ja' });
  d = await sb.waitFor(ctx, (x) => x.listTitle === 'すべてのアカウント');
  await step('language ja applies', d.listTitle === 'すべてのアカウント', d.listTitle);
  writeSettings();
  d = await sb.waitFor(ctx, (x) => x.listTitle === 'All accounts');

  writeSettings({ 'planswap.usageDisplay': 'used' });
  d = await sb.waitFor(ctx, (x) => work(x).usage[0].includes(' 42% '));
  await step('usageDisplay used: percentages show what is used, colors still follow what is left',
    work(d).usage[0] === '5-hour limit 42% ok' && d.rows[0].usage[0] === '5-hour limit 80% warn', { work: work(d).usage, current: d.rows[0].usage });

  writeSettings({ 'planswap.sidebar.showEmail': false });
  d = await sb.waitFor(ctx, (x) => x.rows.every((r) => r.email === null));
  await step('showEmail off: no email on any row', d.rows.every((r) => r.email === null));

  writeSettings({ 'planswap.sidebar.showFiveHourLimit': false });
  d = await sb.waitFor(ctx, (x) => work(x).usage.length === 1);
  await step('showFiveHourLimit off: only the 7-day window', work(d).usage.length === 1 && work(d).usage[0].startsWith('7-day'), work(d).usage);
  writeSettings({ 'planswap.sidebar.showFiveHourLimit': false, 'planswap.sidebar.showWeeklyLimit': false });
  d = await sb.waitFor(ctx, (x) => work(x).usage.length === 0);
  await step('both general windows off: no usage block, recommendation card still names the account with its time', work(d).usage.length === 0 && d.card?.title === 'Recommended: work' && /Updated/.test(d.card?.text ?? ''), d.card);

  writeSettings({ 'planswap.sidebar.showModelLimits': true });
  d = await sb.waitFor(ctx, (x) => work(x).usage.length === 3);
  await step('showModelLimits on: the Fable window appears after the general ones', work(d).usage[2] === '7-day limit · Fable 90% ok', work(d).usage);
  await sb.shot(ctx, '02-model-limits.png');

  writeSettings({ 'planswap.sidebar.warningThreshold': 60, 'planswap.sidebar.errorThreshold': 25 });
  d = await sb.waitFor(ctx, (x) => work(x).usage[0].endsWith(' warn'));
  await step('sidebar thresholds 60/25: 58% left is warn, 20% left is low', work(d).usage[0].endsWith(' warn') && d.rows[0].usage[0].endsWith(' low'), { work: work(d).usage[0], current: d.rows[0].usage[0] });
  writeSettings();
  await sleep(1000);
  d = await sb.waitFor(ctx, (x) => work(x).usage.length === 2 && work(x).email !== null);
  await step('defaults restored', work(d).usage.length === 2 && work(d).email !== null && work(d).usage[0] === '5-hour limit 58% ok');
}
