import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { AccountStore } from './accounts';
import { currentDir, settingEnvNames } from './claudeSettings';
import { codexRunsInWsl, restartInfo } from './codex/codexCommands';
import { codexDefaultDir } from './codex/codexPaths';
import { effectiveDir, isEnabled, preCheck, readSelectedDir, STATE_FILE } from './codex/codexState';
import type { CodexAccountStore } from './codex/codexStore';
import { buildDiagnosticsReport, type DiagnosticAccount, type DiagnosticSnapshot } from './diagnostics';
import { claudeCredentialOverrides } from './environmentWarnings';
import { t } from './i18n';
import { defaultDir, samePath } from './paths';
import { collectVersions } from './tools';

type Versions = Awaited<ReturnType<typeof collectVersions>>;

export interface DiagnosticsDeps {
  store: Pick<AccountStore, 'named'>;
  codexStore?: Pick<CodexAccountStore, 'named'>;
  extensionVersion: string;
  versions?: () => Promise<Versions>;
  check?: () => { ok: boolean };
  enabled?: () => boolean;
  restart?: () => { context: 'local' | 'wsl' | 'remote'; auto: boolean };
}

function accountFor(dir: string, base: string, named: Array<{ dir: string }>): DiagnosticAccount {
  if (samePath(dir, base)) return { kind: 'default' };
  const index = named.findIndex((account) => samePath(account.dir, dir));
  return index < 0 ? { kind: 'external' } : { kind: 'named', number: index + 1 };
}

export async function collectDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticSnapshot> {
  const versions = await (deps.versions ?? collectVersions)();
  const claudeNamed = deps.store.named();
  const codexNamed = deps.codexStore?.named() ?? [];
  const runsInWsl = codexRunsInWsl();
  let precheck: DiagnosticSnapshot['codex']['precheck'] = 'unavailable';
  if (!runsInWsl) {
    try { precheck = (deps.check ?? preCheck)().ok ? 'passed' : 'blocked'; } catch { /* no raw error in report */ }
  }
  const restart = (deps.restart ?? restartInfo)();
  const selected = readSelectedDir() ?? codexDefaultDir();
  const effective = effectiveDir();
  let enabled: boolean | undefined;
  try { enabled = (deps.enabled ?? isEnabled)(); } catch { /* report unknown without exposing the error */ }
  const restartMode: DiagnosticSnapshot['codex']['restart'] = restart.context === 'wsl'
    ? restart.auto ? 'automatic-wsl' : 'manual-wsl'
    : restart.context === 'remote' ? 'manual-remote'
      : process.platform === 'win32' ? 'manual-windows' : 'manual-local';
  return {
    extensionVersion: deps.extensionVersion,
    editorVersion: vscode.version,
    platform: process.platform,
    remoteName: vscode.env.remoteName,
    versions: {
      claudeCli: versions[0]?.value ?? '', claudeExtension: versions[1]?.value ?? '',
      codexCli: versions[2]?.value ?? '', codexExtension: versions[3]?.value ?? '',
    },
    claude: {
      configured: accountFor(currentDir(), defaultDir(), claudeNamed),
      count: claudeNamed.length,
      credentialOverrides: claudeCredentialOverrides(process.env, settingEnvNames()),
    },
    codex: {
      effective: accountFor(effective, codexDefaultDir(), codexNamed),
      selected: accountFor(selected, codexDefaultDir(), codexNamed),
      count: codexNamed.length,
      enabled,
      pending: (enabled === true || fs.existsSync(STATE_FILE())) && !samePath(effective, selected),
      runsInWsl,
      precheck,
      restart: restartMode,
    },
  };
}

export function registerDiagnosticsCommand(deps: DiagnosticsDeps): vscode.Disposable {
  return vscode.commands.registerCommand('planswap.tools.diagnostics', async () => {
    try {
      const report = buildDiagnosticsReport(await collectDiagnostics(deps));
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
      await vscode.window.showTextDocument(document);
      const copy = t('diagnostics.copy');
      if (await vscode.window.showInformationMessage(t('diagnostics.previewHint'), copy) === copy) {
        await vscode.env.clipboard.writeText(report);
        void vscode.window.showInformationMessage(t('diagnostics.copied'));
      }
    } catch {
      void vscode.window.showErrorMessage(t('diagnostics.failed'));
    }
  });
}
