/**
 * Checks the built site in dist/: every internal link, image, script and stylesheet points at a file that
 * exists, every `#fragment` on a page the site generated points at an id on that page, and the pieces the
 * launch depends on are there (the playground, the API reference, the search index, the favicon and the 404 page), and, while the repository is private, that nothing links to it.
 * It reads the HTML as text, so it needs no browser and no dependency.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_PUBLIC, REPO_URL } from './content-map.mjs';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const problems = [];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

if (!existsSync(DIST)) {
  console.error('check-site: dist/ is missing. Run `npm exec nx -- run website:build-site`.');
  process.exit(1);
}

for (const required of ['index.html', 'playground/index.html', 'playground/worker.js', 'playground/sqlite3.wasm', 'sync-demo/index.html', 'sync-demo/device.html', 'sync-demo/devices.css', 'sync-demo/hub.js', 'sync-demo/device-worker.js', 'sync-demo/sqlite3.wasm', 'api/index.html', 'sitemap-index.xml', 'pagefind/pagefind.js', 'favicon.svg', '404.html']) {
  if (!existsSync(join(DIST, required))) problems.push(`dist/${required} is missing`);
}

const pages = walk(DIST).filter((file) => file.endsWith('.html'));
const idsOf = new Map();
const idsIn = (file) => {
  if (!idsOf.has(file)) {
    const html = readFileSync(file, 'utf8');
    idsOf.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return idsOf.get(file);
};

/** The file a site-relative path serves, or undefined. */
function served(path) {
  const clean = decodeURIComponent(path.replace(/^\/+/, ''));
  for (const candidate of [clean, join(clean, 'index.html'), `${clean}.html`]) {
    const file = join(DIST, candidate);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return undefined;
}

let links = 0;
for (const page of pages) {
  const relativePage = page.slice(DIST.length + 1);
  if (relativePage.startsWith('pagefind/')) continue;
  const html = readFileSync(page, 'utf8');
  const base = '/' + dirname(relativePage).replace(/\\/g, '/').replace(/^\.$/, '') + '/';
  for (const match of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const target = match[1];
    // While the repository is private a link to it is a dead link for every visitor (REPO_PUBLIC, content-map.mjs).
    if (!REPO_PUBLIC && target.startsWith(REPO_URL)) problems.push(`${relativePage}: links to the private repository (${target})`);
    if (!target || /^([a-z][a-z0-9+.-]*:|\/\/|data:)/i.test(target)) continue;
    links += 1;
    // A query string is for the page, not a file: `device.html?device=a` is `device.html`.
    const [withQuery, fragment] = target.split('#');
    const pathPart = withQuery.split('?')[0];
    const absolute = pathPart === '' ? base : pathPart.startsWith('/') ? pathPart : new URL(pathPart, `http://x${base}`).pathname;
    const file = served(absolute);
    if (!file) {
      problems.push(`${relativePage}: ${target} -> nothing at ${absolute}`);
    } else if (fragment && file.endsWith('.html') && !file.includes(`${DIST}/playground/`) && !idsIn(file).has(decodeURIComponent(fragment))) {
      problems.push(`${relativePage}: ${target} -> no #${fragment} on ${file.slice(DIST.length + 1)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-site: ${problems.length} problem(s):\n${[...new Set(problems)].map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-site: ${pages.length} pages, ${links} internal references, no broken link`);
