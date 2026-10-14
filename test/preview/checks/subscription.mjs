// Subscription warning stays inline and does not turn its recheck action into an account switch.
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  const selector = '#panel-claude .row[data-dir="/fixture/.claude-work"]';
  await ctx.apply((state) => {
    const row = state.claude.accounts.find((a) => a.name === 'work');
    row.subscriptionUnavailable = true;
    row.label = 'Xiaoni';
  }, 'claude');
  const row = page.locator(selector);
  const button = row.locator('.subscription-btn');
  await step('Unavailable: one accessible warning icon', await button.count() === 1 && !!await button.getAttribute('aria-label') && await button.locator('vscode-icon').getAttribute('name') === 'warning');
  await step('Unavailable: cached quota hidden and plan marked historical', await row.locator('.row-usage').count() === 0 && await row.locator('.plan.is-stale[title]').count() === 1);
  const layout = await row.evaluate((el) => {
    const button = el.querySelector('.subscription-btn').getBoundingClientRect();
    const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
    const name = el.querySelector('.row-name');
    const range = document.createRange();
    range.selectNodeContents(name);
    const first = range.getClientRects()[0];
    return {
      inline: button.top < first.bottom && button.bottom > first.top,
      inside: button.left >= sidebar.left && button.right <= sidebar.right,
      overflow: el.scrollWidth > el.clientWidth + 1,
    };
  });
  await step('Unavailable: icon stays beside short name without overflow', layout.inline && layout.inside && !layout.overflow, layout);
  await page.evaluate(() => window.preview.clearMessages());
  await button.click();
  await button.dblclick();
  const messages = await page.evaluate(() => window.preview.messages);
  await step('Recheck: dispatches correct account without switching', messages.length > 0 && messages.every((m) => m.type === 'subscriptionCheck' && m.mode === 'claude' && m.dir === '/fixture/.claude-work'), messages);
  await shot(`${locale}-${width}-unavailable.png`);
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    state.claude.accounts.find((a) => a.name === 'work').subscriptionChecking = true;
    window.preview.post({ type: 'state', state });
  });
  await step('Checking: disabled animated icon and no old quota', await button.isDisabled() && await button.locator('vscode-icon[spin]').count() === 1 && await button.getAttribute('aria-busy') === 'true' && await row.locator('.row-usage').count() === 0);
  await shot(`${locale}-${width}-checking.png`);
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    const row = state.claude.accounts.find((a) => a.name === 'work');
    row.subscriptionChecking = false;
    row.subscriptionUnavailable = false;
    window.preview.post({ type: 'state', state });
  });
  await step('Recovered: warning removed and normal quota restored', await button.count() === 0 && await row.locator('.plan.is-stale').count() === 0 && await row.locator('.row-usage').count() === 1);
  await shot(`${locale}-${width}-recovered.png`);
  await ctx.apply((state) => {
    const row = state.claude.accounts.find((a) => a.name === 'work');
    row.label = 'A-very-long-account-name-for-work';
    row.isCurrent = true;
    row.subscriptionUnavailable = true;
  }, 'claude');
  const longLayout = await row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const b = el.querySelector('.subscription-btn').getBoundingClientRect();
    return el.scrollWidth <= el.clientWidth + 1 && b.left >= r.left && b.right <= r.right;
  });
  await step('Current long-name account: warning remains inside card', longLayout);
  await shot(`${locale}-${width}-long-current.png`);
  await ctx.apply((state) => {
    const row = state.codex.accounts.find((a) => a.name === 'work');
    row.subscriptionUnavailable = true;
    row.subscriptionChecking = true;
  }, 'codex');
  await step('Codex: subscription flags do not change its card', await page.locator('#panel-codex .subscription-btn, #panel-codex .plan.is-stale').count() === 0 && await page.locator('#panel-codex .row[data-dir="/fixture/.codex-work"] .row-usage').count() === 1);
}
