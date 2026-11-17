// The agy (Antigravity CLI) tab: shown only while the host sends its state; the signed-in account first with the
// terminal button and the refresh button, other saved accounts with Switch and Remove; scoped usage windows; the add
// section's sign-in button and help; the warning banner; nothing outside the sidebar
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  const inside = (selector) => page.evaluate((sel) => {
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
    return [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length).every((el) => {
      const rect = el.getBoundingClientRect();
      return rect.left >= sidebar.left - 1 && rect.right <= sidebar.right + 1;
    });
  }, selector);
  const noHorizontalScroll = () => page.evaluate(() => {
    const sidebar = document.querySelector('#sidebar');
    return sidebar.scrollWidth <= sidebar.clientWidth + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  });

  // Without agy state there is no agy tab
  await ctx.apply((state) => { delete state.agy; }, 'claude');
  await step('no agy state: no agy tab', await page.locator('#tab-agy').isHidden());

  await ctx.apply(() => undefined, 'agy');
  await step('agy tab shown and selected', await page.locator('#tab-agy').getAttribute('aria-selected') === 'true');
  await step('three tabs fit the sidebar', await inside('.tabs .tab'));
  const rows = page.locator('#panel-agy .row');
  await step('two saved accounts', await rows.count() === 2);
  const current = page.locator('#panel-agy .row.is-current');
  await step('signed-in account first', await rows.first().getAttribute('aria-current') === 'true');
  await step('signed-in account: terminal, no switch, no remove',
    await current.locator('[data-action="terminal"]').count() === 1
    && await current.locator('[data-action="switch"]').count() === 0
    && await current.locator('[data-action="remove"]').count() === 0);
  const other = rows.nth(1);
  await step('other account: switch and remove, no terminal',
    await other.locator('[data-action="switch"]').count() === 1
    && await other.locator('[data-action="remove"]').count() === 1
    && await other.locator('[data-action="terminal"]').count() === 0);
  await step('model-group windows on both rows', await page.locator('#panel-agy .usage-window').count() === 6);
  await step('refresh shown, refresh-all hidden',
    await page.locator('#panel-agy [data-action="refreshUsage"]').isVisible() && await page.locator('#panel-agy [data-action="refreshAllUsage"]').isHidden());
  await step('no recommendation exclude toggles', await page.locator('#panel-agy [data-action="recommendExclude"]').count() === 0);
  await step('no page tools', await page.locator('#panel-agy .page-tools').isHidden());
  await step('rows stay inside the sidebar', await inside('#panel-agy .row, #panel-agy .row *'));
  await step('no horizontal scroll', await noHorizontalScroll());
  await shot(`${locale}-${width}-agy.png`);

  // Switch sends the row's directory
  await page.evaluate(() => window.preview.clearMessages());
  await other.locator('[data-action="switch"]').click();
  const sent = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'switch'));
  await step('switch message', sent.length === 1 && sent[0].mode === 'agy' && sent[0].dir.endsWith('g000000000002'), sent);

  // The add section: help text and the sign-in button
  // The page is reused across cases: open the add section only when it is closed
  if (await page.locator('#panel-agy .add-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#panel-agy .add-toggle').click();
  await step('add section: help and sign-in button',
    await page.locator('#add-agy .help').isVisible() && await page.locator('#add-agy [data-action="agySignIn"]').isVisible()
    && await page.locator('#add-agy vscode-textfield').count() === 0);
  await step('add section inside the sidebar', await inside('#add-agy, #add-agy *'));
  await page.evaluate(() => window.preview.clearMessages());
  await page.locator('#add-agy [data-action="agySignIn"]').click();
  const tool = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'tool'));
  await step('sign-in button asks for the agy terminal', tool.length === 1 && tool[0].tool === 'agySignIn' && tool[0].mode === 'agy', tool);
  await step('no horizontal scroll with the add section', await noHorizontalScroll());
  await shot(`${locale}-${width}-agy-add.png`);

  // The host's warning banner
  await ctx.apply((state) => {
    state.agy.notice = 'agy is signed in, but PlanSwap cannot tell to which Google account. Switching is turned off so that this sign-in is not lost; sign in again in agy (/logout, then /login).';
  }, 'agy');
  await step('notice banner shown', await page.locator('#panel-agy .banner').count() === 1);
  await step('notice inside the sidebar', await inside('#panel-agy .banner, #panel-agy .banner *'));
  await shot(`${locale}-${width}-agy-notice.png`);
}
