/**
 * In `astro dev`, serves the two pieces that are built elsewhere and only assembled into `dist/` by
 * scripts/assemble.mjs: the playground at /playground/ and the API reference at /api/. Without this the
 * dev server answers 404 for both, and so for every sidebar link to them. `website:dev` builds them first.
 * Nothing is copied: the folders are read in place. It applies to the dev server only.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const MOUNTS = { '/playground': join(ROOT, 'apps/playground/.build'), '/api': join(ROOT, 'dist/api') };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function mountBuilt() {
  return {
    name: 'typedblite-mount-built',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const mount = Object.keys(MOUNTS).find((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
          if (!mount) return next();
          if (url.pathname === mount) {
            response.writeHead(301, { location: `${mount}/${url.search}` }).end();
            return;
          }
          const base = MOUNTS[mount];
          let file = normalize(join(base, decodeURIComponent(url.pathname.slice(mount.length))));
          if (file !== base && !file.startsWith(base + sep)) return next(); // no `..` out of the folder
          if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
          if (!existsSync(file)) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end(
              existsSync(base)
                ? `Not found: ${url.pathname}`
                : `${mount}/ is not built. Run: npm exec nx -- run website:dev (it builds the playground and the API first).`,
            );
            return;
          }
          response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
          createReadStream(file).pipe(response);
        });
      },
    },
  };
}
