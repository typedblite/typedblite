/**
 * `nx run sync-demo:browser-hub`: serve the in-browser hub's build on http://127.0.0.1:4400/ (or `PORT`).
 * Build it first: `nx run sync-demo:build-browser`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer } from './static-server.js';

const BUILD = join(fileURLToPath(new URL('.', import.meta.url)), '../../.build-browser');
if (!existsSync(join(BUILD, 'index.html'))) {
  console.error(`No build at ${BUILD}. Run: npm exec nx -- run sync-demo:build-browser`);
  process.exit(1);
}
const server = await startStaticServer(BUILD, { port: Number(process.env['PORT'] ?? 4400) });
console.log(`TypeDBLite hub in the browser: ${server.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void server.close().then(() => process.exit(0)));
