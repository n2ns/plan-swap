// Tests for the host i18n tables (src/i18n.ts), the webview tables (src/webview/i18n.ts) and package.nls*.json parity.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  en as hostEn, formatMessage, getLocale, intlLocale, LOCALE_INFO, LOCALES, matchLocale, setLocale, t, translationsOf,
  zhCn as hostZh, es as hostEs, ja as hostJa, type Locale,
} from '../src/i18n';
import {
  en as webEn, zhCn as webZh, es as webEs, ja as webJa, formatMessage as webFormatMessage, getLocale as getWebLocale,
  matchLocale as webMatchLocale, setLocale as setWebLocale, t as webT, WEB_LOCALE_INFO,
} from '../src/webview/i18n';

const root = path.join(__dirname, '..');
const locales = LOCALES.filter((l) => l !== 'en');
const hostTables: Record<Locale, Record<string, string>> = { en: hostEn, 'zh-cn': hostZh, es: hostEs, ja: hostJa };
const webTables: Record<Locale, Record<string, string>> = { en: webEn, 'zh-cn': webZh, es: webEs, ja: webJa };

interface PluralBlock { source: string; name: string; branches: Record<string, string> }

/**
 * Parses the ICU plural blocks (`{name, plural, one {...} other {...}}`) in a message and returns them with the
 * remaining text (blocks removed). Throws when a block that starts with `{name, plural,` does not parse.
 */
function parsePlurals(text: string): { blocks: PluralBlock[]; rest: string } {
  const blocks: PluralBlock[] = [];
  let rest = '';
  let pos = 0;
  const start = /\{(\w+)\s*,\s*plural\s*,/g;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    rest += text.slice(pos, m.index);
    let i = m.index + m[0].length;
    const branches: Record<string, string> = {};
    for (;;) {
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] === '}') { i++; break; }
      const category = /^\w+/.exec(text.slice(i))?.[0];
      if (!category) throw new Error(`malformed plural block in: ${text}`);
      i += category.length;
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] !== '{') throw new Error(`plural category ${category} without a branch in: ${text}`);
      const body = /^\{((?:[^{}]|\{\w+\})*)\}/.exec(text.slice(i));
      if (!body) throw new Error(`unterminated plural branch ${category} in: ${text}`);
      if (category in branches) throw new Error(`duplicate plural category ${category} in: ${text}`);
      branches[category] = body[1];
      i += body[0].length;
    }
    blocks.push({ source: text.slice(m.index, i), name: m[1], branches });
    pos = i;
    start.lastIndex = i;
  }
  return { blocks, rest: rest + text.slice(pos) };
}

/**
 * Placeholder names used in a message, sorted and deduplicated. A plural block counts as its own name plus the
 * `{name}` placeholders inside its branches; `#` is not a placeholder.
 */
function placeholders(text: string): string[] {
  const simple = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const { blocks, rest } = parsePlurals(text);
  const names = [...simple(rest), ...blocks.flatMap((b) => [b.name, ...Object.values(b.branches).flatMap(simple)])];
  return [...new Set(names)].sort();
}

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
    assert.deepEqual(translationsOf('account.external'), LOCALES.map((l) => hostTables[l]['account.external']));
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

