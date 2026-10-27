import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { topLevelConfigString } from './codexPaths';
// macOS differences of Codex switching: which login shell runs, the startup file that carries the rc marker block
// (codexState.rcBlock, unchanged), the files whose own CODEX_HOME export would defeat it, and the credential-store note.
// The block writing, removal, upgrade, pre-check and self-check themselves are codexState's, which branches here on
// macOS. The editor resolves its environment by running the login shell with `-i -l -c` and caches it until it fully
// quits, so a selection takes effect after a full restart; the editor is never restarted or signalled. macOS only
// reads ~/.config/planswap/codex-home (no per-editor codex-home.<kind>). No vscode import.

/** The login shells PlanSwap can write a marker block for on macOS. */
export type MacShell = 'zsh' | 'bash';

function defaultUserShell(): string | undefined {
  return os.userInfo().shell ?? undefined;
}

/**
 * The login shell the editor uses to resolve its environment: $SHELL, else the account's shell from the user database
 * (os.userInfo().shell), the order VS Code uses. undefined when neither is known.
 */
export function macLoginShell(env: NodeJS.ProcessEnv = process.env, userShell: () => string | undefined = defaultUserShell): string | undefined {
  if (env.SHELL) return env.SHELL;
  try {
    return userShell() || undefined;
  } catch {
    return undefined;
  }
}

/** 'zsh' or 'bash' by the shell's file name; any other shell (fish, sh, tcsh, …) or none → undefined. */
export function macShellKind(shell: string | undefined): MacShell | undefined {
  const name = shell ? path.basename(shell) : '';
  return name === 'zsh' || name === 'bash' ? name : undefined;
}

// zsh reads its startup files from $ZDOTDIR when the environment it starts with sets it, else from the home directory
function zshDir(env: NodeJS.ProcessEnv): string {
  return env.ZDOTDIR ? path.resolve(env.ZDOTDIR) : os.homedir();
}

// A login bash reads only the first of these that exists
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'];

function entryExists(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

/**
 * The startup file that gets the marker block. zsh: .zshenv, which every zsh reads first. bash: the first of
 * ~/.bash_profile, ~/.bash_login and ~/.profile that exists (a login bash reads only that one, so creating
 * ~/.bash_profile next to an existing ~/.profile would stop bash reading the user's file), else ~/.bash_profile.
 */
export function macRcFile(kind: MacShell, env: NodeJS.ProcessEnv = process.env): string {
  if (kind === 'zsh') return path.join(zshDir(env), '.zshenv');
  const home = os.homedir();
  const existing = BASH_LOGIN_FILES.map((name) => path.join(home, name)).find(entryExists);
  return existing ?? path.join(home, '.bash_profile');
}

/** The current login shell's marker block file (macRcFile), or undefined when the shell is neither zsh nor bash. */
export function currentMacRcFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const kind = macShellKind(macLoginShell(env));
  return kind && macRcFile(kind, env);
}

/**
 * The files the editor's `-i -l -c` login shell reads, in which a user's own `export CODEX_HOME=` or an incomplete
 * marker block conflicts with the block (pre-check). zsh: .zshenv, .zprofile, .zshrc and .zlogin; bash: its login file
 * (macRcFile) and ~/.bashrc, which login files commonly source.
 */
export function macStartupFiles(kind: MacShell, env: NodeJS.ProcessEnv = process.env): string[] {
  if (kind === 'zsh') return ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((name) => path.join(zshDir(env), name));
  return [macRcFile(kind, env), path.join(os.homedir(), '.bashrc')];
}

/** Every file a marker block may have been written to on macOS under either shell (removal and upgrade), each once. */
export function macBlockFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const files = [path.join(zshDir(env), '.zshenv'), path.join(home, '.zshenv'), ...BASH_LOGIN_FILES.map((name) => path.join(home, name))];
  return [...new Set(files)];
}

/** Codex's config.toml key that chooses where the CLI keeps its sign-in: `file` (auth.json, the default), `keyring`,
 *  `auto` or `ephemeral`. */
export const CREDENTIAL_STORE_KEY = 'cli_auth_credentials_store';

/**
 * macOS only: true when the account's config.toml sets cli_auth_credentials_store to anything but `file`, so its
 * sign-in may live in the macOS Keychain (or nowhere on disk) and auth.json cannot tell PlanSwap the email, plan or
 * sign-in state. Reads config.toml only; never touches the Keychain. A missing or unreadable file → false.
 */
export function usesKeychainStore(dir: string, platform: string = process.platform): boolean {
  if (platform !== 'darwin') return false;
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  } catch {
    return false;
  }
  const store = topLevelConfigString(text, CREDENTIAL_STORE_KEY);
  return store !== undefined && store !== 'file';
}
