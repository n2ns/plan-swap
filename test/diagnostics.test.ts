import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticsReport, type DiagnosticSnapshot } from '../src/diagnostics';
import { setLocale } from '../src/i18n';

const snapshot = (): DiagnosticSnapshot => ({
  extensionVersion: '0.2.0', editorVersion: '1.107.0', platform: 'linux', remoteName: 'wsl',
  versions: { claudeCli: '2.1.285 (Claude Code)', codexCli: 'codex-cli 0.139.0', claudeExtension: '2.1.0', codexExtension: '0.6.0' },
  claude: { configured: { kind: 'named', number: 2 }, count: 3, credentialOverrides: ['ANTHROPIC_AUTH_TOKEN'] },
  codex: {
    effective: { kind: 'default' }, selected: { kind: 'named', number: 1 }, count: 2, enabled: true,
    pending: true, runsInWsl: false, precheck: 'passed', restart: 'manual-wsl',
  },
});

after(() => setLocale('en'));

test('report shows normalized versions, anonymous selections and the pending restart step', () => {
  setLocale('en');
  const report = buildDiagnosticsReport(snapshot());
  assert.match(report, /^# PlanSwap diagnostics\n/);
  assert.match(report, /Claude CLI:\*\* 2\.1\.285/);
  assert.match(report, /Codex CLI:\*\* 0\.139\.0/);
  assert.match(report, /Configured account:\*\* Account #2/);
  assert.match(report, /Effective account:\*\* Default/);
  assert.match(report, /Selected account:\*\* Account #1/);
  assert.match(report, /Restart the WSL editor server to apply the selection/);
  assert.match(report, /does not verify the official session identity/);
  assert.match(report, /does not upload it automatically/);
});

test('public report contract discards raw identifiers, paths, errors and unsupported values', () => {
  setLocale('en');
  const data = snapshot();
  const secret = 'person@example.test';
  data.extensionVersion = `0.2.0 ${secret}`;
  data.editorVersion = `/home/${secret}/1.107.0`;
  data.platform = `linux ${secret}`;
  data.remoteName = `ssh-remote:${secret}`;
  data.versions.claudeCli = `Failed: ${secret}`;
  data.versions.codexCli = `codex-cli 0.139.0 (${secret})`;
  data.versions.claudeExtension = `v2.1.0 ${secret}`;
  data.claude.configured = { kind: 'named', number: 0 };
  data.claude.credentialOverrides = ['ANTHROPIC_AUTH_TOKEN', `ANTHROPIC_AUTH_TOKEN=${secret}`, 'HOME', 'ANTHROPIC_FEDERATION_RULE_ID'];
  const report = buildDiagnosticsReport(data);
  assert.doesNotMatch(report, /person@example\.test|\/home\/|HOME|Failed:/);
  assert.match(report, /Unknown/);
  assert.match(report, /ANTHROPIC_AUTH_TOKEN, ANTHROPIC_FEDERATION_RULE_ID/);
  assert.doesNotMatch(report, /0\.2\.0/);
});

test('Windows Codex running in WSL shows guidance without presenting local account state as WSL state', () => {
  setLocale('en');
  const data = snapshot();
  data.platform = 'win32';
  data.codex.runsInWsl = true;
  data.codex.pending = true;
  data.codex.restart = 'manual-windows';
  const codex = buildDiagnosticsReport(data).split('## Codex\n')[1];
  assert.match(codex, /Codex runs in WSL from Windows:\*\* Yes/);
  assert.match(codex, /Manage Codex accounts from a WSL window/);
  for (const label of ['Effective account', 'Selected account', 'Registered accounts', 'Switching enabled',
    'Selection pending', 'Switching precheck', 'Restart method']) {
    assert.ok(!codex.includes(label), label);
  }
});

test('report remains readable in all four supported locales', () => {
  const headings = { en: 'PlanSwap diagnostics', 'zh-cn': 'PlanSwap 诊断报告', es: 'Diagnóstico de PlanSwap', ja: 'PlanSwap 診断レポート' } as const;
  for (const [locale, heading] of Object.entries(headings)) {
    setLocale(locale as keyof typeof headings);
    const report = buildDiagnosticsReport(snapshot());
    assert.ok(report.startsWith(`# ${heading}\n`), locale);
    assert.match(report, /2\.1\.285/);
    assert.doesNotMatch(report, /\{\w+\}/);
    assert.ok(report.split('\n').length > 20);
  }
});
