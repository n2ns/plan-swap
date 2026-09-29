import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCredentialOverrides, oneDriveHome } from '../src/environmentWarnings';

describe('claudeCredentialOverrides', () => {
  test('names variables that outrank the per-account sign-in, from the environment or the setting', () => {
    assert.deepEqual(claudeCredentialOverrides({ PATH: '/bin', HOME: '/h' }, [], 'linux'), []);
    assert.deepEqual(claudeCredentialOverrides({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_PROFILE: '' }, ['CLAUDE_CODE_OAUTH_TOKEN'], 'linux'), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    // Federation counts only with both variables
    assert.deepEqual(claudeCredentialOverrides({ ANTHROPIC_FEDERATION_RULE_ID: 'r' }, [], 'linux'), []);
    assert.deepEqual(claudeCredentialOverrides({ ANTHROPIC_FEDERATION_RULE_ID: 'r' }, ['ANTHROPIC_ORGANIZATION_ID'], 'linux'), ['ANTHROPIC_FEDERATION_RULE_ID']);
    // Names are case-insensitive on Windows only
    assert.deepEqual(claudeCredentialOverrides({ anthropic_api_key: 'k' }, ['claude_code_use_bedrock'], 'linux'), []);
    assert.deepEqual(claudeCredentialOverrides({ anthropic_api_key: 'k' }, ['claude_code_use_bedrock'], 'win32'), ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY']);
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
