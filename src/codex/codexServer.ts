import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { t } from '../i18n';

export type ServerKind = 'antigravity' | 'vscodium' | 'vscode' | 'unknown';
export interface ServerPlan { serverPid: number; children: number[]; commit: string }

const SERVER_MAIN = '/out/server-main.js';
const COMMIT_RE = /^[0-9a-f]{40}$/;
// Whitelist of data dir names directly under $HOME
const DATA_DIR_KINDS: Record<string, ServerKind> = {
  '.antigravity-ide-server': 'antigravity',
  '.antigravity-server': 'antigravity', // older Antigravity releases
  '.vscodium-server': 'vscodium',
  '.vscode-server': 'vscode',
};

/** Parses field 4 (parent pid) of /proc/<pid>/stat. comm may contain spaces and parentheses, so split after the last ')'. */
export function parseStatParentPid(statText: string): number {
  const end = statText.lastIndexOf(')');
  if (end < 0) throw new Error(t('server.statUnparseable'));
  const fields = statText.slice(end + 1).trim().split(/\s+/);
  // fields[0] = state (field 3), fields[1] = ppid (field 4)
  const ppid = Number(fields[1]);
  if (!Number.isInteger(ppid)) throw new Error(t('server.statUnparseable'));
  return ppid;
}

/** Server root from a server-main argv: the first argument ending with /out/server-main.js, with that suffix stripped. */
export function parseServerRoot(argv: string[]): string | undefined {
  const arg = argv.find((s) => s.endsWith(SERVER_MAIN));
  const root = arg?.slice(0, -SERVER_MAIN.length);
  return root ? root : undefined;
}

/** Data dir of a server root laid out as <dataDir>/bin/<version dir>; undefined for any other layout. */
function dataDirOf(root: string): string | undefined {
  const bin = path.dirname(root);
  return path.basename(bin) === 'bin' ? path.dirname(bin) : undefined;
}

/** Resolves symlinks when the path exists; otherwise falls back to path.resolve. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Whitelist mapping; dataDir must be <name> directly under home (symlinks in either path are resolved). */
export function classifyDataDir(dataDir: string, home: string): ServerKind {
  const name = path.basename(dataDir);
  if (!Object.hasOwn(DATA_DIR_KINDS, name) || realPath(path.dirname(dataDir)) !== realPath(home)) return 'unknown';
  return DATA_DIR_KINDS[name];
}

/** Classifies the server that hosts this process (process.ppid). Never throws; any failure → 'unknown'. */
export function detectServerKind(): ServerKind {
  try {
    const root = parseServerRoot(readArgv(process.ppid));
    const dataDir = root && dataDirOf(root);
    return dataDir ? classifyDataDir(dataDir, os.homedir()) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Only servers with a pid file and auto-shutdown can be restarted automatically. */
export function canAutoRestart(kind: ServerKind): boolean {
  return kind === 'antigravity' || kind === 'vscodium';
}

/** Reads the top-level commit of <root>/product.json; must be 40 lowercase hex digits. */
export function readServerCommit(root: string): string {
  let commit: unknown;
  try {
    commit = (JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')) as { commit?: unknown }).commit;
  } catch {
    throw new Error(t('server.noCommit'));
  }
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) throw new Error(t('server.noCommit'));
  return commit;
}

/** Reads /proc/<pid>/cmdline as argv (split on \0, so arguments may contain spaces). */
export function readArgv(pid: number): string[] {
  return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((s) => s !== '');
}

/** Walks numeric dirs under /proc and collects processes with ppid === parentPid (excluding process.pid). */
export function listChildren(parentPid: number): number[] {
  const children: number[] = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue; // process has exited
    }
    try {
      if (parseStatParentPid(stat) === parentPid) children.push(pid);
    } catch {
      continue;
    }
  }
  return children;
}

/**
 * Verifies an auto-restartable server from its argv and its parent (wrapper) pid; returns the commit.
 * Only reads product.json and the pid file under home.
 */
export function verifyServer(argv: string[], wrapperPid: number, home: string): string {
  const root = parseServerRoot(argv);
  const dataDir = root && dataDirOf(root);
  if (!root || !dataDir || !argv.includes('--start-server') || !canAutoRestart(classifyDataDir(dataDir, home))) {
    throw new Error(t('server.unsupported', { cmdline: argv.join(' ').slice(0, 120) }));
  }

  const commit = readServerCommit(root);
  const dirName = path.basename(root);
  if (dirName !== commit && !dirName.endsWith(`-${commit}`)) throw new Error(t('server.noCommit'));

  const pidFile = path.join(dataDir, `.${commit}.pid`);
  let pidText: string;
  try {
    pidText = fs.readFileSync(pidFile, 'utf8');
  } catch {
    throw new Error(t('server.pidReadFailed', { file: pidFile }));
  }
  const filePid = Number(pidText.trim());
  if (!Number.isInteger(filePid) || filePid !== wrapperPid) {
    throw new Error(t('server.pidMismatch'));
  }
  return commit;
}

export function planRestart(): ServerPlan {
  const ppid = process.ppid;
  if (ppid <= 1) throw new Error(t('server.notFound'));

  const wrapperPid = parseStatParentPid(fs.readFileSync(`/proc/${ppid}/stat`, 'utf8'));
  const commit = verifyServer(readArgv(ppid), wrapperPid, os.homedir());
  return { serverPid: ppid, children: listChildren(ppid), commit };
}

export function executeRestart(plan: ServerPlan): void {
  // process.kill is TerminateProcess outside Linux; never signal there
  if (process.platform !== 'linux') throw new Error(t('ext.linuxOnly'));
  process.kill(plan.serverPid, 'SIGTERM');
  for (const pid of plan.children) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw e;
    }
  }
}
