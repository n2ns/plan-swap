// The Antigravity CLI (agy) sign-in: the one credential document agy itself reads, where it lives on each platform,
// and how PlanSwap recognizes whose sign-in it is. Imports no vscode.
//
// agy keeps a single global sign-in (it has no per-account folder or option): the JSON document
// {token: {access_token, token_type, refresh_token, expiry, ...}, auth_method, id_token? | id_token_email?, ...}.
// agy 1.5 writes id_token_email instead of id_token; older documents carry an id_token whose payload has the email.
// Where agy keeps it (go-keyring, service "gemini", user "antigravity"; the file is agy's fallback):
// - Linux / WSL: the file ~/.gemini/antigravity-cli/antigravity-oauth-token (mode 600). When the Secret Service holds
//   an item of that service and user, agy reads it instead, which PlanSwap cannot write: switching is refused then.
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
  | 'unrecognized' | 'readFailed' | 'writeFailed' | 'verifyFailed' | 'linuxKeyring' | 'tooLarge'
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

/** Linux / WSL: agy's token file (atomic replace, mode 600, folder 700 when created). */
export function fileStore(file: string = agyTokenFile(), run: Run = defaultRun): LiveStore {
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
    blocked: () => secretServiceHasItem(run).then((found) => (found ? 'linuxKeyring' : undefined)),
  };
}

/**
 * Whether the Secret Service holds an item agy would read before its file (SearchItems over D-Bus with gdbus; only
 * object paths come back, never a secret). No gdbus, no session bus or no service: false, agy then uses its file.
 */
export async function secretServiceHasItem(run: Run = defaultRun): Promise<boolean> {
  const r = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets',
    '--method', 'org.freedesktop.Secret.Service.SearchItems', `{'service': '${KEYRING_SERVICE}', 'username': '${KEYRING_USER}'}`]);
  if (r.code !== 0) return false;
  // Output: ([unlocked paths], [locked paths]); an empty pair prints as (@ao [], @ao [])
  return /objectpath|\/org\/freedesktop\/secrets\/collection\//.test(r.stdout);
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
