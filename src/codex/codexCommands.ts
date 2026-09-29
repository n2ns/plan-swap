import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NAME_RE, samePath, sameRealPath } from '../paths';
import { shQuote } from '../commands';
import { type AccountsPanel, type PanelSource, tildify } from '../accountsPanel';
import { labelFor, sameName, type LabelStore, EXTERNAL_NAME } from '../labels';
import type { AccountView, FromWebview, RestartInfo } from '../protocol';
import {
  CODEX_DEFAULT_NAME,
  type CodexAccount,
  codexAccountDir,
  codexDefaultDir,
  codexLoggedIn,
  readCodexAccountInfo,
  deleteCodexDir,
  ensureCodexDir,
} from './codexPaths';
import { codexAccountBusy, copyCodexIndependent, ensureCodexLinks, isSharedCodexAccount, makeCodexIndependent, migrateCodexToShared } from './codexShare';
import { describeShareReport } from '../shareReport';
import {
  STATE_FILE,
  effectiveDir,
  disableWindows,
  enableWindows,
  installRcBlocks,
  isEnabled,
  preCheck,
  rcBlock,
  rcStatus,
  readSelectedDir,
  removeRcBlockFrom,
  removeRcBlocks,
  removeWindowsState,
  selfCheck,
  writeSelection,
} from './codexState';
import { isWindows } from '../platform';
import { askCopyFallback } from '../linkPolicy';
import { type ServerKind, canAutoRestart, detectServerKind, executeRestart, planRestart } from './codexServer';
import type { CodexAccountStore } from './codexStore';
import { runTool, type ToolDeps } from '../tools';
import { t } from '../i18n';

export interface CodexDeps { store: CodexAccountStore; panel: AccountsPanel; labels: LabelStore; tools: ToolDeps }

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Editor display names (not localized); a Record so that a new kind cannot be left out
const EDITOR_NAMES: Record<ServerKind, string> = {
  antigravity: 'Antigravity',
  vscodium: 'VSCodium',
  vscode: 'VS Code',
  unknown: '', // unused: the unknown kind never names an editor
};
const editorName = (kind: ServerKind): string => EDITOR_NAMES[kind];

/** Uses the editor connection context, not the kernel, so WSLg desktop windows get local guidance. */
export function manualRestartMessages(kind: ServerKind, remoteName: string | undefined, windows: boolean = isWindows()): { hint: string; required: string; switchConfirm: string } {
  if (remoteName === undefined && windows) {
    const hint = t('codex.manualRestartHintWin');
    return {
      hint,
      required: t('codex.manualRestartRequiredWin', { hint }),
      switchConfirm: t('codex.switchConfirmManualWin', { hint }),
    };
  }
  if (remoteName === undefined) {
    const hint = t('codex.manualRestartHintLocal');
    return {
      hint,
      required: t('codex.manualRestartRequiredLocal', { hint }),
      switchConfirm: t('codex.switchConfirmManualLocal', { hint }),
    };
  }
  if (remoteName !== 'wsl') {
    const hint = t('codex.manualRestartHintRemote');
    return {
      hint,
      required: t('codex.manualRestartRequiredRemote', { hint }),
      switchConfirm: t('codex.switchConfirmManualRemote', { hint }),
    };
  }
  const hint = kind === 'vscode' ? t('codex.manualRestartHintVscode')
    : kind === 'unknown' ? t('codex.manualRestartHintUnknown')
      : t('codex.manualRestartHint', { editor: editorName(kind) });
  return {
    hint,
    required: t('codex.manualRestartRequired', { hint }),
    switchConfirm: t('codex.switchConfirmManual', { hint }),
  };
}

/** Automatic restart is restricted to the existing supported WSL servers. kind: the caller's detectServerKind() result. */
export function restartInfo(kind: ServerKind = detectServerKind()): RestartInfo {
  const remoteName = vscode.env.remoteName;
  const context = remoteName === undefined ? 'local' : remoteName === 'wsl' ? 'wsl' : 'remote';
  return { context, auto: context === 'wsl' && canAutoRestart(kind) };
}

