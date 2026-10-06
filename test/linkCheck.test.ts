import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale } from '../src/i18n';
import { ensureClaudeLinks, mirrorClaudeJson, type ShareReport } from '../src/claudeShare';
import { ensureCodexLinks } from '../src/codex/codexShare';
import { accountDir } from '../src/paths';
import { codexAccountDir } from '../src/codex/codexPaths';
import { accountProblems, announcementKeys, isFixable, LinkCheckNotices, REANNOUNCE_MS, type AccountCheck } from '../src/linkCheck';
import { assertTempHome, LINUX_ONLY, makeTempHome, MemoryMemento, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;

before(() => {
  tmp = makeTempHome('linkcheck');
  home = tmp.home;
  setLocale('en');
});
after(() => tmp.restore());

beforeEach(() => {
  assertTempHome(home);
  for (const e of fs.readdirSync(home)) fs.rmSync(path.join(home, e), { recursive: true, force: true });
});

const write = (f: string, content: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

// Every entry below dir with its kind, mode, size, mtime, link target or content (links never followed); a read-only
// check must leave all of it unchanged
function fullSnapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    const st = fs.lstatSync(d);
    out.push(`${rel}|${st.mode.toString(8)}|${st.mtimeMs}`);
    if (!st.isDirectory()) return;
    for (const child of fs.readdirSync(d).sort()) {
      const p = path.join(d, child);
      const r = path.join(rel, child);
      const cs = fs.lstatSync(p);
      if (cs.isSymbolicLink()) out.push(`${r}|link|${fs.readlinkSync(p)}|${cs.mtimeMs}`);
      else if (cs.isDirectory()) walk(p, r);
      else out.push(`${r}|file|${cs.mode.toString(8)}|${cs.size}|${cs.mtimeMs}|${fs.readFileSync(p, 'latin1')}`);
    }
  };
  walk(dir, '.');
  return out;
}

