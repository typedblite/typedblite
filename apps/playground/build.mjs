/**
 * The playground build: the page and its worker, bundled by esbuild for the browser, with SQLite's
 * `.wasm`, the static shell and the logo, into `.build/`. The bundler's `browser` condition selects
 * `@typedblite/runtime`'s browser entry (ADR-009 D3); nothing is aliased. Every URL in the page is
 * relative, so `.build/` can be served from any path, and the scripts find the workers and the `.wasm` beside
 * themselves (`import.meta.url`), so the page that loads them may be at a different URL.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '.build');
const SRC = join(HERE, 'src');
const BRAND = join(HERE, '../../docs/brand');
const require = createRequire(import.meta.url);
const WASM = join(dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json')), 'dist/sqlite3.wasm');
// Monaco's package root, found from its CommonJS entry (`<root>/min/vs/index.js`) so that a hoisted install
// does not matter. Its `exports` map reaches `esm/vs/**` only.
const MONACO = join(dirname(require.resolve('monaco-editor')), '../..');
const minify = process.argv.includes('--minify');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const common = { bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'warning', sourcemap: true, minify };
await build({ ...common, entryPoints: [join(SRC, 'worker.ts')], outfile: join(OUT, 'worker.js') });
await build({ ...common, entryPoints: [join(SRC, 'language-worker.ts')], outfile: join(OUT, 'language-worker.js') });
// Monaco's own worker (word-based features, diffing), as the standalone editor asks for it.
await build({ ...common, entryPoints: [join(MONACO, 'esm/vs/editor/editor.worker.js')], outfile: join(OUT, 'editor.worker.js') });
// The page. Monaco's CSS comes out beside it as main.css, and its icon font is copied next to that.
await build({
  ...common,
  entryPoints: [join(SRC, 'main.ts')],
  outfile: join(OUT, 'main.js'),
  alias: { 'monaco-lsp-client': join(MONACO, 'esm/external/monaco-lsp-client/out/index.js') },
  loader: { '.ttf': 'file' },
  assetNames: '[name]',
});
copyFileSync(WASM, join(OUT, 'sqlite3.wasm'));
// The page's markup is a fragment shared by two pages: the standalone one (index.html, which this puts it in) and
// the website's, which wraps it in Starlight's layout (apps/website/src/pages/playground.astro reads app.html).
const app = readFileSync(join(SRC, 'app.html'), 'utf8');
writeFileSync(join(OUT, 'app.html'), app);
writeFileSync(join(OUT, 'index.html'), readFileSync(join(SRC, 'index.html'), 'utf8').replace('<!--@APP-->', app));
copyFileSync(join(SRC, 'app.css'), join(OUT, 'app.css'));
copyFileSync(join(BRAND, 'typedblite-logo.svg'), join(OUT, 'logo.svg'));
copyFileSync(join(BRAND, 'typedblite-logo-dark.svg'), join(OUT, 'logo-dark.svg'));
copyFileSync(join(BRAND, 'typedblite-icon.svg'), join(OUT, 'logo-icon.svg'));
console.log(`playground built into ${OUT}`);
