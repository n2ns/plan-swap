// The Antigravity CLI (agy) sign-in: the one credential document agy itself reads, where it lives on each platform,
// and how PlanSwap recognizes whose sign-in it is. Imports no vscode.
//
// agy keeps a single global sign-in (it has no per-account folder or option): the JSON document
// {token: {access_token, token_type, refresh_token, expiry, ...}, auth_method, id_token? | id_token_email?, ...}.
// agy 1.5 writes id_token_email instead of id_token; older documents carry an id_token whose payload has the email.
// Where agy keeps it (go-keyring, service "gemini", user "antigravity"; the file is agy's fallback):
// - Linux / WSL: the file ~/.gemini/antigravity-cli/antigravity-oauth-token (mode 600). When the Secret Service holds
//   an item of that service and user, agy reads it instead, which PlanSwap cannot write: switching is refused then, also
//   when a session bus exists but that lookup fails (go-keyring talks to D-Bus itself, so a missing gdbus proves nothing),
//   and when there is no session bus but dbus-launch is on PATH and the Secret Service can be activated (go-keyring
//   then starts a bus of its own, where it would start).
// - macOS: the login Keychain generic password (service gemini, account antigravity), read and written through
//   /usr/bin/security like go-keyring does; the value is "go-keyring-base64:" + base64 of the JSON.
// - Windows: the Credential Manager generic credential "gemini:antigravity" (user antigravity), the bare JSON as UTF-8
//   bytes, at most 2560 bytes; read and written through PowerShell (CredReadW / CredWriteW).
// The document is passed only through stdin, never in command arguments or the environment, and never logged.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPlainObject } from '../platform';

export const KEYRING_SERVICE = 'gemini';
export const KEYRING_USER = 'antigravity';
const GO_KEYRING_PREFIX = 'go-keyring-base64:';
// Windows Credential Manager limit of one credential's blob, which go-keyring enforces too
export const WINCRED_BLOB_LIMIT = 2560;
// security(1) exit code for errSecItemNotFound
const SECURITY_NOT_FOUND = 44;
const SECURITY = '/usr/bin/security';
const RUN_TIMEOUT_MS = 15_000;

