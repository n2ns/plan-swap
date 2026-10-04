// Account rows (Features 2.3, 2.5, 2.7, 4.2, 4.3, 4.6, 4.7): add linked and independent accounts, duplicate-name
// validation, inline rename with collision, link/unlink confirmations, inline remove with the directory kept.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sb from '../sidebar.mjs';

export async function run(ctx) {
  const { dirs, home, step, notifications, sleep } = ctx;
  await sb.waitFor(ctx, (x) => x.rows.length === 5);

  // Add a linked account: its row shows the link badge and its projects entry links to the default account
  await sb.addAccount(ctx, 'claude', 'team', true);
  let d = await sb.waitFor(ctx, (x) => x.rows.some((r) => r.name === 'team'));
  const teamDir = path.join(home, '.claude-team');
  const team = d.rows.find((r) => r.name === 'team');
  await step('add linked: row with link badge, directory created, projects is a link into the default account',
    !!team?.shared && fs.existsSync(teamDir) && fs.lstatSync(path.join(teamDir, 'projects')).isSymbolicLink() && fs.readlinkSync(path.join(teamDir, 'projects')) === path.join(dirs.claudeDefault, 'projects'),
    { shared: team?.shared, link: fs.existsSync(path.join(teamDir, 'projects')) && fs.readlinkSync(path.join(teamDir, 'projects')) });
  await step('add: form collapsed after success', await ctx.frame.locator('#panel-claude .add').evaluate((el) => el.hidden));
  // Add an independent account: no badge, a real projects directory
  await sb.addAccount(ctx, 'claude', 'solo', false);
  d = await sb.waitFor(ctx, (x) => x.rows.some((r) => r.name === 'solo'));
  const soloDir = path.join(home, '.claude-solo');
  const solo = d.rows.find((r) => r.name === 'solo');
  const links = (dir) => fs.readdirSync(dir).filter((e) => fs.lstatSync(path.join(dir, e)).isSymbolicLink());
  await step('add independent: no badge, directory created, nothing linked', !!solo && !solo.shared && fs.existsSync(soloDir) && links(soloDir).length === 0, { shared: solo?.shared, links: links(soloDir) });
  await step('state.json lists both new accounts', ['team', 'solo'].every((n) => sb.readState(ctx).accounts.some((a) => a.name === n)), sb.readState(ctx).accounts.map((a) => a.name));
  await sb.shot(ctx, '01-added.png');

  // A duplicate name is refused by the page before anything is sent
  const panel = ctx.frame.locator('#panel-claude');
  await panel.locator('.add-toggle').click();
  await panel.locator('.add vscode-textfield input').fill('work');
  d = await sb.dump(ctx);
  await step('add: duplicate name shows the validation message and disables Add', d.addHelp === 'An account with this name already exists' && await panel.locator('.add vscode-button').evaluate((el) => el.disabled), d.addHelp);
  await panel.locator('.add vscode-textfield input').press('Escape');

  // Rename: alias stored and shown; a name of another account is refused inline; the account's own name clears the alias
  await sb.rename(ctx, dirs.claudeWork, 'Work Main');
  d = await sb.waitFor(ctx, (x) => x.rows.find((r) => r.dir === dirs.claudeWork)?.name === 'Work Main');
  await step('rename: display name shown and stored as alias', d.rows.find((r) => r.dir === dirs.claudeWork)?.name === 'Work Main' && sb.readState(ctx)['claude.labels']?.work === 'Work Main', sb.readState(ctx)['claude.labels']);
  await sb.rename(ctx, dirs.claudeWork, 'spare');
  d = await sb.waitFor(ctx, (x) => !!x.rows.find((r) => r.dir === dirs.claudeWork)?.error);
  await step('rename: a colliding name is refused inline', /already|exists|another/i.test(d.rows.find((r) => r.dir === dirs.claudeWork)?.error ?? ''), d.rows.find((r) => r.dir === dirs.claudeWork)?.error);
  await (await sb.row(ctx, dirs.claudeWork)).locator('.rename-field input').press('Escape');
  await sb.rename(ctx, dirs.claudeWork, 'work');
  d = await sb.waitFor(ctx, (x) => x.rows.find((r) => r.dir === dirs.claudeWork)?.name === 'work' && !x.rows.some((r) => r.error));
  await step('rename to the own name clears the alias', sb.readState(ctx)['claude.labels']?.work === undefined, sb.readState(ctx)['claude.labels']);

  // Link / unlink ask a modal first (refused in test mode; the refusal quotes the question)
  await sb.rowAction(ctx, soloDir, 'share');
  await sleep(1500);
  await step('link asks for confirmation naming the account', (await notifications()).some((n) => n.includes('Link solo to the default account?')), (await notifications())[0]?.slice(0, 120));
  await sb.rowAction(ctx, teamDir, 'unshare');
  await sleep(1500);
  await step('unlink asks for confirmation naming the account', (await notifications()).some((n) => n.includes('Unlink team from the default account?')), (await notifications())[0]?.slice(0, 120));
  await step('refused confirmations change nothing', fs.lstatSync(path.join(teamDir, 'projects')).isSymbolicLink() && links(soloDir).length === 0);

  // Remove: inline confirmation, then the row goes; the directory question is a modal (refused), so the folder stays
  await sb.rowAction(ctx, soloDir, 'remove');
  d = await sb.waitFor(ctx, (x) => x.rows.find((r) => r.dir === soloDir)?.confirming === true);
  await step('remove: inline confirmation inside the row', d.rows.find((r) => r.dir === soloDir)?.confirming === true);
  await sb.rowAction(ctx, soloDir, 'confirmCancel');
  d = await sb.waitFor(ctx, (x) => x.rows.find((r) => r.dir === soloDir)?.confirming === false);
  await step('remove: Cancel restores the row', !!d.rows.find((r) => r.dir === soloDir) && sb.readState(ctx).accounts.some((a) => a.name === 'solo'));
  await sb.remove(ctx, soloDir);
  d = await sb.waitFor(ctx, (x) => !x.rows.some((r) => r.dir === soloDir));
  await step('remove: row gone, account unregistered and its directory ignored, folder kept (directory question refused)',
    !d.rows.some((r) => r.dir === soloDir) && !sb.readState(ctx).accounts.some((a) => a.name === 'solo') && (sb.readState(ctx).ignoredDirs ?? []).includes(soloDir) && fs.existsSync(soloDir),
    { ignored: sb.readState(ctx).ignoredDirs });
  await step('current and default rows have no remove button', d.rows.filter((r) => r.current || r.dir === dirs.claudeDefault).every((r) => !r.actions.includes('remove')));
  await sb.shot(ctx, '02-after-remove.png');

  // Codex: add a linked account and remove it again
  await sb.tab(ctx, 'codex');
  await sb.waitFor(ctx, (x) => x.mode === 'codex' && x.rows.length === 3);
  await sb.addAccount(ctx, 'codex', 'extra', true);
  d = await sb.waitFor(ctx, (x) => x.rows.some((r) => r.name === 'extra'));
  const extraDir = path.join(home, '.codex-extra');
  await step('codex add linked: row with badge, sessions linked to the default account',
    !!d.rows.find((r) => r.name === 'extra')?.shared && fs.lstatSync(path.join(extraDir, 'sessions')).isSymbolicLink(), { shared: d.rows.find((r) => r.name === 'extra')?.shared });
  await sb.remove(ctx, extraDir);
  d = await sb.waitFor(ctx, (x) => !x.rows.some((r) => r.dir === extraDir));
  await step('codex remove: row gone, folder kept', !d.rows.some((r) => r.dir === extraDir) && fs.existsSync(extraDir) && !sb.readState(ctx)['codex.accounts'].some((a) => a.name === 'extra'));
  await sb.shot(ctx, '03-codex.png');
}
