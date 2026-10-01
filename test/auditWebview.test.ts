// Tests for webview i18n helpers added by the webview audit fixes (src/webview/i18n.ts)
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { en, es, ja, zhCn, zhTw, joinSentences, setLocale, t } from '../src/webview/i18n';

describe('webview i18n: joinSentences', () => {
  after(() => setLocale('en'));
  test('English and Spanish join sentences with a space', () => {
    for (const locale of ['en', 'es'] as const) {
      setLocale(locale);
      assert.equal(joinSentences('One.', 'Two.'), 'One. Two.');
    }
  });
  test('Chinese and Japanese join sentences without a space after the full-width stop', () => {
    setLocale('zh-cn');
    assert.equal(joinSentences('第一句。', '第二句。'), '第一句。第二句。');
    setLocale('ja');
    assert.equal(joinSentences('一文目。', '二文目。'), '一文目。二文目。');
  });
});

describe('webview i18n: rename button label', () => {
  after(() => setLocale('en'));
  test('every locale places the account name through the {name} placeholder', () => {
    for (const table of [en, zhCn, zhTw, es, ja]) assert.ok(table['row.renameAria'].includes('{name}'));
    setLocale('ja');
    assert.equal(t('row.renameAria', { name: 'work' }), 'work の名前を変更');
    setLocale('en');
    assert.equal(t('row.renameAria', { name: 'work' }), 'Rename work');
  });
});
