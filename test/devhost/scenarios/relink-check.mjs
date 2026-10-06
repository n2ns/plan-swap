// Link check of linked accounts (Features 5.5, Claude design 6.7 "Link check"): a linked Claude account whose `rules`
// link was deleted is pointed out by the background check on activation without being repaired; Re-link reports the
// same problem first, and only Repair recreates the link.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedAccounts } from '../fixtures/accounts.mjs';
import * as sb from '../sidebar.mjs';

// CLAUDE_SHARED_ENTRIES of src/claudeShare.ts; a drift shows up as other missing entries in the notification
const FILES = ['settings.json', 'CLAUDE.md', 'history.jsonl'];
const DIRS = ['projects', 'file-history', 'todos', 'session-env', 'shell-snapshots', 'sessions', 'tasks', 'uploads', 'agents',
  'commands', 'output-styles', 'hooks', 'rules', 'ide'];

export function seed(home) {
  const dirs = seedAccounts(home);
  const def = dirs.claudeDefault;
  const acc = path.join(home, '.claude-linked');
  fs.mkdirSync(acc, { mode: 0o700 });
  for (const f of FILES) fs.writeFileSync(path.join(def, f), f === 'settings.json' ? '{}\n' : '', { mode: 0o600 });
  for (const d of DIRS) fs.mkdirSync(path.join(def, d), { recursive: true, mode: 0o700 });
  for (const name of [...FILES, ...DIRS]) if (name !== 'rules') fs.symlinkSync(path.join(def, name), path.join(acc, name));
  for (const d of ['skills', 'plugins']) {
    fs.mkdirSync(path.join(def, d), { mode: 0o700 });
    fs.mkdirSync(path.join(acc, d), { mode: 0o700 });
  }
  return { ...dirs, claudeLinked: acc, rulesLink: path.join(acc, 'rules'), rulesTarget: path.join(def, 'rules') };
}

const PROBLEM = /Linked Claude accounts have link problems/;
const linkOf = (p) => { try { return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : 'not a link'; } catch { return 'missing'; } };

export async function run(ctx) {
  const { dirs, step, notifications, sleep, page } = ctx;
  await sb.waitFor(ctx, (x) => x.rows.some((r) => r.dir === dirs.claudeLinked && r.shared));

  // Background check on activation (the focused window)
  let notices = await ctx.waitFor(() => notifications(), (v) => v.some((n) => PROBLEM.test(n)), 30_000);
  const background = notices.find((n) => PROBLEM.test(n)) ?? '';
  await step('background check names the account and the missing link', /linked: missing: rules/.test(background), background.slice(0, 300));
  await step('background notification offers Repair', background.includes('Repair'));
  await step('background check repaired nothing', linkOf(dirs.rulesLink) === 'missing', linkOf(dirs.rulesLink));
  const announced = sb.readState(ctx)['links.announced'];
  await step('the announcement is recorded once for Claude', !!announced?.claude && !announced.codex && Object.keys(announced.claude).sort().join() === 'at,fp', announced);
  await sleep(500);
  await ctx.page.screenshot({ path: `${ctx.out}/01-background.png` });

  // Dismiss it, then Re-link: the check reports first and changes nothing
  const toast = page.locator('.notification-toast', { hasText: PROBLEM });
  await toast.hover();
  await toast.locator('.codicon-notifications-clear').click();
  await ctx.waitFor(() => notifications(), (v) => !v.some((n) => PROBLEM.test(n)), 5000);
  await ctx.frame.locator('#panel-claude .page-tools vscode-button[icon="sync"]').click();
  notices = await ctx.waitFor(() => notifications(), (v) => v.some((n) => PROBLEM.test(n)), 10_000);
  const relink = notices.find((n) => PROBLEM.test(n)) ?? '';
  await step('Re-link reports the problem before changing anything', /linked: missing: rules/.test(relink) && linkOf(dirs.rulesLink) === 'missing', relink.slice(0, 300));
  await sleep(500);
  await ctx.page.screenshot({ path: `${ctx.out}/02-relink.png` });

  // Repair recreates the link and reports the usual result
  await page.locator('.notification-toast', { hasText: PROBLEM }).locator('.monaco-button', { hasText: 'Repair' }).click();
  notices = await ctx.waitFor(() => notifications(), (v) => v.some((n) => /Re-linked 1 linked Claude account/.test(n)), 10_000);
  await step('Repair reports the re-link', notices.some((n) => /Re-linked 1 linked Claude account to the default account/.test(n)), notices);
  await step('Repair restored the link', linkOf(dirs.rulesLink) === dirs.rulesTarget, linkOf(dirs.rulesLink));
  await sleep(500);
  await ctx.page.screenshot({ path: `${ctx.out}/03-repaired.png` });

  // A second Re-link finds nothing wrong
  await ctx.frame.locator('#panel-claude .page-tools vscode-button[icon="sync"]').click();
  notices = await ctx.waitFor(() => notifications(), (v) => v.some((n) => /linked correctly/.test(n)), 10_000);
  await step('Re-link after the repair says all is well', notices.some((n) => /The linked Claude account is linked correctly/.test(n)), notices);
  await step('the record is cleared once nothing is wrong', !sb.readState(ctx)['links.announced'], sb.readState(ctx)['links.announced']);
}
