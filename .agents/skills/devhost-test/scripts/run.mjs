// Entry point: node .agents/skills/devhost-test/scripts/run.mjs <scenario> [--window x,y,w,h]
// <scenario> names a module in ../scenarios/ exporting `run(ctx)` and optionally `seed(home)` (default: the account
// fixture). --window (or PLANSWAP_DEVHOST_WINDOW) places the editor window; the test-mode editor never saves its own.
import { runScenario } from './lib.mjs';
import { seedAccounts } from '../fixtures/accounts.mjs';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error('usage: node run.mjs <scenario> [--window x,y,w,h]');
  process.exit(1);
}
const windowArg = args.find((a) => a.startsWith('--window='))?.slice('--window='.length) ?? process.env.PLANSWAP_DEVHOST_WINDOW;
const window = windowArg ? (([x, y, width, height]) => ({ x, y, width, height }))(windowArg.split(',').map(Number)) : undefined;
const mod = await import(`../scenarios/${name}.mjs`);
const report = await runScenario({ name, seed: mod.seed ?? seedAccounts, scenario: mod.run, window });
process.exit(report.failures.length ? 1 : 0);
