// Runs inside the launched extension host: activates the extension under test, runs its focus command, then waits
// until the driver writes <HOME>/done (or the timeout passes). No other action.
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

exports.run = async function run() {
  if (os.homedir() !== process.env.DEVHOST_HOME) throw new Error(`editor did not inherit the disposable HOME: ${os.homedir()}`);
  const extension = vscode.extensions.getExtension(process.env.DEVHOST_EXTENSION_ID);
  if (!extension) throw new Error(`extension ${process.env.DEVHOST_EXTENSION_ID} not found`);
  await extension.activate();
  if (process.env.DEVHOST_FOCUS_COMMAND) await vscode.commands.executeCommand(process.env.DEVHOST_FOCUS_COMMAND);
  console.info('[devhost] extension active; waiting for the driver');
  const done = path.join(os.homedir(), 'done');
  const until = Date.now() + Number(process.env.DEVHOST_TIMEOUT_MS || 10 * 60_000);
  while (!fs.existsSync(done) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  console.info('[devhost] finished');
};
