// Card order (Features 2.3): every card but the current one can be dragged and carries a grip inside its left edge;
// Alt+Down moves the focused card at once and sends the order, Alt+Up at the top of the movable cards does nothing,
// a mouse drag moves a card and sends the order, and a state push in another order rebuilds the list in that order.
export async function run(ctx) {
  const { page, locale, width, step, shot } = ctx;
  const order = (mode) => page.evaluate((mode) => [...document.querySelectorAll(`#panel-${mode} .list > .row`)].map((el) => el.dataset.dir), mode);
  const lastReorder = () => page.evaluate(() => window.preview.messages.filter((m) => m.type === 'reorder').at(-1)?.dirs ?? null);
  const clear = () => page.evaluate(() => window.preview.clearMessages());
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  for (const mode of ['claude', 'codex']) {
    await ctx.apply(() => {}, mode);
    const rows = page.locator(`#panel-${mode} .list > .row`);
    const info = await rows.evaluateAll((els) => els.map((el) => {
      const grip = el.querySelector('.grip');
      const r = el.getBoundingClientRect();
      const g = grip?.getBoundingClientRect();
      return {
        dir: el.dataset.dir, current: el.getAttribute('aria-current') === 'true', draggable: el.getAttribute('draggable') === 'true',
        grip: !!grip, gripTitle: grip?.title ?? null,
        gripInside: !!g && g.left >= r.left && g.right <= r.left + 14 && g.top >= r.top && g.bottom <= r.bottom,
      };
    }));
    await step(`${mode}: current card first, not draggable and without a grip`, info[0].current && !info[0].draggable && !info[0].grip, info[0]);
    await step(`${mode}: the other cards are draggable with a grip inside their left edge`, info.slice(1).every((r) => r.draggable && r.grip && r.gripInside && r.gripTitle), info.slice(1));
    const before = info.map((r) => r.dir);

    // Keyboard: Alt+Down on the second card swaps it with the third and sends the whole order; the focus stays on it
    await clear();
    await rows.nth(1).focus();
    await page.keyboard.press('Alt+ArrowDown');
    const afterDown = await order(mode);
    await step(`${mode}: Alt+Down moves the card below its neighbor and sends the order`,
      same(afterDown, [before[0], before[2], before[1]]) && same(await lastReorder(), afterDown), { afterDown, message: await lastReorder() });
    await step(`${mode}: the moved card keeps the focus`, await page.evaluate((dir) => document.activeElement?.dataset.dir === dir, before[1]));
    // Alt+Up on the card right below the current one has nowhere to go
    await clear();
    await rows.nth(1).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await step(`${mode}: Alt+Up below the current card changes nothing`, same(await order(mode), afterDown) && (await lastReorder()) === null);
    await rows.nth(1).hover();
    await page.waitForFunction((mode) => getComputedStyle(document.querySelector(`#panel-${mode} .list > .row:nth-child(2) .grip`)).opacity === '1', mode);
    await shot(`${locale}-${width}-${mode}-keyboard.png`);

    // Mouse: drag the last card onto the upper half of the second one; it lands above it
    await ctx.apply(() => {}, mode);
    await clear();
    const from = await rows.nth(2).boundingBox();
    const to = await rows.nth(1).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + 2, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + 6, { steps: 12 });
    await page.mouse.move(to.x + to.width / 2, to.y + 5, { steps: 2 });
    await page.mouse.up();
    const afterDrag = await order(mode);
    await step(`${mode}: a mouse drag moves the card above the one it was dropped on and sends the order`,
      same(afterDrag, [before[0], before[2], before[1]]) && same(await lastReorder(), afterDrag), { afterDrag, message: await lastReorder() });
    await step(`${mode}: no card is left marked as dragging`, await page.locator(`#panel-${mode} .row.is-dragging`).count() === 0);
    await shot(`${locale}-${width}-${mode}-dragged.png`);

    // The host's state in another order rebuilds the list in that order, the current card still first; the pushed
    // order differs from what the drag left in the DOM, so a list that was not rebuilt would fail here
    await ctx.apply((state) => {
      const tab = state[state.active];
      tab.accounts = [tab.accounts[1], tab.accounts[0], tab.accounts[2]];
    }, mode);
    await step(`${mode}: a state push in another order is shown as pushed, current card first`, same(await order(mode), before), { shown: await order(mode), expected: before });
  }

  // With one movable card there is nothing to reorder: no grip, nothing draggable
  await ctx.apply((state) => {
    const tab = state[state.active];
    tab.accounts = tab.accounts.slice(0, 2);
  }, 'claude');
  const two = await page.locator('#panel-claude .list > .row').evaluateAll((els) => els.map((el) => ({ draggable: el.getAttribute('draggable'), grip: !!el.querySelector('.grip') })));
  await step('claude: two cards (one movable) show no grip and nothing draggable', two.every((r) => r.draggable === null && !r.grip), two);
}
