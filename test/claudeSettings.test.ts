// 'vscode' is aliased by esbuild to ./stubs/vscode.ts; the stub is imported directly here to control the configuration
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { affectsSetting, currentDir, isExplicitConfigDir, setConfigDir } from '../src/claudeSettings';
import { ConfigurationTarget, resetConfig, setConfig, updates } from './stubs/vscode';
import { assertTempHome, makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;
let home: string;
let def: string;

before(() => {
  tmp = makeTempHome('claude-settings');
  home = tmp.home;
  def = path.join(home, '.claude');
});
after(() => tmp.restore());
beforeEach(() => resetConfig());

const KEY = 'environmentVariables';
const set = (raw: unknown): void => setConfig('claudeCode', KEY, raw);
const last = (): unknown => updates[updates.length - 1]?.value;

describe('currentDir (getConfiguredConfigDir)', () => {
  test('missing → default directory', () => {
    assertTempHome(home);
    assert.equal(currentDir(), def);
  });
  test('array form', () => {
    set([{ name: 'OTHER', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: home + '/.claude-a/' }]);
    assert.equal(currentDir(), path.join(home, '.claude-a'));
  });
  test('object form', () => {
    set({ CLAUDE_CONFIG_DIR: home + '/x/../.claude-b' });
    assert.equal(currentDir(), path.join(home, '.claude-b'));
  });
  test('empty entries are skipped; a later non-empty entry overrides earlier ones', () => {
    set([{ name: 'CLAUDE_CONFIG_DIR', value: '' }]);
    assert.equal(currentDir(), def);
    set([{ name: 'CLAUDE_CONFIG_DIR', value: home + '/.claude-1' }, { name: 'CLAUDE_CONFIG_DIR', value: '' }]);
    assert.equal(currentDir(), path.join(home, '.claude-1'));
    set([{ name: 'CLAUDE_CONFIG_DIR', value: home + '/.claude-1' }, { name: 'CLAUDE_CONFIG_DIR', value: home + '/.claude-2' }]);
    assert.equal(currentDir(), path.join(home, '.claude-2'));
  });
  test('non-string value is stringified; null / undefined skipped; invalid elements ignored', () => {
    set([{ name: 'CLAUDE_CONFIG_DIR', value: null }, 'junk', 42, { value: 'no-name' }]);
    assert.equal(currentDir(), def);
    set([{ name: 'CLAUDE_CONFIG_DIR', value: 123 }]);
    assert.equal(currentDir(), path.resolve('123'));
  });
  test('neither array nor object (e.g. a string) → default directory', () => {
    set('garbage');
    assert.equal(currentDir(), def);
  });
});

describe('isExplicitConfigDir', () => {
  test('setting missing or empty → false, even for the default directory', () => {
    assert.equal(isExplicitConfigDir(def), false);
    set([{ name: 'CLAUDE_CONFIG_DIR', value: '' }]);
    assert.equal(isExplicitConfigDir(def), false);
  });
  test('true only for the configured directory (default directory included)', () => {
    set([{ name: 'CLAUDE_CONFIG_DIR', value: def + '/' }]);
    assert.equal(isExplicitConfigDir(def), true);
    assert.equal(isExplicitConfigDir(path.join(home, '.claude-a')), false);
    set({ CLAUDE_CONFIG_DIR: path.join(home, '.claude-a') });
    assert.equal(isExplicitConfigDir(path.join(home, '.claude-a')), true);
    assert.equal(isExplicitConfigDir(def), false);
  });
});

describe('setConfigDir', () => {
  test('keeps other entries, removes every CLAUDE_CONFIG_DIR entry, appends the new one, writes to Global', async () => {
    set([{ name: 'A', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: '/old' }, { name: 'B', value: 2 }, { name: 'CLAUDE_CONFIG_DIR', value: '' }]);
    await setConfigDir(home + '/.claude-a/');
    assert.deepEqual(last(), [{ name: 'A', value: '1' }, { name: 'B', value: 2 }, { name: 'CLAUDE_CONFIG_DIR', value: path.join(home, '.claude-a') }]);
    assert.equal(updates[0].target, ConfigurationTarget.Global);
    assert.equal(updates[0].section, 'claudeCode');
    assert.equal(updates[0].key, KEY);
  });
  test('does not mutate the array returned by get()', async () => {
    const raw = [{ name: 'A', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: '/old' }];
    set(raw);
    await setConfigDir(home + '/.claude-a');
    assert.deepEqual(raw, [{ name: 'A', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: '/old' }]);
    assert.notEqual((last() as unknown[])[0], raw[0]);
  });
  test('object form is converted to a {name, value} array with stringified values', async () => {
    set({ A: 1, CLAUDE_CONFIG_DIR: '/old', B: 'x' });
    await setConfigDir(home + '/.claude-b');
    assert.deepEqual(last(), [{ name: 'A', value: '1' }, { name: 'B', value: 'x' }, { name: 'CLAUDE_CONFIG_DIR', value: path.join(home, '.claude-b') }]);
  });
  test('default directory or undefined → only removes entries, appends nothing', async () => {
    set([{ name: 'A', value: '1' }, { name: 'CLAUDE_CONFIG_DIR', value: '/old' }]);
    await setConfigDir(def + '/');
    assert.deepEqual(last(), [{ name: 'A', value: '1' }]);
    await setConfigDir(undefined);
    assert.deepEqual(last(), [{ name: 'A', value: '1' }]);
  });
  test('setting missing → writes an array with only the new entry', async () => {
    await setConfigDir(home + '/.claude-c');
    assert.deepEqual(last(), [{ name: 'CLAUDE_CONFIG_DIR', value: path.join(home, '.claude-c') }]);
  });
});

describe('variable name case on Windows', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  const asPlatform = (platform: string): void => { Object.defineProperty(process, 'platform', { value: platform }); };
  after(() => Object.defineProperty(process, 'platform', realPlatform));

  test('a lower-case entry sets the directory on Windows only; the upper-case spelling wins as it does for Node', async () => {
    set([{ name: 'claude_config_dir', value: home + '/.claude-low' }]);
    asPlatform('linux');
    assert.equal(currentDir(), def);
    asPlatform('win32');
    assert.equal(currentDir(), path.join(home, '.claude-low'));
    set([{ name: 'claude_config_dir', value: home + '/.claude-low' }, { name: 'CLAUDE_CONFIG_DIR', value: home + '/.claude-up' }]);
    assert.equal(currentDir(), path.join(home, '.claude-up'));
    // A switch replaces every spelling
    await setConfigDir(home + '/.claude-new');
    assert.deepEqual(last(), [{ name: 'CLAUDE_CONFIG_DIR', value: path.join(home, '.claude-new') }]);
    Object.defineProperty(process, 'platform', realPlatform);
  });
});

describe('affectsSetting', () => {
  test('checks exactly claudeCode.environmentVariables', () => {
    const seen: string[] = [];
    const event = (hit: boolean) => ({ affectsConfiguration: (s: string) => (seen.push(s), hit) });
    assert.equal(affectsSetting(event(true)), true);
    assert.equal(affectsSetting(event(false)), false);
    assert.deepEqual(seen, ['claudeCode.environmentVariables', 'claudeCode.environmentVariables']);
  });
});
