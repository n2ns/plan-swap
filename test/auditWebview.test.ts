// The Webview boundary (headers of src/webview/main.ts and src/accountsPanel.ts): source-level checks of the frontend
// and of the HTML the host serves, plus the webview i18n helpers (src/webview/i18n.ts)
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { en, es, ja, ko, zhCn, zhTw, joinSentences, setLocale, t } from '../src/webview/i18n';
import { TOOL_IDS } from '../src/protocol';

const root = path.resolve(__dirname, '..');
const source = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('webview boundary', () => {
  test('the frontend renders text only through textContent: no HTML sinks, no code evaluation, no Node or vscode imports', () => {
    const main = source('src/webview/main.ts');
    // Code only: the header comment names innerHTML as what is never used
    const code = main.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, /\.(innerHTML|outerHTML)\b|\.insertAdjacentHTML\(|document\.write\(|\beval\(|new Function\(|srcdoc/);
    assert.doesNotMatch(main, /from ['"](node:|vscode)/);
    assert.doesNotMatch(main, /require\(/);
  });
  test('the page CSP allows nothing by default, scripts only with the nonce, no remote sources, and the media folder is the only resource root', () => {
    const panel = source('src/accountsPanel.ts');
    const csp = panel.slice(panel.indexOf('const csp = ['), panel.indexOf("].join('; ')"));
    assert.match(csp, /"default-src 'none'"/);
    assert.match(csp, /`script-src 'nonce-\$\{nonce\}'`/);
    assert.doesNotMatch(csp, /'unsafe-eval'|https?:|\*/);
    // Only styles may be inline (the Lit fallback); scripts never are
    assert.doesNotMatch(csp.replace(/`style-src[^`]*`/, ''), /'unsafe-inline'/);
    assert.match(panel, /localResourceRoots: \[media\]/);
    assert.match(panel, /joinPath\(this\.extensionUri, 'dist', 'media'\)/);
  });
  test('a saved API key reaches the page only in providerKeyResult and leaves it only in add, providerModels and saveProvider', () => {
    const protocol = source('src/protocol.ts');
    const toWebview = protocol.slice(protocol.indexOf('export type ToWebview'), protocol.indexOf('export type FromWebview'));
    const keyMessages = [...toWebview.matchAll(/\{ type: '(\w+)'[^}]*\bkey\??: string/g)].map((m) => m[1]);
    assert.deepEqual(keyMessages, ['providerKeyResult']);
    const fromWebview = protocol.slice(protocol.indexOf('export type FromWebview'));
    const sent = [...fromWebview.matchAll(/\{ type: '(\w+)'[^}]*\bkey: string/g)].map((m) => m[1]);
    assert.deepEqual(sent.sort(), ['providerModels', 'saveProvider']);
    assert.match(fromWebview, /type: 'add'[^}]*provider\?: ApiCardInput/);
  });
  test('every tool id the page can send is listed for the host check', () => {
    const toolIds = [...source('src/webview/main.ts').matchAll(/type: 'tool'[^}]*tool: '(\w+)'/g)].map((m) => m[1]);
    assert.ok(toolIds.length > 0);
    for (const id of toolIds) assert.ok((TOOL_IDS as readonly string[]).includes(id), id);
  });
});

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
    for (const table of [en, zhCn, zhTw, es, ja, ko]) assert.ok(table['row.renameAria'].includes('{name}'));
    setLocale('ja');
    assert.equal(t('row.renameAria', { name: 'work' }), 'work の名前を変更');
    setLocale('en');
    assert.equal(t('row.renameAria', { name: 'work' }), 'Rename work');
  });
});
