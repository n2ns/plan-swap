// Saved Antigravity CLI (agy) accounts: PlanSwap's own copies of agy sign-ins, one folder per account under
// ~/.config/planswap/agy/accounts/<name>/ (folders 700, credential.json 600), and the user-initiated switch that puts a
// saved copy into agy's single global sign-in (agyLogin.LiveStore). Imports no vscode.
//
// An account is recognized by its refresh token, then by its email. Reading the live sign-in saves it: a sign-in of a
// saved account refreshes that copy (agy renews its tokens there), a new one is added. Nothing here refreshes tokens,
// talks to Google or touches a running agy: sessions started before a switch keep the account they started with.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgyError, decodeLogin, sameLogin, type AgyLogin, type LiveStore } from './agyLogin';
import { renameReplacing } from '../platform';

const CREDENTIAL_FILE = 'credential.json';
// Account folder names: a hash of the email, so no address appears in a path
const NAME_RE = /^g[0-9a-f]{12}$/;

/** Root of the saved accounts. */
export function agyAccountsRoot(home: string = os.homedir()): string {
  return path.join(home, '.config', 'planswap', 'agy', 'accounts');
}

/** The folder name of an email's account. */
export function accountName(email: string): string {
  return 'g' + createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12);
}

export interface AgyAccount {
  name: string;
  dir: string;
  email: string;
  login: AgyLogin;
}

/** What agy is signed in to now. unrecognized: a sign-in PlanSwap cannot read or name (no email, not a saved one). */
export interface LiveState {
  current?: string;
  signedIn: boolean;
  unrecognized: boolean;
}

export type SwitchResult = 'switched' | 'already';

export class AgyAccounts {
  // sync, switchTo and remove run one at a time: a Keychain or Credential Manager read or write is a separate process,
  // and two interleaved switches could otherwise report a switch whose sign-in the other one replaced
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: LiveStore, readonly root: string = agyAccountsRoot()) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Every readable saved account, in folder-name order; folders that are not accounts are skipped. */
  list(): AgyAccount[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    return names.filter((n) => NAME_RE.test(n)).sort().flatMap((name) => {
      const account = this.read(name);
      return account ? [account] : [];
    });
  }

  find(name: string): AgyAccount | undefined {
    return NAME_RE.test(name) ? this.read(name) : undefined;
  }

  /** The saved account of a sign-in: the same refresh token first, then the same email. */
  match(login: AgyLogin, accounts: AgyAccount[] = this.list()): AgyAccount | undefined {
    return (login.refreshToken !== undefined ? accounts.find((a) => a.login.refreshToken === login.refreshToken) : undefined)
      ?? (login.email !== undefined ? accounts.find((a) => a.email === login.email) : undefined);
  }

  /**
   * Reads agy's sign-in and saves it (a saved account's copy is replaced when it differs; a new email is added).
   * A store that cannot be read is thrown (AgyError readFailed).
   */
  sync(): Promise<LiveState> {
    return this.exclusive(() => this.syncNow());
  }

  private async syncNow(): Promise<LiveState> {
    const raw = await this.store.read();
    if (raw === undefined) return { signedIn: false, unrecognized: false };
    const login = decodeLogin(raw);
    if (!login) return { signedIn: true, unrecognized: true };
    const saved = this.match(login);
    if (saved) {
      // A renewed document of a saved account that names no email keeps the saved one, so the copy stays recognizable
      const doc = login.email === undefined ? { ...login.doc, id_token_email: saved.email } : login.doc;
      if (JSON.stringify(saved.login.doc) !== JSON.stringify(doc)) this.save(saved.name, doc);
      return { current: saved.name, signedIn: true, unrecognized: false };
    }
    if (login.email === undefined) return { signedIn: true, unrecognized: true };
    const name = accountName(login.email);
    this.save(name, login.doc);
    return { current: name, signedIn: true, unrecognized: false };
  }

  /**
   * Switches agy's sign-in to a saved account: saves the current sign-in first (so its latest tokens are kept), writes
   * the target's copy, reads it back and checks it is the target's sign-in. A sign-in that cannot be recognized is
   * never overwritten (unrecognized); a store agy would not read is refused (blocked); a read-back that does not match
   * puts the previous sign-in back and throws verifyFailed. Running agy sessions are neither checked nor stopped.
   */
  switchTo(name: string): Promise<SwitchResult> {
    return this.exclusive(() => this.switchNow(name));
  }

  private async switchNow(name: string): Promise<SwitchResult> {
    const target = this.find(name);
    if (!target) throw new AgyError('unknownAccount');
    const blocked = await this.store.blocked();
    if (blocked) throw new AgyError(blocked);
    const live = await this.syncNow();
    if (live.unrecognized) throw new AgyError('unrecognized');
    if (live.current === name) return 'already';
    const previous = live.current !== undefined ? this.find(live.current) : undefined;
    await this.store.write(target.login.doc);
    const back = await this.store.read();
    const written = back === undefined ? undefined : decodeLogin(back);
    if (!written || !sameLogin(written, target.login) || written.email !== target.email) {
      if (previous) await this.store.write(previous.login.doc).catch(() => undefined);
      throw new AgyError('verifyFailed');
    }
    return 'switched';
  }

  /** Deletes PlanSwap's copy of an account (never agy's own sign-in); the account agy is signed in to is refused. */
  remove(name: string): Promise<void> {
    return this.exclusive(() => this.removeNow(name));
  }

  private async removeNow(name: string): Promise<void> {
    const account = this.find(name);
    if (!account) throw new AgyError('unknownAccount');
    const live = await this.syncNow();
    if (live.current === name) throw new AgyError('removeCurrent');
    // Only a folder matching NAME_RE directly under the root; never follows a link out of it
    const dir = path.join(this.root, name);
    if (fs.lstatSync(dir).isSymbolicLink()) throw new AgyError('unknownAccount');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private read(name: string): AgyAccount | undefined {
    const dir = path.join(this.root, name);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, CREDENTIAL_FILE), 'utf8');
    } catch {
      return undefined;
    }
    const login = decodeLogin(raw);
    if (!login?.email) return undefined;
    return { name, dir, email: login.email, login };
  }

  // Atomic replace of an account's copy (folders 700, file 600)
  private save(name: string, doc: Record<string, unknown>): void {
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The agy folder, the accounts folder and the account's own folder stay private even when they existed before
    if (process.platform !== 'win32') for (const d of [path.dirname(this.root), this.root, dir]) fs.chmodSync(d, 0o700);
    const file = path.join(dir, CREDENTIAL_FILE);
    const tmp = path.join(dir, `.${CREDENTIAL_FILE}.${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600, flag: 'wx' });
    try {
      renameReplacing(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}