/** The sign-in file agy uses on Linux / WSL (and as a fallback elsewhere). */
export function agyTokenFile(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

/** Why an agy sign-in operation failed; the command layer turns the code into a localized message. */
export type AgyErrorCode =
  | 'unrecognized' | 'readFailed' | 'writeFailed' | 'verifyFailed' | 'linuxKeyring' | 'keyringUnknown' | 'tooLarge' | 'queryRunning'
  | 'unknownAccount' | 'removeCurrent';

export class AgyError extends Error {
  constructor(readonly code: AgyErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** A credential document: the parsed JSON object and the identity read from it (never displayed except the email). */
export interface AgyLogin {
  doc: Record<string, unknown>;
  // Lower-cased email from the id_token payload or id_token_email; undefined when neither is present
  email?: string;
  refreshToken?: string;
}

/** Parses a document as agy stores it (bare JSON or the go-keyring base64 form); undefined when it is not one. */
export function decodeLogin(raw: string): AgyLogin | undefined {
  let text = raw.trim();
  if (text.startsWith(GO_KEYRING_PREFIX)) {
    const encoded = text.slice(GO_KEYRING_PREFIX.length);
    if (!/^[A-Za-z0-9+/=]*$/.test(encoded)) return undefined;
    text = Buffer.from(encoded, 'base64').toString('utf8');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.token)) return undefined;
  const token = doc.token;
  const refreshToken = typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : undefined;
  const access = typeof token.access_token === 'string' && token.access_token ? token.access_token : undefined;
  if (!refreshToken && !access) return undefined;
  return { doc, email: loginEmail(doc), refreshToken };
}

// The email of a document: the id_token payload (no signature check; it is only a local label) or id_token_email
function loginEmail(doc: Record<string, unknown>): string | undefined {
  const fromToken = typeof doc.id_token === 'string' ? idTokenEmail(doc.id_token) : undefined;
  const email = fromToken ?? (typeof doc.id_token_email === 'string' ? doc.id_token_email : undefined);
  const trimmed = email?.trim().toLowerCase();
  return trimmed || undefined;
}

function idTokenEmail(idToken: string): string | undefined {
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isPlainObject(claims) && typeof claims.email === 'string' && claims.email.trim() ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

/** Short one-way fingerprint of a document's refresh token, for comparisons only (never displayed or persisted). */
export function fingerprint(login: AgyLogin): string | undefined {
  return login.refreshToken === undefined ? undefined : createHash('sha256').update(login.refreshToken).digest('hex').slice(0, 16);
}

/** Whether two documents are the same sign-in: the same refresh token, or, without one, the same email. */
export function sameLogin(a: AgyLogin, b: AgyLogin): boolean {
  if (a.refreshToken !== undefined || b.refreshToken !== undefined) return a.refreshToken === b.refreshToken;
  return a.email !== undefined && a.email === b.email;
}

/** Result of a helper process: exit code (null when it did not exit normally) and its output. */
export interface RunResult { code: number | null; stdout: string; stderr: string }
/** Runs a program with optional stdin; tests inject their own. */
export type Run = (file: string, args: string[], input?: string) => Promise<RunResult>;

export const defaultRun: Run = (file, args, input) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(file, args, { windowsHide: true, timeout: RUN_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
    return;
  }
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  child.on('error', (err) => resolve({ code: null, stdout, stderr: stderr || err.message }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
  child.stdin.on('error', () => undefined);
  child.stdin.end(input ?? '');
});

/** The place agy reads its sign-in from on this platform. read: the raw value, undefined when there is none. */
export interface LiveStore {
  readonly kind: 'file' | 'keychain' | 'wincred';
  read(): Promise<string | undefined>;
  /** Replaces the sign-in with this document, encoded the way agy writes it on this platform. */
  write(doc: Record<string, unknown>): Promise<void>;
  /** Why switching cannot work here (agy would keep reading another store), or undefined. */
  blocked(): Promise<AgyErrorCode | undefined>;
}

// Whether an executable named name is in one of env.PATH's folders; the Windows folders WSL appends (/mnt/<drive>/...)
// are never looked into
function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(path.delimiter).filter((dir) => dir && !/^\/mnt\/[a-z](\/|$)/i.test(dir)).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

// Where go-keyring's godbus looks for the session bus by uid
const RUN_USER = '/run/user';
// The data folders a session bus always reads activation files from, besides XDG_DATA_HOME and XDG_DATA_DIRS
const FIXED_DATA_DIRS = ['/usr/share'];

// Whether a session bus started now could activate the Secret Service: a .service file naming org.freedesktop.secrets in
// one of the session bus's standard service folders (<data dir>/dbus-1/services of XDG_DATA_HOME, else ~/.local/share,
// then XDG_DATA_DIRS, else /usr/local/share and /usr/share, then fixedDataDirs). Reads files only; /mnt/<drive> skipped
function secretsActivatable(env: NodeJS.ProcessEnv, fixedDataDirs: readonly string[]): boolean {
  const home = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share');
  const system = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  return [home, ...system, ...fixedDataDirs].filter((dir) => dir && !/^\/mnt\/[a-z](\/|$)/i.test(dir)).some((dir) => {
    const services = path.join(dir, 'dbus-1', 'services');
    let names: string[];
    try {
      names = fs.readdirSync(services).filter((n) => n.endsWith('.service'));
    } catch {
      return false;
    }
    return names.some((n) => {
      try {
        return /^\s*Name\s*=\s*org\.freedesktop\.secrets\s*$/m.test(fs.readFileSync(path.join(services, n), 'utf8'));
      } catch {
        return false;
      }
    });
  });
}

/** Linux / WSL: agy's token file (atomic replace, mode 600, folder 700 when created). env, runUser (/run/user) and
 *  fixedDataDirs (/usr/share): where the session bus and the Secret Service activation files are looked up. */
export function fileStore(
  file: string = agyTokenFile(), run: Run = defaultRun, env: NodeJS.ProcessEnv = process.env, runUser = RUN_USER, fixedDataDirs: readonly string[] = FIXED_DATA_DIRS,
): LiveStore {
  return {
    kind: 'file',
    async read() {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new AgyError('readFailed', (err as Error).message);
      }
    },
    async write(doc) {
      const dir = path.dirname(file);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = path.join(dir, `.${path.basename(file)}.planswap-${process.pid}-${Date.now()}`);
        fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600, flag: 'wx' });
        try {
          fs.renameSync(tmp, file);
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          throw err;
        }
        fs.chmodSync(file, 0o600);
      } catch (err) {
        throw new AgyError('writeFailed', (err as Error).message);
      }
    },
    blocked: async () => {
      const keyring = await secretServiceState(run, env, runUser, fixedDataDirs);
      return keyring === 'item' ? 'linuxKeyring' : keyring === 'unknown' ? 'keyringUnknown' : undefined;
    },
  };
}

