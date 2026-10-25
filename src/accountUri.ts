// URI request validation only; no runtime vscode import, account lookup or writes. The command handler supplies
// the receiving extension host's environment, resolves the registered name and uses the normal switch flow.
import type { Uri } from 'vscode';
import { t } from './i18n';
import { NAME_RE } from './paths';

export interface AccountUriContext {
  uriScheme: string;
  platform: NodeJS.Platform;
  remoteName: string | undefined;
  distro: string | undefined;
}

/**
 * Parses /switch?account=<name>[&reload=1][&target=wsl|windows][&distro=<name>]. Parameter names and values other
 * than account names are case-sensitive. Every parameter may occur once. WSL is the default target, and must be
 * a WSL remote window on a Linux host with WSL_DISTRO_NAME; distro, when supplied, must match it exactly. Native
 * Windows requires explicit target=windows and no remote connection. Throws a localized reason before any write.
 */
export function parseAccountUri(
  uri: Pick<Uri, 'scheme' | 'authority' | 'path' | 'query' | 'fragment'>,
  context: AccountUriContext,
): { account: string; reload: boolean } {
  if (uri.scheme !== context.uriScheme || uri.authority !== 'n2ns.planswap' || uri.path !== '/switch' || uri.fragment) {
    throw new Error(t('uri.invalid'));
  }
  // URLSearchParams silently tolerates malformed percent escapes and UTF-8; reject those before decoding values.
  try {
    decodeURIComponent(uri.query);
  } catch {
    throw new Error(t('uri.parameters'));
  }
  const params = new URLSearchParams(uri.query);
  const allowed = new Set(['account', 'reload', 'target', 'distro']);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!allowed.has(key) || seen.has(key)) throw new Error(t('uri.parameters'));
    seen.add(key);
  }
  const account = params.get('account');
  const reload = params.get('reload');
  const target = params.get('target') ?? 'wsl';
  const distro = params.get('distro');
  if (!account || !NAME_RE.test(account) || (reload !== null && reload !== '1')
    || (target !== 'wsl' && target !== 'windows') || (distro !== null && (!distro || target !== 'wsl'))) {
    throw new Error(t('uri.parameters'));
  }
  if (target === 'wsl') {
    if (context.platform !== 'linux' || context.remoteName !== 'wsl' || !context.distro) {
      throw new Error(t('uri.wslRequired'));
    }
    if (distro !== null && distro !== context.distro) throw new Error(t('uri.distroMismatch', { distro }));
  } else if (context.platform !== 'win32' || context.remoteName) {
    throw new Error(t('uri.windowsRequired'));
  }
  return { account, reload: reload === '1' };
}
