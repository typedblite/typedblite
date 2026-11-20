// SPIKE: bundle the Durable Object Worker (for workerd) and the Node baseline.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;

await build({
  entryPoints: [`${here}src/store.ts`],
  outfile: `${here}dist/worker.js`,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['browser', 'module', 'main'],
  external: ['cloudflare:workers'],
  logLevel: 'warning',
});

await build({
  entryPoints: [`${here}src/node-baseline.ts`],
  outfile: `${here}dist/node-baseline.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
});

const size = statSync(`${here}dist/worker.js`).size;
const gzip = gzipSync(readFileSync(`${here}dist/worker.js`)).length;
console.log(`worker.js: ${(size / 1024).toFixed(0)} KiB, ${(gzip / 1024).toFixed(0)} KiB gzipped`);
