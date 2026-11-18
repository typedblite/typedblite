/**
 * A static file server for the in-browser hub's build: what `serve` runs, and what the browser tests load the page
 * from. Loopback only, GET and HEAD only, nothing served from outside its folder, and never cached, so a rebuild is
 * seen on reload. It sends no COOP/COEP headers on purpose: the SAH-pool VFS needs no `SharedArrayBuffer`, and the
 * page working without them is part of what the tests check.
 *
 * `prefix` mounts the folder under a path (`/sync-demo`), as the website does, so a test can prove the page does not
 * assume it is at `/`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServerOptions {
  /** 0 picks a free port. Default 0. */
  readonly port?: number;
  /** Serve the folder under this path, with no trailing slash: `/sync-demo`. Default none. */
  readonly prefix?: string;
}

export interface StaticServer {
  /** `http://127.0.0.1:<port>`, plus the prefix, with a trailing slash. */
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export function startStaticServer(folder: string, options: StaticServerOptions = {}): Promise<StaticServer> {
  const root = resolve(folder);
  const prefix = options.prefix ?? '';
  const server = createServer((request, response) => {
    const text = (status: number, message: string, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(message);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed', { allow: 'GET, HEAD' });

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    } catch {
      return text(400, 'Bad request');
    }
    if (prefix) {
      if (pathname === prefix) return void response.writeHead(301, { location: `${prefix}/` }).end();
      if (!pathname.startsWith(`${prefix}/`)) return text(404, `Not found: ${pathname}`);
      pathname = pathname.slice(prefix.length);
    }
    let file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) return text(403, 'Forbidden');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return text(404, `Not found: ${pathname}`);

    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    if (request.method === 'HEAD') return void response.end();
    createReadStream(file).pipe(response);
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveStart({
        url: `http://127.0.0.1:${port}${prefix}/`,
        server,
        close: () => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))),
      });
    });
  });
}
