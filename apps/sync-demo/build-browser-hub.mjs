/**
 * The in-browser hub's build: the page, the hub Worker, the device engine and the device page, bundled by esbuild for
 * the browser with SQLite's `.wasm`, into `.build-browser/`. The bundler's `browser` condition selects
 * `@typedblite/runtime`'s browser entry (ADR-009 D3); nothing is aliased. Every URL is relative and the scripts find
 * their workers and the `.wasm` beside themselves (`import.meta.url`), so `.build-browser/` can be served from any
 * path, and the website serves it at `/sync-demo/` (apps/website/src/pages/sync-demo.astro reads `app.html`).
 *
 * `device.html` is the shipped device page (`src/client/index.html`) with this feature's three differences made at
 * build time, so there is no second copy of its markup and styles to drift: no PWA manifest, a Disconnect /
 * Reconnect switch in the card header, and the light and dark palettes keyed on `data-theme`, which the page takes
 * from the page that embeds it.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '.build-browser');
const SRC = join(HERE, 'src/browser-hub');
const require = createRequire(import.meta.url);
const WASM = join(dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json')), 'dist/sqlite3.wasm');
const minify = process.argv.includes('--minify');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const common = { bundle: true, platform: 'browser', target: 'es2022', format: 'esm', logLevel: 'warning', sourcemap: true, minify };
for (const [entry, out] of [
  ['hub-worker.ts', 'hub.js'],
  ['device-worker.ts', 'device-worker.js'],
  ['device-page.ts', 'device.js'],
  ['page.ts', 'page.js'],
]) {
  await build({ ...common, entryPoints: [join(SRC, entry)], outfile: join(OUT, out) });
}
copyFileSync(WASM, join(OUT, 'sqlite3.wasm'));

// The page: a markup fragment shared by two pages, the standalone one (index.html, which this puts it in) and the
// website's, which wraps it in Starlight's layout.
const app = readFileSync(join(SRC, 'app.html'), 'utf8');
writeFileSync(join(OUT, 'app.html'), app);
writeFileSync(join(OUT, 'index.html'), readFileSync(join(SRC, 'index.html'), 'utf8').replace('<!--@APP-->', app));
copyFileSync(join(SRC, 'app.css'), join(OUT, 'app.css'));

// The device page, derived from the shipped one.
const shipped = readFileSync(join(HERE, 'src/client/index.html'), 'utf8');
const palette = (css) => css.match(/\{([^{}]*)\}/)?.[1]?.trim();
const light = palette(shipped.match(/^\s*:root\s*(\{[^}]*\})/m)?.[1] ?? '');
const dark = palette(shipped.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*(:root\s*\{[^}]*\})/)?.[1] ?? '');
if (!light || !dark) throw new Error('src/client/index.html no longer has the :root palettes this build reads');
const device = shipped
  .replace('/main.js', 'device.js')
  .replace(/<link rel="manifest"[^>]*>\n?/, '')
  .replace(/<link rel="icon"[^>]*>\n?/, '')
  .replace(
    '</style>',
    [
      '  /* The embedding page\'s theme, when it has one (device-page.ts): the same palettes, keyed on data-theme. */',
      `  :root[data-theme="light"] { ${light} }`,
      `  :root[data-theme="dark"] { ${dark} }`,
      '  /* This device\'s own switch, in its card header. */',
      '  header { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }',
      '  header h1 { flex: 1; }',
      '  #link { font: inherit; font-size: 13px; font-weight: 600; padding: 4px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink); cursor: pointer; }',
      '  #link[aria-pressed="true"] { background: var(--off); border-color: var(--off); color: #fff; }',
      '  header #status, header #pending { flex-basis: 100%; }',
      '</style>',
    ].join('\n'),
  )
  .replace('<h1>Tasks <small id="device"></small></h1>', '<h1>Tasks <small id="device"></small></h1>\n  <button id="link" type="button" aria-pressed="false">Disconnect</button>');
if (!device.includes('id="link"') || device.includes('/main.js') || /(?:href|src)="\//.test(device)) throw new Error('the device page was not derived as expected');
writeFileSync(join(OUT, 'device.html'), device);
console.log(`in-browser hub built into ${OUT}`);