// Returns false when automatic restart is unsupported or validation failed and the manual alternative was shown
function restart(kind: ServerKind): boolean {
  const messages = manualRestartMessages(kind, vscode.env.remoteName);
  if (vscode.env.remoteName !== 'wsl' || !canAutoRestart(kind)) {
    void vscode.window.showWarningMessage(messages.required);
    return false;
  }
  let plan;
  try {
    plan = planRestart();
  } catch (err) {
    void vscode.window.showWarningMessage(t('codex.restartPlanFailed', { error: errText(err), hint: messages.hint }));
    return false;
  }
  try {
    executeRestart(plan);
  } catch (err) {
    void vscode.window.showWarningMessage(t('codex.restartFailed', { error: errText(err), hint: messages.hint }));
    return false;
  }
  return true;
}

/** Restart a supported WSL server with modal confirmation; otherwise show instructions: shared by the panel button, Command Palette and toolbar */
export async function restartServerInteractive(): Promise<void> {
  const kind = detectServerKind();
  const info = restartInfo(kind);
  if (!info.auto) {
    void vscode.window.showWarningMessage(manualRestartMessages(kind, vscode.env.remoteName).required);
    return;
  }
  const continueLabel = t('common.continue');
  const confirm = t('codex.restartConfirm', { editor: editorName(kind) });
  const ok = await vscode.window.showWarningMessage(confirm, { modal: true }, continueLabel);
  if (ok !== continueLabel) return;
  restart(kind);
}

/** Data source of the Codex panel tab */
export function codexPanelSource(store: CodexAccountStore, labels: LabelStore): PanelSource {
  const accounts = (): AccountView[] => {
    const cur = effectiveDir();
    const selected = readSelectedDir() ?? codexDefaultDir();
    const rows: AccountView[] = store.all().map((a) => ({
      kind: a.name === CODEX_DEFAULT_NAME ? 'default' : 'named',
      name: a.name,
      label: labelFor(a.name, labels),
      dir: a.dir,
      dirLabel: tildify(a.dir),
      ...readCodexAccountInfo(a.dir),
      isCurrent: samePath(a.dir, cur),
      isSelected: samePath(a.dir, selected),
      shared: a.name === CODEX_DEFAULT_NAME ? undefined : isSharedCodexAccount(a.dir),
    }));
    if (!rows.some((r) => r.isCurrent)) {
      rows.push({
        kind: 'external',
        name: EXTERNAL_NAME,
        label: labelFor(EXTERNAL_NAME, labels),
        dir: cur,
        dirLabel: tildify(cur),
        ...readCodexAccountInfo(cur),
        isCurrent: true,
        isSelected: samePath(cur, selected),
      });
    }
    return rows;
  };
  return {
    accounts,
    // Treat errors such as unreadable rc files as not enabled so panel rendering is not interrupted; a broken block
    // (start marker without end marker) counts as not enabled so the Enable button leads to preCheck's repair guidance
    enabled: () => {
      try {
        return isEnabled();
      } catch {
        return false;
      }
    },
    pendingDir: () => {
      const selected = readSelectedDir() ?? codexDefaultDir();
      if (samePath(selected, effectiveDir())) return undefined;
      const account = store.findByDir(selected);
      return account ? labelFor(account.name, labels) : selected;
    },
    // Same directories as accounts() (registered ones plus the external effective dir) without decoding any auth.json
    watchTargets: () => {
      const cur = effectiveDir();
      const dirs = store.all().map((a) => a.dir);
      if (!dirs.some((d) => samePath(d, cur))) dirs.push(cur);
      return [...dirs.map((d) => path.join(d, 'auth.json')), STATE_FILE()];
    },
    restart: () => restartInfo(),
  };
}

