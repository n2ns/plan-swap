// The agy page's Tools section: which global rules files are offered, creating a missing rules file or settings.json
// only after the confirmation, and the update terminal; with a temporary HOME
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agyRulesFiles, agySettingsFile, openAgyRules, openAgySettings, updateAgy } from '../src/agy/agyTools';
import { t } from '../src/i18n';
import { makeTempHome, type TempHome } from './helpers';
import { window, type StubTerminal } from './stubs/vscode';

let tmp: TempHome;
beforeEach(() => { tmp = makeTempHome('agy-tools'); });
afterEach(() => tmp.restore());

const write = (rel: string, text = 'x'): string => {
  const file = path.join(tmp.home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

test('rules files: the existing global ones in agy\'s order, then the rules folder\'s .md files by name', () => {
  const rules = [write('.gemini/config/rules/z.md'), write('.gemini/config/rules/global.md')];
  write('.gemini/config/rules/notes.txt');
  const config = write('.gemini/config/AGENTS.md');
  const root = write('.gemini/GEMINI.md');
  assert.deepEqual(agyRulesFiles(tmp.home), [root, config, rules[1], rules[0]]);
});

test('rules: the picked file is opened; nothing is created', async (ctx) => {
  const file = write('.gemini/config/rules/global.md');
  const pick = ctx.mock.method(window, 'showQuickPick', async (items: Array<{ file: string }>) => items[0]);
  const open = ctx.mock.method(window, 'showTextDocument', async (d: unknown) => d);
  await openAgyRules();
  assert.deepEqual((pick.mock.calls[0].arguments[0] as Array<{ file: string }>).map((i) => i.file), [file]);
  assert.equal((open.mock.calls[0].arguments[0] as { path: string }).path, file);
  assert.equal(fs.existsSync(path.join(tmp.home, '.gemini', 'GEMINI.md')), false);
});

test('rules: with none, ~/.gemini/GEMINI.md is created only after the confirmation', async (ctx) => {
  const file = path.join(tmp.home, '.gemini', 'GEMINI.md');
  const pick = ctx.mock.method(window, 'showQuickPick', async () => undefined);
  ctx.mock.method(window, 'showInformationMessage', async () => undefined);
  await openAgyRules();
  assert.equal(fs.existsSync(file), false);
  ctx.mock.method(window, 'showInformationMessage', async () => t('tools.create'));
  await openAgyRules();
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.equal(pick.mock.callCount(), 0);
});

test('settings: a missing settings.json is created as an empty object after the confirmation; an existing one is kept', async (ctx) => {
  ctx.mock.method(window, 'showInformationMessage', async () => t('tools.create'));
  await openAgySettings();
  assert.equal(fs.readFileSync(agySettingsFile(tmp.home), 'utf8'), '{}\n');
  // POSIX file modes only; Windows keeps the profile's ACLs
  if (process.platform !== 'win32') assert.equal(fs.statSync(agySettingsFile(tmp.home)).mode & 0o777, 0o600);
  fs.writeFileSync(agySettingsFile(tmp.home), '{"a":1}');
  await openAgySettings();
  assert.equal(fs.readFileSync(agySettingsFile(tmp.home), 'utf8'), '{"a":1}');
});

test('update: a terminal runs the found CLI with update (Windows: agy by name)', (ctx) => {
  const created = ctx.mock.method(window, 'createTerminal', window.createTerminal);
  updateAgy('/opt/my agy');
  const terminal = created.mock.calls[0].result as StubTerminal;
  assert.deepEqual(terminal.sent, [process.platform === 'win32' ? 'agy update' : "'/opt/my agy' update"]);
  assert.equal(terminal.shown, 1);
});
