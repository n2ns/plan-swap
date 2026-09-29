// Build a launcher using the same temporary-HOME helper as the unit tests, and a real extension-host suite.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, '.test-out', 'integration');
await build({
  entryPoints: ['test/integration/launch.ts', 'test/integration/suite.ts'].map((p) => path.join(root, p)),
  outdir, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
  banner: { js: `'use strict';require(${JSON.stringify(path.join(root, 'scripts/test-guard.cjs'))});` },
});
const result = spawnSync(process.execPath, [path.join(outdir, 'launch.js')], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
