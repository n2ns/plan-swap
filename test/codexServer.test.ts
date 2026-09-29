// Only tests the pure parsers, classification, readServerCommit, verifyServer (temp HOME), listChildren and the throwing paths of planRestart; never calls executeRestart and never signals any process not started by this test
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setLocale } from '../src/i18n';
import {
  canAutoRestart, classifyDataDir, detectServerKind, listChildren, parseServerRoot, parseStatParentPid, planRestart,
  readArgv, readServerCommit, verifyServer,
} from '../src/codex/codexServer';
import { assertTempHome, LINUX_ONLY, makeTempHome, type TempHome } from './helpers';

let tmp: TempHome;

before(() => {
  tmp = makeTempHome('codex-server');
});
after(() => tmp.restore());

describe('parseStatParentPid', () => {
  test('parses after the last ) when comm contains spaces and parentheses', () => {
    assert.equal(parseStatParentPid('1234 (node (x) y) S 99 1490 1490 34816'), 99);
    assert.equal(parseStatParentPid('1805 (node) S 1526 1490 1490 34816 1490'), 1526);
  });
  test('throws a localized error when the format cannot be parsed', () => {
    assert.throws(() => parseStatParentPid('garbage'), { message: 'Cannot parse stat format' });
    assert.throws(() => parseStatParentPid('1 (x) S abc'), { message: 'Cannot parse stat format' });
  });
  test('matches /proc/self/stat', LINUX_ONLY, () => {
    assert.equal(parseStatParentPid(fs.readFileSync('/proc/self/stat', 'utf8')), process.ppid);
  });
});

const COMMIT = 'ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8';

const serverArgv = (root: string, ...args: string[]): string[] => [`${root}/node`, `${root}/out/server-main.js`, ...args];

describe('parseServerRoot', () => {
  test('Antigravity: bin/<version>-<commit>', () => {
    const root = `/home/u/.antigravity-ide-server/bin/2.5.5-${COMMIT}`;
    assert.equal(parseServerRoot(serverArgv(root, '--start-server', '--host=127.0.0.1')), root);
  });
  test('VSCodium: bin/<commit>', () => {
    const root = `/home/u/.vscodium-server/bin/${COMMIT}`;
    assert.equal(parseServerRoot(serverArgv(root, '--start-server', '--enable-remote-auto-shutdown')), root);
  });
  test('VS Code: bin/<commit>', () => {
    const root = `/home/u/.vscode-server/bin/${COMMIT}`;
    assert.equal(parseServerRoot(serverArgv(root, '--host=127.0.0.1', '--port=0')), root);
  });
  test('a home path containing spaces is kept intact', () => {
    const root = `/home/John Doe/.vscodium-server/bin/${COMMIT}`;
    assert.equal(parseServerRoot(serverArgv(root, '--start-server')), root);
  });
  test('no server-main argument → undefined', () => {
    assert.equal(parseServerRoot(['/usr/bin/node', 'foo.js']), undefined);
    assert.equal(parseServerRoot(['/usr/bin/node', '/x/out/server-main.jsx']), undefined);
    assert.equal(parseServerRoot(['node', '/out/server-main.js']), undefined);
  });
});

