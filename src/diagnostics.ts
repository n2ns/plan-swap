// A report assembled from explicit, non-secret fields. Never interpolate raw account or error text. No runtime vscode
// import: the snapshot is collected by diagnosticsCommand.ts.
import { CLAUDE_OVERRIDE_VARS } from './environmentWarnings';
import { t, type MessageKey } from './i18n';

// An account reference without names or paths: its kind and, for a named account, its position in the store
export type DiagnosticAccount = { kind: 'default' | 'named' | 'external'; number?: number };

export interface DiagnosticSnapshot {
  extensionVersion: string;
  editorVersion: string;
  platform: string;
  remoteName?: string;
  versions: { claudeCli: string; codexCli: string; claudeExtension: string; codexExtension: string };
  claude: { configured: DiagnosticAccount; count: number; credentialOverrides: string[] };
  codex: {
    effective: DiagnosticAccount;
    selected: DiagnosticAccount;
    count: number;
    enabled?: boolean;
    pending: boolean;
    runsInWsl: boolean;
    precheck: 'passed' | 'blocked' | 'unavailable';
    restart: 'automatic-wsl' | 'manual-wsl' | 'manual-local' | 'manual-remote' | 'manual-windows';
  };
}

// Accept complete versions and known CLI prefixes only. Unknown output is never copied into the report.
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const VERSION = new RegExp(`^v?(${SEMVER})$`);
const CLI_VERSION = new RegExp(`^(?:claude(?: code)?|codex(?:-cli)?)\\s+v?(${SEMVER})(?:\\s+\\([^\\r\\n]*\\))?$`, 'i');
const CLAUDE_VERSION = new RegExp(`^v?(${SEMVER})\\s+\\(Claude Code\\)$`);

function version(value: string, cli = false): string {
  if (typeof value !== 'string') return t('diagnostics.unknown');
  const match = value.trim().match(VERSION) ?? (cli ? value.trim().match(CLI_VERSION) ?? value.trim().match(CLAUDE_VERSION) : null);
  return match ? match[1] : t('diagnostics.unknown');
}

function account(value: DiagnosticAccount): string {
  if (value?.kind === 'default') return t('diagnostics.default');
  if (value?.kind === 'external') return t('diagnostics.external');
  if (value?.kind === 'named' && Number.isSafeInteger(value.number) && value.number! > 0) {
    return t('diagnostics.named', { number: value.number! });
  }
  return t('diagnostics.unknown');
}

function count(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : t('diagnostics.unknown');
}

function platform(value: string): string {
  return value === 'linux' ? t('diagnostics.platformLinux')
    : value === 'win32' ? t('diagnostics.platformWindows') : t('diagnostics.unknown');
}

function remote(value?: string): string {
  const key: MessageKey = value === undefined || value === '' ? 'diagnostics.remoteLocal'
    : value === 'wsl' ? 'diagnostics.remoteWsl'
      : value === 'ssh-remote' ? 'diagnostics.remoteSsh'
        : value === 'dev-container' ? 'diagnostics.remoteContainer'
          : value === 'codespaces' ? 'diagnostics.remoteCodespaces' : 'diagnostics.remoteOther';
  return t(key);
}

function state(value: boolean | undefined): string {
  return value === true ? t('diagnostics.yes') : value === false ? t('diagnostics.no') : t('diagnostics.unknown');
}

function enumLabel(value: string, keys: Record<string, MessageKey>): string {
  return t(Object.hasOwn(keys, value) ? keys[value] : 'diagnostics.unknown');
}

/**
 * Creates a localized Markdown preview; it does not copy, upload or read any credentials. Only whitelisted values
 * reach the text: versions matching a known pattern (anything else becomes "unknown"), platform / connection enums,
 * anonymous account references, counts, known credential-override variable names and the Codex selection,
 * pre-check and restart states. When Codex runs inside WSL (Windows) the local Codex account and switching lines are
 * omitted.
 */
export function buildDiagnosticsReport(snapshot: DiagnosticSnapshot): string {
  const overrides: string[] = CLAUDE_OVERRIDE_VARS.filter((name) => snapshot.claude.credentialOverrides.includes(name));
  if (snapshot.claude.credentialOverrides.includes('ANTHROPIC_FEDERATION_RULE_ID')) overrides.push('ANTHROPIC_FEDERATION_RULE_ID');
  const precheck = enumLabel(snapshot.codex.precheck, {
    passed: 'diagnostics.precheckPassed', blocked: 'diagnostics.precheckBlocked', unavailable: 'diagnostics.precheckUnavailable',
  });
  const restart = enumLabel(snapshot.codex.restart, {
    'automatic-wsl': 'diagnostics.restartAutomaticWsl', 'manual-wsl': 'diagnostics.restartManualWsl',
    'manual-local': 'diagnostics.restartManualLocal', 'manual-remote': 'diagnostics.restartManualRemote',
    'manual-windows': 'diagnostics.restartManualWindows',
  });
  const next = snapshot.codex.runsInWsl ? t('diagnostics.nextRunsInWsl')
    : snapshot.codex.pending ? enumLabel(snapshot.codex.restart, {
      'automatic-wsl': 'diagnostics.nextAutomaticWsl', 'manual-wsl': 'diagnostics.nextManualWsl',
      'manual-local': 'diagnostics.nextManualLocal', 'manual-remote': 'diagnostics.nextManualRemote',
      'manual-windows': 'diagnostics.nextManualWindows',
    }) : t('diagnostics.nextNone');
  const row = (label: MessageKey, value: string): string => `- **${t(label)}:** ${value}`;
  return [
    `# ${t('diagnostics.title')}`,
    '',
    t('diagnostics.previewHint'),
    '',
    `## ${t('diagnostics.environment')}`,
    row('diagnostics.planSwapVersion', version(snapshot.extensionVersion)),
    row('diagnostics.editorVersion', version(snapshot.editorVersion)),
    row('diagnostics.platform', platform(snapshot.platform)),
    row('diagnostics.remote', remote(snapshot.remoteName)),
    '',
    `## ${t('diagnostics.versions')}`,
    row('diagnostics.claudeCli', version(snapshot.versions.claudeCli, true)),
    row('diagnostics.codexCli', version(snapshot.versions.codexCli, true)),
    row('diagnostics.claudeExtension', version(snapshot.versions.claudeExtension)),
    row('diagnostics.codexExtension', version(snapshot.versions.codexExtension)),
    '',
    '## Claude',
    row('diagnostics.configured', account(snapshot.claude.configured)),
    row('diagnostics.count', count(snapshot.claude.count)),
    row('diagnostics.overrides', overrides.length ? overrides.join(', ') : t('diagnostics.none')),
    t('diagnostics.claudeSelectionNote'),
    '',
    '## Codex',
    ...(snapshot.codex.runsInWsl ? [row('diagnostics.runsInWsl', state(true))] : [
      row('diagnostics.effective', account(snapshot.codex.effective)),
      row('diagnostics.selected', account(snapshot.codex.selected)),
      row('diagnostics.count', count(snapshot.codex.count)),
      row('diagnostics.enabled', state(snapshot.codex.enabled)),
      row('diagnostics.pending', state(snapshot.codex.pending)),
      row('diagnostics.runsInWsl', state(false)),
      row('diagnostics.precheck', precheck),
      row('diagnostics.restart', restart),
    ]),
    row('diagnostics.next', next),
    '',
  ].join('\n');
}
