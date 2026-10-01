// Consistency checks between the documentation and the code: manifest contributions, relative links and anchors,
// the AGENTS.md document routing and the UI test locale list.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCALES } from '../src/i18n';

const root = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when `id` occurs in `text` as a whole identifier (not as a prefix of a longer dotted id). */
const mentions = (text: string, id: string): boolean => new RegExp(`(?<![\\w.])${escapeRe(id)}(?![\\w.])`).test(text);

interface Manifest {
  contributes: {
    commands: { command: string }[];
    configuration: { properties: Record<string, unknown> } | { properties: Record<string, unknown> }[];
  };
}
const manifest = JSON.parse(read('package.json')) as Manifest;

/** Markdown files whose relative links are checked (CHANGELOG.md is history and is left out). */
function markdownFiles(): string[] {
  const files = ['README.md', 'AGENTS.md', 'TODO.md'];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) files.push(rel);
    }
  };
  walk('docs');
  return files;
}

/** Splits Markdown into lines with fenced code blocks blanked out, so neither links nor headings are read from them. */
function proseLines(text: string): string[] {
  let fence: string | null = null;
  return text.split(/\r?\n/).map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return '';
    }
    if (m) { fence = m[1]; return ''; }
    return line;
  });
}

/** Removes inline code spans (any backtick run length) from a line. */
const stripInlineCode = (line: string): string => line.replace(/(`+)[\s\S]*?\1/g, '');

/** GitHub heading slug: lowercase, punctuation other than - and _ removed, each space becomes -. */
function slug(heading: string): string {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images keep their text
    .replace(/<[^>]+>/g, '') // inline HTML
    .replace(/(\*+|_+)(\S(?:[\s\S]*?\S)?)\1/g, '$2') // emphasis markers
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

const anchorCache = new Map<string, Set<string>>();
/** Anchors GitHub generates for a Markdown file: heading slugs (duplicates get -1, -2, ...) plus explicit HTML ids. */
function anchorsOf(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of proseLines(fs.readFileSync(file, 'utf8'))) {
    const h = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/** Relative link targets in a Markdown file (inline links, images and reference definitions), with line numbers. */
function linksOf(rel: string): { target: string; line: number }[] {
  const links: { target: string; line: number }[] = [];
  proseLines(read(rel)).forEach((raw, i) => {
    const line = stripInlineCode(raw);
    const targets: string[] = [];
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1]);
    const def = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
    if (def) targets.push(def[1]);
    for (let target of targets) {
      target = target.replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http(s), mailto and other schemes
      links.push({ target, line: i + 1 });
    }
  });
  return links;
}

describe('docs/features.md covers the manifest contributions', () => {
  const features = read('docs/features.md');

  test('every contributed command id is mentioned', () => {
    const missing = manifest.contributes.commands.map((c) => c.command).filter((id) => !mentions(features, id));
    assert.deepEqual(missing, []);
  });

  test('every planswap.* setting is mentioned', () => {
    const configs = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
    const settings = configs.flatMap((c) => Object.keys(c.properties)).filter((k) => k.startsWith('planswap.'));
    assert.ok(settings.length > 0);
    assert.deepEqual(settings.filter((id) => !mentions(features, id)), []);
  });
});

describe('Markdown links', () => {
  test('slug follows the GitHub rules', () => {
    assert.equal(slug('9a. Native Windows'), '9a-native-windows');
    assert.equal(slug('2. Background facts (verified)'), '2-background-facts-verified');
    assert.equal(slug('Use `t()` & keys_here'), 'use-t--keys_here');
    assert.equal(slug('切换账号 Switch'), '切换账号-switch');
    assert.equal(slug('[Link](x.md) **bold**'), 'link-bold');
  });

  test('every relative link resolves to a file and every anchor to a heading', () => {
    const broken: string[] = [];
    for (const rel of markdownFiles()) {
      const file = path.join(root, rel);
      for (const { target, line } of linksOf(rel)) {
        const hash = target.indexOf('#');
        const filePart = hash < 0 ? target : target.slice(0, hash);
        const anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
        const dest = filePart ? path.resolve(path.dirname(file), decodeURIComponent(filePart.split('?')[0])) : file;
        if (!fs.existsSync(dest)) { broken.push(`${rel}:${line} ${target} (missing file)`); continue; }
        if (anchor && dest.endsWith('.md') && !anchorsOf(dest).has(anchor.toLowerCase())) broken.push(`${rel}:${line} ${target} (missing anchor)`);
      }
    }
    assert.deepEqual(broken, []);
  });
});

test('AGENTS.md links every docs/*.md file except translated user guides', () => {
  const map = read('AGENTS.md');
  const missing = fs.readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.md') && !/^user-guide\.[a-z-]+\.md$/.test(f))
    .filter((f) => !map.includes(`](docs/${f}`));
  assert.deepEqual(missing, []);
});

test('the UI test locale list equals LOCALES', () => {
  const m = /const locales = (\[[^\]]*\])/.exec(read('scripts/run-ui-tests.mjs'));
  assert.ok(m, 'const locales = [...] not found in scripts/run-ui-tests.mjs');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), [...LOCALES]);
});
