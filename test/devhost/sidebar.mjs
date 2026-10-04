// PlanSwap sidebar helpers for devhost scenarios: what the page shows and how to operate it. Selectors follow
// src/webview/main.ts; keep them in step with the Webview.
import * as path from 'node:path';

/** Card, banners, list title, add help and the rows (usage levels, toggle, buttons) of the visible page */
export const dump = (ctx) => ctx.frame.evaluate(() => {
  const mode = document.querySelector('.tab[aria-selected="true"]')?.id.replace('tab-', '');
  const panel = document.querySelector(`#panel-${mode}`);
  const card = panel.querySelector('.banner.recommend');
  return {
    mode, width: document.body.clientWidth,
    listTitle: panel.querySelector('.section-title .title-main > span:first-child')?.textContent ?? null,
    addHelp: panel.querySelector('.add .help')?.textContent ?? null,
    disabled: !!panel.querySelector('.disabled-card'),
    card: card && { title: card.querySelector('.banner-title').textContent, text: card.querySelector('.recommend-text').textContent,
      buttons: [...card.querySelectorAll('vscode-button')].map((b) => `${b.dataset.action}:${b.textContent.trim()}`) },
    banner: panel.querySelector('.banner:not(.recommend) .banner-title')?.textContent ?? null,
    rows: [...panel.querySelectorAll('.row')].map((r) => ({
      dir: r.dataset.dir, current: r.getAttribute('aria-current') === 'true', name: r.querySelector('.row-name')?.textContent ?? null,
      email: r.querySelector('.row-email')?.textContent ?? null, plan: r.querySelector('.pill.plan')?.textContent ?? null,
      shared: !!r.querySelector('.shared-icon'), confirming: r.classList.contains('is-confirming'), error: r.querySelector('.row-error')?.textContent ?? null,
      usage: [...r.querySelectorAll('.usage-window')].map((w) => `${w.querySelector('.usage-duration').textContent} ${w.querySelector('.usage-pct').textContent} ${w.querySelector('.usage-track').dataset.level}`),
      toggle: (() => { const t = r.querySelector('[data-action="recommendExclude"]'); return t && { icon: t.getAttribute('icon'), checked: t.shadowRoot?.querySelector('button')?.getAttribute('aria-checked') }; })(),
      actions: [...r.querySelectorAll('[data-action]')].map((a) => a.dataset.action),
    })),
  };
});

/** Polls dump() until pred holds */
export const waitFor = (ctx, pred, ms) => ctx.waitFor(() => dump(ctx), pred, ms);

/** Screenshot with the list scrolled to the top */
export async function shot(ctx, file) {
  await ctx.frame.evaluate(() => { document.querySelector('#app').scrollTop = 0; });
  await ctx.shot(file);
}

/** The row of an account directory */
export async function row(ctx, dir) {
  const rows = ctx.frame.locator('.row');
  for (let i = 0, n = await rows.count(); i < n; i++) if ((await rows.nth(i).getAttribute('data-dir')) === dir) return rows.nth(i);
  throw new Error(`row ${dir} not found`);
}

/** Clicks the control with data-action=action in the row of dir */
export const rowAction = async (ctx, dir, action) => (await row(ctx, dir)).locator(`[data-action="${action}"]`).click();

export const tab = (ctx, mode) => ctx.frame.locator(`#tab-${mode}`).click();

/** Opens the add form if needed, sets the linked checkbox, types the name and submits with Enter */
export async function addAccount(ctx, mode, name, shared) {
  const panel = ctx.frame.locator(`#panel-${mode}`);
  if (await panel.locator('.add').evaluate((el) => el.hidden)) await panel.locator('.add-toggle').click();
  const box = panel.locator('vscode-checkbox.add-shared');
  if ((await box.evaluate((el) => el.checked)) !== shared) await box.click();
  const input = panel.locator('.add vscode-textfield input');
  await input.fill(name);
  await input.press('Enter');
}

/** Types a new display name into the row's inline rename field and submits with Enter */
export async function rename(ctx, dir, label) {
  await rowAction(ctx, dir, 'rename');
  const input = (await row(ctx, dir)).locator('.rename-field input');
  await input.fill(label);
  await input.press('Enter');
}

/** Remove button, then the inline confirmation */
export async function remove(ctx, dir) {
  await rowAction(ctx, dir, 'remove');
  await rowAction(ctx, dir, 'confirmRemove');
}

export const readState = (ctx) => ctx.readHomeJson(path.join('.config', 'planswap', 'state.json'));

/** The PlanSwap status bar item: text, side, background and (on hover) tooltip text; null when hidden */
export async function statusItem(ctx, { hover = false } = {}) {
  const item = ctx.page.locator('#workbench\\.parts\\.statusbar .statusbar-item', { hasText: /Claude|Codex/ }).first();
  if ((await item.count()) === 0) return null;
  // VS Code marks a colored item with a kind class (warning-kind / error-kind) on the item element
  const info = await item.evaluate((el) => ({
    text: el.innerText.trim(), left: !!el.closest('.left-items'),
    kind: [...el.classList].find((c) => c.endsWith('-kind')) ?? null,
  }));
  if (!hover) return info;
  await item.hover();
  const tip = ctx.page.locator('.workbench-hover, .monaco-hover').first();
  await tip.waitFor({ timeout: 5000 }).catch(() => undefined);
  info.tooltip = (await tip.count()) ? await tip.innerText() : null;
  await ctx.page.mouse.move(1800, 900);
  return info;
}

export const basename = (p) => path.basename(p);
