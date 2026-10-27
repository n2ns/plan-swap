// Signs a Claude account out through the official CLI right before the account is deleted (macOS: Claude Code keeps
// each config directory's sign-in in the login Keychain, which deleting the folder would leave behind). PlanSwap never
// touches the Keychain itself and never reads the CLI's output. No vscode import.
import type { SpawnOptions } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { runClaudeCli, type ClaudeQueryOptions } from './claudeUsage';

/** cliMissing: no `claude` on PATH and no bundled CLI; timeout: the run exceeded the timeout; failed: a non-zero exit,
 *  a signal, a spawn error or cancellation, with a short detail that never contains CLI output. */
export type ClaudeLogoutResult = { ok: true } | { ok: false; reason: 'cliMissing' | 'timeout' | 'failed'; detail?: string };

const ARGS = ['auth', 'logout'];
export const LOGOUT_TIMEOUT_MS = 30_000;

/**
 * Runs `claude auth logout` for a non-default account with CLAUDE_CONFIG_DIR=path.resolve(dir), the exact string
 * setConfigDir writes and from which Claude Code derives the account's Keychain item, over process.env plus
 * options.env (the setting variables). The CLI is resolved as for the usage query (runClaudeCli: PATH `claude`, then
 * options.fallback, the bundled CLI); the run shares options.timeoutMs (default LOGOUT_TIMEOUT_MS) and options.signal.
 * Every stdio stream is ignored, so no output is ever read. failed's detail is the spawn error message (truncated),
 * 'exit code <n>' or 'signal <name>'. Callers never pass the default account.
 */
export async function logoutClaude(dir: string, options: ClaudeQueryOptions = {}): Promise<ClaudeLogoutResult> {
  const base: SpawnOptions = {
    env: { ...process.env, ...options.env, CLAUDE_CONFIG_DIR: path.resolve(dir) },
    cwd: os.homedir(),
    windowsHide: true,
    stdio: 'ignore',
  };
  const a = await runClaudeCli<ClaudeLogoutResult>(ARGS, base, (options.now ?? Date.now)(), { ...options, timeoutMs: options.timeoutMs ?? LOGOUT_TIMEOUT_MS }, {
    failure: (detail) => ({ ok: false, reason: 'failed', detail }),
    timeout: () => ({ ok: false, reason: 'timeout' }),
    exit: (_out, code, signal) => (code === 0 && signal === null
      ? { ok: true }
      : { ok: false, reason: 'failed', detail: signal !== null ? `signal ${signal}` : `exit code ${code}` }),
  });
  return a.kind === 'enoent' ? { ok: false, reason: 'cliMissing' } : a.result;
}
