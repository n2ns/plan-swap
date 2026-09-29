// Run isolated synthetic account-info measurements without touching the test suite's output directory.
import * as esbuild from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'planswap-perf-'));
const output = path.join(temporary, 'accountInfo.cjs');

try {
  await esbuild.build({
    entryPoints: [path.join(root, 'test/perf/accountInfo.ts')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    alias: { vscode: path.join(root, 'test/stubs/vscode.ts') },
    banner: { js: `require(${JSON.stringify(path.join(root, 'scripts/test-guard.cjs'))});` },
    logLevel: 'silent',
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
