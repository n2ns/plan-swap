// Recommendation toggles depend on the account count of their own vendor page.
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  for (const mode of ['claude', 'codex']) {
    await ctx.apply((state) => {
      const tab = state[state.active];
      tab.accounts = tab.accounts.slice(0, 1);
    }, mode);
    const toggles = page.locator(`#panel-${mode} [data-action="recommendExclude"]`);
    await step(`${mode}: single account hides recommendation toggle`, await toggles.count() === 0);
    await shot(`${locale}-${width}-${mode}-single.png`);

    await ctx.apply((state) => {
      const tab = state[state.active];
      tab.accounts = tab.accounts.slice(0, 2);
      tab.accounts[0].recommendExcluded = true;
    }, mode);
    await step(`${mode}: two accounts show both recommendation toggles`, await toggles.count() === 2);
    await step(`${mode}: excluded account can be included again`, await toggles.first().getAttribute('checked') !== null);
    const inside = await toggles.evaluateAll((buttons) => {
      const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
      return buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= sidebar.left - 1 && rect.right <= sidebar.right + 1;
      });
    });
    await step(`${mode}: toggles stay inside the sidebar`, inside);
    await shot(`${locale}-${width}-${mode}-multiple.png`);
  }
}
