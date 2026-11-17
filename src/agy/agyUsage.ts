// Antigravity CLI (agy) usage limits and CLI discovery. Imports no vscode.
//
// `agy -p /usage --output-format json` answers from the read-only slash command without starting an agent turn,
// spending quota or leaving a conversation behind (agy changelog); its payload command.data.groups[] holds the model
// groups, each with buckets {id, name, window ('5h' | 'weekly'), remaining_fraction, reset_time}. It names no account:
// the caller attributes the answer to the sign-in that was active before and after the query (agyCommands).
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPlainObject, taskkillTree } from '../platform';

const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json'];
const USAGE_TIMEOUT_MS = 60_000;
// Larger answers are not a usage report
const MAX_OUTPUT = 256 * 1024;

export interface AgyUsageWindow { usedPercent: number; windowMinutes?: number; resetsAt?: number; scope?: string }
export interface AgyUsage { windows: AgyUsageWindow[]; checkedAt: number }

export type AgyUsageResult = { ok: true; usage: AgyUsage } | { ok: false; reason: 'cliMissing' | 'failed' | 'timeout' | 'unparsed'; detail?: string };

/** Where the agy CLI is: the first agy on PATH (Windows: agy.exe / agy.cmd), else the installer's ~/.local/bin/agy. On Linux
 *  the Windows folders WSL appends to PATH (/mnt/<drive>/...) are skipped: a Windows-side agy is never found or run. */
export function findAgy(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir(),
  runnable: (file: string) => boolean = (file) => isRunnable(file, platform)): string | undefined {
  const names = platform === 'win32' ? ['agy.exe', 'agy.cmd'] : ['agy'];
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map((d) => d.replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && !(platform === 'linux' && /^\/mnt\/[a-z](\/|$)/i.test(d)));
  const candidates = [...dirs.flatMap((d) => names.map((n) => path.join(d, n))), ...(platform === 'win32' ? [] : [path.join(home, '.local', 'bin', 'agy')])];
  return candidates.find(runnable);
}

// A regular file that this user may run (Windows: any file)
function isRunnable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const WINDOW_MINUTES: Record<string, number> = { '5h': 300, weekly: 7 * 1440, daily: 1440 };

/** Window length in minutes of a bucket's window id ('5h', 'weekly', '30m', '2d'); undefined when unknown. */
export function windowMinutes(window: unknown): number | undefined {
  if (typeof window !== 'string') return undefined;
  if (Object.hasOwn(WINDOW_MINUTES, window)) return WINDOW_MINUTES[window];
  const m = /^(\d+)([mhd])$/.exec(window);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : 1440);
}

/** The usage windows of a /usage JSON answer, scoped by model group; undefined when it is not one. */
export function parseAgyUsage(text: string, now: number): AgyUsage | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(payload) || !isPlainObject(payload.command) || !isPlainObject(payload.command.data)) return undefined;
  const groups = payload.command.data.groups;
  if (!Array.isArray(groups)) return undefined;
  const windows: AgyUsageWindow[] = [];
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.buckets)) continue;
    const scope = typeof group.name === 'string' && group.name.trim() ? group.name.trim() : undefined;
    for (const bucket of group.buckets) {
      if (!isPlainObject(bucket) || typeof bucket.remaining_fraction !== 'number' || !Number.isFinite(bucket.remaining_fraction)) continue;
      const remaining = Math.min(1, Math.max(0, bucket.remaining_fraction));
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
      windows.push({
        usedPercent: Number(((1 - remaining) * 100).toFixed(2)),
        windowMinutes: windowMinutes(bucket.window),
        resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : undefined,
        scope,
      });
    }
  }
  return windows.length ? { windows, checkedAt: now } : undefined;
}

export interface UsageSpawnChild {
  stdout: NodeJS.ReadableStream | null;
  pid?: number;
  on(event: 'error', fn: (err: Error) => void): unknown;
  on(event: 'close', fn: (code: number | null) => void): unknown;
  kill(): unknown;
}
export type AgyUsageSpawn = (command: string, args: string[], options: { cwd: string; windowsHide: boolean; shell: boolean }) => UsageSpawnChild;

/**
 * Runs the usage query with the agy CLI at `cli` in the home folder. Its raw output is only parsed here, never logged
 * or stored; a failure carries no output either.
 */
export function readAgyUsage(cli: string | undefined, options: { spawn?: AgyUsageSpawn; now?: () => number; timeoutMs?: number; platform?: NodeJS.Platform; killTree?: (pid: number) => void } = {}): Promise<AgyUsageResult> {
  if (!cli) return Promise.resolve({ ok: false, reason: 'cliMissing' });
  const run: AgyUsageSpawn = options.spawn ?? ((c, a, o) => spawn(c, a, { ...o, stdio: ['ignore', 'pipe', 'ignore'] }));
  const now = options.now ?? Date.now;
  // An npm-style agy.cmd shim needs a shell on Windows; the arguments are fixed, so nothing user-typed reaches it
  const shell = (options.platform ?? process.platform) === 'win32' && cli.toLowerCase().endsWith('.cmd');
  return new Promise((resolve) => {
    let child: UsageSpawnChild;
    try {
      child = run(shell ? `"${cli}"` : cli, USAGE_ARGS, { cwd: os.homedir(), windowsHide: true, shell });
    } catch (err) {
      resolve({ ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    let out = '';
    let done = false;
    const finish = (result: AgyUsageResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Through a shell (Windows agy.cmd) kill() would end only cmd.exe and leave agy running: end the whole tree
    const stop = (): void => {
      if (shell && child.pid !== undefined) (options.killTree ?? taskkillTree)(child.pid);
      else child.kill();
    };
    const timer = setTimeout(() => {
      stop();
      finish({ ok: false, reason: 'timeout' });
    }, options.timeoutMs ?? USAGE_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
      if (out.length > MAX_OUTPUT) {
        stop();
        finish({ ok: false, reason: 'unparsed' });
      }
    });
    child.on('error', (err) => finish({ ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'cliMissing' : 'failed', detail: err.message }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, reason: 'failed', detail: `exit ${code}` });
      const usage = parseAgyUsage(out, now());
      finish(usage ? { ok: true, usage } : { ok: false, reason: 'unparsed' });
    });
  });
}
