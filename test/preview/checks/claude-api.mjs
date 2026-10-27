// Synthetic Claude API cards (window.preview.claudeApiCards) exercise the Claude tab's API card rows, edit area and add
// form without reading accounts or sending model requests.
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  await ctx.apply((state) => {
    state.claude.accounts.push(...window.preview.claudeApiCards());
    // A preset card whose endpoint the host does not report: the edit form starts from the preset's
    delete state.claude.accounts.find((a) => a.name === 'deepseek').providerBaseUrl;
  }, 'claude');
  const panel = page.locator('#panel-claude');
  const rowOf = (name) => panel.locator(`.row[data-dir="/fixture/.claude-${name}"]`);
  const deepseek = rowOf('deepseek'), broken = rowOf('broken'), gateway = rowOf('gateway'), local = rowOf('local');
  const details = (row) => row.locator('.provider-details').textContent();
  await step('A configured card shows its service, model and configuration-only status', await deepseek.locator('.pill.plan').textContent() === 'DeepSeek API'
    && (await details(deepseek)).includes('deepseek-v4-pro') && await deepseek.locator('.provider-details [title]').count() === 1);
  await step('A custom endpoint card shows its label, model and endpoint host', await gateway.locator('.pill.plan').textContent() === 'Custom API'
    && (await details(gateway)).includes('gateway.example.test') && (await details(gateway)).includes('gateway-model'));
  await step('A linked card shows the link badge', await gateway.locator('.shared-icon').count() === 1 && await deepseek.locator('.shared-icon').count() === 0);
  await step('A keyless card shows its local endpoint', (await details(local)).includes('localhost:11434') && (await details(local)).includes('qwen3-coder'));
  await step('A card with a configuration error shows it and no model line', await broken.locator('.provider-error').textContent() === 'Synthetic provider configuration error'
    && await broken.locator('.provider-details > div').count() === 1);
  const subscriptionParts = await panel.evaluate((el) => ['deepseek', 'broken', 'gateway', 'local'].map((name) => el.querySelector(`.row[data-dir="/fixture/.claude-${name}"]`)
    .querySelectorAll('.pill.warn, .row-btn, .row-usage, [data-action="recommendExclude"], .subscription-btn, .row-hint:not(.provider-error), .row-email').length));
  await step('API cards have no sign-in, not-logged-in pill or hint, usage or recommendation controls', subscriptionParts.every((n) => n === 0), subscriptionParts);
  await step('API cards keep Switch, Terminal and the edit button', await deepseek.locator('[data-action="switch"]').count() === 1
    && await deepseek.locator('[data-action="terminal"]').count() === 1 && await deepseek.locator('[data-action="editProvider"]').count() === 1);
  await step('Subscription cards keep their sign-in parts', await panel.locator('.row[data-dir="/fixture/.claude-empty"] .row-btn').count() === 1
    && await panel.locator('.row[data-dir="/fixture/.claude"] .row-email').textContent() === 'claude-default@example.invalid');
  const rowsFit = await panel.evaluate((el) => [...el.querySelectorAll('.row')].every((node) => node.scrollWidth <= node.clientWidth + 1));
  await step('API cards fit the sidebar', rowsFit);
  await shot(`${locale}-${width}-rows.png`);
  await page.evaluate(() => window.preview.clearMessages());
  await deepseek.locator('[data-action="terminal"]').click();
  const terminal = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Terminal uses the account action of the Claude tab', terminal?.type === 'terminal' && terminal.mode === 'claude' && terminal.dir === '/fixture/.claude-deepseek', terminal);

  // Editing a preset: the endpoint is editable (no DeepSeek exception on Claude) and the cached list shows at once
  await page.evaluate(() => window.preview.clearMessages());
  await deepseek.locator('[data-action="editProvider"]').click();
  await page.waitForTimeout(100);
  const presetEdit = deepseek.locator('.provider-edit');
  const presetLoads = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels'));
  await step('A preset card edits its endpoint, prefilled with the preset one', await presetEdit.locator('.api-url').isVisible()
    && await presetEdit.locator('.api-url').evaluate((el) => el.value) === 'https://api.deepseek.com/anthropic');
  await step('A preset card on its preset endpoint offers the cached models without a request', presetLoads.length === 0
    && await presetEdit.locator('.api-model').evaluate((el) => !el.disabled && el.options.length === 2 && el.value === 'deepseek-v4-pro'), presetLoads);
  await presetEdit.locator('.api-url input').fill('https://deepseek-proxy.example.test/anthropic');
  await page.waitForTimeout(1300);
  const movedLoad = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels').at(-1));
  await step('A preset card on another endpoint asks the host with an empty key field and the card', movedLoad?.mode === 'claude' && movedLoad.service === 'deepseek'
    && movedLoad.baseUrl === 'https://deepseek-proxy.example.test/anthropic' && movedLoad.key === '' && movedLoad.dir === '/fixture/.claude-deepseek', movedLoad);
  await presetEdit.locator('[data-action="cancelEdit"]').click();
  await step('Cancel closes the edit area', await deepseek.locator('.provider-edit').count() === 0);

  // Editing a custom endpoint: loads with the saved key, saves with mode claude
  await page.evaluate(() => window.preview.clearMessages());
  await gateway.locator('[data-action="editProvider"]').click();
  await page.waitForTimeout(100);
  const load = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Edit loads the models with the saved key', load?.type === 'providerModels' && load.mode === 'claude' && load.service === 'custom' && load.key === ''
    && load.dir === '/fixture/.claude-gateway' && load.baseUrl === 'https://gateway.example.test/anthropic', load);
  await page.evaluate((request) => window.preview.post({ type: 'providerModelsResult', mode: 'claude', request, models: ['gateway-model', 'other-model'] }), load?.request);
  const editArea = gateway.locator('.provider-edit');
  await step('The edit area shows the endpoint, a password key field and the loaded models', await editArea.locator('.api-url').isVisible()
    && await editArea.locator('.api-key').getAttribute('type') === 'password' && await editArea.locator('.api-model').evaluate((el) => el.options.length) === 2
    && await editArea.locator('.api-model').evaluate((el) => el.value) === 'gateway-model');
  const editFits = await gateway.evaluate((el) => [...el.querySelectorAll('.provider-edit, .api-fields, .api-model-row')].every((n) => n.scrollWidth <= n.clientWidth + 1));
  await step('The edit area fits the card', editFits);
  await shot(`${locale}-${width}-edit.png`);
  await editArea.locator('.api-model').evaluate((el) => { el.value = 'other-model'; el.dispatchEvent(new Event('change')); });
  await page.evaluate(() => window.preview.clearMessages());
  await editArea.locator('[data-action="saveProvider"]').click();
  const save = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Save sends the model and endpoint, keeping the key with an empty field', save?.type === 'saveProvider' && save.mode === 'claude' && save.dir === '/fixture/.claude-gateway'
    && save.model === 'other-model' && save.key === '' && save.baseUrl === 'https://gateway.example.test/anthropic', save);
  await page.evaluate(() => window.preview.post({ type: 'saveProviderResult', mode: 'claude', dir: '/fixture/.claude-gateway', error: 'Synthetic save error' }));
  await step('A failed save keeps the edit area with its error', await gateway.locator('.provider-edit .row-error').textContent() === 'Synthetic save error');
  await page.evaluate(() => window.preview.post({ type: 'saveProviderResult', mode: 'claude', dir: '/fixture/.claude-gateway' }));
  await step('A saved edit closes the edit area', await gateway.locator('.provider-edit').count() === 0);

  // The add form: Claude sign-in or API card
  const toggle = panel.locator('.add-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const help = panel.locator('.add .help');
  const input = panel.locator('.add .input-group vscode-textfield input');
  const radios = panel.locator('vscode-radio[name="add-provider-claude"]');
  await step('The add form offers a Claude sign-in or an API card, sign-in first', await radios.count() === 2
    && await radios.nth(0).getAttribute('value') === 'claude' && await radios.nth(1).getAttribute('value') === 'api'
    && await page.locator('#panel-codex vscode-radio[name="add-provider-claude"]').count() === 0);
  await input.fill('');
  const idleHelp = await help.textContent();
  await radios.nth(1).click();
  await step('API card keeps the idle help until a name is entered', await help.textContent() === idleHelp, await help.textContent());
  await input.fill('api-new');
  const apiHelp = await help.textContent();
  await step('The API card help names the card settings.json, not config.toml', apiHelp.includes('/fixture/.claude-api-new') && apiHelp.includes('settings.json')
    && !apiHelp.includes('config.toml'), apiHelp);
  await panel.locator('vscode-radio[name="add-mode-claude"][value="linked"]').click();
  const form = panel.locator('.add .api-fields');
  const submit = panel.locator('.add .input-group vscode-button');
  await step('The service list shows the Claude services', await form.locator('.api-service').evaluate((el) => el.options.map((o) => o.value).join()) === 'deepseek,kimi,ollama,openrouter,zai,custom');
  await page.evaluate(() => window.preview.clearMessages());
  await form.locator('.api-service').evaluate((el) => { el.value = 'deepseek'; el.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);
  const deepseekLoads = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels'));
  await step('Choosing DeepSeek shows its models at once, without a request, on its fixed endpoint', deepseekLoads.length === 0 && await form.locator('.api-url').isHidden()
    && await form.locator('.api-model').evaluate((el) => !el.disabled && el.value === 'deepseek-flash'), deepseekLoads);
  await step('Create waits for the key of a service that needs one', await submit.evaluate((el) => el.disabled));
  // A keyless local server loads its list at once without a key
  await form.locator('.api-key input').fill('');
  await form.locator('.api-service').evaluate((el) => { el.value = 'ollama'; el.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);
  const keyless = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels').at(-1));
  await step('A keyless service loads its models without a key', keyless?.mode === 'claude' && keyless.service === 'ollama' && keyless.key === '' && keyless.baseUrl === undefined, keyless);
  await page.evaluate((r) => window.preview.post({ type: 'providerModelsResult', mode: 'claude', request: r, models: ['qwen3-coder', 'gpt-oss'] }), keyless?.request);
  await step('A keyless service can be created without a key', await form.locator('.api-model').evaluate((el) => el.value) === 'qwen3-coder' && !(await submit.evaluate((el) => el.disabled)));
  await form.locator('.api-service').evaluate((el) => { el.value = 'custom'; el.dispatchEvent(new Event('change')); });
  // Claude Code appends /v1/messages itself, so the example has no OpenAI-style /v1
  const placeholder = await form.locator('.api-url').getAttribute('placeholder');
  await step('A custom endpoint asks for an Anthropic-format address', await form.locator('.api-url').isVisible()
    && placeholder.includes('https://gateway.example.com') && !placeholder.includes('example.com/v1'), placeholder);
  await form.locator('.api-url input').fill('https://gateway.example.test/anthropic');
  await page.evaluate(() => window.preview.clearMessages());
  await form.locator('.api-key input').fill('synthetic-typed-key');
  await page.waitForTimeout(1300);
  const request = await page.evaluate(() => window.preview.messages.filter((m) => m.type === 'providerModels').at(-1));
  await step('Typing the key loads the models with the service, endpoint and key', request?.mode === 'claude' && request.service === 'custom'
    && request.baseUrl === 'https://gateway.example.test/anthropic' && request.key === 'synthetic-typed-key' && request.dir === undefined, { ...request, key: request?.key ? '<set>' : request?.key });
  await page.evaluate((r) => window.preview.post({ type: 'providerModelsResult', mode: 'claude', request: r, error: 'Synthetic model list error' }), request?.request);
  await step('A failed load shows its reason and allows a typed model ID', (await form.locator('.api-status').textContent()).startsWith('Synthetic model list error')
    && await form.locator('.api-model').evaluate((el) => el.creatable && !el.disabled));
  await form.locator('.api-model input').click();
  await form.locator('.api-model input').fill('typed/model-id');
  await form.locator('.api-model li.placeholder').click();
  await page.waitForTimeout(200);
  await step('A typed model ID is accepted after a failed load', await form.locator('.api-model').evaluate((el) => el.value) === 'typed/model-id'
    && !(await submit.evaluate((el) => el.disabled)));
  await form.locator('.api-load').click();
  const retry = await page.evaluate(() => window.preview.messages.at(-1));
  await page.evaluate((r) => window.preview.post({ type: 'providerModelsResult', mode: 'claude', request: r, models: ['vendor/model-a', 'vendor/model-b'] }), retry?.request);
  await step('Load models answers with a list to choose from', retry?.type === 'providerModels' && retry.mode === 'claude'
    && await form.locator('.api-model').evaluate((el) => el.value === 'vendor/model-a' && el.options.length === 2 && !el.creatable));
  await form.locator('.api-model').evaluate((el) => { el.value = 'vendor/model-b'; el.dispatchEvent(new Event('change')); });
  const fits = await panel.evaluate((el) => [...el.querySelectorAll('.row, .add, .api-fields, .api-model-row')].every((node) => node.scrollWidth <= node.clientWidth + 1));
  await step('Cards and form fit the sidebar', fits);
  await shot(`${locale}-${width}-add.png`);
  await page.evaluate(() => window.preview.clearMessages());
  await submit.click();
  const add = await page.evaluate(() => window.preview.messages.at(-1));
  await step('Create sends a linked Claude API card', add?.type === 'add' && add.mode === 'claude' && add.name === 'api-new' && add.shared === true
    && add.provider?.service === 'custom' && add.provider.baseUrl === 'https://gateway.example.test/anthropic' && add.provider.key === 'synthetic-typed-key' && add.provider.model === 'vendor/model-b',
    { ...add, provider: add?.provider && { ...add.provider, key: '<checked>' } });
  await page.evaluate(() => window.preview.post({ type: 'addResult', mode: 'claude' }));
  await step('A created card clears the typed key and closes the form', (await form.locator('.api-key input').inputValue()) === '' && await toggle.getAttribute('aria-expanded') === 'false');
  // Leave the form as the next case expects it: the sign-in choice
  await toggle.click();
  await radios.nth(0).click();
  await step('The sign-in choice hides the API fields', await form.isHidden());
  await toggle.click();
}