// Fake /proc: <root>/<pid>/environ (Claude) and an optional exe link (Codex)
function fakeProc(procs: Record<number, { exe?: string; env: Record<string, string> }> = {}): string {
  const root = path.join(home, 'fakeproc');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  for (const [pid, { exe, env }] of Object.entries(procs)) {
    write(path.join(root, pid, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    if (exe) fs.symlinkSync(exe, path.join(root, pid, 'exe'));
  }
  return root;
}

const fixableOf = (report: ShareReport, mirror?: string[]): string[] =>
  accountProblems({ dir: '', label: '', report, mirror }).filter((p) => isFixable(p.kind)).map((p) => p.kind);

interface Scenario { name: string; breakIt: (acc: string, def: string) => void; busy?: boolean; expect: string[] }

// The check writes nothing, reports exactly what the repair then reports, and after the repair nothing fixable is left
function assertCheckMatchesRepair(scenario: Scenario, run: (check: boolean, proc: string) => ShareReport, acc: string, def: string, busyEnv: Record<string, string>, exe?: string): void {
  scenario.breakIt(acc, def);
  const proc = fakeProc(scenario.busy ? { 4242: { exe, env: busyEnv } } : {});
  if (scenario.busy) write(path.join(acc, 'sessions', '4242.json'), JSON.stringify({ pid: 4242 }));
  const before = fullSnapshot(home);
  const checked = run(true, proc);
  assert.deepEqual(fullSnapshot(home), before, `${scenario.name}: the check wrote something`);
  assert.deepEqual(accountProblems({ dir: acc, label: 'a', report: checked }).map((p) => p.kind), scenario.expect, scenario.name);
  const repaired = run(false, proc);
  assert.deepEqual(checked, repaired, `${scenario.name}: the check differs from the repair`);
  if (!scenario.busy) assert.deepEqual(fixableOf(run(true, proc)), [], `${scenario.name}: still fixable after the repair`);
}

describe('Claude read-only link check', LINUX_ONLY, () => {
  const setup = (): { acc: string; def: string } => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'settings.json'), '{"model":"x"}\n');
    write(path.join(def, 'history.jsonl'), 'a\n');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), 's');
    write(path.join(def, 'plugins', 'p', 'x'), 'p');
    write(path.join(def, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    const acc = accountDir('a');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureClaudeLinks(acc, fakeProc());
    return { acc, def };
  };
  const scenarios: Scenario[] = [
    { name: 'healthy', breakIt: () => undefined, expect: [] },
    { name: 'deleted link', breakIt: (acc) => fs.unlinkSync(path.join(acc, 'rules')), expect: ['missing'] },
    { name: 'link elsewhere', breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'agents')); fs.symlinkSync(path.join(home, 'elsewhere'), path.join(acc, 'agents')); }, expect: ['elsewhere'] },
    { name: 'own folder', breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'commands')); fs.mkdirSync(path.join(acc, 'commands')); }, expect: ['conflict'] },
    { name: 'history replaced by a file', breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'history.jsonl')); write(path.join(acc, 'history.jsonl'), 'b\n'); }, expect: ['replaced'] },
    { name: 'history replaced while busy', busy: true, breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'history.jsonl')); write(path.join(acc, 'history.jsonl'), 'b\n'); }, expect: ['busy'] },
    { name: 'default entry deleted', breakIt: (_acc, def) => fs.rmSync(path.join(def, 'todos'), { recursive: true }), expect: ['defaultMissing'] },
    { name: 'whole-folder skills link', breakIt: (acc, def) => { fs.rmSync(path.join(acc, 'skills'), { recursive: true }); fs.symlinkSync(path.join(def, 'skills'), path.join(acc, 'skills')); }, expect: ['missing', 'stale'] },
    { name: 'dangling child link', breakIt: (_acc, def) => fs.rmSync(path.join(def, 'plugins', 'p'), { recursive: true }), expect: ['stale'] },
    { name: 'default settings gained a sign-in key', breakIt: (_acc, def) => write(path.join(def, 'settings.json'), '{"apiKeyHelper":"x"}\n'), expect: ['stale'] },
    { name: 'default folder deleted', breakIt: (_acc, def) => { for (const e of fs.readdirSync(def)) if (e !== '.claude.json') fs.rmSync(path.join(def, e), { recursive: true }); }, expect: ['defaultMissing', 'stale'] },
  ];
  for (const scenario of scenarios) {
    test(scenario.name, () => {
      const { acc, def } = setup();
      assertCheckMatchesRepair(scenario, (check, proc) => ensureClaudeLinks(acc, proc, { check }), acc, def, { CLAUDE_CONFIG_DIR: acc });
    });
  }

  test('a refused settings.json missing in the account: the stripped copy is reported as missing', () => {
    const { acc, def } = setup();
    write(path.join(def, 'settings.json'), '{"apiKeyHelper":"x","model":"m"}\n');
    ensureClaudeLinks(acc, fakeProc());
    fs.unlinkSync(path.join(acc, 'settings.json'));
    assertCheckMatchesRepair({ name: 'stripped', breakIt: () => undefined, expect: ['missing'] }, (check, proc) => ensureClaudeLinks(acc, proc, { check }), acc, def, {});
    // A refusal the account already follows is a known state, not a problem
    assert.deepEqual(accountProblems({ dir: acc, label: 'a', report: ensureClaudeLinks(acc, fakeProc(), { check: true }) }), []);
  });

  test('the .claude.json mirror check lists what the mirror changes and writes nothing', () => {
    const { acc, def } = setup();
    const from = path.join(def, '.claude.json');
    mirrorClaudeJson(from, acc);
    assert.deepEqual(mirrorClaudeJson(from, acc, undefined, true).changed, []);
    write(from, JSON.stringify({ mcpServers: { b: { command: 'b' } }, projects: { '/p': { hasTrustDialogAccepted: true } } }));
    const before = fullSnapshot(home);
    const checked = mirrorClaudeJson(from, acc, undefined, true).changed;
    assert.deepEqual(fullSnapshot(home), before);
    assert.deepEqual(checked, ['mcpServers', 'projects:/p']);
    assert.deepEqual(fixableOf({ linked: [], created: [], conflicts: [], refused: [] }, checked), ['mirror']);
    assert.deepEqual(mirrorClaudeJson(from, acc).changed, checked);
    assert.deepEqual(mirrorClaudeJson(from, acc, undefined, true).changed, []);
  });

  test('the mirror check ignores changes to what Claude Code reads anyway (research fact 18)', () => {
    const { acc, def } = setup();
    const from = path.join(def, '.claude.json');
    mirrorClaudeJson(from, acc);
    // The default account opened a new project: an entry of default values only, as Claude Code writes it
    const fresh = { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false, lastCost: 1 };
    write(from, JSON.stringify({ mcpServers: { a: { command: 'a' } }, projects: { '/new': fresh } }));
    assert.deepEqual(mirrorClaudeJson(from, acc, undefined, true).changed, []);
    // The repair still writes the entry; the account reads the same values before and after
    assert.deepEqual(mirrorClaudeJson(from, acc).changed, ['projects:/new']);

    // Trusting the project in the default account is a real difference, also against an account entry lacking the key
    const accJson = path.join(acc, '.claude.json');
    const data = JSON.parse(fs.readFileSync(accJson, 'utf8'));
    delete data.projects['/new'].hasTrustDialogAccepted;
    write(accJson, JSON.stringify(data));
    write(from, JSON.stringify({ mcpServers: { a: { command: 'a' } }, projects: { '/new': { ...fresh, hasTrustDialogAccepted: true } } }));
    assert.deepEqual(mirrorClaudeJson(from, acc, undefined, true).changed, ['projects:/new']);
  });

  test('the mirror check ignores what the account has beyond the default', () => {
    const { acc, def } = setup();
    const from = path.join(def, '.claude.json');
    const accJson = path.join(acc, '.claude.json');
    write(from, JSON.stringify({ mcpServers: { a: { command: 'a' } }, projects: { '/p': { hasTrustDialogAccepted: false, enabledMcpjsonServers: ['x'] } } }));
    // A project only the account trusts, an MCP server only it has, an extra enabled server
    write(accJson, JSON.stringify({ mcpServers: { a: { command: 'a' }, mine: { command: 'm' } }, projects: { '/p': { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['x', 'y'] } } }));
    assert.deepEqual(mirrorClaudeJson(from, acc, undefined, true).changed, []);
    // A server the default changed, or one the account lacks, is a difference
    write(from, JSON.stringify({ mcpServers: { a: { command: 'a2' } } }));
    assert.deepEqual(mirrorClaudeJson(from, acc, undefined, true).changed, ['mcpServers']);
    write(from, JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    assert.deepEqual(mirrorClaudeJson(from, acc, undefined, true).changed, ['mcpServers']);
  });

  test('a check of an account with a missing default directory creates nothing', () => {
    const { acc, def } = setup();
    fs.rmSync(def, { recursive: true });
    const proc = fakeProc();
    const before = fullSnapshot(home);
    ensureClaudeLinks(acc, proc, { check: true });
    assert.deepEqual(fullSnapshot(home), before);
    assert.equal(fs.existsSync(def), false);
  });
});

