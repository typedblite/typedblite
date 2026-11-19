/**
 * The playground build: the page and its worker, bundled by esbuild for the browser, with SQLite's
 * `.wasm`, the static shell and the logo, into `.build/`. The bundler's `browser` condition selects
 * `@typedblite/runtime`'s browser entry (ADR-009 D3); nothing is aliased. Every URL in the page is
 * relative, so `.build/` can be served from any path, and the scripts find the workers and the `.wasm` beside
 * themselves (`import.meta.url`), so the page that loads them may be at a different URL.
 */
import { build } from 'esbuild';
import MarkdownIt from 'markdown-it';
import { parseNotebook } from '@typedblite/notebook';
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
const NUNITO = join(dirname(require.resolve('@fontsource-variable/nunito/package.json')), 'files/nunito-latin-wght-normal.woff2');
const minify = process.argv.includes('--minify');
const GUIDE = join(HERE, '../../docs/guides/try-it.tql.md');
/**
 * Where the guide's relative links go on the website, from the page at `/try/`. A link to anything else is a build error, so a
 * guide cannot link somewhere the site does not have.
 */
const LINKS = {
  'five-minute-tour.tql.md': '../guide/five-minute-tour/',
  'typeqlite-language.md': '../guide/typeqlite-language/',
  'getting-started.md': '../guide/getting-started/',
};

/**
 * The browser notebook's cells, from the guide (`docs/guides/try-it.tql.md`, which is also a notebook in VS Code): its code
 * cells as they are, and its Markdown as HTML made here, with raw HTML switched off. The guide's printed answers
 * (`tour:expect` blocks) are left out, because the page shows the real ones beneath each cell, and its leading title,
 * because the page around it has its own.
 */
function notebookData() {
  const md = new MarkdownIt({ html: false, linkify: false });
  const open = md.renderer.rules.link_open ?? ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const href = tokens[i].attrGet('href') ?? '';
    if (!/^(https?:|#)/.test(href)) {
      const [path, fragment] = href.split('#');
      const to = LINKS[path];
      if (to === undefined) throw new Error(`${GUIDE}: the link to ${href} goes nowhere on the site. Add it to LINKS in build.mjs.`);
      tokens[i].attrSet('href', fragment ? `${to}#${fragment}` : to);
    }
    return open(tokens, i, options, env, self);
  };
  const cells = [];
  for (const cell of parseNotebook(readFileSync(GUIDE, 'utf8')).cells) {
    if (cell.kind === 'code') {
      cells.push({ kind: 'code', source: cell.value });
      continue;
    }
    const prose = cell.value.replace(/<!--\s*tour:expect[^>]*-->\s*```[^\n]*\n[\s\S]*?```[ \t]*\n?/g, '').replace(/^# .*\n?/, '').trim();
    if (prose !== '') cells.push({ kind: 'markup', html: md.render(prose) });
  }
  return { cells };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const common = { bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'warning', sourcemap: true, minify };
await build({ ...common, entryPoints: [join(SRC, 'worker.ts')], outfile: join(OUT, 'worker.js') });
await build({ ...common, entryPoints: [join(SRC, 'language-worker.ts')], outfile: join(OUT, 'language-worker.js') });
// The browser notebook's engine: the same WASM SQLite in a worker of its own, answering the kernel's operations.
await build({ ...common, entryPoints: [join(SRC, 'notebook/kernel-worker.ts')], outfile: join(OUT, 'kernel-worker.js') });
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
// The browser notebook's page. Monaco's CSS comes out beside it as notebook.css; the notebook's own styles are nb.css.
await build({
  ...common,
  entryPoints: [join(SRC, 'notebook/notebook.ts')],
  outfile: join(OUT, 'notebook.js'),
  alias: { 'monaco-lsp-client': join(MONACO, 'esm/external/monaco-lsp-client/out/index.js') },
  loader: { '.ttf': 'file' },
  assetNames: '[name]',
});
writeFileSync(join(OUT, 'try-data.json'), JSON.stringify(notebookData()));
copyFileSync(WASM, join(OUT, 'sqlite3.wasm'));
// The standalone page's heading font (the website's page has its own copy), subset to Latin.
copyFileSync(NUNITO, join(OUT, 'nunito.woff2'));
// The page's markup is a fragment shared by two pages: the standalone one (index.html, which this puts it in) and
// the website's, which wraps it in Starlight's layout (apps/website/src/pages/playground.astro reads app.html).
const app = readFileSync(join(SRC, 'app.html'), 'utf8');
writeFileSync(join(OUT, 'app.html'), app);
writeFileSync(join(OUT, 'index.html'), readFileSync(join(SRC, 'index.html'), 'utf8').replace('<!--@APP-->', app));
copyFileSync(join(SRC, 'app.css'), join(OUT, 'app.css'));
// The notebook's markup is a fragment too: the standalone page (try.html) and the website's (/try/) both put it in.
const notebook = readFileSync(join(SRC, 'notebook.html'), 'utf8');
writeFileSync(join(OUT, 'notebook.html'), notebook);
writeFileSync(join(OUT, 'try.html'), readFileSync(join(SRC, 'try.html'), 'utf8').replace('<!--@APP-->', notebook));
copyFileSync(join(SRC, 'nb.css'), join(OUT, 'nb.css'));
copyFileSync(join(BRAND, 'typedblite-logo.svg'), join(OUT, 'logo.svg'));
copyFileSync(join(BRAND, 'typedblite-logo-dark.svg'), join(OUT, 'logo-dark.svg'));
copyFileSync(join(BRAND, 'typedblite-icon.svg'), join(OUT, 'logo-icon.svg'));
console.log(`playground built into ${OUT}`);
