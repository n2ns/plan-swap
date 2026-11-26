// The agy page's Tools section: agy's global rules files, its settings.json and `agy update`.
//
// Paths are those of agy 1.5.17 / 1.5.18 on macOS and WSL (agy research, Facts 10 to 12); Windows is not verified.
// The rules files are agy's global ones in the order its changelog names them, then the rules folder's *.md files by
// name; the user picks one of the existing files, and only when none exists is ~/.gemini/GEMINI.md created after a
// confirmation. A missing settings.json is created as an empty JSON object after a confirmation.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { t } from '../i18n';
import { isWindows, tildify } from '../platform';
import { accountTerminalShell, hasControlChars, shQuote } from '../terminalShell';
import { openOrCreateFile } from '../tools';

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** agy's existing global rules files: ~/.gemini/{GEMINI,AGENTS}.md, ~/.gemini/config/{GEMINI,AGENTS}.md, then ~/.gemini/config/rules/*.md by name. */
export function agyRulesFiles(home: string = os.homedir()): string[] {
  const root = path.join(home, '.gemini');
  const config = path.join(root, 'config');
  const rulesDir = path.join(config, 'rules');
  let rules: string[] = [];
  try {
    rules = fs.readdirSync(rulesDir).filter((n) => n.toLowerCase().endsWith('.md')).sort().map((n) => path.join(rulesDir, n));
  } catch {
    // No rules folder
  }
  return [path.join(root, 'GEMINI.md'), path.join(root, 'AGENTS.md'), path.join(config, 'GEMINI.md'), path.join(config, 'AGENTS.md'), ...rules].filter(isFile);
}

/** agy's settings file. */
export function agySettingsFile(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

/** Lets the user pick one of agy's existing global rules files and opens it; with none, offers to create ~/.gemini/GEMINI.md. */
export async function openAgyRules(): Promise<void> {
  const files = agyRulesFiles();
  if (!files.length) {
    await openOrCreateFile(path.join(os.homedir(), '.gemini', 'GEMINI.md'), { createDir: true });
    return;
  }
  const picked = await vscode.window.showQuickPick(files.map((file) => ({ label: tildify(file), file })), { placeHolder: t('agy.rulesPick') });
  if (picked) await openOrCreateFile(picked.file);
}

/** Opens agy's settings.json; a missing one is created as `{}` after a confirmation. */
export async function openAgySettings(): Promise<void> {
  await openOrCreateFile(agySettingsFile(), { content: '{}\n', createDir: true });
}

/** A terminal running `agy update` with the found CLI (by name on Windows, which finds agy only on PATH). */
export function updateAgy(cli: string): void {
  if (!isWindows() && hasControlChars(cli)) return;
  const terminal = vscode.window.createTerminal({ name: t('tools.updateCli', { vendor: 'agy' }), shellPath: accountTerminalShell() });
  terminal.sendText(isWindows() ? 'agy update' : `${shQuote(cli)} update`);
  terminal.show();
}