describe('Codex read-only link check', LINUX_ONLY, () => {
  const CODEX_EXE = '/opt/codex/codex';
  const setup = (): { acc: string; def: string } => {
    const def = path.join(home, '.codex');
    write(path.join(def, 'config.toml'), 'model = "x"\n');
    write(path.join(def, 'history.jsonl'), 'a\n');
    write(path.join(def, 'session_index.jsonl'), 'a\n');
    write(path.join(def, 'skills', 'one', 'SKILL.md'), 's');
    write(path.join(def, 'plugins', 'cache', 'p', 'x'), 'p');
    const acc = codexAccountDir('a');
    fs.mkdirSync(acc, { mode: 0o700 });
    ensureCodexLinks(acc, {}, fakeProc());
    return { acc, def };
  };
  const scenarios: Scenario[] = [
    { name: 'healthy', breakIt: () => undefined, expect: [] },
    { name: 'deleted link', breakIt: (acc) => fs.unlinkSync(path.join(acc, 'rules')), expect: ['missing'] },
    { name: 'link elsewhere', breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'agents')); fs.symlinkSync(path.join(home, 'elsewhere'), path.join(acc, 'agents')); }, expect: ['elsewhere'] },
    { name: 'own database', breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'state_5.sqlite')); write(path.join(acc, 'state_5.sqlite'), 'db'); }, expect: ['conflict'] },
    { name: 'index replaced by a file', breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'session_index.jsonl')); write(path.join(acc, 'session_index.jsonl'), 'b\n'); }, expect: ['replaced'] },
    { name: 'history replaced while busy', busy: true, breakIt: (acc) => { fs.unlinkSync(path.join(acc, 'history.jsonl')); write(path.join(acc, 'history.jsonl'), 'b\n'); }, expect: ['busy'] },
    { name: '.tmp folder deleted', breakIt: (acc) => fs.rmSync(path.join(acc, '.tmp'), { recursive: true }), expect: ['missing'] },
    { name: 'default entry deleted', breakIt: (_acc, def) => fs.rmSync(path.join(def, 'themes'), { recursive: true }), expect: ['defaultMissing'] },
    { name: 'whole-folder plugins link', breakIt: (acc, def) => { fs.rmSync(path.join(acc, 'plugins'), { recursive: true }); fs.symlinkSync(path.join(def, 'plugins'), path.join(acc, 'plugins')); }, expect: ['missing', 'stale'] },
    { name: 'dangling child link', breakIt: (_acc, def) => fs.rmSync(path.join(def, 'skills', 'one'), { recursive: true }), expect: ['stale'] },
    { name: 'default config gained a sign-in key', breakIt: (_acc, def) => write(path.join(def, 'config.toml'), 'forced_login_method = "api"\n'), expect: ['stale'] },
  ];
  for (const scenario of scenarios) {
    test(scenario.name, () => {
      const { acc, def } = setup();
      assertCheckMatchesRepair(scenario, (check, proc) => ensureCodexLinks(acc, { check }, proc), acc, def, { CODEX_HOME: acc }, CODEX_EXE);
    });
  }
});

