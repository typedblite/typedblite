/**
 * ADR-009 D7: a spoke never reports itself in sync when it is not.
 *
 * 🔴 `fetchSince` returned an empty list for any non-OK answer but 401/403, so a spoke whose hub
 * answered 503 — a hub that is down behind a proxy — counted as caught up. Found by a downstream
 * offline demo, whose "the hub goes down" step could not show an offline device without a workaround.
 * A stream cut before the hub's caught-up marker, and a hub that accepts and then says nothing, are
 * the same lie by other routes.
 */
import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { createChangeStreamHandler } from '../src/change-stream.js';
import { TypeDBLiteReplicator } from '../src/typedblite-replicator.js';

const SCHEMA = `define entity note, owns note-id @key; attribute note-id, value string;`;
const servers: Server[] = [];

async function hub(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function spoke(): TypeDBLiteInterpreter {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(SCHEMA);
  return db;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('a spoke whose hub is not answering properly', () => {
  it('fails when the hub answers 503, instead of reporting itself in sync', async () => {
    const url = await hub((_request, response) => void response.writeHead(503).end('down'));
    const replicator = new TypeDBLiteReplicator(spoke().changeLog, url);
    await assert.rejects(replicator.replicateOnce({ direction: 'pull' }), /pull failed: the hub answered 503/);
    await assert.rejects(replicator.replicateOnce({ direction: 'duplex' }), /pull failed: the hub answered 503/);
  });

  it('fails when the stream ends before the hub says it is caught up', async () => {
    const url = await hub((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(); // cut off: no `: caught-up`
    });
    const replicator = new TypeDBLiteReplicator(spoke().changeLog, url);
    await assert.rejects(replicator.replicateOnce({ direction: 'pull' }), /ended before the hub reported it was caught up/);
  });

  it('fails within timeoutMs when the hub accepts and then says nothing', async () => {
    const url = await hub(() => undefined); // never answers
    const replicator = new TypeDBLiteReplicator(spoke().changeLog, url);
    const started = Date.now();
    await assert.rejects(replicator.replicateOnce({ direction: 'duplex', timeoutMs: 300 }), /no answer from the hub within 300 ms/);
    assert.ok(Date.now() - started < 5_000, 'the timeout, not the socket, ended it');
  });

  it('fails a push the hub refuses', async () => {
    const url = await hub((_request, response) => void response.writeHead(500).end());
    const db = spoke();
    db.execute(`insert $n isa note, has note-id "n1";`);
    await assert.rejects(new TypeDBLiteReplicator(db.changeLog, url).replicateOnce({ direction: 'push' }), /push failed: 500/);
  });

  it('still syncs with a healthy hub, timeout or not', async () => {
    const center = spoke();
    const handler = createChangeStreamHandler(center.changeLog, { pollMs: 50 });
    const url = await hub(handler.handle);
    const db = spoke();
    db.execute(`insert $n isa note, has note-id "n1";`);
    const outcome = await new TypeDBLiteReplicator(db.changeLog, url).replicateOnce({ direction: 'duplex', timeoutMs: 5_000 });
    assert.equal(outcome.cursor.push, 1);
    assert.deepEqual(center.query(`match $n isa note, has note-id $i; select $i;`).rows.map((row) => row.i.asString()), ['n1']);
    handler.close();
  });
});
