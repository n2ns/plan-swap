// The agy (Antigravity CLI) tab: its panel source, panel messages, Command Palette commands and usage limits.
//
// The tab exists only while the agy CLI is found (findAgy, checked on activation and whenever the window regains
// focus). Rows are PlanSwap's saved copies of agy sign-ins (agyAccounts); the current row is the one agy is signed in to
// now. The live sign-in is read asynchronously (a Keychain or Credential Manager read starts a process) and cached:
// on activation, on focus, after every action and, on Linux / WSL, when agy's token file changes. Switching is the
// user's own action: no confirmation, no check of running agy sessions and no automatic switching; the message after
// a switch says that only agy sessions started afterwards use the new account.
//
// Usage limits come from the official CLI for the signed-in account only (agyUsage), and are kept for an account only
// when agy was signed in to that same account before and after the query; other rows show their own last observation.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AccountsPanel, PanelSource } from '../accountsPanel';
import type { StateMemento } from '../fileState';
import { t } from '../i18n';
import type { LabelStore } from '../labels';
import { errText, isWindows, tildify } from '../platform';
import type { AccountView, FromWebview, ToolId } from '../protocol';
import { accountTerminalShell, hasControlChars, shQuote } from '../terminalShell';
import { AgyAccounts, type AgyAccount, type LiveState } from './agyAccounts';
import { AgyError, agyTokenFile, liveStore, type AgyErrorCode, type LiveStore } from './agyLogin';
import { findAgy, readAgyUsage, type AgyUsage, type AgyUsageResult } from './agyUsage';

const MODE = 'agy';
const ORDER_KEY = 'agy.order';
const USAGE_KEY = 'agy.usage';
// The signed-in account's limits are queried again on focus once its last observation is this old
const USAGE_STALE_MS = 15 * 60_000;
// Footer tools that do not depend on the tab; the agy page has no other tools
const GENERIC_TOOLS: readonly ToolId[] = ['openHelp', 'openStar', 'reloadWindow', 'restartExtHost', 'cliVersions'];

export interface AgyDeps {
  panel: AccountsPanel;
  state: StateMemento;
  labels: LabelStore;
  // Runs a footer tool that does not depend on the tab
  runGenericTool: (tool: ToolId) => Promise<void>;
  // Tests inject these
  store?: LiveStore;
  accounts?: AgyAccounts;
  findCli?: () => string | undefined;
  readUsage?: (cli: string | undefined) => Promise<AgyUsageResult>;
  // How long a switch waits for a stopped usage query process to exit before it is refused (default 5 s)
  exitWaitMs?: number;
}

/** The localized text of an agy error code. */
export function agyErrorText(code: AgyErrorCode): string {
  return t(`agy.error.${code}`);
}

const errorMessage = (err: unknown): string => (err instanceof AgyError ? agyErrorText(err.code) : errText(err));

/** The local part of an email: the default label, so a hidden email (planswap.sidebar.showEmail) is not shown in full. */
function defaultLabel(email: string): string {
  return email.split('@')[0] || email;
}