describe('locale metadata', () => {
  after(() => setWebLocale('en'));
  test('LOCALE_INFO has one entry per locale and English comes first', () => {
    assert.equal(LOCALES[0], 'en');
    assert.deepEqual(Object.keys(LOCALE_INFO).sort(), [...LOCALES].sort());
    for (const locale of LOCALES) assert.ok(Intl.PluralRules.supportedLocalesOf(LOCALE_INFO[locale].intl).length > 0, `${locale}: Intl supports ${LOCALE_INFO[locale].intl}`);
  });
  test('intlLocale follows the current locale or the given one', (ctx) => {
    ctx.after(() => setLocale('en'));
    for (const locale of LOCALES) {
      assert.equal(intlLocale(locale), LOCALE_INFO[locale].intl);
      setLocale(locale);
      assert.equal(intlLocale(), LOCALE_INFO[locale].intl);
    }
  });
  test('the webview metadata matches the host on every shared field', () => {
    assert.deepEqual(Object.keys(WEB_LOCALE_INFO).sort(), [...LOCALES].sort());
    for (const locale of LOCALES) {
      const { userGuide: _userGuide, ...shared } = LOCALE_INFO[locale];
      assert.deepEqual(WEB_LOCALE_INFO[locale], shared, locale);
    }
  });
  test('the webview has a table for every locale', () => {
    for (const locale of LOCALES) {
      setWebLocale(locale);
      assert.equal(getWebLocale(), locale);
      assert.equal(webT('panel.loading'), webTables[locale]['panel.loading']);
    }
    setWebLocale('xx' as Locale);
    assert.equal(getWebLocale(), 'en', 'an unknown locale falls back to en');
  });
  test('every locale has its user guide under docs/', () => {
    for (const locale of LOCALES) {
      const file = path.join(root, 'docs', LOCALE_INFO[locale].userGuide);
      assert.ok(fs.existsSync(file), `${locale}: ${file}`);
    }
  });
  test('the planswap.language setting lists auto plus every locale, each with a label', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['planswap.language'];
    assert.deepEqual(setting.enum, ['auto', ...LOCALES]);
    assert.equal(setting.enumDescriptions.length, setting.enum.length);
    const nlsEn = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
    for (const [i, value] of (setting.enum as string[]).entries()) {
      const key = /^%(config\.language\.[^%]+)%$/.exec(setting.enumDescriptions[i])?.[1];
      assert.ok(key && nlsEn[key], `${value}: config.language.* label`);
      if (value !== 'auto' && value !== 'en') assert.ok(fs.existsSync(path.join(root, `package.nls.${value}.json`)), `package.nls.${value}.json`);
    }
  });
});

describe('matchLocale', () => {
  const cases: Array<[string, Locale]> = [
    ['en', 'en'], ['EN-us', 'en'], ['zh-CN', 'zh-cn'], ['zh-cn', 'zh-cn'], ['zh-tw', 'zh-cn'], ['zh', 'zh-cn'],
    ['es', 'es'], ['es-419', 'es'], ['ja', 'ja'], ['ja-jp', 'ja'], ['JA-jp', 'ja'], ['ES', 'es'], ['pt-br', 'en'], ['fr', 'en'], ['', 'en'],
  ];
  for (const [side, match] of [['host', matchLocale], ['webview', webMatchLocale]] as const) {
    test(`${side}: editor language tags map to supported locales`, () => {
      for (const [language, expected] of cases) assert.equal(match(language), expected, language);
    });
    test(`${side}: every locale id selects itself`, () => {
      for (const locale of LOCALES) assert.equal(match(locale), locale);
    });
  }
});

describe('plural messages', () => {
  const tableSets = [['host', hostTables], ['webview', webTables]] as const;
  for (const locale of LOCALES) {
    const intl = LOCALE_INFO[locale].intl;
    const rules = new Intl.PluralRules(intl);
    const valid = new Set<string>(rules.resolvedOptions().pluralCategories);
    const needed = new Set(Array.from({ length: 201 }, (_, n) => rules.select(n)));
    test(`${locale}: every plural block parses, has other and covers the locale's categories`, () => {
      for (const [side, tables] of tableSets) {
        for (const [key, text] of Object.entries(tables[locale])) {
          const { blocks } = parsePlurals(text);
          for (const block of blocks) {
            const where = `${side} ${key}: ${block.source}`;
            assert.ok('other' in block.branches, `${where}: missing other`);
            for (const category of Object.keys(block.branches)) assert.ok(valid.has(category), `${where}: ${category} is not a ${intl} category`);
            for (const category of needed) assert.ok(category in block.branches || category === 'other', `${where}: missing ${category}`);
          }
        }
      }
    });
    test(`${locale}: t() renders plural messages through formatMessage`, (ctx) => {
      ctx.after(() => { setLocale('en'); setWebLocale('en'); });
      setLocale(locale);
      setWebLocale(locale);
      for (const [side, tables, translate, format] of [['host', hostTables, t, formatMessage], ['webview', webTables, webT, webFormatMessage]] as const) {
        for (const [key, text] of Object.entries(tables[locale])) {
          const { blocks } = parsePlurals(text);
          if (blocks.length === 0) continue;
          for (const n of [0, 1, 2, 5, 21]) {
            const params = Object.fromEntries(placeholders(text).map((name) => [name, blocks.some((b) => b.name === name) ? n : `<${name}>`]));
            const out = (translate as (k: string, p: Record<string, string | number>) => string)(key, params);
            assert.equal(out, format(text, params, intl), `${side} ${key} n=${n}`);
            assert.ok(!/,\s*plural\s*,/.test(out), `${side} ${key} n=${n}: ${out}`);
          }
        }
      }
    });
  }
  test('English and Spanish no longer use (s) for counts', () => {
    for (const tables of [hostTables, webTables]) {
      for (const locale of ['en', 'es'] as const) {
        for (const [key, text] of Object.entries(tables[locale])) assert.ok(!/\w\(s\)/.test(text), `${locale} ${key}: ${text}`);
      }
    }
  });
});

