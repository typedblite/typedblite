/**
 * The client build: the page, the device worker and the service worker, bundled by esbuild for the
 * browser, with SQLite's `.wasm` and the static shell, into `.build/`. The bundler's `browser`
 * condition selects `@typedblite/runtime`'s browser entry (ADR-009 D3); nothing is aliased.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '.build');
const CLIENT = join(HERE, 'src/client');
const require = createRequire(import.meta.url);
const WASM = join(dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json')), 'dist/sqlite3.wasm');
const minify = process.argv.includes('--minify');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const common = { bundle: true, platform: 'browser', target: 'es2022', logLevel: 'warning', sourcemap: true, minify };
await build({ ...common, format: 'esm', entryPoints: [join(CLIENT, 'worker.ts')], outfile: join(OUT, 'worker.js') });
await build({ ...common, format: 'esm', entryPoints: [join(CLIENT, 'main.ts')], outfile: join(OUT, 'main.js') });
await build({ ...common, format: 'iife', entryPoints: [join(CLIENT, 'sw.ts')], outfile: join(OUT, 'sw.js') });
// The desktop shell: Electron's main process, CommonJS, with Electron itself left to the runtime.
await build({ ...common, sourcemap: false, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: [join(HERE, 'src/electron/main.ts')], outfile: join(OUT, 'electron-main.cjs') });
copyFileSync(WASM, join(OUT, 'sqlite3.wasm'));
for (const file of ['index.html', 'manifest.webmanifest', 'icon.svg']) copyFileSync(join(CLIENT, file), join(OUT, file));
console.log(`client built into ${OUT}`);
