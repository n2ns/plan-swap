// npm test: bundle test/*.test.ts into .test-out/ with esbuild, then run node --test
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.test-out');
const testDir = path.join(root, 'test');
// Refuses reg / powershell / pwsh / setx for the whole test process; loaded before anything else in every bundle
const guard = path.join(root, 'scripts', 'test-guard.cjs');

rmSync(outDir, { recursive: true, force: true });

const entryPoints = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(testDir, f));

await esbuild.build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: 'inline',
  alias: { vscode: path.join(testDir, 'stubs', 'vscode.ts') },
  // 'use strict' stays the first statement, so the bundles keep running in strict mode
  banner: { js: `'use strict';require(${JSON.stringify(guard)});` },
  logLevel: 'error',
});

// node --test does not accept a directory argument; use its built-in glob to match every test file in .test-out/.
// A per-test timeout turns a hung test (a child that never exits, a promise that never settles) into a failure. The spec
// reporter is named explicitly: Node 22 falls back to TAP when stdout is not a terminal (CI pipes it through tee), and the
// CI steps read the spec summary ('failing tests:', 'ℹ skipped N').
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-timeout=60000', path.join(outDir, '*.test.js')], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