describe('formatMessage', () => {
  const en = '{n, plural, one {# account} other {# accounts}}';
  for (const [side, format] of [['host', formatMessage], ['webview', webFormatMessage]] as const) {
    test(`${side}: English picks one or other`, () => {
      assert.equal(format(en, { n: 1 }, 'en'), '1 account');
      assert.equal(format(en, { n: 0 }, 'en'), '0 accounts');
      assert.equal(format(en, { n: 2 }, 'en'), '2 accounts');
      assert.equal(format(en, { n: '1' }, 'en'), '1 account', 'numeric strings select by their number');
      assert.equal(format('{n,plural,one{# file}other{# files}}', { n: 1 }, 'en'), '1 file', 'whitespace between parts is optional');
      assert.equal(format('Checked {ok} of {n, plural, one {# account} other {# accounts}}.', { ok: 1, n: 3 }, 'en'), 'Checked 1 of 3 accounts.');
    });
    test(`${side}: a category without a branch falls back to other`, () => {
      const es = '{n, plural, one {# cuenta} other {# cuentas}}';
      assert.equal(format(es, { n: 1 }, 'es'), '1 cuenta');
      assert.equal(format(es, { n: 2 }, 'es'), '2 cuentas');
      assert.equal(format(es, { n: 1000000 }, 'es'), '1000000 cuentas', `es selects ${new Intl.PluralRules('es').select(1000000)} for 1000000`);
      assert.equal(format('{n, plural, other {# 个}}', { n: 1 }, 'zh-CN'), '1 个');
    });
    test(`${side}: a missing or non-numeric plural param leaves the block unchanged`, () => {
      assert.equal(format(en, { m: 1 }, 'en'), en);
      assert.equal(format(en, { n: 'many' }, 'en'), en);
      assert.equal(format(en, { n: Number.NaN }, 'en'), en);
      assert.equal(format(en, undefined, 'en'), en);
      assert.equal(format(`${en} in {dir}`, undefined, 'en'), `${en} in {dir}`, 'without params nothing is replaced');
    });
    test(`${side}: # is replaced only inside plural branches`, () => {
      assert.equal(format('# {n, plural, one {#: # item} other {#: # items}}', { n: 1 }, 'en'), '# 1: 1 item');
      assert.equal(format('# {n}', { n: 4 }, 'en'), '# 4');
    });
    test(`${side}: simple placeholders inside branches are filled`, () => {
      const text = '{count, plural, one {# linked {vendor} account} other {# linked {vendor} accounts}} in {dir}';
      assert.equal(format(text, { count: 1, vendor: 'Codex', dir: '/x' }, 'en'), '1 linked Codex account in /x');
      assert.equal(format(text, { count: 3, vendor: 'Claude' }, 'en'), '3 linked Claude accounts in {dir}');
    });
    test(`${side}: plain placeholders behave as before`, () => {
      assert.equal(format('{a} and {b}', { a: 'x', b: 2 }, 'en'), 'x and 2');
      assert.equal(format('{a} and {b}', { a: 'x' }, 'en'), 'x and {b}', 'unknown placeholders are left as-is');
      assert.equal(format('{a} and {b}', { a: '{b}', b: 'y' }, 'en'), '{b} and y', 'substituted values are not interpolated again');
      assert.equal(format('{n} 个', { n: 1 }, 'zh-CN'), '1 个');
    });
  }
});
