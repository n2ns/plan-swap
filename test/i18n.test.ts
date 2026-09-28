// Tests for the host i18n tables (src/i18n.ts), the webview tables (src/webview/i18n.ts) and package.nls*.json parity.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { en as hostEn, getLocale, setLocale, t, translationsOf, zhCn as hostZh, es as hostEs, ja as hostJa } from '../src/i18n';
import { en as webEn, zhCn as webZh, es as webEs, ja as webJa, setLocale as setWebLocale, t as webT } from '../src/webview/i18n';

const root = path.join(__dirname, '..');
const locales = ['zh-cn', 'es', 'ja'] as const;
const hostTables = { 'zh-cn': hostZh, es: hostEs, ja: hostJa };
const webTables = { 'zh-cn': webZh, es: webEs, ja: webJa };

/** Placeholder names (`{name}`) used in a message, sorted. */
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Asserts two translation tables have the same keys, non-empty values and the same placeholders per key. */
function assertParity(en: Record<string, string>, translated: Record<string, string>): void {
  const enKeys = Object.keys(en);
  const translatedKeys = Object.keys(translated);
  assert.ok(enKeys.length > 0, 'empty en table');
  assert.deepEqual(translatedKeys.filter((k) => !(k in en)), [], 'keys only in translation');
  assert.deepEqual(enKeys.filter((k) => !(k in translated)), [], 'keys only in en');
  for (const key of enKeys) {
    assert.ok(en[key].trim() !== '', `empty en value for ${key}`);
    assert.ok(translated[key].trim() !== '', `empty translated value for ${key}`);
    assert.deepEqual(placeholders(translated[key]), placeholders(en[key]), `placeholder mismatch for ${key}`);
  }
}

describe('host i18n: setLocale / getLocale', () => {
  after(() => setLocale('en'));
  test('default locale is en', () => {
    assert.equal(getLocale(), 'en');
    assert.equal(t('common.delete'), 'Delete');
  });
  test('setLocale switches the table used by t()', () => {
    setLocale('zh-cn');
    assert.equal(getLocale(), 'zh-cn');
    assert.equal(t('common.delete'), '删除');
    setLocale('en');
    assert.equal(getLocale(), 'en');
    assert.equal(t('common.delete'), 'Delete');
  });
});

describe('host i18n: t() interpolation', () => {
  test('fills {name} placeholders with string and number params', () => {
    assert.equal(t('account.alreadyCurrent', { label: 'work' }), 'work is already the current account.');
    assert.equal(t('label.tooLong', { max: 32 }), 'Display name can be at most 32 characters');
  });
  test('fills several placeholders in one message', () => {
    assert.equal(
      t('account.removeDirPrompt', { label: 'test1', dir: '/h/.claude-test1' }),
      'Account test1 was removed from the list. Also delete directory /h/.claude-test1?',
    );
  });
  test('without params the text is returned as-is, placeholders included', () => {
    assert.equal(t('account.alreadyCurrent'), '{label} is already the current account.');
  });
  test('placeholders missing from params are left intact; extra params are ignored', () => {
    assert.equal(t('account.removeDirPrompt', { label: 'a', other: 'x' }), 'Account a was removed from the list. Also delete directory {dir}?');
  });
  test('substituted values are not interpolated again', () => {
    assert.equal(t('account.removeDirPrompt', { label: '{dir}', dir: '/x' }), 'Account {dir} was removed from the list. Also delete directory /x?');
  });
});

describe('all supported translations', () => {
  after(() => { setLocale('en'); setWebLocale('en'); });
  for (const locale of locales) {
    test(`${locale}: host and webview keys, values and placeholders match English`, () => {
      assertParity(hostEn, hostTables[locale]);
      assertParity(webEn, webTables[locale]);
    });
    test(`${locale}: host and webview switch tables and interpolate names`, () => {
      setLocale(locale);
      setWebLocale(locale);
      assert.equal(getLocale(), locale);
      assert.equal(t('panel.loading'), hostTables[locale]['panel.loading']);
      assert.equal(webT('panel.loading'), webTables[locale]['panel.loading']);
      assert.equal(t('account.alreadyCurrent', { label: 'work' }), hostTables[locale]['account.alreadyCurrent'].replace('{label}', 'work'));
      assert.equal(webT('confirm.text', { name: 'work' }), webTables[locale]['confirm.text'].replace('{name}', 'work'));
    });
  }
  for (const locale of ['es', 'ja'] as const) {
    test(`${locale}: product names, commands and configuration identifiers stay unchanged`, () => {
      const terms = ['PlanSwap', 'Claude', 'Codex', 'ChatGPT', 'WSL', 'Linux', 'CLI', 'MCP', 'JSON', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'AGENTS.md', 'CLAUDE.md', 'config.toml', 'settings.json', 'hooks.json', '~/.profile', '~/.bashrc', 'wsl --shutdown', 'dbus-run-session'];
      for (const [source, translated] of [[hostEn, hostTables[locale]], [webEn, webTables[locale]]] as Array<[Record<string, string>, Record<string, string>]>) {
        for (const [key, value] of Object.entries(source)) {
          for (const term of terms) if (value.includes(term)) assert.ok(translated[key].includes(term), `${key}: preserve ${term}`);
        }
      }
    });
  }
  test('translationsOf includes every localized external-directory label', () => {
    assert.deepEqual(translationsOf('account.external'), [hostEn, hostZh, hostEs, hostJa].map((table) => table['account.external']));
  });
});

describe('package.nls parity', () => {
  const readJson = (f: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const nlsEn = readJson('package.nls.json');
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const used = [...new Set([...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]))];
  for (const locale of locales) {
    const file = `package.nls.${locale}.json`;
    test(`${file}: all keys and manifest references are translated`, () => {
      const table = readJson(file);
      assertParity(nlsEn, table);
      assert.ok(used.length > 0);
      assert.deepEqual(used.filter((key) => !(key in table)), []);
    });
  }
});
