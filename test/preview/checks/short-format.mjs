// Synthetic-only checks for the sidebar setting; full-mode snapshots are the semantic baseline.
let installed = false;
export async function run(ctx) {
  const { page, locale, width } = ctx;
  if (!installed) { await page.clock.install({ time: new Date('2026-10-10T12:00:00Z') }); installed = true; }
  await page.clock.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  const shortLabels = { en: ['5h', '7d'], 'zh-cn': ['5小时', '7天'], 'zh-tw': ['5小時', '7天'], es: ['5 h', '7 d'], ja: ['5時間', '7日'] }[locale];
  for (const mode of ['claude', 'codex']) {
    await ctx.apply((s) => {
      s.shortFormat = false;
      s.usageDisplay = 'remaining';
      for (const vendor of ['claude', 'codex']) {
        const a = s[vendor].accounts.find((a) => a.dir.endsWith('-work'));
        a.label = 'Work Alias';
        const now = Date.now() / 1000;
        a.usage = { checkedAt: Date.now(), windows: [
          { usedPercent: 42, windowMinutes: 300, resetsAt: now + (5 * 1440 + 12 * 60) * 60 },
          { usedPercent: 42, windowMinutes: 10080, resetsAt: now + (3 * 60 + 45) * 60 },
          { usedPercent: 42, windowMinutes: 300, resetsAt: now + 3600 },
          { usedPercent: 42, windowMinutes: 300, resetsAt: now + 59 * 60 + 1 },
          { usedPercent: 42, windowMinutes: 300, resetsAt: now - 60 },
          { usedPercent: 42 },
          { usedPercent: 42, windowMinutes: 10080, scope: 'Model Name' },
        ] };
        s[vendor].recommended = a.dir;
      }
    }, mode);
    const row = page.locator(`.row[data-dir="/fixture/.${mode}-work"]`);
    const snapshot = () => row.locator('.usage-window').evaluateAll((els) => els.map((el) => ({
      duration: el.querySelector('.usage-duration').textContent,
      durationTitle: el.querySelector('.usage-duration').title,
      reset: el.querySelector('.usage-reset-time')?.textContent,
      resetTitle: el.querySelector('.usage-reset')?.title,
      pct: el.querySelector('.usage-pct').textContent,
      label: el.querySelector('.usage-track').getAttribute('aria-label'),
      value: el.querySelector('.usage-track').getAttribute('aria-valuetext'),
      title: el.querySelector('.usage-track').title,
      level: el.dataset.level,
    })));
    const before = await snapshot();
    const toggle = (shortFormat, usageDisplay = 'remaining') => page.evaluate(({shortFormat, usageDisplay}) => {
      const s = window.preview.state(); s.shortFormat = shortFormat; s.usageDisplay = usageDisplay;
      window.preview.post({ type: 'state', state: s });
    }, {shortFormat, usageDisplay});
    await toggle(true);
    const compact = await snapshot();
    ctx.step(`${mode}: localized short labels and Latin countdown boundaries`, compact[0].duration === shortLabels[0] && compact[1].duration === shortLabels[1] &&
      JSON.stringify(compact.map(x => x.reset)) === JSON.stringify(['5d 12h', '3h 45m', '1h', '1h', '1m', undefined, undefined]), JSON.stringify(compact));
    ctx.step(`${mode}: full semantics, missing cycle/time and names preserved`, compact.every((x,i) => x.value === before[i].value && x.label === before[i].label && x.title === before[i].title && x.pct === '58%' && x.level === before[i].level) && compact[5].duration === before[5].duration && compact[6].duration.includes('Model Name') && await row.locator('.row-name').textContent() === 'Work Alias');
    ctx.step(`${mode}: reset hover is fully localized`, compact[0].resetTitle === before[0].value.split(', ').slice(1).join(', ') && compact[0].durationTitle === before[0].duration, compact[0].resetTitle);
    const recommendation = await page.locator(`#panel-${mode} .recommend-text [aria-hidden="true"]`).allTextContents();
    ctx.step(`${mode}: recommendation has bare percentages with full hover meaning`, recommendation.includes(`${shortLabels[0]} 58%`) && (await page.locator(`#panel-${mode} .recommend-text .sr-only`).first().textContent()) === `${before[0].duration} ${before[0].value.split(', ')[0]}` && (await page.locator(`#panel-${mode} .recommend-text span[title]`).first().getAttribute('title')).includes(before[0].duration));
    await toggle(false);
    ctx.step(`${mode}: disabling restores full display immediately`, JSON.stringify(await snapshot()) === JSON.stringify(before));
    await toggle(false, 'used');
    const fullUsed = await snapshot();
    await toggle(true, 'used');
    const used = await snapshot();
    ctx.step(`${mode}: used mode keeps accurate tooltip/ARIA and remaining-based colors`, used.every((x,i) => x.pct === '42%' && x.value === fullUsed[i].value && x.title === fullUsed[i].title && x.level === before[i].level) && used[0].title !== before[0].title);
    await page.clock.runFor(60_000);
    const live = await snapshot();
    ctx.step(`${mode}: minute tick retains Latin format and localized reset hover/ARIA`, live[1].reset === '3h 44m' && live[1].value !== used[1].value && live[1].resetTitle === live[1].value.split(', ').slice(1).join(', '));
    await page.evaluate((locale) => {
      const s = window.preview.state(); s.locale = locale;
      window.preview.post({ type: 'state', state: s });
    }, locale === 'en' ? 'ja' : 'en');
    const translated = await snapshot();
    ctx.step(`${mode}: switching language updates full explanations but keeps Latin time`, translated[1].reset === live[1].reset && translated[1].label !== live[1].label && translated[1].title !== live[1].title && translated[1].value !== live[1].value);
    await page.evaluate((locale) => {
      const s = window.preview.state(); s.locale = locale;
      window.preview.post({ type: 'state', state: s });
    }, locale);
    const layout = await row.locator('.usage-window').evaluateAll((els) => {
      const sidebar = document.querySelector('#sidebar').getBoundingClientRect();
      return els.every(el => ['.usage-duration','.usage-pct','.usage-reset'].every(sel => {
        const r = el.querySelector(sel)?.getBoundingClientRect();
        return !r || r.left >= sidebar.left - 1 && r.right <= sidebar.right + 1;
      }));
    });
    ctx.step(`${mode}: short format stays within ${width}px sidebar`, layout);
    await ctx.shot(`${locale}-${width}-${mode}.png`);
  }
}
