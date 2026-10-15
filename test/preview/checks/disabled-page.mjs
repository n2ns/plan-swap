// Codex disabled page: only the enable card shows; the account list section stays hidden (its `hidden` attribute must
// win over the section's own display rule), and enabling again brings the list back.

export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  const listVisible = () => page.evaluate(() => {
    const section = document.querySelector('#panel-codex .section');
    return !!section && section.getBoundingClientRect().height > 0;
  });
  await ctx.apply((state) => { state.codex.enabled = false; }, 'codex');
  await step('codex disabled page: enable card shown', await page.locator('#panel-codex .disabled-title').count() === 1);
  await step('codex disabled page: account list hidden', !(await listVisible()));
  await shot(`${locale}-${width}-codex-disabled.png`);
  await ctx.apply(() => {}, 'codex');
  await step('codex enabled page: account list shown', await listVisible());
}
