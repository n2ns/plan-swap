import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCredentialOverrides, oneDriveHome, pathVarsWithSpaces } from '../src/environmentWarnings';

describe('claudeCredentialOverrides', () => {
  test('names variables that outrank the per-account sign-in, from the environment or the setting', () => {
    assert.deepEqual(claudeCredentialOverrides({ PATH: '/bin', HOME: '/h' }, { set: [] }, 'linux'), []);
    assert.deepEqual(claudeCredentialOverrides({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_PROFILE: '' }, { set: ['CLAUDE_CODE_OAUTH_TOKEN'] }, 'linux'), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    // Federation counts only with both variables
    assert.deepEqual(claudeCredentialOverrides({ ANTHROPIC_FEDERATION_RULE_ID: 'r' }, { set: [] }, 'linux'), []);
    assert.deepEqual(claudeCredentialOverrides({ ANTHROPIC_FEDERATION_RULE_ID: 'r' }, { set: ['ANTHROPIC_ORGANIZATION_ID'] }, 'linux'), ['ANTHROPIC_FEDERATION_RULE_ID']);
    // An empty entry in the setting clears the inherited variable for Claude Code
    assert.deepEqual(claudeCredentialOverrides({ ANTHROPIC_API_KEY: 'k' }, { set: [], cleared: ['ANTHROPIC_API_KEY'] }, 'linux'), []);
    // Names are case-insensitive on Windows only
    assert.deepEqual(claudeCredentialOverrides({ anthropic_api_key: 'k' }, { set: ['claude_code_use_bedrock'] }, 'linux'), []);
    assert.deepEqual(claudeCredentialOverrides({ anthropic_api_key: 'k' }, { set: ['claude_code_use_bedrock'] }, 'win32'), ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY']);
  });
});

describe('pathVarsWithSpaces', () => {
  test('names folder variables with surrounding spaces; blank and clean values are fine', () => {
    assert.deepEqual(pathVarsWithSpaces({ CLAUDE_CONFIG_DIR: '/a ', CODEX_HOME: ' /b', PATH: ' x ' }), ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
    assert.deepEqual(pathVarsWithSpaces({ CLAUDE_CONFIG_DIR: '/a', CODEX_HOME: '   ' }), []);
    assert.deepEqual(pathVarsWithSpaces({}), []);
  });
});

describe('oneDriveHome', () => {
  test('a home folder inside any OneDrive root, compared as a Windows path', () => {
    const env = { OneDrive: 'C:\\Users\\a\\OneDrive', OneDriveCommercial: 'C:\\Users\\a\\OneDrive - Corp' };
    assert.equal(oneDriveHome('C:\\Users\\a', env, 'win32'), undefined);
    assert.equal(oneDriveHome('c:\\users\\a\\onedrive - corp\\home', env, 'win32'), 'C:\\Users\\a\\OneDrive - Corp');
    assert.equal(oneDriveHome('C:\\Users\\a\\OneDrive', env, 'win32'), 'C:\\Users\\a\\OneDrive');
    assert.equal(oneDriveHome('C:\\Users\\a\\OneDriveX', { OneDrive: 'C:\\Users\\a\\OneDrive' }, 'win32'), undefined);
    assert.equal(oneDriveHome('C:\\Users\\a\\OneDrive\\x', env, 'linux'), undefined);
    assert.equal(oneDriveHome('C:\\Users\\a', {}, 'win32'), undefined);
  });
});
