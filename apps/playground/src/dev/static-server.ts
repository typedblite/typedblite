import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/**
 * Serves a directory, for trying the playground locally and for its browser test.
 *
 * Not a production server, and not meant to be exposed: it binds `127.0.0.1`. It does refuse a path
 * that climbs out of the directory, because "serve a folder" is exactly where that mistake lives.
 */
export function serveDirectory(directory: string, port = 0): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const root = resolve(directory);
  const server = createServer((request, response) => {
    void (async () => {
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      } catch {
        return void response.writeHead(400).end('bad request');
      }
      const file = normalize(join(root, path === '/' ? 'index.html' : path));
      if (file !== root && !file.startsWith(root + sep)) return void response.writeHead(403).end('forbidden');
      try {
        const body = await readFile(file);
        response
          .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
          .end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    })();
  });
  return new Promise((resolveListening) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolveListening({
        server,
        url: `http://127.0.0.1:${bound}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