/** Wires the agy tab; returns its disposables (commands, watcher, focus listener). */
export function registerAgy(deps: AgyDeps): vscode.Disposable[] {
  const { panel, state, labels } = deps;
  const store = deps.store ?? liveStore();
  const accounts = deps.accounts ?? new AgyAccounts(store);
  const findCli = deps.findCli ?? (() => findAgy());
  const readUsage = deps.readUsage ?? ((cli) => readAgyUsage(cli));
  let cli = findCli();
  let live: LiveState | undefined;
  let blocked: AgyErrorCode | undefined;
  let readError: string | undefined;
  let usageRun: Promise<void> | undefined;
  // A stopped usage query whose process was not confirmed gone; cleared once it is
  let queryExit: Promise<void> | undefined;

  const labelOf = (a: AgyAccount): string => labels.get(a.name) ?? defaultLabel(a.email);
  const usageCache = (): Record<string, AgyUsage> => state.get<Record<string, AgyUsage>>(USAGE_KEY) ?? {};

  // Saved accounts in the stored order (new ones last, by folder name)
  const ordered = (): AgyAccount[] => {
    const order = state.get<string[]>(ORDER_KEY) ?? [];
    const rank = (name: string): number => {
      const i = order.indexOf(name);
      return i < 0 ? order.length : i;
    };
    return accounts.list().sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  };

  // The account agy is signed in to; none while agy reads a store PlanSwap does not (the Linux keyring), since the file
  // PlanSwap reads may then hold another account
  const currentName = (): string | undefined => (blocked ? undefined : live?.current);

  const rows = (): AccountView[] => {
    const cache = usageCache();
    const current = currentName();
    return ordered().map((a) => {
      const isCurrent = current === a.name;
      const tier = a.login.doc.tier_display_name;
      return {
        kind: 'named',
        name: a.name,
        label: labelOf(a),
        dir: a.dir,
        dirLabel: tildify(a.dir),
        email: a.email,
        plan: typeof tier === 'string' && tier.trim() ? tier.trim() : undefined,
        loggedIn: true,
        usageEligible: isCurrent,
        isCurrent,
        usage: Object.hasOwn(cache, a.name) ? cache[a.name] : undefined,
      };
    });
  };

  const source: PanelSource = {
    accounts: rows,
    enabled: () => true,
    pendingDir: () => undefined,
    // agy's token file is watched by this module itself (syncLive), so a change also saves the new sign-in
    watchTargets: () => [],
    notice: () => {
      if (readError) return t('agy.notice.readFailed', { error: readError });
      if (blocked) return agyErrorText(blocked);
      if (live?.unrecognized) return t('agy.notice.unrecognized');
      return undefined;
    },
  };

  // Shows or hides the tab as the CLI comes and goes
  const syncCli = (): void => {
    cli = findCli();
    void vscode.commands.executeCommand('setContext', 'planswap.agyAvailable', cli !== undefined);
    panel.setAgySource(cli ? source : undefined);
  };

  // Reads (and saves) agy's sign-in; refreshes the panel when anything shown changed
  const syncLive = async (): Promise<void> => {
    if (!cli) return;
    const before = JSON.stringify([live, blocked, readError]);
    try {
      [live, blocked] = await Promise.all([accounts.sync(), store.blocked()]);
      readError = undefined;
    } catch (err) {
      readError = errorMessage(err);
    }
    if (JSON.stringify([live, blocked, readError]) !== before) panel.refresh();
  };

  // Usage of the signed-in account, kept only when agy was signed in to it before and after the query. An automatic
  // request joins a running query; a manual one, and the one after a switch (fresh), wait for it and run their own
  const refreshUsage = async (manual: boolean, fresh = false): Promise<void> => {
    if (usageRun && !manual && !fresh) return usageRun;
    while (usageRun) await usageRun;
    usageRun = runUsage(manual);
    return usageRun;
  };

  const runUsage = async (manual: boolean): Promise<void> => {
    try {
      // A stopped query that has not exited yet: no second agy beside it
      if (queryExit) {
        if (manual) void vscode.window.showWarningMessage(t('agy.usage.stuck'));
        return;
      }
      const keyring = await store.blocked();
      if (keyring) {
        blocked = keyring;
        if (manual) void vscode.window.showWarningMessage(agyErrorText(keyring));
        return;
      }
      const before = await accounts.sync();
      if (!before.current) {
        if (manual) void vscode.window.showWarningMessage(t('agy.usage.noAccount'));
        return;
      }
      const result = await readUsage(cli);
      if (!result.ok && result.reason === 'stuck') {
        const exited = result.exited;
        queryExit = exited;
        void exited.then(() => { if (queryExit === exited) queryExit = undefined; });
        if (manual) void vscode.window.showWarningMessage(t('agy.usage.stuck'));
        return;
      }
      const after = await accounts.sync();
      live = after;
      if (!result.ok) {
        if (manual) {
          void vscode.window.showWarningMessage(result.reason === 'failed'
            ? t('agy.usage.failed', { error: result.detail ?? '' }) : t(`agy.usage.${result.reason}`));
        }
        return;
      }
      if (after.current !== before.current) {
        if (manual) void vscode.window.showWarningMessage(t('agy.usage.changed'));
        return;
      }
      const name = before.current;
      await state.updateWith<Record<string, AgyUsage>>(USAGE_KEY, (cache) => ({ ...(cache ?? {}), [name]: result.usage }));
    } catch (err) {
      if (manual) void vscode.window.showWarningMessage(t('agy.usage.failed', { error: errorMessage(err) }));
    } finally {
      usageRun = undefined;
      panel.refresh();
    }
  };

  const refreshIfStale = (): void => {
    const current = currentName();
    if (!cli || !current) return;
    const last = usageCache()[current]?.checkedAt;
    if (last === undefined || Date.now() - last > USAGE_STALE_MS) void refreshUsage(false);
  };

  const switchTo = async (a: AgyAccount): Promise<void> => {
    try {
      // A running usage query's agy must not renew and write back the previous sign-in after the switch: wait for it,
      // and refuse while a stopped query's process is not confirmed gone
      while (usageRun) await usageRun;
      if (queryExit) {
        const pending = queryExit;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const gone = await Promise.race([pending.then(() => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), deps.exitWaitMs ?? 5_000); })]);
        clearTimeout(timer);
        if (!gone) throw new AgyError('queryRunning');
      }
      const result = await accounts.switchTo(a.name);
      if (result === 'switched') {
        void vscode.window.showInformationMessage(t('agy.switched', { label: labelOf(a) }));
        live = { current: a.name, signedIn: true, unrecognized: false };
        void refreshUsage(false, true);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(t('agy.switchFailed', { error: errorMessage(err) }));
    } finally {
      await syncLive();
      panel.refresh();
    }
  };

  const openTerminal = (a: AgyAccount | undefined): void => {
    if (!cli) return;
    // Windows finds agy only on PATH, so it runs by name there (whatever the shell); elsewhere the found file runs by
    // its quoted path, which also covers the installer's ~/.local/bin when that is not on PATH. A control character
    // (a newline) must never be typed into a terminal
    if (!isWindows() && hasControlChars(cli)) return;
    const terminal = vscode.window.createTerminal({ name: a ? `Antigravity (${labelOf(a)})` : 'Antigravity', shellPath: accountTerminalShell() });
    terminal.sendText(isWindows() ? 'agy' : shQuote(cli));
    terminal.show();
  };

  const signIn = (): void => {
    openTerminal(undefined);
    void vscode.window.showInformationMessage(t('agy.signInTip'));
  };

  const remove = async (a: AgyAccount): Promise<void> => {
    try {
      await accounts.remove(a.name);
      await labels.remove(a.name);
      await state.updateWith<Record<string, AgyUsage>>(USAGE_KEY, (cache) => {
        const next = { ...(cache ?? {}) };
        delete next[a.name];
        return next;
      });
      await state.updateWith<string[]>(ORDER_KEY, (order) => (order ?? []).filter((n) => n !== a.name));
    } catch (err) {
      void vscode.window.showErrorMessage(t('agy.removeFailed', { error: errorMessage(err) }));
    } finally {
      panel.refresh();
    }
  };

  const rename = async (a: AgyAccount, label: string): Promise<string | undefined> => {
    const others = ordered().map((x) => ({ name: x.name, label: labelOf(x) }));
    const error = labels.validate(label, a.name, others);
    if (error) return error;
    const value = label.trim();
    // Typing the default label back clears the alias
    await labels.set(a.name, value === defaultLabel(a.email) ? undefined : value);
    panel.refresh();
    return undefined;
  };

  const find = (dir: string): AgyAccount | undefined => {
    const row = panel.resolve(MODE, dir);
    return row && accounts.find(row.name);
  };

  panel.setHandler(MODE, async (msg: FromWebview) => {
    switch (msg.type) {
      case 'switch': {
        const a = find(msg.dir);
        if (a && currentName() !== a.name) await switchTo(a);
        return;
      }
      case 'terminal': {
        // Only the signed-in account runs as itself: agy has one global sign-in
        const a = find(msg.dir);
        if (a && currentName() === a.name) openTerminal(a);
        return;
      }
      case 'remove': {
        const a = find(msg.dir);
        if (a) await remove(a);
        return;
      }
      case 'rename': {
        const a = find(msg.dir);
        if (!a) return;
        let error: string | undefined;
        try {
          error = await rename(a, msg.label);
        } catch (err) {
          error = errText(err);
        }
        panel.post({ type: 'renameResult', mode: MODE, dir: msg.dir, error });
        return;
      }
      case 'reorder': {
        const names = msg.dirs.map((d) => panel.resolve(MODE, d)?.name).filter((n): n is string => !!n);
        await state.updateWith<string[]>(ORDER_KEY, () => names);
        panel.refresh();
        return;
      }
      case 'tool':
        if (msg.tool === 'agySignIn') signIn();
        else if (msg.tool === 'refreshUsage' || msg.tool === 'refreshAllUsage') await refreshUsage(true);
        else if (GENERIC_TOOLS.includes(msg.tool)) await deps.runGenericTool(msg.tool);
        return;
      default:
        return;
    }
  });

  syncCli();
  void syncLive().then(refreshIfStale);

  const disposables: vscode.Disposable[] = [
    vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused) return;
      syncCli();
      void syncLive().then(refreshIfStale);
    }),
    vscode.commands.registerCommand('planswap.agy.switchAccount', async () => {
      if (!cli) return;
      await syncLive();
      const items = ordered().filter((a) => a.name !== currentName()).map((a) => ({ label: labelOf(a), description: a.email, account: a }));
      if (!items.length) {
        void vscode.window.showInformationMessage(t('agy.noOtherAccount'));
        return;
      }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: t('agy.switchPlaceholder') });
      if (picked) await switchTo(picked.account);
    }),
    vscode.commands.registerCommand('planswap.agy.refreshUsage', () => (cli ? refreshUsage(true) : undefined)),
    vscode.commands.registerCommand('planswap.agy.signIn', () => (cli ? signIn() : undefined)),
  ];
  // Linux / WSL: agy's sign-in is a file; a sign-in, sign-out or token renewal there is saved and shown at once
  if (store.kind === 'file') {
    const file = agyTokenFile();
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
    const changed = (): void => void syncLive();
    disposables.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed));
  }
  return disposables;
}
