// activate() end to end in a temporary HOME with the vscode stub and a fake claude CLI (childProcess.spawn mocked:
// the real CLI never runs). Every extension subscription is disposed after each test, so no timer keeps running.
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type * as vscode from 'vscode';
import { activate } from '../src/extension';
import { setLocale, t } from '../src/i18n';
import { CLAUDE_REFRESH_ALL_USAGE_COMMAND, CLAUDE_REFRESH_USAGE_COMMAND } from '../src/statusBar';
import { commands, resetConfig, setConfig, window } from './stubs/vscode';
import { LINUX_ONLY, makeTempHome, MemoryMemento, type TempHome } from './helpers';

let tmp: TempHome;
let subscriptions: Array<{ dispose(): unknown }> = [];
beforeEach(() => { tmp = makeTempHome('activate'); });
afterEach(() => {
  for (const s of subscriptions) s.dispose();
  subscriptions = [];
  resetConfig();
  setLocale('en');
  tmp.restore();
});

async function activateExtension(): Promise<void> {
  const ctx = { globalState: new MemoryMemento(), subscriptions, extensionUri: { path: '/ext' }, extension: { packageJSON: { version: '0.0.0' } } };
  await activate(ctx as unknown as vscode.ExtensionContext);
}

function writeIdentity(file: string, account: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: `${account}@example.com`, accountUuid: account, organizationUuid: 'org' } }));
}

class Child extends EventEmitter {
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean { return true; }
}
const usageWithoutReport = [{ type: 'result', subtype: 'success', is_error: false, local_command: 'usage' }];
const denied = [{ type: 'assistant', error: 'oauth_org_not_allowed' }, { type: 'result', subtype: 'success', is_error: true }];

/** Fake claude: /usage answers without limit data, the subscription probe with an access denial. */
function fakeClaude(ctx: TestContext): Array<{ dir: string | undefined; probe: boolean }> {
  const calls: Array<{ dir: string | undefined; probe: boolean }> = [];
  ctx.mock.method(childProcess, 'spawn', ((command: string, args: string[], options: childProcess.SpawnOptions) => {
    assert.equal(command, 'claude');
    const probe = args.includes('Reply with OK.');
    calls.push({ dir: options.env?.CLAUDE_CONFIG_DIR, probe });
    const child = new Child();
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify(probe ? denied : usageWithoutReport));
      child.exitCode = probe ? 1 : 0;
      child.emit('exit', child.exitCode, null);
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  return calls;
}

test('a manual refresh of a current account confirmed unavailable still queries it', LINUX_ONLY, async (ctx) => {
  ctx.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  writeIdentity(path.join(tmp.home, '.claude.json'), 'current');
  const calls = fakeClaude(ctx);
  await activateExtension();
  await commands.registered[CLAUDE_REFRESH_USAGE_COMMAND]();
  assert.deepEqual(calls.map((c) => c.probe), [false, true], 'missing limit data triggers the probe, which confirms the denial');
  ctx.mock.timers.setTime(1_700_000_000_000 + 61_000);
  await commands.registered[CLAUDE_REFRESH_USAGE_COMMAND]();
  assert.deepEqual(calls.map((c) => c.probe), [false, true, false], 'the manual refresh queries usage; no automatic probe follows the denial');
});

test('refresh-all joins its skipped-accounts sentence with the locale separator', LINUX_ONLY, async (ctx) => {
  setConfig('planswap', 'language', 'zh-cn');
  writeIdentity(path.join(tmp.home, '.claude.json'), 'current');
  writeIdentity(path.join(tmp.home, '.claude-work', '.claude.json'), 'work');
  fakeClaude(ctx);
  const messages: string[] = [];
  ctx.mock.method(window, 'showInformationMessage', async (message: string) => { messages.push(message); return undefined; });
  ctx.mock.method(window, 'showWarningMessage', async (message: string) => { messages.push(message); return undefined; });
  await activateExtension();
  // The current account is now in the manual cooldown, so refresh-all skips it
  await commands.registered[CLAUDE_REFRESH_USAGE_COMMAND]();
  messages.length = 0;
  await commands.registered[CLAUDE_REFRESH_ALL_USAGE_COMMAND]();
  const skipped = t('usage.allSkipped', { n: 1 });
  const summary = messages.find((m) => m.includes(skipped));
  assert.ok(summary, JSON.stringify(messages));
  assert.ok(!summary.includes(` ${skipped}`), summary);
});

test('a state folder that cannot be created only warns: activation still registers the commands', LINUX_ONLY, async (ctx) => {
  const errors: string[] = [];
  ctx.mock.method(window, 'showErrorMessage', async (message: string) => { errors.push(message); return undefined; });
  // A file where ~/.config/planswap should be
  fs.mkdirSync(path.join(tmp.home, '.config'), { recursive: true });
  fs.writeFileSync(path.join(tmp.home, '.config', 'planswap'), '');
  await activateExtension();
  assert.ok(commands.registered[CLAUDE_REFRESH_USAGE_COMMAND]);
  assert.ok(errors.length >= 1, 'the state file problem is reported');
});

test('an unwritable state folder without a state file only warns and names the file', { skip: (LINUX_ONLY.skip || process.getuid?.() === 0) && 'Linux, not root' }, async (ctx) => {
  const errors: string[] = [];
  ctx.mock.method(window, 'showErrorMessage', async (message: string) => { errors.push(message); return undefined; });
  const stateDir = path.join(tmp.home, '.config', 'planswap');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.chmodSync(stateDir, 0o500);
  try {
    await activateExtension();
  } finally { fs.chmodSync(stateDir, 0o700); }
  assert.ok(commands.registered[CLAUDE_REFRESH_USAGE_COMMAND]);
  assert.ok(errors.some((m) => m.includes(path.join(stateDir, 'state.json')) && m.includes('EACCES')), JSON.stringify(errors));
});
