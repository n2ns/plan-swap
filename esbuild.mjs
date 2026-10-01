// npm run build / npm run watch: bundles the extension host and the Webview frontend.
// Every frontend asset must land in dist/media/, the Webview's only localResourceRoots entry; frontend dependencies
// cannot be loaded from node_modules at runtime. --watch watches both entries.
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
  // Extension host: Node 22 is the runtime bundled with the oldest supported editor server (VS Code 1.107 core)
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
  // Sidebar Webview frontend (panel.js + panel-style.css); regular builds minify without sourcemaps, watch mode keeps
  // sources readable with sourcemaps. __PLANSWAP_VERSION__ is the manifest version.
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
