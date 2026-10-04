// Exclusion marks survive a restart: a state file that already holds claude.recommendExcluded = [work] shows the
// excluded toggle and recommends the next account from the first render.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedAccounts } from '../fixtures/accounts.mjs';
import * as sb from '../sidebar.mjs';

export function seed(home) {
  const dirs = seedAccounts(home);
  const file = path.join(home, '.config', 'planswap', 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state['claude.recommendExcluded'] = ['work'];
  state['codex.recommendExcluded'] = ['work'];
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  return dirs;
}

export async function run(ctx) {
  const { dirs, step } = ctx;
  let d = await sb.waitFor(ctx, (x) => !!x.card);
  const work = d.rows.find((r) => r.dir === dirs.claudeWork);
  await step('claude: stored mark shown as excluded, Spare recommended instead of Work', work?.toggle?.icon === 'lightbulb-empty' && work?.toggle?.checked === 'true' && d.card?.title === 'Recommended: spare', { toggle: work?.toggle, card: d.card?.title });
  await sb.shot(ctx, '01-claude.png');
  await sb.tab(ctx, 'codex');
  d = await sb.waitFor(ctx, (x) => x.mode === 'codex');
  const codexWork = d.rows.find((r) => r.dir === dirs.codexWork);
  await step('codex: stored mark shown as excluded, no card (Team is limit-reached)', codexWork?.toggle?.icon === 'lightbulb-empty' && !d.card, { toggle: codexWork?.toggle, card: d.card });
  await sb.rowAction(ctx, dirs.codexWork, 'recommendExclude');
  d = await sb.waitFor(ctx, (x) => !!x.card);
  await step('including Work again recommends it and leaves only the Claude mark', d.card?.title === 'Recommended: work' && JSON.stringify(sb.readState(ctx)['claude.recommendExcluded']) === '["work"]' && sb.readState(ctx)['codex.recommendExcluded'] === undefined, sb.readState(ctx));
}