export function registerCodexCommands(deps: CodexDeps): vscode.Disposable[] {
  const { store, panel, labels, tools } = deps;
  const MODE = 'codex';
  // Terminals created by this extension -> their account
  const terminals = new Map<vscode.Terminal, CodexAccount>();

  // Display name: the alias if set, otherwise the name
  const labelOf = (a: CodexAccount): string => labelFor(a.name, labels);
  const isEffective = (a: CodexAccount): boolean => samePath(a.dir, effectiveDir());
  const isSelected = (a: CodexAccount): boolean => samePath(a.dir, readSelectedDir() ?? codexDefaultDir());
  // A switch is in progress (e.g. its modal is open); further requests such as a double click are ignored
  let switching = false;

  async function pickAccount(accounts: CodexAccount[], placeHolder: string): Promise<CodexAccount | undefined> {
    if (accounts.length === 0) {
      void vscode.window.showInformationMessage(t('common.noAccounts'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((account) => ({
        label: labelOf(account),
        description: codexLoggedIn(account.dir) ? t('common.loggedIn') : t('common.notLoggedIn'),
        detail: account.dir,
        account,
      })),
      { placeHolder },
    );
    return picked?.account;
  }

  async function enable(): Promise<void> {
    let check: ReturnType<typeof preCheck>;
    try {
      check = preCheck();
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.enableFailed', { error: errText(err) }));
      return;
    }
    if (!check.ok) {
      void vscode.window.showErrorMessage(t('codex.enableFailedReasons', { reasons: check.reasons.join('\n') }));
      return;
    }
    const writeLabel = t('codex.enableButton');
    if (isWindows()) {
      const okWin = await vscode.window.showWarningMessage(t('codex.win.enableConfirm'), { modal: true, detail: t('codex.win.enableDetail') }, writeLabel);
      if (okWin !== writeLabel) return;
      try {
        enableWindows();
        const result = selfCheck();
        if (!result.ok) {
          removeWindowsState();
          void vscode.window.showErrorMessage(t('codex.selfCheckFailed', { detail: result.detail }));
        }
      } catch (err) {
        void vscode.window.showErrorMessage(t('codex.writeRcFailed', { error: errText(err) }));
      }
      panel.refresh();
      return;
    }
    const ok = await vscode.window.showWarningMessage(t('codex.enableConfirm'), { modal: true, detail: rcBlock() }, writeLabel);
    if (ok !== writeLabel) return;
    // Snapshot before writing: rollback only removes blocks from files newly written this time, never the user's existing blocks
    let newlyWritten: string[];
    try {
      newlyWritten = rcStatus().filter((s) => !s.hasBlock).map((s) => s.file);
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.enableFailed', { error: errText(err) }));
      return;
    }
    const rollback = (): string[] => {
      const failed: string[] = [];
      for (const file of newlyWritten) {
        try {
          removeRcBlockFrom(file);
        } catch (e) {
          failed.push(errText(e));
        }
      }
      return failed;
    };
    try {
      installRcBlocks();
    } catch (err) {
      const failed = rollback();
      void vscode.window.showErrorMessage(
        t('codex.writeRcFailed', { error: errText(err) }) +
          (failed.length ? t('codex.rollbackFailedSuffix', { errors: failed.join('\n') }) : ''),
      );
      panel.refresh();
      return;
    }
    const result = selfCheck();
    if (!result.ok) {
      const failed = rollback();
      void vscode.window.showErrorMessage(
        failed.length
          ? t('codex.selfCheckFailedRollbackFailed', { detail: result.detail, errors: failed.join('\n') })
          : t('codex.selfCheckFailed', { detail: result.detail }),
      );
    }
    panel.refresh();
  }

  async function disable(): Promise<void> {
    const disableLabel = t('codex.disableButton');
    const ok = await vscode.window.showWarningMessage(t('codex.disableConfirm'), { modal: true }, disableLabel);
    if (ok !== disableLabel) return;
    try {
      if (isWindows()) {
        disableWindows();
      } else {
        removeRcBlocks();
        try {
          fs.unlinkSync(STATE_FILE());
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.disableFailed', { error: errText(err) }));
    }
    panel.refresh();
  }

  async function switchTo(account: CodexAccount): Promise<void> {
    if (switching) return;
    // Switching is only allowed once PlanSwap manages CODEX_HOME (an unreadable rc file counts as not enabled)
    let enabled = false;
    try {
      enabled = isEnabled();
    } catch {
      enabled = false;
    }
    if (!enabled) {
      void vscode.window.showWarningMessage(t('codex.notEnabled'));
      return;
    }
    switching = true;
    try {
      await doSwitch(account);
    } finally {
      switching = false;
    }
  }

  async function doSwitch(account: CodexAccount): Promise<void> {
    if (isEffective(account) && isSelected(account)) {
      void vscode.window.showInformationMessage(t('account.alreadyCurrent', { label: labelOf(account) }));
      return;
    }
    if (!fs.existsSync(account.dir)) {
      void vscode.window.showErrorMessage(t('account.dirMissing', { dir: account.dir }));
      return;
    }
    // Already effective in this window (e.g. another window selected a different account): only the state file
    // is brought back in line; no confirmation and no restart
    if (isEffective(account)) {
      try {
        writeSelection(account.name === CODEX_DEFAULT_NAME ? undefined : account.dir);
      } catch (err) {
        void vscode.window.showErrorMessage(t('codex.writeStateFailed', { error: errText(err) }));
        return;
      }
      panel.refresh();
      return;
    }
    const kind = detectServerKind();
    const info = restartInfo(kind);
    const auto = info.auto;
    const confirmText = !auto
      ? manualRestartMessages(kind, vscode.env.remoteName).switchConfirm
      : t('codex.switchConfirm', { editor: editorName(kind) });
    const continueLabel = t('common.continue');
    const ok = await vscode.window.showWarningMessage(confirmText, { modal: true }, continueLabel);
    if (ok !== continueLabel) return;
    // A shared account is re-linked first; a problem only warns, the switch still happens
    if (account.name !== CODEX_DEFAULT_NAME && isSharedCodexAccount(account.dir)) {
      try {
        const notes = describeShareReport(ensureCodexLinks(account.dir));
        if (notes) void vscode.window.showWarningMessage(t('share.refreshWarning', { label: labelOf(account), notes }));
      } catch (err) {
        void vscode.window.showWarningMessage(t('share.refreshWarning', { label: labelOf(account), notes: errText(err) }));
      }
    }
    try {
      writeSelection(account.name === CODEX_DEFAULT_NAME ? undefined : account.dir);
    } catch (err) {
      void vscode.window.showErrorMessage(t('codex.writeStateFailed', { error: errText(err) }));
      return;
    }
    panel.refresh();
    // Manual kinds already showed the instructions in the confirmation
    if (auto) restart(kind);
  }

  // Rename: only named rows (the default and external rows cannot be renamed); label equal to name clears the alias
  async function rename(dir: string, label: string): Promise<string | undefined> {
    const account = panel.resolve(MODE, dir);
    if (!account || account.kind !== 'named') return undefined;
    const existing = store.all().map((a) => ({ name: a.name, label: labelOf(a) }));
    const error = labels.validate(label, account.name, existing);
    if (error) return error;
    const value = label.trim();
    await labels.set(account.name, value === account.name ? undefined : value);
    panel.refresh();
    return undefined;
  }

  // shared: link everything but the login to the default account; otherwise copy its configuration once
  async function addAccount(name: string, shared: boolean): Promise<string | undefined> {
    const error = validateName(name, store, labels);
    if (error) return error;
    const account: CodexAccount = { name, dir: codexAccountDir(name) };
    try {
      ensureCodexDir(account.dir);
    } catch (err) {
      return t('account.createDirFailed', { error: errText(err) });
    }
    const linkOptions = shared ? await askCopyFallback(account.dir, 'Codex') : {};
    // Linking or copying failures only warn and do not block
    try {
      if (shared) {
        const notes = describeShareReport(ensureCodexLinks(account.dir, linkOptions));
        if (notes) void vscode.window.showWarningMessage(t('share.addNotes', { name, notes }));
      } else {
        const result = copyCodexIndependent(account.dir);
        // "Source missing" / "target exists" are normal and not reported; only blocked or unreadable files are
        const normal = [t('codex.seed.srcMissing'), t('codex.seed.dstExists')];
        const notable = result.skipped.filter((s) => !normal.includes(s.reason));
        if (notable.length) {
          void vscode.window.showInformationMessage(
            t('codex.seedSkipped', {
              name,
              list: notable.map((s) => t('codex.seedSkippedItem', { file: s.file, reason: s.reason })).join('\n'),
            }),
          );
        }
      }
    } catch (err) {
      void vscode.window.showWarningMessage(t(shared ? 'share.addLinkFailed' : 'share.addCopyFailed', { name, error: errText(err) }));
    }
    await store.add(account);
    panel.refresh();
    return undefined;
  }

  // Converts an independent account to a shared one after a modal confirmation
  async function shareAccount(account: CodexAccount): Promise<void> {
    if (account.name === CODEX_DEFAULT_NAME || isSharedCodexAccount(account.dir)) return;
    if (isEffective(account) || isSelected(account)) {
      void vscode.window.showWarningMessage(t('share.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('share.confirmButton');
    const picked = await vscode.window.showWarningMessage(t('share.confirmCodex', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    if (codexAccountBusy(account.dir)) {
      void vscode.window.showWarningMessage(t('share.busyCodex', { name: labelOf(account) }));
      return;
    }
    const linkOptions = await askCopyFallback(account.dir, 'Codex');
    try {
      const report = migrateCodexToShared(account.dir, account.name, '/proc', linkOptions);
      void vscode.window.showInformationMessage(t('share.done', { label: labelOf(account), summary: describeShareReport(report) || t('share.nothingElse') }));
    } catch (err) {
      void vscode.window.showErrorMessage(t('share.failed', { label: labelOf(account), error: errText(err) }));
    }
    panel.refresh();
  }

  // Converts a shared account back to an independent one after a modal confirmation; sessions stay in ~/.codex
  async function unshareAccount(account: CodexAccount): Promise<void> {
    if (account.name === CODEX_DEFAULT_NAME || !isSharedCodexAccount(account.dir)) return;
    if (isEffective(account) || isSelected(account)) {
      void vscode.window.showWarningMessage(t('unshare.current', { label: labelOf(account) }));
      return;
    }
    const ok = t('unshare.confirmButton');
    const picked = await vscode.window.showWarningMessage(t('unshare.confirmCodex', { label: labelOf(account), dir: account.dir }), { modal: true }, ok);
    if (picked !== ok) return;
    if (codexAccountBusy(account.dir)) {
      void vscode.window.showWarningMessage(t('share.busyCodex', { name: labelOf(account) }));
      return;
    }
    try {
      const r = makeCodexIndependent(account.dir, account.name);
      const done = t('unshare.done', { label: labelOf(account), removed: r.removed.length, copied: r.copied.join(', ') || t('unshare.nothingCopied') });
      const skipped = r.skipped.length ? t('unshare.skipped', { list: r.skipped.map((s) => `${s.file} (${s.reason})`).join(', ') }) : '';
      void vscode.window.showInformationMessage([done, skipped].filter(Boolean).join(' '));
    } catch (err) {
      void vscode.window.showErrorMessage(t('unshare.failed', { label: labelOf(account), error: errText(err) }));
    }
    panel.refresh();
  }

  // confirmed: the panel already did an inline confirmation; Command Palette entries need a modal confirmation
  async function removeAccount(account: CodexAccount, confirmed: boolean): Promise<void> {
    if (account.name === CODEX_DEFAULT_NAME || !store.find(account.name)) return;
    // Re-checked after every modal: another window may have selected the account meanwhile
    const inUse = (): boolean => {
      if (isEffective(account)) {
        void vscode.window.showWarningMessage(t('codex.removeEffective', { label: labelOf(account) }));
        return true;
      }
      if (isSelected(account)) {
        void vscode.window.showWarningMessage(t('codex.removeSelected', { label: labelOf(account) }));
        return true;
      }
      return false;
    };
    if (inUse()) return;
    if (!confirmed) {
      const deleteLabel = t('common.delete');
      const ok = await vscode.window.showWarningMessage(t('codex.removeConfirm', { label: labelOf(account) }), { modal: true }, deleteLabel);
      if (ok !== deleteLabel || inUse()) return;
    }

    // Capture the alias before labels.remove clears it
    const label = labelOf(account);
    const shared = isSharedCodexAccount(account.dir);
    await store.remove(account.name);
    await labels.remove(account.name);
    panel.refresh();

    const detail = t(shared ? 'share.removeDirDetail' : 'codex.removeDirDetail');
    const deleteDirLabel = t('common.deleteDir');
    const delDir = await vscode.window.showWarningMessage(
      t('account.removeDirPrompt', { label, dir: account.dir }),
      { modal: true, detail },
      deleteDirLabel,
    );
    if (delDir !== deleteDirLabel || inUse()) return;
    try {
      await deleteCodexDir(account.dir);
      await store.unignore(account.dir);
    } catch (err) {
      void vscode.window.showErrorMessage(t('account.deleteDirFailed', { error: errText(err) }));
    }
  }

  function openTerminal(account: CodexAccount, login: boolean): void {
    const isDefault = account.name === CODEX_DEFAULT_NAME;
    // Windows shells have no `env` command: the terminal environment carries the variable instead (null removes it)
    const terminal = vscode.window.createTerminal({
      name: `Codex (${labelOf(account)})`,
      env: isWindows() ? { CODEX_HOME: isDefault ? null : account.dir } : undefined,
    });
    terminals.set(terminal, account);
    const cmd = isWindows() ? 'codex' : isDefault ? 'env -u CODEX_HOME codex' : `env CODEX_HOME=${shQuote(account.dir)} codex`;
    terminal.sendText(login ? `${cmd} login` : cmd);
    terminal.show();
  }

  // Panel messages
  panel.setHandler(MODE, async (msg: FromWebview) => {
    switch (msg.type) {
      case 'enable':
        await enable();
        return;
      case 'restartServer':
        await restartServerInteractive();
        return;
      case 'switch': {
        const a = panel.resolve(MODE, msg.dir);
        if (a) await switchTo(a);
        return;
      }
      case 'terminal': {
        const a = panel.resolve(MODE, msg.dir);
        if (a) openTerminal(a, !codexLoggedIn(a.dir));
        return;
      }
      case 'remove': {
        const a = panel.resolve(MODE, msg.dir);
        if (a?.kind === 'named') await removeAccount(a, true);
        return;
      }
      case 'add':
        panel.post({ type: 'addResult', mode: MODE, error: await addAccount(msg.name.trim(), msg.shared !== false) });
        return;
      case 'share': {
        const a = panel.resolve(MODE, msg.dir);
        if (a?.kind === 'named') await shareAccount(a);
        return;
      }
      case 'unshare': {
        const a = panel.resolve(MODE, msg.dir);
        if (a?.kind === 'named') await unshareAccount(a);
        return;
      }
      case 'rename':
        panel.post({ type: 'renameResult', mode: MODE, dir: msg.dir, error: await rename(msg.dir, msg.label) });
        return;
      case 'reload':
      case 'dismissBanner':
        return;
      case 'tool':
        await runTool(MODE, msg.tool, tools);
        return;
    }
  });

  // Command Palette entries
  const allWithExternal = (): CodexAccount[] =>
    store.findByDir(effectiveDir()) ? store.all() : [...store.all(), { name: EXTERNAL_NAME, dir: effectiveDir() }];

  return [
    vscode.commands.registerCommand('planswap.codex.enable', enable),
    vscode.commands.registerCommand('planswap.codex.disable', disable),
    vscode.commands.registerCommand('planswap.codex.switchAccount', async () => {
      const a = await pickAccount(store.all().filter((x) => !(isEffective(x) && isSelected(x))), t('codex.pick.switch'));
      if (a) await switchTo(a);
    }),
    vscode.commands.registerCommand('planswap.codex.addAccount', () => panel.focusAdd(MODE)),
    vscode.commands.registerCommand('planswap.codex.removeAccount', async () => {
      const a = await pickAccount(store.named().filter((x) => !isEffective(x) && !isSelected(x)), t('codex.pick.remove'));
      if (a) await removeAccount(a, false);
    }),
    vscode.commands.registerCommand('planswap.codex.openTerminal', async () => {
      const a = await pickAccount(allWithExternal(), t('codex.pick.terminal'));
      if (a) openTerminal(a, !codexLoggedIn(a.dir));
    }),
    vscode.commands.registerCommand('planswap.codex.restartServer', () => restartServerInteractive()),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (!terminals.delete(terminal)) return;
      panel.refresh();
    }),
  ];
}

// Name check for a new Codex account; only Codex accounts are compared (the same name as on the Claude side is allowed)
export function validateName(name: string, store: CodexAccountStore, labels: LabelStore): string | undefined {
  if (!name) return t('name.empty');
  if (!NAME_RE.test(name)) return t('name.invalid');
  if (sameName(name, CODEX_DEFAULT_NAME)) return t('name.reserved', { name: CODEX_DEFAULT_NAME });
  if (store.all().some((a) => sameName(a.name, name))) return t('name.exists');
  if (store.all().some((a) => sameName(labelFor(a.name, labels), name))) return t('name.dupLabel');
  if (sameRealPath(codexAccountDir(name), codexDefaultDir())) return t('name.sameAsDefaultDir');
  return undefined;
}
