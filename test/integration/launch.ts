import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTempHome } from '../helpers';

async function main(): Promise<void> {
  // This suite covers the Linux extension host. Windows registry integration remains user-operated acceptance.
  if (process.platform !== 'linux') throw new Error('Run test:integration on Linux/WSL with a display or xvfb-run.');
  const root = path.resolve(__dirname, '../..');
  const tmp = makeTempHome('editor');
  try {
    // Prevent the launcher from attaching to an existing editor or inheriting its account environment.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
    }
    for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) process.env[key] = path.join(tmp.home, key);
    const userData = path.join(tmp.home, 'editor-data');
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
      'extensions.autoUpdate': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    }));
    for (const name of ['.claude-smoke', '.codex-smoke', 'workspace', 'extensions']) {
      fs.mkdirSync(path.join(tmp.home, name));
    }
    await runTests({
      version: '1.107.0',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      extensionTestsEnv: { PLANSWAP_TEST_HOME: tmp.home },
      launchArgs: [path.join(tmp.home, 'workspace'),
        '--user-data-dir', userData, '--extensions-dir', path.join(tmp.home, 'extensions'),
        '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        '--disable-gpu', '--no-sandbox'],
    });
  } finally { tmp.restore(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
