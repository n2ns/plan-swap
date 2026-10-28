// The panel account messages both tabs handle the same way (add, provider forms, link / unlink, rename, recommendation
// exclusion, reorder, remove, tool), dispatched once for the Claude and the Codex command modules; the vendor
// operations come in as AccountMessageOps. The tab-specific messages (switch, terminal, subscriptionCheck, enable,
// reload, dismissBanner) stay in the modules, which call handleAccountMessage for the rest.
import type { AccountsPanel } from './accountsPanel';
import type { ProviderConfigError, ProviderErrorCode } from './codex/codexProvider';
import { t } from './i18n';
import { errText } from './platform';
import type { ApiCardInput, FromWebview, PanelMode } from './protocol';
import type { RecommendExclusions } from './recommend';
import { runTool, type ToolDeps } from './tools';

export interface AccountRef { name: string; dir: string }
export type ResolvedAccount = ReturnType<AccountsPanel['resolve']>;

export interface AccountMessageOps<A extends AccountRef> {
  mode: PanelMode;
  panel: AccountsPanel;
  store: { setOrder(names: string[]): Promise<void> };
  exclusions?: RecommendExclusions;
  tools: ToolDeps;
  /** The directory a new account name maps to (for the create-failed message of an API card) */
  accountDir(name: string): string;
  /** Whether the directory is an API card (hasClaudeProviderMarker / preserveProviderConfig) */
  isCard(dir: string): boolean;
  /** The vendor's text of an API card error code */
  providerErrorText(code: ProviderErrorCode): string;
  /** The card's saved key (readClaudeProviderKey / readProviderKey); throws ProviderConfigError */
  readProviderKey(dir: string): string;
  isProviderConfigError(err: unknown): err is ProviderConfigError;
  addAccount(name: string, shared: boolean, provider?: ApiCardInput): Promise<string | undefined>;
  listProviderModels(msg: { service: string; baseUrl?: string; key: string; dir?: string }): Promise<{ models?: string[]; error?: string }>;
  saveProvider(account: A, msg: { model: string; baseUrl?: string; key: string; service?: string }): Promise<string | undefined>;
  shareAccount(account: A): Promise<void>;
  unshareAccount(account: A): Promise<void>;
  rename(dir: string, label: string): Promise<string | undefined>;
  removeAccount(account: A, confirmed: boolean): Promise<void>;
}

/**
 * Handles one of the shared account messages (add, providerModels, saveProvider, revealProviderKey, share, unshare,
 * rename, recommendExclude, reorder, remove, tool); any other message type is ignored, the modules handle those
 * themselves. Every account directory goes through panel.resolve first. The add, rename,
 * provider-model and provider-save messages always answer (also when the operation throws), so the page never keeps
 * waiting; a saved key reaches the page only through revealProviderKey's providerKeyResult. Named rows only for
 * remove, share, unshare and the card forms; the external row is never excluded or reordered.
 */
export async function handleAccountMessage<A extends AccountRef>(msg: FromWebview, ops: AccountMessageOps<A>): Promise<void> {
  const { mode, panel } = ops;
  const resolve = (dir: string): (A & { kind: NonNullable<ResolvedAccount>['kind'] }) | undefined => panel.resolve(mode, dir) as (A & { kind: NonNullable<ResolvedAccount>['kind'] }) | undefined;
  switch (msg.type) {
    case 'remove': {
      const a = resolve(msg.dir);
      if (a?.kind === 'named') await ops.removeAccount(a, true);
      return;
    }
    case 'add': {
      // Any failure still answers, so the panel never keeps waiting for the result
      let error: string | undefined;
      try {
        error = await ops.addAccount(msg.name.trim(), msg.shared !== false, msg.provider);
      } catch (err) {
        error = msg.provider ? t('codex.provider.createFailed', { dir: ops.accountDir(msg.name.trim()) }) : errText(err);
      }
      panel.post({ type: 'addResult', mode, error });
      return;
    }
    case 'providerModels': {
      const result = await ops.listProviderModels(msg);
      panel.post({ type: 'providerModelsResult', mode, request: msg.request, ...result });
      return;
    }
    case 'saveProvider': {
      const a = resolve(msg.dir);
      const error = a?.kind === 'named' && ops.isCard(a.dir) ? await ops.saveProvider(a, msg) : ops.providerErrorText('unmanaged');
      panel.post({ type: 'saveProviderResult', mode, dir: msg.dir, error });
      return;
    }
    case 'revealProviderKey': {
      // The eye button: the only path of a saved key to the page, on this explicit request only
      const a = resolve(msg.dir);
      let key: string | undefined;
      let error: string | undefined;
      if (a?.kind === 'named' && ops.isCard(a.dir)) {
        try { key = ops.readProviderKey(a.dir) || undefined; } catch (err) { error = ops.providerErrorText(ops.isProviderConfigError(err) ? err.code : 'file'); }
      } else error = ops.providerErrorText('unmanaged');
      panel.post({ type: 'providerKeyResult', mode, dir: msg.dir, key, error });
      return;
    }
    case 'share': {
      const a = resolve(msg.dir);
      if (a?.kind === 'named') await ops.shareAccount(a);
      return;
    }
    case 'unshare': {
      const a = resolve(msg.dir);
      if (a?.kind === 'named') await ops.unshareAccount(a);
      return;
    }
    case 'rename': {
      let error: string | undefined;
      try {
        error = await ops.rename(msg.dir, msg.label);
      } catch (err) {
        error = errText(err);
      }
      panel.post({ type: 'renameResult', mode, dir: msg.dir, error });
      return;
    }
    case 'recommendExclude': {
      const a = resolve(msg.dir);
      if (!a || a.kind === 'external' || ops.isCard(a.dir)) return;
      await ops.exclusions?.set(a.name, msg.excluded !== false);
      panel.refresh();
      return;
    }
    case 'reorder': {
      const names = msg.dirs.map((dir) => resolve(dir)).filter((a) => a && a.kind !== 'external').map((a) => a!.name);
      await ops.store.setOrder(names);
      panel.refresh();
      return;
    }
    case 'tool':
      await runTool(mode, msg.tool, ops.tools);
      return;
    default:
      return;
  }
}
