/**
 * ADR-009 in a real browser: the engine runs in a Web Worker on WASM SQLite with OPFS, a store
 * survives closing the WHOLE browser, a duplicate key is refused as on Node, and 🔴 every revision the
 * browser computes equals the one Node computes for the same writes (ADR-009 D5).
 *
 * `nx run typedblite-runtime:test-browser`. Needs Playwright's Chromium (`npx playwright-core install
 * chromium`); it builds the runtime first, because the worker imports the package as a user would.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type BrowserContext } from 'playwright-core';

import { TypeDBLiteInterpreter } from '../src/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WASM = fileURLToPath(new URL('../../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm', import.meta.url));
const PAGE = `<!doctype html><meta charset="utf-8"><title>TypeDBLite OPFS test</title><script>
  window.ask = (message) => new Promise((resolve) => {
    window.worker ??= new Worker('/worker.js', { type: 'module' });
    window.worker.onmessage = (event) => resolve(event.data);
    window.worker.postMessage(message);
  });
</script>`;
const NOTES: Array<[string, string]> = [['n1', 'first'], ['n2', "second, with 'quotes' and €"], ['n3', 'third']];

let root: string;
let server: Server;
let origin: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'typedblite-opfs-'));
  const site = join(root, 'site');
  mkdirSync(site);
  await build({
    entryPoints: [join(HERE, 'worker.ts')],
    outfile: join(site, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'error',
  });
  copyFileSync(WASM, join(site, 'sqlite3.wasm'));
  const types: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm' };
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') return void response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    try {
      const body = readFileSync(join(site, path.slice(1)));
      response.writeHead(200, { 'content-type': types[path.split('.').pop() ?? ''] ?? 'application/octet-stream' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** A whole browser on one profile: closing it ends every process, so what survives is on disk. */
async function session<T>(work: (ask: (message: unknown) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const context: BrowserContext = await chromium.launchPersistentContext(join(root, 'profile'), { headless: true });
  try {
    const page = await context.newPage();
    await page.goto(origin);
    return await work((message) => page.evaluate((m) => (window as unknown as { ask: (x: unknown) => Promise<Record<string, unknown>> }).ask(m), message));
  } finally {
    await context.close();
  }
}

describe('TypeDBLite in Chromium, on WASM SQLite and OPFS', () => {
  it('keeps a store across a full browser restart, and computes the revisions Node computes', async () => {
    const written = await session(async (ask) => {
      const answer = await ask({ type: 'write', notes: NOTES });
      assert.equal(answer['ok'], true, String(answer['message']));
      return answer;
    });
    assert.deepEqual(written['notes'], NOTES);

    const reread = await session(async (ask) => ask({ type: 'read' }));
    assert.equal(reread['ok'], true, String(reread['message']));
    assert.deepEqual(reread['notes'], NOTES, 'the notes survived closing the whole browser');
    assert.ok((reread['pool'] as { files: string[] }).files.some((file) => file.endsWith('notes.db')), 'the store is an OPFS file');

    const node = new TypeDBLiteInterpreter(':memory:');
    node.define(`define entity note, owns note-id @key, owns body; attribute note-id, value string; attribute body, value string;`);
    for (const [id, body] of NOTES) node.execute(`insert $n isa note, has note-id "${id}", has body "${body}";`);
    assert.deepEqual(reread['revisions'], node.changeLog.since(0, 1000).map((record) => [record.entityId, record.rev]));
    node.close();
  }, 120_000);

  it('refuses a duplicate key with the same diagnostic as on Node', async () => {
    const answer = await session(async (ask) => ask({ type: 'duplicate' }));
    assert.equal(answer['refused'], true);
    assert.equal(answer['code'], 'typedblite.constraint-violated');
    assert.match(String(answer['message']), /\[CNT9\]/);
  }, 120_000);

  it('runs on a Chromium that has Object.groupBy (ADR-009 D6)', async () => {
    const answer = await session(async (ask) => ask({ type: 'read' }));
    assert.equal(answer['groupBy'], 'function');
  }, 120_000);
});
