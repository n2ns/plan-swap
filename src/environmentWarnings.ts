// Environment conditions that defeat per-account separation or endanger the account folders. Pure checks; no vscode
// import. Sources: Claude Code authentication docs (credential precedence), anthropics/claude-code#29153 (OneDrive).
import * as path from 'node:path';

/**
 * Variables Claude Code prefers over the /login credential stored in the selected CLAUDE_CONFIG_DIR (authentication
 * precedence: cloud provider switches, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, a named
 * Anthropic profile). With any of them set, switching accounts does not change the credential Claude Code uses.
 */
export const CLAUDE_OVERRIDE_VARS = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE',
] as const;
// Workload Identity Federation also outranks /login, but only with both variables set
const FEDERATION_VARS = ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID'] as const;

/**
 * The override variables Claude Code started by this editor would see: set (non-empty) in the extension host
 * environment, or passed by claudeCode.environmentVariables (settingNames). Names only; values are never read out.
 * Names compare case-insensitively on Windows.
 */
export function claudeCredentialOverrides(env: NodeJS.ProcessEnv, settingNames: readonly string[], platform: string = process.platform): string[] {
  const norm = (n: string): string => (platform === 'win32' ? n.toUpperCase() : n);
  const fromSetting = new Set(settingNames.map(norm));
  const isSet = (name: string): boolean => fromSetting.has(norm(name)) || Object.keys(env).some((k) => norm(k) === norm(name) && !!env[k]);
  const found: string[] = CLAUDE_OVERRIDE_VARS.filter(isSet);
  if (FEDERATION_VARS.every(isSet)) found.push(FEDERATION_VARS[0]);
  return found;
}

/**
 * Windows: the OneDrive folder that contains the home directory (and with it ~/.claude, ~/.claude.json and every
 * account folder), or undefined. OneDrive sync has corrupted .claude.json through concurrent writes.
 */
export function oneDriveHome(home: string, env: NodeJS.ProcessEnv, platform: string = process.platform): string | undefined {
  if (platform !== 'win32') return undefined;
  // Windows path rules explicitly, so the check behaves the same when tests run elsewhere
  const cmp = (p: string): string => path.win32.resolve(p).toLowerCase();
  const h = cmp(home);
  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const root = env[key];
    if (!root) continue;
    const r = cmp(root);
    if (h === r || h.startsWith(r.endsWith('\\') ? r : r + '\\')) return root;
  }
  return undefined;
}
