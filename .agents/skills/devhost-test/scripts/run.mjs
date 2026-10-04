// node .agents/skills/devhost-test/scripts/run.mjs <scenario>|list [--window=x,y,w,h] [--no-build] [--visible]
// Builds the project, takes the run lock, launches one scenario (test/devhost/scenarios/<scenario>.mjs) in a
// disposable editor and prints only the step lines and the summary. Exit code 1 when any step failed.
// With xvfb-run installed the editor runs on a virtual display and no window appears; --visible uses the real one.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(skillDir, '..', '..', '..');
const scenariosDir = path.join(root, 'test', 'devhost', 'scenarios');
const configPath = path.join(root, 'test', 'devhost', 'devhost.config.mjs');
// Persistent, machine-local files live next to the cached editor: npm test wipes .test-out
const localConfigPath = path.join(root, '.vscode-test', 'devhost', 'local.json');
const lockPath = path.join(root, '.vscode-test', 'devhost', 'lock');

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const scenarios = fs.existsSync(scenariosDir) ? fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort() : [];
if (!name || name === 'list') {
  console.log(scenarios.length ? scenarios.join('\n') : `no scenarios under ${scenariosDir}`);
  process.exit(name ? 0 : 1);
}
if (!scenarios.includes(name)) {
  console.error(`unknown scenario ${name}; available: ${scenarios.join(', ') || 'none'}`);
  process.exit(1);
}
if (!fs.existsSync(configPath)) {
  console.error(`missing ${configPath}`);
  process.exit(1);
}

// Machine-local options (git-ignored), overridden by command-line flags: { "window": "x,y,w,h" }
const local = fs.existsSync(localConfigPath) ? JSON.parse(fs.readFileSync(localConfigPath, 'utf8')) : {};
const windowArg = args.find((a) => a.startsWith('--window='))?.slice('--window='.length) ?? process.env.DEVHOST_WINDOW ?? local.window ?? '';

if (!args.includes('--no-build')) {
  const build = spawnSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// One editor at a time: the lock names the running driver's pid
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (fs.existsSync(lockPath)) {
  const pid = Number(fs.readFileSync(lockPath, 'utf8'));
  if (alive(pid)) { console.error(`another devhost run is active (pid ${pid}); wait for it or stop that process by its pid`); process.exit(1); }
}
fs.writeFileSync(lockPath, String(process.pid));

// Only the lines that matter reach the caller; the editor's own log goes to .test-out/devhost/<name>.log
const KEEP = /^(ok  |FAIL|all steps passed|FAILURES:|\[devhost\]|\s+at .*(test\/devhost|devhost-test)|[A-Za-z]*Error[: ])/;
const logPath = path.join(root, '.test-out', 'devhost', `${name}.log`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const log = fs.createWriteStream(logPath);
const launch = [process.execPath, path.join(skillDir, 'scripts', 'launch.mjs'), configPath, path.join(scenariosDir, `${name}.mjs`), name, windowArg];
const xvfb = !args.includes('--visible') && spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).status !== null;
const [cmd, ...cmdArgs] = xvfb ? ['xvfb-run', '-a', '-s', '-screen 0 2560x1600x24', ...launch] : launch;
if (!xvfb && !args.includes('--visible')) console.log('[devhost] xvfb-run not found: the editor window opens on the real display (install xvfb to hide it)');
const child = spawn(cmd, cmdArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
const killer = setTimeout(() => { console.error('devhost run exceeded 15 minutes; stopping it'); child.kill('SIGTERM'); }, 15 * 60_000);
let rest = '';
const onData = (chunk) => {
  log.write(chunk);
  rest += chunk.toString();
  const lines = rest.split('\n');
  rest = lines.pop();
  for (const line of lines) if (KEEP.test(line)) console.log(line);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('exit', (code) => {
  clearTimeout(killer);
  if (rest && KEEP.test(rest)) console.log(rest);
  log.end();
  try { if (Number(fs.readFileSync(lockPath, 'utf8')) === process.pid) fs.unlinkSync(lockPath); } catch { /* already gone */ }
  process.exit(code ?? 1);
});
