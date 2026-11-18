/**
 * SPIKE build: the hub Worker, the device engine and page, and the hub page, into `.build-spike/`
 * with a static server (`node build-spike.mjs --serve [port]`). No special headers: the SAH-pool VFS
 * needs no SharedArrayBuffer, so no COOP/COEP.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '.build-spike');
const SRC = join(HERE, 'src/spike');
const require = createRequire(import.meta.url);
const WASM = join(dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json')), 'dist/sqlite3.wasm');

if (!process.argv.includes('--no-build')) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const common = { bundle: true, platform: 'browser', target: 'es2022', format: 'esm', logLevel: 'warning', sourcemap: true };
  for (const [entry, out] of [['hub-worker.ts', 'spike-hub.js'], ['device-worker.ts', 'spike-device-worker.js'], ['device-page.ts', 'spike-device.js'], ['hub-panel.ts', 'spike-page.js']]) {
    await build({ ...common, entryPoints: [join(SRC, entry)], outfile: join(OUT, out) });
  }
  copyFileSync(WASM, join(OUT, 'sqlite3.wasm'));
  copyFileSync(join(SRC, 'index.html'), join(OUT, 'index.html'));
  // The device page is the shipped one, pointed at the spike's script and without the PWA manifest.
  const device = readFileSync(join(HERE, 'src/client/index.html'), 'utf8')
    .replace('/main.js', '/spike-device.js')
    .replace(/<link rel="manifest"[^>]*>\n?/, '')
    .replace(/<link rel="icon"[^>]*>\n?/, '');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(OUT, 'device.html'), device);
  console.log(`spike built into ${OUT}`);
}

const serve = process.argv.indexOf('--serve');
if (serve !== -1) {
  const port = Number(process.argv[serve + 1] ?? 4400);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' };
  createServer((request, response) => {
    const path = normalize(new URL(request.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(OUT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(OUT) || !existsSync(file)) return void response.writeHead(404).end();
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => console.log(`spike on http://127.0.0.1:${port}/`));
}
