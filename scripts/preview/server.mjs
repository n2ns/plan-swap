import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.resolve(here, '../../dist/media');
const files = new Map([
  ['/media/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
  ['/media/panel-style.css', ['panel-style.css', 'text/css; charset=utf-8']],
  ['/media/codicon.css', ['codicon.css', 'text/css; charset=utf-8']],
  ['/media/codicon.ttf', ['codicon.ttf', 'font/ttf']],
]);

export async function startPreview({ port = 0 } = {}) {
  const fixture = await build({
    entryPoints: [path.join(here, 'fixture.ts')], bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent',
  });
  const html = await readFile(path.join(here, 'index.html'));
  const fixtureJs = fixture.outputFiles[0].contents;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    try {
      if (pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(html);
      } else if (pathname === '/fixture.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(fixtureJs);
      } else if (files.has(pathname)) {
        const [name, type] = files.get(pathname);
        const content = await readFile(path.join(media, name));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(content);
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Preview listener has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preview = await startPreview({ port: 8768 });
  console.log(preview.url);
  process.once('SIGINT', () => { void preview.close().then(() => process.exit(0)); });
}
