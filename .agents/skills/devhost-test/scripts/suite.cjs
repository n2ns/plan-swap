// Runs inside the launched extension host: activates PlanSwap, opens the sidebar, then waits until the driver writes
// <HOME>/done (or the timeout passes). No account mutation, no CLI, no restart.
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

exports.run = async function run() {
  if (os.homedir() !== process.env.PLANSWAP_TEST_HOME) throw new Error(`editor did not inherit the disposable HOME: ${os.homedir()}`);
  const extension = vscode.extensions.getExtension('n2ns.planswap');
  await extension.activate();
  await vscode.commands.executeCommand('planswap.accounts.focus');
  console.info('[devhost] sidebar focused; waiting for the driver');
  const done = path.join(os.homedir(), 'done');
  const until = Date.now() + Number(process.env.PLANSWAP_DEVHOST_TIMEOUT_MS || 10 * 60_000);
  while (!fs.existsSync(done) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  console.info('[devhost] finished');
};
