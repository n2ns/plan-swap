// Codex run inside WSL on native Windows: the warning banner sits on top without overflow, and no row offers the
// sign-in or terminal buttons or the sign-in hint (the host refuses Codex terminals there). The disabled page shows
// the banner above its enable card too.

const runsInWsl = (state) => {
  state.codex.runsInWsl = true;
};

export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  // Signed-out rows exist in the fixture before the patch, so the hidden buttons are a real difference
  await ctx.apply(() => {}, 'codex');
  const before = await page.locator('#panel-codex [data-action="terminal"]').count();
  await step('codex: terminal and sign-in buttons shown without the flag', before > 0, before);
  await ctx.apply(runsInWsl, 'codex');
  const r = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const panel = document.querySelector('#panel-codex');
    const banners = [...panel.querySelectorAll('.banner')];
    const banner = banners[0];
    const icon = banner && rect(banner.querySelector('.banner-icon'));
    const text = banner?.querySelector('.banner-title-text');
    const range = document.createRange();
    if (text) range.selectNodeContents(text);
    const firstLine = text && range.getClientRects()[0];
    return {
      banners: banners.length,
      iconOnTitleLine: !!firstLine && icon.top + icon.height / 2 >= firstLine.top && icon.top + icon.height / 2 <= firstLine.bottom,
      overflow: !!banner && (banner.scrollWidth > banner.clientWidth + 1 || document.documentElement.scrollWidth > document.documentElement.clientWidth),
      terminals: panel.querySelectorAll('[data-action="terminal"]').length,
      hints: panel.querySelectorAll('.row-hint').length,
    };
  });
  await step('codex: one banner rendered', r.banners === 1, r.banners);
  await step('codex banner: icon on the title line', r.iconOnTitleLine);
  await step('codex banner: no horizontal overflow', !r.overflow);
  await step('codex: no sign-in or terminal buttons', r.terminals === 0, r.terminals);
  await step('codex: no sign-in hint', r.hints === 0, r.hints);
  await shot(`${locale}-${width}-codex.png`);

  await ctx.apply((state) => { state.codex.runsInWsl = true; state.codex.enabled = false; }, 'codex');
  const d = await page.evaluate(() => {
    const panel = document.querySelector('#panel-codex');
    const banner = panel.querySelector('.banner');
    return {
      banner: !!banner,
      beforeCard: !!banner && !!panel.querySelector('.disabled-title') && !!(banner.compareDocumentPosition(panel.querySelector('.disabled-title')) & Node.DOCUMENT_POSITION_FOLLOWING),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  await step('codex disabled page: banner above the enable card', d.banner && d.beforeCard, d);
  await step('codex disabled page: no horizontal overflow', !d.overflow);
  await shot(`${locale}-${width}-codex-disabled.png`);
}
