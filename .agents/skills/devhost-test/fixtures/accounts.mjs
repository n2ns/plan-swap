// Fake Claude and Codex accounts for a disposable HOME. Nothing here is a real account: identities are made up, the
// Codex id_token is an unsigned JWT-shaped string, and every file lives under the given home.
import * as fs from 'node:fs';
import * as path from 'node:path';

const H = 3600_000;
const D = 24 * H;

/**
 * Seeds `home` and returns the directories by role. Claude: the default account's info file is ~/.claude.json (as
 * Claude Code keeps it), named accounts keep theirs inside their directory; usage comes from cachedUsageUtilization.
 * Codex: <dir>/auth.json plus observations in state.json (codex.usageHistory, stamped with the auth.json stat).
 *
 * Claude: default 20% left in 5 hours (low), work 58%/46% (best), personal weekly used up, spare 35%/80%, fresh no
 * observation. Codex: default 15% left (effective, low), work 80%/60% (best), team limitReached.
 */
export function seedAccounts(home) {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const claude = (name, email, uuid, limits, agoMs) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    const data = { oauthAccount: { emailAddress: email, accountUuid: uuid, organizationUuid: 'org-fake' } };
    if (limits) data.cachedUsageUtilization = { accountUuid: uuid, fetchedAtMs: now - agoMs, utilization: { limits } };
    fs.writeFileSync(name === '.claude' ? path.join(home, '.claude.json') : path.join(dir, '.claude.json'), JSON.stringify(data, null, 2));
    return dir;
  };
  const session = (p) => ({ kind: 'session', percent: p, resets_at: iso(2 * H) });
  const weekly = (p) => ({ kind: 'weekly_all', percent: p, resets_at: iso(3 * D) });
  const scoped = (p) => ({ kind: 'weekly_scoped', percent: p, resets_at: iso(4 * D), scope: { model: { display_name: 'Fable' } } });
  const dirs = {
    claudeDefault: claude('.claude', 'default@fake.invalid', 'uuid-default', [session(80), weekly(40), scoped(25)], 3 * 60_000),
    claudeWork: claude('.claude-work', 'work@fake.invalid', 'uuid-work', [session(42), weekly(54), scoped(10)], 2 * 60_000),
    claudePersonal: claude('.claude-personal', 'personal@fake.invalid', 'uuid-personal', [session(5), weekly(100)], 10 * 60_000),
    claudeSpare: claude('.claude-spare', 'spare@fake.invalid', 'uuid-spare', [session(65), weekly(20)], 50 * 60_000),
    claudeFresh: claude('.claude-fresh', 'fresh@fake.invalid', 'uuid-fresh', undefined, 0),
  };

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const codex = (name, email, plan, userId) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir, { mode: 0o700 });
    const payload = { email, sub: userId, 'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_user_id: userId, chatgpt_account_id: `acct-${userId}` } };
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `${b64({ alg: 'none' })}.${b64(payload)}.sig`, access_token: 'fake', refresh_token: 'fake' } }));
    return dir;
  };
  dirs.codexDefault = codex('.codex', 'codex-default@fake.invalid', 'plus', 'user-default');
  dirs.codexWork = codex('.codex-work', 'codex-work@fake.invalid', 'pro', 'user-work');
  dirs.codexTeam = codex('.codex-team', 'codex-team@fake.invalid', 'team', 'user-team');
  const stamp = (dir) => { const st = fs.statSync(path.join(dir, 'auth.json')); return `${st.mtimeMs}:${st.size}`; };
  const resetsAt = (ms) => Math.floor((now + ms) / 1000);
  const obs = (dir, five, week, agoMs, limitReached = false) => ({ dir, stamp: stamp(dir), usage: {
    windows: [{ usedPercent: five, windowMinutes: 300, resetsAt: resetsAt(90 * 60_000) }, { usedPercent: week, windowMinutes: 10080, resetsAt: resetsAt(5 * D) }],
    checkedAt: now - agoMs, limitReached } });
  fs.mkdirSync(path.join(home, '.config', 'planswap'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.config', 'planswap', 'state.json'), JSON.stringify({
    'codex.usageHistory': [obs(dirs.codexDefault, 85, 30, 4 * 60_000), obs(dirs.codexWork, 20, 40, 6 * 60_000), obs(dirs.codexTeam, 10, 10, 60_000, true)],
  }, null, 2) + '\n', { mode: 0o600 });

  // Codex switching counts as enabled when both rc files carry the marker block. Same text as rcBlock() in
  // src/codex/codexState.ts; a drift shows up as a disabled Codex page in the editor
  const block = ['# >>> planswap codex >>>', 'if [ -r "$HOME/.config/planswap/codex-home" ]; then',
    '  _planswap_codex_home="$(cat "$HOME/.config/planswap/codex-home" 2>/dev/null)"',
    '  if [ -n "$_planswap_codex_home" ] && [ -d "$_planswap_codex_home" ]; then', '    export CODEX_HOME="$_planswap_codex_home"',
    '  else', '    unset CODEX_HOME', '  fi', '  unset _planswap_codex_home', 'fi', '# <<< planswap codex <<<', ''].join('\n');
  for (const rc of ['.bashrc', '.profile']) fs.writeFileSync(path.join(home, rc), `# fake ${rc}\n\n${block}`);
  return dirs;
}