describe('link problems', () => {
  const report = (r: Partial<ShareReport>): ShareReport => ({ linked: [], created: [], conflicts: [], refused: [], ...r });

  test('classifies each report list; refusals and Windows link limits are not problems', () => {
    const problems = accountProblems({
      dir: '/a', label: 'a', mirror: ['mcpServers'],
      report: report({
        linked: ['rules', 'history.jsonl'], merged: ['history.jsonl'], created: ['todos'], unlinked: ['settings.json', 'skills/x'],
        stripped: ['settings.json'], conflicts: ['agents', 'hooks'], elsewhere: ['hooks'], busy: ['plugins'],
        refused: ['settings.json'], noPrivilege: ['CLAUDE.md'], failed: ['ide'], copied: ['x'],
      }),
    });
    assert.deepEqual(problems, [
      { kind: 'missing', entries: ['rules'] },
      { kind: 'defaultMissing', entries: ['todos'] },
      { kind: 'replaced', entries: ['history.jsonl'] },
      { kind: 'stale', entries: ['settings.json', 'skills/x'] },
      { kind: 'mirror', entries: ['.claude.json'] },
      { kind: 'busy', entries: ['plugins'] },
      { kind: 'elsewhere', entries: ['hooks'] },
      { kind: 'conflict', entries: ['agents'] },
    ]);
    assert.deepEqual(accountProblems({ dir: '/a', label: 'a', report: report({ refused: ['config.toml'], noPrivilege: ['AGENTS.md'] }) }), []);
  });

  test('announcement keys: repairable problems only, without labels, error text or mirrored key names', () => {
    const a: AccountCheck[] = [{ dir: '/a', label: 'one', report: report({ linked: ['rules'] }), mirror: ['mcpServers'] }, { dir: '/b', label: 'x', error: 'boom' }];
    const b: AccountCheck[] = [{ dir: '/a', label: 'two', report: report({ linked: ['rules'] }), mirror: ['projects:/p'] }, { dir: '/b', label: 'y', error: 'other' }];
    assert.deepEqual(announcementKeys(a), announcementKeys(b));
    assert.deepEqual(announcementKeys(a), ['/a\0mirror\0.claude.json', '/a\0missing\0rules']);
    const unrepairable = report({ conflicts: ['agents', 'hooks'], elsewhere: ['hooks'], busy: ['plugins/x'] });
    assert.deepEqual(announcementKeys([{ dir: '/a', label: 'a', report: unrepairable }]), []);
    assert.deepEqual(announcementKeys([{ dir: '/a', label: 'a', report: report({}) }]), []);
  });

  test('plugin cache files are a known state; plugin folders are not', () => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'plugins', 'known_marketplaces.json'), '{}');
    write(path.join(def, 'plugins', 'cache-v2.json'), '{}');
    fs.mkdirSync(path.join(def, 'plugins', 'marketplaces'), { recursive: true });
    const check: AccountCheck = {
      dir: '/a', label: 'a', def,
      report: report({ linked: ['plugins/known_marketplaces.json', 'plugins/marketplaces'], conflicts: ['plugins/cache-v2.json'] }),
    };
    assert.deepEqual(accountProblems(check), [{ kind: 'missing', entries: ['plugins/marketplaces'] }]);
  });

  test('announcement keys leave out missing file links while Windows file links are unknown', () => {
    const def = path.join(home, '.claude');
    write(path.join(def, 'CLAUDE.md'), '');
    fs.mkdirSync(path.join(def, 'rules'), { recursive: true });
    const check: AccountCheck = { dir: '/a', label: 'a', def, report: report({ linked: ['CLAUDE.md', 'rules'] }) };
    assert.deepEqual(announcementKeys([check]), ['/a\0missing\0CLAUDE.md', '/a\0missing\0rules']);
    assert.deepEqual(announcementKeys([check], true), ['/a\0missing\0rules']);
  });
});

