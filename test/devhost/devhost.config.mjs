// Project configuration for the devhost-test skill (.agents/skills/devhost-test): what to launch, how to find the
// sidebar, which settings and stub extensions the editor needs, and the default fixture.
import { seedAccounts } from './fixtures/accounts.mjs';

export default {
  vscodeVersion: '1.107.0',
  extensionId: 'n2ns.planswap',
  focusCommand: 'planswap.accounts.focus',
  // The sidebar Webview's document, once the first account row rendered
  frameSelector: '#panel-claude .row',
  // Automatic usage checks must never run against the fake accounts (claude / codex are off PATH anyway)
  settings: { 'planswap.claude.usageAutoRefresh': false, 'planswap.codex.usageAutoRefresh': false },
  // Inherited account variables must not reach the editor
  clearEnv: ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
  // Switching writes claudeCode.environmentVariables; the real Claude Code extension registers it, here a stub does
  stubExtensions: {
    'stub-claude-code': { contributes: { configuration: { properties: { 'claudeCode.environmentVariables': { type: 'array', scope: 'machine', default: [] } } } } },
  },
  seed: seedAccounts,
};
