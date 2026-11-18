/**
 * Puts the playground's and the sync demo's scripts, workers and `.wasm` beside the pages Astro builds at /playground/ and /sync-demo/. (The API reference
 * is Astro's too: starlight-typedoc writes it as pages, see astro.config.mjs.) Both must be built
 * first (website:build depends on them).
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(SITE, '../..');
const DIST = join(SITE, 'dist');

const parts = [
  ['apps/playground/.build', 'playground', 'npm exec nx -- run playground:build'],
  ['apps/sync-demo/.build-browser', 'sync-demo', 'npm exec nx -- run sync-demo:build-browser'],
];
for (const [from, to, how] of parts) {
  const source = join(ROOT, from);
  if (!existsSync(join(source, 'index.html'))) {
    console.error(`assemble: ${from}/index.html is missing. Build it first: ${how}`);
    process.exit(1);
  }
  // Each one's own index.html is for its standalone page: the site has its own page at /playground/ and /sync-demo/,
  // built by Astro around the same markup (src/pages/playground.astro, sync-demo.astro), which must not be overwritten.
  const keep = (file) => file !== join(source, 'index.html');
  cpSync(source, join(DIST, to), { recursive: true, filter: keep });
}
console.log('assemble: the playground and the sync demo are in dist/');
