import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocale } from '../src/i18nVscode';
import { env, resetConfig, setConfig } from './stubs/vscode';

afterEach(() => { resetConfig(); env.language = 'en'; });

test('explicit language overrides the editor language', () => {
  env.language = 'zh-cn';
  for (const locale of ['en', 'zh-cn', 'es', 'ja'] as const) {
    setConfig('planswap', 'language', locale);
    assert.equal(resolveLocale(), locale);
  }
});

test('auto resolves supported languages and regional display-language variants', () => {
  setConfig('planswap', 'language', 'auto');
  for (const [language, expected] of [['es', 'es'], ['es-MX', 'es'], ['es-ES', 'es'], ['ja', 'ja'], ['ja-JP', 'ja'], ['zh-TW', 'zh-cn'], ['en-US', 'en'], ['fr', 'en']] as const) {
    env.language = language;
    assert.equal(resolveLocale(), expected, language);
  }
});

test('the default setting follows the editor language', () => {
  env.language = 'ja';
  assert.equal(resolveLocale(), 'ja');
});
