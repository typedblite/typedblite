import { fileURLToPath } from 'node:url';
import { serveDirectory } from './static-server.js';

/** `nx run playground:serve`: the built playground, at http://127.0.0.1:4400 (PLAYGROUND_PORT to change). */
const BUILD = fileURLToPath(new URL('../../.build', import.meta.url));
const { url } = await serveDirectory(BUILD, Number(process.env['PLAYGROUND_PORT'] ?? 4400));
console.log(`TypeDBLite playground on ${url}`);