/**
 * Where agy's go-keyring would find its sign-in on Linux: 'item' when the Secret Service holds an item of agy's service
 * and user (SearchItems over D-Bus with gdbus; only object paths come back, never a secret), 'none' when it holds none,
 * when no Secret Service runs on the bus, or when there is no session bus and none with a Secret Service could be
 * started (agy then uses its file), and 'unknown' when a session bus exists but the lookup failed (no gdbus, a timeout, another D-Bus
 * error; go-keyring talks to D-Bus itself, so agy may still read the keyring) or when there is no session bus but
 * dbus-launch is on PATH and the Secret Service has an activation file (go-keyring then starts a bus of its own, where
 * the Secret Service would start; Fact 3).
 */
export async function secretServiceState(
  run: Run = defaultRun, env: NodeJS.ProcessEnv = process.env, runUser = RUN_USER, fixedDataDirs: readonly string[] = FIXED_DATA_DIRS,
): Promise<'item' | 'none' | 'unknown'> {
  const bus = sessionBus(env, runUser);
  // Without a bus go-keyring's library starts one with dbus-launch (on PATH); when that bus could activate the Secret
  // Service, agy may read the keyring there, which cannot be ruled out without starting a bus (PlanSwap never does)
  if (!bus) return onPath('dbus-launch', env) && secretsActivatable(env, fixedDataDirs) ? 'unknown' : 'none';
  const r = await run('gdbus', ['call', ...bus, '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets',
    '--method', 'org.freedesktop.Secret.Service.SearchItems', `{'service': '${KEYRING_SERVICE}', 'username': '${KEYRING_USER}'}`]);
  if (r.code === 0) {
    // Output: ([unlocked paths], [locked paths]); an empty pair prints as (@ao [], @ao [])
    return /objectpath|\/org\/freedesktop\/secrets\/collection\//.test(r.stdout) ? 'item' : 'none';
  }
  return /org\.freedesktop\.DBus\.Error\.ServiceUnknown/.test(r.stderr) ? 'none' : 'unknown';
}

// The gdbus arguments that reach the session bus go-keyring's godbus would connect to (Fact 3), undefined when there
// is none: DBUS_SESSION_BUS_ADDRESS (--session), else by uid whatever XDG_RUNTIME_DIR says, the socket
// /run/user/<uid>/bus or the address in /run/user/<uid>/dbus-session (--address)
function sessionBus(env: NodeJS.ProcessEnv, runUser: string): string[] | undefined {
  if (env.DBUS_SESSION_BUS_ADDRESS) return ['--session'];
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const dir = path.join(runUser, String(uid));
  if (fs.existsSync(path.join(dir, 'bus'))) return ['--address', `unix:path=${path.join(dir, 'bus')}`];
  try {
    const text = fs.readFileSync(path.join(dir, 'dbus-session'), 'utf8');
    const address = text.startsWith('DBUS_SESSION_BUS_ADDRESS=') ? text.slice('DBUS_SESSION_BUS_ADDRESS='.length).replace(/[\r\n]+$/u, '') : '';
    if (address) return ['--address', address];
  } catch {
    // No such file: no bus found by uid
  }
  return undefined;
}

