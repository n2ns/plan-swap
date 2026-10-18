// Card order (Features 2.3): a stored claude.order shows from the first render with the current card first and the
// unordered accounts after it by name; Alt+Down moves a card and writes the whole order; on the Codex page a mouse
// drag does the same and writes codex.order.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedAccounts } from '../fixtures/accounts.mjs';
import * as sb from '../sidebar.mjs';

export function seed(home) {
  const dirs = seedAccounts(home);
  const file = path.join(home, '.config', 'planswap', 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state['claude.order'] = ['spare', 'default', 'work'];
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  return dirs;
}

export async function run(ctx) {
  const { dirs, step } = ctx;
  const names = (d) => d.rows.map((r) => sb.basename(r.dir));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let d = await sb.waitFor(ctx, (x) => x.rows.length === 5);
  await step('claude: stored order shown, the current (default) card first, unordered accounts by name after',
    same(names(d), ['.claude', '.claude-spare', '.claude-work', '.claude-fresh', '.claude-personal']) && !d.rows[0].draggable && d.rows.slice(1).every((r) => r.draggable), names(d));
  await sb.shot(ctx, '01-claude-stored-order.png');

  // Alt+Down on Spare moves it below Work; the host stores every row's name in the shown order
  await (await sb.row(ctx, dirs.claudeSpare)).press('Alt+ArrowDown');
  d = await sb.waitFor(ctx, (x) => same(sb.readState(ctx)['claude.order'], ['default', 'work', 'spare', 'fresh', 'personal']));
  await step('claude: Alt+Down moves Spare below Work and writes claude.order',
    same(names(d), ['.claude', '.claude-work', '.claude-spare', '.claude-fresh', '.claude-personal']) && same(sb.readState(ctx)['claude.order'], ['default', 'work', 'spare', 'fresh', 'personal']),
    { rows: names(d), order: sb.readState(ctx)['claude.order'] });
  await sb.shot(ctx, '02-claude-moved.png');

  // Codex: drag Work (last) onto the upper half of Team (second); it lands above Team
  await sb.tab(ctx, 'codex');
  d = await sb.waitFor(ctx, (x) => x.mode === 'codex' && x.rows.length === 3);
  await step('codex: default order is the current card, then by name', same(names(d), ['.codex', '.codex-team', '.codex-work']), names(d));
  const from = await (await sb.row(ctx, dirs.codexWork)).boundingBox();
  const to = await (await sb.row(ctx, dirs.codexTeam)).boundingBox();
  const { mouse } = ctx.page;
  await mouse.move(from.x + from.width / 2, from.y + 12);
  await mouse.down();
  await mouse.move(from.x + from.width / 2, from.y + 2, { steps: 4 });
  await mouse.move(to.x + to.width / 2, to.y + 6, { steps: 12 });
  await mouse.move(to.x + to.width / 2, to.y + 5, { steps: 2 });
  await mouse.up();
  d = await sb.waitFor(ctx, (x) => same(sb.readState(ctx)['codex.order'], ['default', 'work', 'team']));
  await step('codex: the drag moves Work above Team and writes codex.order; claude.order is untouched',
    same(names(d), ['.codex', '.codex-work', '.codex-team']) && same(sb.readState(ctx)['codex.order'], ['default', 'work', 'team'])
    && same(sb.readState(ctx)['claude.order'], ['default', 'work', 'spare', 'fresh', 'personal']),
    { rows: names(d), codexOrder: sb.readState(ctx)['codex.order'], claudeOrder: sb.readState(ctx)['claude.order'] });
  await sb.shot(ctx, '03-codex-dragged.png');
}
