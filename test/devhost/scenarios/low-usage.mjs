// Low usage-limit notices (Features 2, planswap.notifications.*): the fixture's current Claude account has 20% of its
// 5-hour limit left and the effective Codex account 15%, both at the default threshold of 20.
import * as sb from '../sidebar.mjs';

export async function run(ctx) {
  const { step, notifications, writeSettings, readHomeJson, sleep } = ctx;
  await sb.waitFor(ctx, (x) => x.rows.length === 5);
  const low = (texts) => texts.filter((n) => /limit left/.test(n));
  let notices = await ctx.waitFor(() => notifications(), (v) => low(v).length >= 2, 30_000);
  await step('Claude notice names the account, window, percentage and reset',
    low(notices).some((n) => /Claude account default has 20% of its 5h limit left\. It resets in /.test(n)), low(notices));
  await step('Codex notice names the effective account', low(notices).some((n) => /Codex account default has 15% of its 5h limit left/.test(n)), low(notices));
  await step('each notice offers Open PlanSwap', low(notices).every((n) => n.includes('Open PlanSwap')));
  await step('one notice per product', low(notices).length === 2, low(notices).length);
  await sleep(500);
  await ctx.page.screenshot({ path: `${ctx.out}/01-notices.png` });

  const entries = readHomeJson('.config/planswap/state.json')['usage.lowNotified'] ?? [];
  await step('announced windows are stored without identities', entries.length === 2
    && entries.every((e) => Object.keys(e).sort().join() === 'dir,product,resetsAt,windowMinutes'), entries);

  // A settings change checks again; the announced windows stay quiet
  writeSettings({ 'planswap.notifications.threshold': 50 });
  await sleep(3000);
  notices = await notifications();
  await step('no repeat after another check', low(notices).length === 2, low(notices));
}
