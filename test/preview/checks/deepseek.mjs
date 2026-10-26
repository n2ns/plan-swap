// Synthetic provider cards exercise the real Webview without reading accounts or sending model requests.
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  await ctx.apply((state) => {
    const card = state.codex.accounts.find((a) => a.name === 'work');
    card.provider = 'DeepSeek API';
    card.providerService = 'deepseek';
    card.providerModel = 'deepseek-flash';
    card.providerConfigured = true;
    card.plan = 'DeepSeek API';
    card.loggedIn = false;
    card.email = undefined;
    card.usage = undefined;
    card.usageEligible = false;
    // A custom endpoint card (a gateway) next to it: its endpoint host is shown, never a key
    const gateway = state.codex.accounts.find((a) => a.name === 'empty');
    Object.assign(gateway, { provider: 'Custom API', providerService: 'custom', providerModel: 'gateway-model', providerBaseUrl: 'https://gateway.example.test/v1',
      providerHost: 'gateway.example.test', providerHasKey: true, providerConfigured: true,
      plan: 'Custom API', loggedIn: true, email: undefined, usage: undefined, usageEligible: false });
  }, 'codex');
  const card = page.locator('#panel-codex .row[data-dir="/fixture/.codex-work"]');
  await step('DeepSeek card shows provider, configured model and configuration-only status', await card.locator('.pill.plan').textContent() === 'DeepSeek API' && (await card.locator('.provider-details').textContent()).includes('deepseek-flash') && await card.locator('.provider-details [title]').count() === 1);
  const gatewayCard = page.locator('#panel-codex .row[data-dir="/fixture/.codex-empty"]');
  await step('A custom endpoint card shows its label, model and endpoint host', await gatewayCard.locator('.pill.plan').textContent() === 'Custom API'
    && (await gatewayCard.locator('.provider-details').textContent()).includes('gateway.example.test')
    && (await gatewayCard.locator('.provider-details').textContent()).includes('gateway-model'));
  await step('DeepSeek has no subscription sign-in, quota or recommendation controls', await card.locator('.pill.warn, .row-btn, .row-usage, [data-action="recommendExclude"]').count() === 0);
  await step('Subscription cards retain account identity', await page.locator('#panel-codex .row[data-dir="/fixture/.codex"] .row-email').textContent() === 'codex-default@example.invalid');
  // Editing happens in the card: it loads the model list with the saved key (empty key + dir), then saves
  await page.evaluate(() => window.preview.clearMessages());
  await gatewayCard.locator('[data-action="editProvider"]').click();
  await page.waitForTimeout(100);
  const load = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Edit loads the models with the saved key', load?.type === 'providerModels' && load.service === 'custom' && load.key === '' && load.dir === '/fixture/.codex-empty'
    && load.baseUrl === 'https://gateway.example.test/v1', load);
  await page.evaluate((request) => window.preview.post({ type: 'providerModelsResult', mode: 'codex', request, models: ['gateway-model', 'other-model'] }), load?.request);
  const editArea = gatewayCard.locator('.provider-edit');
  await step('The edit area shows the endpoint, a password key field and the loaded models', await editArea.locator('.api-url').isVisible()
    && await editArea.locator('.api-key').getAttribute('type') === 'password' && await editArea.locator('.api-model').evaluate((el) => el.options.length) === 2);
  await step('Editing preselects the current model, so saving works without choosing again', await editArea.locator('.api-model').evaluate((el) => el.value) === 'gateway-model'
    && !(await editArea.locator('[data-action="saveProvider"]').evaluate((el) => el.disabled)));
  const modelWidth = await page.locator('#panel-codex').evaluate((el) => [...el.querySelectorAll('.api-model')].filter((m) => m.offsetParent).map((m) => m.getBoundingClientRect().width));
  await step('Model lists keep a readable width', modelWidth.every((w) => w >= 110), modelWidth);
  const editFits = await gatewayCard.evaluate((el) => [...el.querySelectorAll('.provider-edit, .api-fields, .api-model-row')].every((n) => n.scrollWidth <= n.clientWidth + 1));
  await step('The edit area fits the card', editFits);
  await shot(`${locale}-${width}-provider-edit.png`);
  // A state refresh while typing in the edit area keeps the focus in the field
  await editArea.locator('.api-key input').focus();
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    state.codex.accounts.find((a) => a.name === 'default').email = 'refreshed@example.invalid';
    window.preview.post({ type: 'state', state });
  });
  await page.waitForTimeout(100);
  await step('A refresh while editing keeps the typing focus', await editArea.locator('.api-key').evaluate((el) => el.matches(':focus-within') || document.activeElement === el));
  await editArea.locator('.api-model').evaluate((el) => { el.value = 'other-model'; el.dispatchEvent(new Event('change')); });
  await page.evaluate(() => window.preview.clearMessages());
  await editArea.locator('[data-action="saveProvider"]').click();
  const save = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Save sends the model and endpoint, keeping the key with an empty field', save?.type === 'saveProvider' && save.dir === '/fixture/.codex-empty' && save.model === 'other-model'
    && save.key === '' && save.baseUrl === 'https://gateway.example.test/v1', save);
  await page.evaluate(() => window.preview.post({ type: 'saveProviderResult', mode: 'codex', dir: '/fixture/.codex-empty' }));
  await step('A saved edit closes the edit area', await gatewayCard.locator('.provider-edit').count() === 0);
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
  await page.locator('#panel-codex vscode-radio[name="add-provider-codex"][value="api"]').click();
  await step('Provider choice keeps the idle help a single sentence until a name is entered', await help.textContent() === idleHelp, await help.textContent());
  await input.fill('api-new');
  await page.locator('#panel-codex vscode-radio[value="independent"]').click();
  const form = page.locator('#panel-codex .add .api-fields');
  const submit = page.locator('#panel-codex .add .input-group vscode-button');
  await step('The service list starts with a service chosen', (await form.locator('.api-service').evaluate((el) => el.value)) !== '');
  // The form is created once per page: start each case from the first service, whose models load at once
  await page.evaluate(() => window.preview.clearMessages());
  await form.locator('.api-service').evaluate((el) => { el.value = 'deepseek'; el.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);
  const deepseekLoad = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels'));
  await step('Choosing DeepSeek shows its models at once, without a key or a request', deepseekLoad.length === 0
    && await form.locator('.api-model').evaluate((el) => !el.disabled && el.value === 'deepseek-flash'), deepseekLoad);
  // A cached list (OpenRouter, refreshed in the background) is offered at once; typing the key sends no request
  await form.locator('.api-service').evaluate((el) => { el.value = 'openrouter'; el.dispatchEvent(new Event('change')); });
  await form.locator('.api-key input').fill('synthetic-or-key');
  await page.waitForTimeout(1300);
  const cachedLoads = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels'));
  await step('A cached service list shows at once and typing the key loads nothing', cachedLoads.length === 0
    && await form.locator('.api-model').evaluate((el) => !el.disabled && el.value === 'anthropic/model-a' && el.options.length === 3), cachedLoads.length);
  // A service needing a key without a cached list says so
  await form.locator('.api-key input').fill('');
  await form.locator('.api-service').evaluate((el) => { el.value = 'kimi'; el.dispatchEvent(new Event('change')); });
  await step('A service without a cached list asks for the key first', (await form.locator('.api-status').textContent()).length > 0
    && await form.locator('.api-model').evaluate((el) => el.disabled));
  await step('API service shows the service list, a password key field and a model list waiting to load', await form.isVisible()
    && await form.locator('.api-service').evaluate((el) => el.options.length) === 8 && await form.locator('.api-key').getAttribute('type') === 'password'
    && await form.locator('.api-model').evaluate((el) => el.disabled && !el.creatable) && await form.locator('.api-url').isHidden());
  await step('Create waits for a chosen model', await submit.evaluate((el) => el.disabled));
  await form.locator('.api-service').evaluate((el) => { el.value = 'custom'; el.dispatchEvent(new Event('change')); });
  await step('A custom endpoint asks for its address', await form.locator('.api-url').isVisible());
  await form.locator('.api-url input').fill('https://gateway.example.test/v1');
  await page.evaluate(() => window.preview.clearMessages());
  await form.locator('.api-key input').fill('synthetic-typed-key');
  await page.waitForTimeout(1300);
  const autoLoads = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels'));
  const request = autoLoads.at(-1);
  // A custom endpoint's key is optional: leaving the address loads once without it, the typed key loads again
  await step('Typing the key loads the models by itself once typing pauses', autoLoads.length >= 1 && autoLoads.at(-1).key === 'synthetic-typed-key', autoLoads.length);
  await step('The automatic load sends the service, endpoint and typed key', request?.type === 'providerModels' && request.service === 'custom'
    && request.baseUrl === 'https://gateway.example.test/v1' && request.key === 'synthetic-typed-key' && request.dir === undefined, { ...request, key: request?.key ? '<set>' : request?.key });
  await page.evaluate((r) => window.preview.post({ type: 'providerModelsResult', mode: 'codex', request: r, error: 'Synthetic model list error' }), request?.request);
  await step('A failed load shows its reason in the form', (await form.locator('.api-status').textContent()).startsWith('Synthetic model list error'));
  await step('Only after a failed load can the model ID be typed', await form.locator('.api-model').evaluate((el) => el.creatable && !el.disabled));
  await form.locator('.api-model input').click();
  await form.locator('.api-model input').fill('typed/model-id');
  await form.locator('.api-model li.placeholder').click();
  await page.waitForTimeout(200);
  await step('A typed model ID is accepted after a failed load', await form.locator('.api-model').evaluate((el) => el.value) === 'typed/model-id'
    && !(await submit.evaluate((el) => el.disabled)), await form.locator('.api-model').evaluate((el) => el.value));
  await form.locator('.api-load').click();
  const retry = await page.evaluate(() => window.preview.messages.at(-1));
  await page.evaluate((r) => window.preview.post({ type: 'providerModelsResult', mode: 'codex', request: r, models: ['vendor/model-a', 'vendor/model-b'] }), retry?.request);
  await step('A loaded list shows its first model chosen', await form.locator('.api-model').evaluate((el) => el.value) === 'vendor/model-a');
  await step('Loaded models can be chosen, not typed', !(await form.locator('.api-model').evaluate((el) => el.disabled)) && await form.locator('.api-model').evaluate((el) => el.options.length) === 2
    && !(await form.locator('.api-model').evaluate((el) => el.creatable)));
  await form.locator('.api-model').evaluate((el) => { el.value = 'vendor/model-b'; el.dispatchEvent(new Event('change')); });
  const fits = await page.locator('#panel-codex').evaluate((el) => [...el.querySelectorAll('.row, .add, .api-fields, .api-model-row')].every((node) => node.scrollWidth <= node.clientWidth + 1));
  await step('Provider card and form fit the sidebar', fits);
  await shot(`${locale}-${width}-provider.png`);
  await page.evaluate(() => window.preview.clearMessages());
  await submit.click();
  const add = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Create sends the API card fields', add?.type === 'add' && add.mode === 'codex' && add.name === 'api-new' && add.shared === false
    && add.provider?.service === 'custom' && add.provider.baseUrl === 'https://gateway.example.test/v1' && add.provider.key === 'synthetic-typed-key' && add.provider.model === 'vendor/model-b',
    { ...add, provider: add?.provider && { ...add.provider, key: '<checked>' } });
  await page.evaluate(() => window.preview.post({ type: 'addResult', mode: 'codex' }));
  await step('A created card clears the typed key', (await form.locator('.api-key input').inputValue()) === '');
  // Closing the form without creating anything shows nothing and keeps no key
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await form.locator('.api-key input').fill('synthetic-unsent-key');
  await toggle.click();
  await toggle.click();
  await step('Closing the form clears the key and shows no message', (await form.locator('.api-key input').inputValue()) === '' && !(await help.getAttribute('class')).includes('error'));
  await step('Claude add flow has no provider choice', await page.locator('#panel-claude vscode-radio[name="add-provider-codex"]').count() === 0);
}