describe('LinkCheckNotices', () => {
  test('announces once per set of problems across windows, again after a day or after a change', async () => {
    const state = new MemoryMemento();
    let now = 1_000_000;
    const windowA = new LinkCheckNotices(state, () => now);
    const windowB = new LinkCheckNotices(state, () => now);
    assert.equal(await windowA.take('claude', []), false);
    assert.equal(state.updates, 0, 'nothing is written while there is nothing to announce');
    assert.equal(await windowA.take('claude', ['k1']), true);
    assert.equal(await windowB.take('claude', ['k1']), false);
    assert.equal(await windowB.take('codex', ['k1']), true, 'vendors are separate');
    now += REANNOUNCE_MS - 1;
    assert.equal(await windowB.take('claude', ['k1']), false);
    assert.equal(await windowB.take('claude', ['k1', 'k2']), true);
    now += REANNOUNCE_MS;
    assert.equal(await windowA.take('claude', ['k1', 'k2']), true);
    assert.equal(await windowA.take('claude', []), false);
    assert.equal(await windowB.take('claude', ['k1', 'k2']), true, 'a resolved problem that comes back is announced');
  });

  test('Re-link records what it showed, so the background check does not repeat it', async () => {
    const state = new MemoryMemento();
    const notices = new LinkCheckNotices(state, () => 5);
    await notices.remember('codex', ['k']);
    assert.equal(await notices.take('codex', ['k']), false);
    await notices.remember('codex', []);
    assert.equal(await notices.take('codex', ['k']), true);
  });

  test('a record that cannot be saved is not announced', async () => {
    const state = new MemoryMemento();
    state.update = async () => { throw new Error('read-only'); };
    assert.equal(await new LinkCheckNotices(state).take('claude', ['k']), false);
  });
});
