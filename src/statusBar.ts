import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { claudeJsonPath, readAccountInfo, samePath } from './paths';
import { currentDir, isExplicitConfigDir } from './claudeSettings';
import type { AccountStore } from './accounts';
import { EXTERNAL_NAME, labelFor, type LabelStore } from './labels';
import { t } from './i18n';
import type { CodexAccountStore } from './codex/codexStore';
import { codexDefaultDir, readCodexAccountInfo } from './codex/codexPaths';
import { effectiveDir, readSelectedDir } from './codex/codexState';

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);

  constructor(
    private readonly store: AccountStore,
    private readonly labels: LabelStore,
    private readonly codex?: { store: CodexAccountStore; labels: LabelStore },
  ) {
    this.item.command = 'workbench.view.extension.planswap';
    this.update();
  }

  update(): void {
    const text: string[] = [];
    const details: string[] = [];
    const dir = currentDir();
    const explicit = isExplicitConfigDir(dir);
    const hasClaude = fs.existsSync(dir) || fs.existsSync(claudeJsonPath(dir, explicit)) ||
      this.store.named().some((account) => fs.existsSync(account.dir));
    if (hasClaude) {
      const account = this.store.findByDir(dir);
      const label = labelFor(account ? account.name : EXTERNAL_NAME, this.labels);
      const info = readAccountInfo(dir, explicit);
      const identity = info.email ?? t(info.loggedIn ? 'common.loggedIn' : 'common.notLoggedIn');
      text.push(`Claude: ${label}`);
      details.push(`Claude: ${label}\n${info.plan ? `${identity} · ${info.plan}` : identity}\n${dir}`);
    }
    const codexDir = effectiveDir();
    if (this.codex && (fs.existsSync(codexDir) || this.codex.store.all().some((account) => fs.existsSync(account.dir)))) {
      const account = this.codex.store.findByDir(codexDir);
      const label = labelFor(account ? account.name : EXTERNAL_NAME, this.codex.labels);
      const info = readCodexAccountInfo(codexDir);
      const identity = info.plan === 'API key' ? 'API key' :
        [info.email ?? t('common.notLoggedIn'), info.plan].filter(Boolean).join(' · ');
      text.push(`Codex: ${label}`);
      let detail = `Codex: ${label}\n${identity}\n${codexDir}`;
      const selected = readSelectedDir() ?? codexDefaultDir();
      if (!samePath(selected, codexDir)) {
        const pendingAccount = this.codex.store.findByDir(selected);
        const pending = pendingAccount ? labelFor(pendingAccount.name, this.codex.labels) : selected;
        detail += `\n${t('status.codexPending', { label: pending })}`;
      }
      details.push(detail);
    }
    this.item.text = text.length ? `$(account) ${text.join(' · ')}` : '';
    this.item.tooltip = details.join('\n\n');
    if (text.length) this.item.show();
    else this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