// Cached lists belong to a preset's own endpoint and never replace a model the user typed or a card's current one
export async function cachedListGuards(ctx) {
  const { page, step } = ctx;
  await ctx.apply((state) => {
    const proxy = state.codex.accounts.find((a) => a.name === 'work');
    Object.assign(proxy, { provider: 'OpenRouter API', providerService: 'openrouter', providerModel: 'proxy/model-x', providerBaseUrl: 'https://proxy.example.test/v1',
      providerHost: 'proxy.example.test', providerHasKey: true, providerConfigured: true, plan: 'OpenRouter API', loggedIn: true, email: undefined, usage: undefined, usageEligible: false });
    delete proxy.providerError;
  }, 'codex');
  const proxyCard = page.locator('#panel-codex .row[data-dir="/fixture/.codex-work"]');
  await page.evaluate(() => window.preview.clearMessages());
  await proxyCard.locator('[data-action="editProvider"]').click();
  await page.waitForTimeout(150);
  const load = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels').at(-1));
  const edit = proxyCard.locator('.provider-edit');
  await step('A preset card on another endpoint loads its own list, not the preset cache', load?.baseUrl === 'https://proxy.example.test/v1'
    && await edit.locator('.api-model').evaluate((el) => el.options.length === 1 && el.value === 'proxy/model-x'), load);
  await page.evaluate((r) => window.preview.post({ type: 'providerModelsResult', mode: 'codex', request: r, models: ['proxy/model-y'] }), load?.request);
  await step('A current model missing from the loaded list stays chosen', await edit.locator('.api-model').evaluate((el) => el.value) === 'proxy/model-x');
  await edit.locator('[data-action="cancelEdit"]').click();
  // A model typed after a failed load survives a state push that brings a cached list
  const panel = page.locator('#panel-codex');
  if (await panel.locator('#add-codex').isHidden()) await panel.locator('.add-toggle').click();
  await panel.locator('vscode-radio[name="add-provider-codex"][value="api"]').click();
  const form = panel.locator('#add-codex .api-fields');
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    delete state.codex.apiServices.find((s) => s.id === 'openrouter').models;
    window.preview.post({ type: 'state', state });
  });
  // The form is shared with the cases before: start from an empty key and a fresh service choice
  await form.locator('.api-key input').fill('');
  await form.locator('.api-service').evaluate((el) => { el.value = 'kimi'; el.dispatchEvent(new Event('change')); });
  await form.locator('.api-service').evaluate((el) => { el.value = 'openrouter'; el.dispatchEvent(new Event('change')); });
  await step('A service without a cached list starts with an empty model list', await form.locator('.api-model').evaluate((el) => el.disabled && el.options.length === 0 && !el.creatable),
    await form.locator('.api-model').evaluate((el) => ({ value: el.value, creatable: el.creatable, disabled: el.disabled, options: el.options.length })));
  await page.evaluate(() => window.preview.clearMessages());
  await form.locator('.api-key input').fill('synthetic-or-key');
  await page.waitForTimeout(1300);
  const failed = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels').at(-1));
  await page.evaluate((r) => window.preview.post({ type: 'providerModelsResult', mode: 'codex', request: r, error: 'Synthetic failure' }), failed?.request);
  await form.locator('.api-model input').click();
  await form.locator('.api-model input').fill('typed/kept');
  await form.locator('.api-model li.placeholder').click();
  await page.evaluate(() => {
    const state = structuredClone(window.preview.state());
    state.codex.apiServices.find((x) => x.id === 'openrouter').models = ['cached/a', 'cached/b'];
    window.preview.post({ type: 'state', state });
  });
  await page.waitForTimeout(100);
  await step('A cached list arriving later keeps the model typed after a failed load', await form.locator('.api-model').evaluate((el) => el.value) === 'typed/kept',
    await form.locator('.api-model').evaluate((el) => ({ value: el.value, creatable: el.creatable, disabled: el.disabled, options: el.options.length })));
  await form.locator('.api-key input').fill('');
  await panel.locator('.add-toggle').click();
}