/** macOS: the login Keychain item through /usr/bin/security; the value goes in on stdin (security -i). */
export function keychainStore(run: Run = defaultRun): LiveStore {
  return {
    kind: 'keychain',
    async read() {
      const r = await run(SECURITY, ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_USER, '-w']);
      if (r.code === SECURITY_NOT_FOUND) return undefined;
      if (r.code !== 0) throw new AgyError('readFailed', `security exit ${r.code}`);
      const value = r.stdout.replace(/[\r\n]+$/, '');
      return value || undefined;
    },
    async write(doc) {
      const value = GO_KEYRING_PREFIX + Buffer.from(JSON.stringify(doc), 'utf8').toString('base64');
      // -U updates in place and keeps the item's access list; the base64 value needs no quoting beyond the quotes
      const line = `add-generic-password -U -s ${KEYRING_SERVICE} -a ${KEYRING_USER} -w "${value}"\n`;
      // security -i reads lines of at most 4096 bytes
      if (line.length > 4000) throw new AgyError('tooLarge');
      const r = await run(SECURITY, ['-i'], line);
      // security -i may exit 0 after an error and only report it on stderr
      if (r.code !== 0 || r.stderr.trim()) throw new AgyError('writeFailed', `security exit ${r.code}`);
    },
    blocked: async () => undefined,
  };
}

// CredReadW / CredWriteW of a generic credential; the blob travels base64-encoded on stdin / stdout
const WINCRED_TYPE = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PlanSwapCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) return "";
      throw new Exception("CredReadW " + e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      return "=" + Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, byte[] blob) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = blob.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
      if (!CredWriteW(ref c, 0)) throw new Exception("CredWriteW " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
}
'@
$ErrorActionPreference = 'Stop'
`;
const WINCRED_TARGET = `${KEYRING_SERVICE}:${KEYRING_USER}`;
const WINCRED_READ = `${WINCRED_TYPE}[Console]::Out.Write([PlanSwapCred]::Read('${WINCRED_TARGET}'))`;
const WINCRED_WRITE = `${WINCRED_TYPE}$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
[PlanSwapCred]::Write('${WINCRED_TARGET}', '${KEYRING_USER}', $b)`;
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * The bare JSON agy writes on Windows. A document over the Credential Manager limit drops its id_token for
 * id_token_email, as agy 1.5 itself writes; still too large: tooLarge.
 */
export function encodeWincred(doc: Record<string, unknown>): string {
  let json = JSON.stringify(doc);
  if (Buffer.byteLength(json, 'utf8') <= WINCRED_BLOB_LIMIT) return json;
  if (typeof doc.id_token === 'string') {
    const { id_token: idToken, ...slim } = doc;
    const email = idTokenEmail(idToken as string);
    if (email && typeof slim.id_token_email !== 'string') slim.id_token_email = email;
    json = JSON.stringify(slim);
    if (Buffer.byteLength(json, 'utf8') <= WINCRED_BLOB_LIMIT) return json;
  }
  throw new AgyError('tooLarge');
}

/** Windows: the Credential Manager generic credential through PowerShell. */
export function wincredStore(run: Run = defaultRun): LiveStore {
  return {
    kind: 'wincred',
    async read() {
      const r = await run('powershell.exe', [...POWERSHELL_ARGS, WINCRED_READ]);
      if (r.code !== 0) throw new AgyError('readFailed', `powershell exit ${r.code}`);
      const out = r.stdout.trim();
      if (!out.startsWith('=')) return undefined;
      const value = Buffer.from(out.slice(1), 'base64').toString('utf8');
      return value || undefined;
    },
    async write(doc) {
      const blob = Buffer.from(encodeWincred(doc), 'utf8').toString('base64');
      const r = await run('powershell.exe', [...POWERSHELL_ARGS, WINCRED_WRITE], blob);
      if (r.code !== 0) throw new AgyError('writeFailed', `powershell exit ${r.code}`);
    },
    blocked: async () => undefined,
  };
}

/** The store agy reads on this platform. */
export function liveStore(platform: NodeJS.Platform = process.platform, run: Run = defaultRun, home: string = os.homedir()): LiveStore {
  if (platform === 'darwin') return keychainStore(run);
  if (platform === 'win32') return wincredStore(run);
  return fileStore(agyTokenFile(home), run);
}
