import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as path from 'node:path';
import { collectDiagnostics, registerDiagnosticsCommand, type DiagnosticsDeps } from '../src/diagnosticsCommand';
import { t } from '../src/i18n';
import { makeTempHome, withEnv } from './helpers';
import { commands, env, resetConfig, setConfig, window, workspace } from './stubs/vscode';

const versions = async () => [
  { label: 'Claude Code CLI', value: 'claude 2.0.0' },
  { label: 'Claude extension', value: '2.1.0' },
  { label: 'Codex CLI', value: 'codex 0.9.0' },
  { label: 'Codex extension', value: '1.0.0' },
];

test('diagnostics uses stable anonymous account numbers and reads no credentials', async (ctx) => {
  const tmp = makeTempHome('diagnostics');
  try {
    await withEnv({ CODEX_HOME: path.join(tmp.home, '.codex-second') }, async () => {
      const claude = path.join(tmp.home, '.claude-first');
      const first = path.join(tmp.home, '.codex-first');
      const second = path.join(tmp.home, '.codex-second');
      fs.mkdirSync(path.join(tmp.home, '.config', 'planswap'), { recursive: true });
      fs.writeFileSync(path.join(tmp.home, '.config', 'planswap', 'codex-home'), second);
      setConfig('claudeCode', 'environmentVariables', [{ name: 'CLAUDE_CONFIG_DIR', value: claude }]);
      const deps: DiagnosticsDeps = {
        store: { named: () => [{ name: 'private-claude', dir: claude }] },
        codexStore: { named: () => [{ name: 'private-first', dir: first }, { name: 'private-second', dir: second }] },
        extensionVersion: '0.2.0', versions,
        check: () => { throw new Error('private precheck failure'); },
        enabled: () => { throw new Error('private rc failure'); },
        restart: () => ({ context: 'local', auto: false }),
      };
      const realRead = fs.readFileSync;
      const reads: string[] = [];
      ctx.mock.method(fsDefault, 'readFileSync', ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        reads.push(String(file));
        return (realRead as (...args: unknown[]) => unknown)(file, ...args);
      }) as typeof fs.readFileSync);
      const snapshot = await collectDiagnostics(deps);
      assert.deepEqual(snapshot.claude.configured, { kind: 'named', number: 1 });
      assert.deepEqual(snapshot.codex.effective, { kind: 'named', number: 2 });
      assert.deepEqual(snapshot.codex.selected, { kind: 'named', number: 2 });
      assert.equal(snapshot.codex.pending, false);
      assert.equal(snapshot.codex.enabled, undefined);
      assert.equal(snapshot.codex.precheck, 'unavailable');
      assert.ok(reads.every((file) => !file.endsWith('auth.json') && !file.endsWith('.credentials.json') && !file.endsWith('.claude.json')));
      assert.ok(!JSON.stringify(snapshot).includes(tmp.home));
      assert.ok(!JSON.stringify(snapshot).includes('private-'));
    });
  } finally { resetConfig(); tmp.restore(); }
});

test('diagnostics previews before copying and cancellation leaves clipboard unchanged', async (ctx) => {
  const tmp = makeTempHome('diagnostics-preview');
  try {
    const events: string[] = [];
    ctx.mock.method(workspace, 'openTextDocument', async (options: { language: string; content: string }) => {
      events.push('open');
      assert.equal(options.language, 'markdown');
      return options;
    });
    ctx.mock.method(window, 'showTextDocument', async (document: { language: string; content: string }) => {
      events.push('preview');
      return document;
    });
    let choice: string | undefined;
    ctx.mock.method(window, 'showInformationMessage', async (...args: unknown[]) => {
      if (args[0] === t('diagnostics.previewHint')) { events.push('prompt'); return choice; }
      events.push('copied');
      return undefined;
    });
    ctx.mock.method(env.clipboard, 'writeText', async (_text: string) => { events.push('copy'); });
    const disposable = registerDiagnosticsCommand({
      store: { named: () => [] }, extensionVersion: '0.2.0', versions,
      check: () => ({ ok: false }), enabled: () => false,
      restart: () => ({ context: 'local', auto: false }),
    });
    try {
      await commands.registered['planswap.tools.diagnostics']();
      assert.deepEqual(events, ['open', 'preview', 'prompt']);
      events.length = 0;
      choice = t('diagnostics.copy');
      await commands.registered['planswap.tools.diagnostics']();
      assert.deepEqual(events, ['open', 'preview', 'prompt', 'copy', 'copied']);
    } finally { disposable.dispose(); }
  } finally { tmp.restore(); }
});
