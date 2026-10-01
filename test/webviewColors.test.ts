// Guard: the Webview sources may take colors only from --vscode-* theme variables and derivations of them
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const webviewDir = path.join(__dirname, '..', 'src', 'webview');

/** Removes block comments and line comments (a `//` right after a colon is a URL scheme and stays). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Hard-coded color literals in a source text: `#rrggbb` / `#rrggbbaa` and `rgb(` / `rgba(` / `hsl(` / `hsla(` calls.
 * The relative color syntax `rgb(from ...)` derives from a theme variable and is allowed. Three- and four-digit hex
 * forms are not scanned because they collide with ids such as `#add`.
 */
function findColorLiterals(source: string): string[] {
  const code = stripComments(source);
  const hex = code.match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g) ?? [];
  const calls = code.match(/\b(?:rgba?|hsla?)\((?!\s*from\b)[^)]*\)?/gi) ?? [];
  return [...hex, ...calls];
}

function webviewFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return webviewFiles(full);
    return /\.(css|ts)$/.test(entry.name) ? [full] : [];
  });
}

describe('webview color guard', () => {
  test('the scanner flags literals and accepts theme derivations', () => {
    assert.deepEqual(findColorLiterals('a { color: #12AB34; }'), ['#12AB34']);
    assert.deepEqual(findColorLiterals('a { color: #12ab3480; }'), ['#12ab3480']);
    assert.equal(findColorLiterals('a { color: rgb(1, 2, 3); }').length, 1);
    assert.equal(findColorLiterals('a { color: rgba(1, 2, 3, 0.5); }').length, 1);
    assert.equal(findColorLiterals('a { color: hsl(10 20% 30%); }').length, 1);
    assert.deepEqual(findColorLiterals('a { color: rgb(from var(--x) calc(r * 0.6) g b); }'), []);
    assert.deepEqual(findColorLiterals('a { color: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }'), []);
    assert.deepEqual(findColorLiterals('/* #112233 rgb(1,2,3) */ a { b: c; } // #445566\nconst id = "#add";'), []);
  });

  test('no file under src/webview contains a hard-coded color', () => {
    const files = webviewFiles(webviewDir);
    assert.ok(files.some((f) => f.endsWith('panel.css')) && files.some((f) => f.endsWith('main.ts')), 'webview sources not found');
    const found = files.flatMap((file) => findColorLiterals(fs.readFileSync(file, 'utf8')).map((literal) => `${path.relative(webviewDir, file)}: ${literal}`));
    assert.deepEqual(found, []);
  });
});
