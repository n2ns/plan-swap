// Codex selection (Features 10.2, 10.6): the switch asks a modal, a pending selection shows the banner with the
// local-editor wording and marks the selected row, clearing the state file removes it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sb from '../sidebar.mjs';

export async function run(ctx) {
  const { dirs, home, step, notifications, sleep } = ctx;
  await sb.tab(ctx, 'codex');
  let d = await sb.waitFor(ctx, (x) => x.mode === 'codex' && x.rows.length === 3);
  await step('codex page enabled with three accounts, default effective', !d.disabled && d.rows[0].dir === dirs.codexDefault && d.rows[0].current, d.rows.map((r) => sb.basename(r.dir)));

  await sb.rowAction(ctx, dirs.codexWork, 'switch');
  await sleep(1500);
  const notices = await notifications();
  await step('switch asks for confirmation (modal refused in test mode, text quoted)', notices.some((n) => /refused to show dialog/.test(n) && /Codex account/.test(n)), notices[0]?.slice(0, 200));
  await step('refused confirmation changes nothing', !fs.existsSync(path.join(home, '.config', 'planswap', 'codex-home')) && !d.banner);

  // A selection written by another window: the state file watcher shows the pending banner
  const stateFile = path.join(home, '.config', 'planswap', 'codex-home');
  fs.writeFileSync(stateFile, dirs.codexWork);
  d = await sb.waitFor(ctx, (x) => !!x.banner);
  await step('pending banner names the selected account with the local-editor wording', /work/.test(d.banner ?? '') && /restarting the editor/.test(d.banner ?? ''), d.banner);
  const work = d.rows.find((r) => r.dir === dirs.codexWork);
  await step('selected row keeps Switch but loses Remove and Link', work?.actions.includes('switch') && !work?.actions.includes('remove') && !work?.actions.includes('share') && !work?.actions.includes('unshare'), work?.actions);
  await step('effective default row offers Switch to cancel the pending selection', d.rows[0].actions.includes('switch'), d.rows[0].actions);
  await sb.shot(ctx, '01-pending.png');

  fs.rmSync(stateFile);
  d = await sb.waitFor(ctx, (x) => !x.banner);
  await step('cleared state file: banner gone, default row has no Switch', !d.banner && !d.rows[0].actions.includes('switch'), d.rows[0].actions);
}
