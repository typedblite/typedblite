/**
 * The demo's hub: a TypeDBLite store that the devices replicate through. Run as a child process of
 * the demo server, so "the hub goes down" stops a real process — and its store, a file, is still
 * there when it comes back.
 *
 * It serves TypeDBLite's own change stream (`createChangeStreamHandler`: SSE out, POST in) behind a
 * bearer token, and `/tasks` for the control page. It listens on 127.0.0.1 only; devices reach it
 * through the demo server's switchboard.
 */
import { createServer } from 'node:http';
import { TypeDBLiteInterpreter, createChangeStreamHandler } from '@typedblite/runtime';

import { DEMO_TOKEN } from '../shared/device.js';
import { SCHEMA, readTasks } from '../shared/schema.js';

const path = process.env['HUB_DB'] ?? 'hub.db';
const port = Number(process.env['HUB_PORT'] ?? 4310);

const db = new TypeDBLiteInterpreter(path);
db.define(SCHEMA);
const changes = createChangeStreamHandler(db.changeLog, { pollMs: 200, path: '/changes' });

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://hub');
  if (url.pathname === '/health') return void response.writeHead(200).end('ok');
  if (url.pathname === '/tasks') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return void response.end(JSON.stringify(readTasks(db)));
  }
  if (url.pathname === '/changes') {
    if (request.headers.authorization !== `Bearer ${DEMO_TOKEN}`) return void response.writeHead(401).end();
    return changes.handle(request, response);
  }
  response.writeHead(404).end();
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  process.send?.({ type: 'ready', port: bound });
  if (!process.send) console.log(`TypeDBLite hub on http://127.0.0.1:${bound}, store ${path}`);
});

const stop = (): void => {
  changes.close();
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