describe('classifyDataDir', () => {
  const home = '/home/u';
  test('maps every whitelisted name directly under home', () => {
    assert.equal(classifyDataDir('/home/u/.antigravity-ide-server', home), 'antigravity');
    assert.equal(classifyDataDir('/home/u/.antigravity-server', home), 'antigravity');
    assert.equal(classifyDataDir('/home/u/.vscodium-server', home), 'vscodium');
    assert.equal(classifyDataDir('/home/u/.vscode-server', home), 'vscode');
  });
  test('unknown name (including VS Code and VSCodium Insiders), nested path or a different home → unknown', () => {
    assert.equal(classifyDataDir('/home/u/.cursor-server', home), 'unknown');
    assert.equal(classifyDataDir('/home/u/.vscode-server-insiders', home), 'unknown');
    assert.equal(classifyDataDir('/home/u/.vscodium-server-insiders', home), 'unknown');
    assert.equal(classifyDataDir('/home/u/x/.vscodium-server', home), 'unknown');
    assert.equal(classifyDataDir('/home/v/.antigravity-ide-server', home), 'unknown');
    assert.equal(classifyDataDir('/home/u/constructor', home), 'unknown');
  });
  test('home reached through a symlink still matches', () => {
    const real = path.join(tmp.home, 'real-home');
    const link = path.join(tmp.home, 'link-home');
    fs.mkdirSync(path.join(real, '.vscodium-server'), { recursive: true });
    fs.symlinkSync(real, link, 'junction');
    assert.equal(classifyDataDir(path.join(real, '.vscodium-server'), link), 'vscodium');
    assert.equal(classifyDataDir(path.join(link, '.vscodium-server'), real), 'vscodium');
  });
});

describe('canAutoRestart / detectServerKind', () => {
  test('only antigravity and vscodium restart automatically', () => {
    assert.equal(canAutoRestart('antigravity'), true);
    assert.equal(canAutoRestart('vscodium'), true);
    assert.equal(canAutoRestart('vscode'), false);
    assert.equal(canAutoRestart('unknown'), false);
  });
  test('the test runner is not a WSL server → unknown', () => {
    assert.equal(detectServerKind(), 'unknown');
  });
});

describe('readServerCommit', () => {
  const writeProduct = (name: string, content: string): string => {
    assertTempHome(tmp.home);
    const root = path.join(tmp.home, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'product.json'), content);
    return root;
  };
  test('reads the top-level commit', () => {
    assert.equal(readServerCommit(writeProduct('valid', JSON.stringify({ nameShort: 'x', commit: COMMIT }))), COMMIT);
  });
  test('missing product.json, invalid JSON or a bad commit throws a localized error', () => {
    const noCommit = { message: 'Cannot read the server commit from product.json' };
    assert.throws(() => readServerCommit(path.join(tmp.home, 'missing')), noCommit);
    assert.throws(() => readServerCommit(writeProduct('invalid', '{')), noCommit);
    assert.throws(() => readServerCommit(writeProduct('nocommit', JSON.stringify({ nameShort: 'x' }))), noCommit);
    assert.throws(() => readServerCommit(writeProduct('short', JSON.stringify({ commit: 'abcdef' }))), noCommit);
    assert.throws(() => readServerCommit(writeProduct('upper', JSON.stringify({ commit: COMMIT.toUpperCase() }))), noCommit);
  });
});

describe('readArgv / listChildren', LINUX_ONLY, () => {
  test('readArgv splits /proc/<pid>/cmdline on \\0', () => {
    const argv = readArgv(process.pid);
    assert.ok(argv.length > 0 && argv.every((a) => a !== '' && !a.includes('\0')));
    assert.ok(argv[0].includes('node'));
  });
  test('lists the sleep child started by this test', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const kids = listChildren(process.pid);
      assert.ok(child.pid !== undefined && kids.includes(child.pid), `children=${kids} childPid=${child.pid}`);
      assert.ok(!listChildren(process.pid).includes(process.pid));
    } finally {
      child.kill(); // The only allowed process operation: ending the sleep this test started itself
    }
  });
});

