/**
 * `nx run sync-demo:serve` — the demo server, the hub, and the client build, on one port.
 *
 *   DEMO_PORT (4300)   DEMO_HOST (127.0.0.1; 0.0.0.0 to reach it from another machine)
 *   HUB_PORT  (4310)   DEMO_DATA (apps/sync-demo/.data)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDemoServer } from './server.js';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const server = await startDemoServer({
  port: Number(process.env['DEMO_PORT'] ?? 4300),
  host: process.env['DEMO_HOST'] ?? '127.0.0.1',
  hubPort: Number(process.env['HUB_PORT'] ?? 4310),
  dataDir: process.env['DEMO_DATA'] ?? join(APP, '.data'),
  clientDir: join(APP, '.build'),
});

const shutdown = (): void => void server.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
