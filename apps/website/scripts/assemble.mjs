/**
 * Puts the other two built pieces into the site: the playground's scripts, workers and `.wasm` beside the page
 * Astro builds at /playground/, and the API reference at /api/. Both must be built
 * first (website:build depends on them).
 */
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(SITE, '../..');
const DIST = join(SITE, 'dist');

const parts = [
  ['apps/playground/.build', 'playground', 'npm exec nx -- run playground:build'],
  ['dist/api', 'api', 'npm run docs:api'],
];
for (const [from, to, how] of parts) {
  const source = join(ROOT, from);
  if (!existsSync(join(source, 'index.html'))) {
    console.error(`assemble: ${from}/index.html is missing. Build it first: ${how}`);
    process.exit(1);
  }
  // The playground's own index.html is for its standalone page: the site has its own page at /playground/,
  // built by Astro around the playground's markup (src/pages/playground.astro), which must not be overwritten.
  const keep = (file) => !(to === 'playground' && file === join(source, 'index.html'));
  cpSync(source, join(DIST, to), { recursive: true, filter: keep });
}
// GitHub Pages serves the custom domain from this file, and `.nojekyll` stops it processing the files.
writeFileSync(join(DIST, 'CNAME'), 'typedblite.dev\n');
writeFileSync(join(DIST, '.nojekyll'), '');
console.log('assemble: playground and API reference are in dist/');
