// A name that fits its line is never split to keep the inline icons (subscription warning, shared badge, pencil) beside
// it: the icons wrap together instead; a name too long for the line still wraps inside the card.
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  for (const label of ['Xiaoni', 'Xiaoni-work', 'Account-1234', 'A-very-long-account-name-for-work']) {
    // apply serializes mutate without closures, so the label is passed through the page
    await page.evaluate((l) => { window.__label = l; }, label);
    await ctx.apply((state) => {
      const row = state.claude.accounts.find((a) => a.name === 'work');
      Object.assign(row, { label: window.__label, shared: true, subscriptionUnavailable: true, plan: 'Max 5x', isCurrent: false });
    }, 'claude');
    const r = await page.locator('#panel-claude .row[data-dir="/fixture/.claude-work"]').evaluate((el) => {
      const name = el.querySelector('.row-name');
      const text = name.firstChild;
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size;
      const probe = document.createElement('span');
      probe.style.whiteSpace = 'nowrap';
      probe.textContent = text.textContent;
      name.append(probe);
      const natural = probe.getBoundingClientRect().width;
      probe.remove();
      const card = el.getBoundingClientRect();
      const tail = el.querySelector('.name-tail').getBoundingClientRect();
      return {
        label: text.textContent, lines, fits: natural <= el.querySelector('.row-title').getBoundingClientRect().width,
        inside: tail.right <= card.right + 0.5 && el.scrollWidth <= el.clientWidth + 1,
      };
    });
    await step(`${label}: not split when it fits, icons inside the card`, (!r.fits || r.lines === 1) && r.inside, r);
  }
  await shot(`${locale}-${width}.png`);
}
