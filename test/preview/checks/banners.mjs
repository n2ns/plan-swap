// Banner layout: the Claude page with the reload banner and the recommendation card, the Codex page with the pending
// banner. For every banner the icon shares the title line, nothing overflows, the buttons stay inside the sidebar and
// the title does not run under the close button.

// State patches, serialized into the preview page by ctx.apply
const claudeBanners = (state) => {
  const tab = state.claude;
  const now = Math.floor(Date.now() / 1000);
  tab.switchedTo = 'Work';
  // The current account runs low; Work has usage windows and was observed just now
  tab.accounts.find((a) => a.isCurrent).usage = { windows: [{ usedPercent: 80, windowMinutes: 300, resetsAt: now + 3600 }, { usedPercent: 40, windowMinutes: 10080, resetsAt: now + 86400 }], checkedAt: Date.now() - 5000 };
  const work = tab.accounts.find((a) => a.dir === '/fixture/.claude-work');
  work.usage.checkedAt = Date.now() - 5000;
  tab.recommended = work.dir;
};
const codexBanners = (state) => { state.codex.pendingDir = 'Work'; };

export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  for (const [mode, mutate, expected] of [['claude', claudeBanners, 2], ['codex', codexBanners, 1]]) {
    await ctx.apply(mutate, mode);
    const banners = await page.evaluate((mode) => {
      const rect = (el) => el.getBoundingClientRect();
      const sidebar = rect(document.querySelector('#sidebar'));
      return [...document.querySelectorAll(`#panel-${mode} .banner`)].map((banner) => {
        const icon = rect(banner.querySelector('.banner-icon'));
        const text = banner.querySelector('.banner-title-text');
        const range = document.createRange();
        range.selectNodeContents(text);
        const firstLine = range.getClientRects()[0];
        const close = banner.querySelector(':scope > .icon-btn');
        return {
          kind: banner.classList.contains('recommend') ? 'recommend' : 'banner',
          iconOnTitleLine: !!firstLine && icon.top + icon.height / 2 >= firstLine.top && icon.top + icon.height / 2 <= firstLine.bottom,
          overflow: banner.scrollWidth > banner.clientWidth + 1 || document.documentElement.scrollWidth > document.documentElement.clientWidth,
          buttonsInside: [...banner.querySelectorAll('vscode-button')].every((b) => rect(b).left >= sidebar.left - 1 && rect(b).right <= sidebar.right + 1),
          titleClearOfClose: !close || rect(text).right <= rect(close).left + 1,
        };
      });
    }, mode);
    await step(`${mode}: ${expected} banner(s) rendered`, banners.length === expected, banners.map((b) => b.kind));
    for (const b of banners) {
      await step(`${mode} ${b.kind}: icon on the title line`, b.iconOnTitleLine);
      await step(`${mode} ${b.kind}: no horizontal overflow`, !b.overflow);
      await step(`${mode} ${b.kind}: buttons inside the sidebar`, b.buttonsInside);
      await step(`${mode} ${b.kind}: title clear of the close button`, b.titleClearOfClose);
    }
    await shot(`${locale}-${width}-${mode}.png`);
  }
}
