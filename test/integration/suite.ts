// Runs inside the actual VS Code extension host; no vscode mock and no real sign-in fixtures.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export async function run(): Promise<void> {
  assert.equal(os.homedir(), process.env.PLANSWAP_TEST_HOME, 'the editor must inherit the disposable HOME');
  assert.equal(process.env.CODEX_HOME, undefined);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
  const extension = vscode.extensions.getExtension('n2ns.planswap');
  assert.ok(extension, 'the development extension is discoverable');
  await extension.activate();
  assert.ok(extension.isActive);
  console.info('[integration] activation passed');

  const commands = new Set(await vscode.commands.getCommands(true));
  const manifest = extension.packageJSON as { contributes: { commands: Array<{ command: string }> } };
  for (const { command } of manifest.contributes.commands) assert.ok(commands.has(command), `missing command: ${command}`);
  console.info('[integration] contributed commands registered');

  const file = path.join(os.homedir(), '.config', 'planswap', 'state.json');
  const readAccounts = (key: string): Array<{ dir: string }> =>
    (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Array<{ dir: string }>>)[key];
  for (const key of ['accounts', 'codex.accounts']) {
    assert.ok(readAccounts(key).some((a) => a.dir === path.join(os.homedir(), key === 'accounts' ? '.claude-smoke' : '.codex-smoke')));
  }
  const newClaude = path.join(os.homedir(), '.claude-refresh');
  const newCodex = path.join(os.homedir(), '.codex-refresh');
  fs.mkdirSync(newClaude);
  fs.mkdirSync(newCodex);

  // Exercises the real view registration and repeated refreshes without invoking account mutations or restarts.
  await vscode.commands.executeCommand('planswap.accounts.focus');
  await vscode.commands.executeCommand('planswap.refresh');
  await vscode.commands.executeCommand('planswap.accounts.focus');
  await vscode.commands.executeCommand('planswap.codex.refreshUsage');
  assert.ok(readAccounts('accounts').some((a) => a.dir === newClaude));
  assert.ok(readAccounts('codex.accounts').some((a) => a.dir === newCodex));
  assert.equal(fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json')), false);
  console.info('[integration] view commands, signed-out usage and fixture discovery passed');
}
