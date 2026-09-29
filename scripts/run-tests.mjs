// npm test: bundle test/*.test.ts into .test-out/ with esbuild, then run node --test
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.test-out');
const testDir = path.join(root, 'test');

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
  logLevel: 'error',
});

// node --test does not accept a directory argument; use its built-in glob to match every test file in .test-out/
const r = spawnSync(process.execPath, ['--test', path.join(outDir, '*.test.js')], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
