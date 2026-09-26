import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Ship the codicon font with the extension (node_modules is not included in the vsix)
mkdirSync('dist/media', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) {
  copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/media/${f}`);
}

const contexts = await Promise.all([
  // Extension host
  esbuild.context({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['vscode'],
    sourcemap: true,
  }),
  // Sidebar Webview frontend
  esbuild.context({
    entryPoints: { panel: 'src/webview/main.ts', 'panel-style': 'src/webview/panel.css' },
    outdir: 'dist/media',
    entryNames: '[name]',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    define: { __PLANSWAP_VERSION__: JSON.stringify(version) },
    target: 'es2022',
    minify: !watch,
    sourcemap: watch,
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
