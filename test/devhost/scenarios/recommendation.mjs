// The recommended-account card (Features 2.4): trigger, ranking, exclusion marks, settings, themes, the Codex variant
// and the card's Switch. Fixture: ../fixtures/accounts.mjs.
import * as sb from '../sidebar.mjs';

export async function run(ctx) {
  const { dirs, step, writeSettings, readSettings, notifications, sleep } = ctx;
  const short = (rows) => rows.map((r) => `${sb.basename(r.dir)} ${r.usage.join(',')} ${r.toggle ? r.toggle.icon : '-'}`);

  // Claude: the default account is low, Work is recommended, Personal (weekly used up) never
  let d = await sb.waitFor(ctx, (x) => !!x.card);
  await step('claude card recommends Work', d.card?.title === 'Recommended: work' && /5-hour limit 58% remaining · 7-day limit 46% remaining · Updated \d+ minutes? ago/.test(d.card?.text ?? ''), d.card);
  await step('claude card buttons: Switch + Terminal', JSON.stringify(d.card?.buttons) === JSON.stringify(['switch:Switch', 'terminal:Terminal']), d.card?.buttons);
  await step('claude rows: default current, 5 rows, a toggle on every registered row', d.rows.length === 5 && d.rows[0].dir === dirs.claudeDefault && d.rows[0].current && d.rows.every((r) => r.toggle), short(d.rows));
  await sb.shot(ctx, '01-claude-dark.png');

  // Exclusion marks: Work out → Spare (35%) next, never Personal; both out → no card; back in → Work, entry cleared
  await sb.rowAction(ctx, dirs.claudeWork, 'recommendExclude');
  d = await sb.waitFor(ctx, (x) => x.card?.title === 'Recommended: spare');
  await step('excluding Work recommends Spare', d.card?.title === 'Recommended: spare', d.card);
  const work = d.rows.find((r) => r.dir === dirs.claudeWork);
  await step('Work toggle shows excluded', work?.toggle?.icon === 'lightbulb-empty' && work?.toggle?.checked === 'true', work?.toggle);
  await step('state.json holds claude.recommendExcluded = [work]', JSON.stringify(sb.readState(ctx)['claude.recommendExcluded']) === '["work"]', sb.readState(ctx)['claude.recommendExcluded']);
  await sb.shot(ctx, '02-claude-work-excluded.png');
  await sb.rowAction(ctx, dirs.claudeSpare, 'recommendExclude');
  d = await sb.waitFor(ctx, (x) => !x.card);
  await step('excluding Spare too leaves no card', !d.card, d.card);
  await sb.rowAction(ctx, dirs.claudeWork, 'recommendExclude');
  await sb.rowAction(ctx, dirs.claudeSpare, 'recommendExclude');
  d = await sb.waitFor(ctx, (x) => x.card?.title === 'Recommended: work' && x.rows.every((r) => r.toggle?.icon === 'lightbulb'));
  await step('including again restores Work and clears the state entry', d.card?.title === 'Recommended: work' && sb.readState(ctx)['claude.recommendExcluded'] === undefined, { card: d.card?.title, state: sb.readState(ctx)['claude.recommendExcluded'] });

  // Settings
  writeSettings({ 'planswap.sidebar.warningThreshold': 10 });
  d = await sb.waitFor(ctx, (x) => !x.card);
  await step('warningThreshold 10 (current has 20% left): no card, no warning bar', !d.card && d.rows.every((r) => !r.usage.some((u) => u.endsWith(' warn'))), d.card);
  writeSettings({ 'planswap.sidebar.showRecommendation': false });
  d = await sb.waitFor(ctx, (x) => x.rows.every((r) => !r.toggle));
  await step('showRecommendation off: no card, no toggles', !d.card && d.rows.every((r) => !r.toggle));
  await sb.shot(ctx, '03-claude-recommendation-off.png');
  writeSettings();
  d = await sb.waitFor(ctx, (x) => !!x.card && x.rows.some((r) => r.toggle));
  await step('settings restored: card and toggles back', !!d.card && d.rows.some((r) => r.toggle));

  // Themes: real theme injection, for the eye (no color assertion)
  for (const [theme, file] of [['Default Light Modern', '04-claude-light.png'], ['Default High Contrast', '05-claude-high-contrast.png'], ['Default High Contrast Light', '06-claude-hc-light.png']]) {
    writeSettings({ 'workbench.colorTheme': theme });
    await sleep(1500);
    await sb.shot(ctx, file);
    await step(`screenshot ${theme}`, true, file);
  }
  writeSettings();
  await sleep(1000);

  // Codex: effective default 15% left → Work with Switch + Terminal; Team (limit reached) never
  await sb.tab(ctx, 'codex');
  d = await sb.waitFor(ctx, (x) => x.mode === 'codex' && !!x.card);
  await step('codex card recommends Work with Switch + Terminal', d.card?.title === 'Recommended: work' && JSON.stringify(d.card?.buttons) === JSON.stringify(['switch:Switch', 'terminal:Terminal']) && /80% remaining · 7-day limit 60% remaining/.test(d.card?.text ?? ''), d.card);
  await step('codex rows: default effective, three rows', d.rows.length === 3 && d.rows[0].dir === dirs.codexDefault && d.rows[0].current, short(d.rows));
  await sb.shot(ctx, '07-codex-dark.png');
  await sb.rowAction(ctx, dirs.codexWork, 'recommendExclude');
  d = await sb.waitFor(ctx, (x) => !x.card);
  await step('codex: excluding Work leaves no card (Team is limit-reached)', !d.card && JSON.stringify(sb.readState(ctx)['codex.recommendExcluded']) === '["work"]', sb.readState(ctx)['codex.recommendExcluded']);
  await sb.rowAction(ctx, dirs.codexWork, 'recommendExclude');
  await sb.waitFor(ctx, (x) => !!x.card);

  // Card Switch: the test-mode editor refuses modal dialogs and its refusal quotes the confirmation text; without the
  // confirmation setting the switch goes through
  await sb.tab(ctx, 'claude');
  d = await sb.waitFor(ctx, (x) => x.mode === 'claude' && !!x.card);
  await ctx.frame.locator('#panel-claude .banner.recommend [data-action="switch"]').click();
  await sleep(1500);
  const notices = await notifications();
  await step('card Switch asks for confirmation (modal text quoted by the test-mode refusal)', notices.some((n) => n.includes('Switch the Claude account to work?')), notices[0]?.slice(0, 160));
  d = await sb.dump(ctx);
  await step('refused confirmation leaves the account unchanged', d.rows[0].dir === dirs.claudeDefault && d.rows[0].current && !!d.card);
  writeSettings({ 'planswap.claude.confirmSwitch': false });
  await sleep(3000);
  await ctx.frame.locator('#panel-claude .banner.recommend [data-action="switch"]').click();
  d = await sb.waitFor(ctx, (x) => !x.card && x.rows.find((r) => r.dir === dirs.claudeWork)?.current === true);
  const env = readSettings()['claudeCode.environmentVariables'];
  await step('card Switch (no confirmation): Work is current, no card, reload banner, setting written',
    d.rows.find((r) => r.dir === dirs.claudeWork)?.current === true && !d.card && !!d.banner && JSON.stringify(env ?? '').includes(dirs.claudeWork), { banner: d.banner, env });
  await sb.shot(ctx, '08-claude-after-switch.png');
}