describe('verifyServer', () => {
  const WRAPPER = 4242;
  // Builds <home>/<dataDir>/bin/<dirName> with product.json and optionally the pid file; returns the server root
  const makeServer = (dataDir: string, dirName: string, pid: string | undefined, commit = COMMIT): string => {
    assertTempHome(tmp.home);
    const root = path.join(tmp.home, dataDir, 'bin', dirName);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify({ commit }));
    const pidFile = path.join(tmp.home, dataDir, `.${commit}.pid`);
    if (pid === undefined) fs.rmSync(pidFile, { force: true });
    else fs.writeFileSync(pidFile, pid);
    return root;
  };
  const unsupported = /^Parent process is not a WSL server that supports automatic restart/;

  test('Antigravity (bin/<version>-<commit>) and VSCodium (bin/<commit>) pass and return the commit', () => {
    const ag = makeServer('.antigravity-ide-server', `2.5.5-${COMMIT}`, `${WRAPPER}\n`);
    assert.equal(verifyServer(serverArgv(ag, '--start-server'), WRAPPER, tmp.home), COMMIT);
    const vc = makeServer('.vscodium-server', COMMIT, `${WRAPPER}\n`);
    assert.equal(verifyServer(serverArgv(vc, '--start-server'), WRAPPER, tmp.home), COMMIT);
  });
  test('VS Code, unknown editors, missing --start-server or a non-bin layout are unsupported', () => {
    const code = makeServer('.vscode-server', COMMIT, `${WRAPPER}`);
    assert.throws(() => verifyServer(serverArgv(code, '--start-server'), WRAPPER, tmp.home), { message: unsupported });
    const cursor = makeServer('.cursor-server', COMMIT, `${WRAPPER}`);
    assert.throws(() => verifyServer(serverArgv(cursor, '--start-server'), WRAPPER, tmp.home), { message: unsupported });
    const vc = makeServer('.vscodium-server', COMMIT, `${WRAPPER}`);
    assert.throws(() => verifyServer(serverArgv(vc), WRAPPER, tmp.home), { message: unsupported });
    const other = path.join(tmp.home, '.vscodium-server', 'other', COMMIT);
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'product.json'), JSON.stringify({ commit: COMMIT }));
    assert.throws(() => verifyServer(serverArgv(other, '--start-server'), WRAPPER, tmp.home), { message: unsupported });
    assert.throws(() => verifyServer(['/usr/bin/node', 'x.js', '--start-server'], WRAPPER, tmp.home), { message: unsupported });
  });
  test('a version dir that does not match the product.json commit is rejected', () => {
    const root = makeServer('.vscodium-server', 'b'.repeat(40), `${WRAPPER}`);
    assert.throws(() => verifyServer(serverArgv(root, '--start-server'), WRAPPER, tmp.home), {
      message: 'Cannot read the server commit from product.json',
    });
  });
  test('a missing or mismatching pid file is rejected', () => {
    const root = makeServer('.vscodium-server', COMMIT, undefined);
    assert.throws(() => verifyServer(serverArgv(root, '--start-server'), WRAPPER, tmp.home), { message: /^Failed to read pid file: .*\.vscodium-server/ });
    makeServer('.vscodium-server', COMMIT, '1234');
    assert.throws(() => verifyServer(serverArgv(root, '--start-server'), WRAPPER, tmp.home), {
      message: 'The pid file does not match the server process',
    });
    makeServer('.vscodium-server', COMMIT, 'abc');
    assert.throws(() => verifyServer(serverArgv(root, '--start-server'), WRAPPER, tmp.home), {
      message: 'The pid file does not match the server process',
    });
  });
});

describe('planRestart', LINUX_ONLY, () => {
  test('under the test process (parent is not the server) throws a localized error and returns no plan', () => {
    assertTempHome(tmp.home);
    assert.throws(
      () => planRestart(),
      (e: unknown) => e instanceof Error && /^(Cannot find the WSL server process|Parent process is not a WSL server that supports automatic restart|Cannot read the server commit from product.json|Failed to read pid file|The pid file does not match the server process)/.test(e.message),
    );
  });
});

describe('codexServer in zh-cn', () => {
  after(() => setLocale('en'));
  test('parse and planRestart errors follow the locale', LINUX_ONLY, () => {
    setLocale('zh-cn');
    assert.throws(() => parseStatParentPid('garbage'), { message: 'stat 格式无法解析' });
    assert.throws(
      () => planRestart(),
      (e: unknown) => e instanceof Error && /^(找不到 WSL 服务端进程|父进程不是支持自动重启的 WSL 服务端|无法从 product.json 读取服务端 commit|读取 pid 文件失败|pid 文件与服务端进程不匹配)/.test(e.message),
    );
  });
});
