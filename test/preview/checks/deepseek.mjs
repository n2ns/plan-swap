// Synthetic provider cards exercise the real Webview without reading accounts or sending model requests.
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  await ctx.apply((state) => {
    const card = state.codex.accounts.find((a) => a.name === 'work');
    card.provider = 'deepseek';
    card.providerModel = 'deepseek-flash';
    card.providerConfigured = true;
    card.plan = 'DeepSeek API';
    card.loggedIn = false;
    card.email = undefined;
    card.usage = undefined;
    card.usageEligible = false;
  }, 'codex');
  const card = page.locator('#panel-codex .row[data-dir="/fixture/.codex-work"]');
  await step('DeepSeek card shows provider, configured model and configuration-only status', await card.locator('.pill.plan').textContent() === 'DeepSeek API' && (await card.locator('.provider-details').textContent()).includes('deepseek-flash') && await card.locator('.provider-details [title]').count() === 1);
  await step('DeepSeek has no subscription sign-in, quota or recommendation controls', await card.locator('.pill.warn, .row-btn, .row-usage, [data-action="recommendExclude"]').count() === 0);
  await step('Subscription cards retain account identity', await page.locator('#panel-codex .row[data-dir="/fixture/.codex"] .row-email').textContent() === 'codex-default@example.invalid');
  await page.evaluate(() => window.preview.clearMessages());
  await card.locator('[data-action="editProvider"]').click();
  const edit = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Edit requests host-owned inputs without a key payload', edit?.type === 'editProvider' && edit.mode === 'codex' && edit.dir === '/fixture/.codex-work' && Object.keys(edit).length === 3, edit);
  await card.locator('[data-action="terminal"]').click();
  const terminal = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Provider terminal uses the existing account action', terminal?.type === 'terminal' && terminal.mode === 'codex' && terminal.dir === '/fixture/.codex-work', terminal);
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    state.codex.hideEmail = true;
    const card = state.codex.accounts.find((a) => a.name === 'work');
    card.providerConfigured = false;
    card.providerError = 'Synthetic provider configuration error';
    delete card.providerModel; // as the host reports an unreadable configuration
    card.isSelected = true;
    state.codex.accounts.find((a) => a.name === 'default').isSelected = false;
    state.codex.pendingDir = 'Work';
    window.preview.post({ type: 'state', state });
  });
  await step('Invalid provider shows an explicit error, not a sign-in action', await card.locator('.provider-error').textContent() === 'Synthetic provider configuration error' && await card.locator('.row-btn').count() === 0);
  await step('Email visibility does not hide provider configuration status', await card.locator('.provider-details').isVisible());
  await step('Invalid provider shows no model line it cannot read', await card.locator('.provider-details > div').count() === 1);
  await step('Pending provider selection is not presented as current', await card.getAttribute('aria-current') === null && await page.locator('#panel-codex .row[data-dir="/fixture/.codex"]').getAttribute('aria-current') === 'true');

  const toggle = page.locator('#panel-codex .add-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const help = page.locator('#panel-codex .add .help');
  const input = page.locator('#panel-codex .add .input-group vscode-textfield input');
  await input.fill('');
  const idleHelp = await help.textContent();
  await page.locator('#panel-codex vscode-radio[name="add-provider-codex"][value="deepseek"]').click();
  await step('Provider choice keeps the idle help a single sentence until a name is entered', await help.textContent() === idleHelp, await help.textContent());
  await input.fill('deepseek-new');
  await page.locator('#panel-codex vscode-radio[value="independent"]').click();
  await step('Provider form collects no API key in the Webview', await page.locator('#panel-codex .add vscode-textfield').count() === 1 && await page.locator('#panel-codex input[type="password"]').count() === 0);
  const fits = await page.locator('#panel-codex').evaluate((el) => [...el.querySelectorAll('.row, .add')].every((node) => node.scrollWidth <= node.clientWidth + 1));
  await step('Provider card and form fit the sidebar', fits);
  await shot(`${locale}-${width}-provider.png`);
  await page.evaluate(() => window.preview.clearMessages());
  await page.locator('#panel-codex .add .input-group vscode-button').click();
  const add = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Create requests the provider and sharing mode without credentials', add?.type === 'add' && add.mode === 'codex' && add.provider === 'deepseek' && add.name === 'deepseek-new' && add.shared === false && Object.keys(add).length === 5, add);
  await page.evaluate(() => window.preview.post({ type: 'addResult', mode: 'codex' }));
  await step('Claude add flow has no provider choice', await page.locator('#panel-claude vscode-radio[name="add-provider-codex"]').count() === 0);
}
