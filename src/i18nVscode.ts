import * as vscode from 'vscode';
import { LOCALES, type Locale, matchLocale, setLocale } from './i18n';

const SECTION = 'planswap';
const KEY = 'language';

/** Resolves the UI locale from `planswap.language`; `auto` follows the editor display language. */
export function resolveLocale(): Locale {
  const setting = vscode.workspace.getConfiguration(SECTION).get<string>(KEY, 'auto');
  if ((LOCALES as readonly string[]).includes(setting)) return setting as Locale;
  return matchLocale(vscode.env.language);
}

// Before the rename to PlanSwap (0.1.0 - 0.1.3) the setting was `aiSwitcher.language`
const LEGACY_SECTION = 'aiSwitcher';
// globalState flag (client side, like the application-scope setting): the carry-over ran successfully
const LEGACY_DONE_KEY = 'legacy.languageMigrated';

/**
 * Carries a user-level `aiSwitcher.language` of `en` / `zh-cn` over to `planswap.language` once, when the new
 * setting has no user-level value. The old key is no longer contributed and cannot be written, so it stays in the
 * user's settings. Failures are only logged and retried on the next activation
 */
export async function migrateLegacyLanguage(state: vscode.Memento): Promise<void> {
  if (state.get<boolean>(LEGACY_DONE_KEY)) return;
  try {
    const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION).inspect<string>(KEY)?.globalValue;
    const config = vscode.workspace.getConfiguration(SECTION);
    if ((legacy === 'en' || legacy === 'zh-cn') && config.inspect<string>(KEY)?.globalValue === undefined) {
      await config.update(KEY, legacy, vscode.ConfigurationTarget.Global);
    }
    await state.update(LEGACY_DONE_KEY, true);
  } catch (err) {
    console.error('[planswap] Language setting migration failed:', err);
  }
}

/** Re-resolves the locale when the setting changes, applies it, then calls onChange. */
export function watchLocale(onChange: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(`${SECTION}.${KEY}`)) return;
    setLocale(resolveLocale());
    onChange();
  });
}
