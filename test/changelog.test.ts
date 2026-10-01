// A released version's CHANGELOG section stays as it was released; new entries go under [Unreleased] (or the next, untagged version)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');

function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

// The text of `## [version]` up to the next `## ` heading, or undefined when there is no such section
function section(changelog: string, version: string): string | undefined {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trimEnd();
}

// Every section already in the newest version tag's CHANGELOG is frozen (earlier tags predate a deliberate rewrite of
// the 0.1.x sections). Without git or tags (a shallow CI checkout) there is nothing to compare.
const latestTag = (git('tag', '--list', 'v*', '--sort=-v:refname') ?? '').split('\n').map((s) => s.trim()).find((s) => /^v\d+\.\d+\.\d+$/.test(s));

describe('CHANGELOG', () => {
  test('released sections are unchanged since the newest version tag', { skip: latestTag === undefined && 'no version tags' }, () => {
    const tagged = git('show', `${latestTag}:CHANGELOG.md`);
    assert.ok(tagged !== undefined, `CHANGELOG.md in ${latestTag}`);
    const current = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const versions = [...tagged.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
    assert.ok(versions.length > 0, `released sections in ${latestTag}`);
    for (const version of versions) {
      assert.equal(section(current, version), section(tagged, version), `CHANGELOG [${version}] differs from ${latestTag}; add new entries under [Unreleased]`);
    }
  });
});
