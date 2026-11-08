/**
 * A hub that wants credentials: the stream mounted under its own routes behind its own check, and a
 * spoke that presents them.
 *
 * 🔴 The refusal cases matter more than the success: a spoke whose token expired must *fail*, not
 * quietly receive nothing — a pull that returned an empty list on 401 looked exactly like a spoke
 * that was in sync.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { createChangeStreamHandler } from '../src/change-stream.js';
import { ChangeStreamClient } from '../src/change-stream-client.js';
import { TypeDBLiteReplicator } from '../src/typedblite-replicator.js';
import { readKeyedSkillsSchema } from './fixtures/keyed-skills-schema.js';

const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const schema = readKeyedSkillsSchema(join(SCHEMAS, 'skills.schema.typeqlite'));
const node = () => {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(schema);
  return db;
};
const addSkill = (db: TypeDBLiteInterpreter, id: string) =>
  db.execute(`insert $s isa skill, has skill-id "${id}", has skill-name "n";`);
const skills = (db: TypeDBLiteInterpreter): string[] =>
  db.changeLog
    .since(0)
    .map((r) => r.entityId)
    .sort();

/** A hub that serves `log` under /orgs/acme/changes and wants `Bearer good`. */
async function hub(db: TypeDBLiteInterpreter) {
  const stream = createChangeStreamHandler(db.changeLog, {
    pollMs: 30,
    path: '/orgs/acme/changes',
  });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== 'Bearer good') {
      response.writeHead(401);
      response.end();
      return;
    }
    stream.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/orgs/acme`;
  return {
    url,
    requests,
    close: async () => {
      stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('a hub behind a credential', () => {
  it('lets a spoke that presents it push and pull, and mounts the stream under a route of its own', async () => {
    const hubDb = node();
    addSkill(hubDb, 'from-hub');
    const spokeDb = node();
    addSkill(spokeDb, 'from-spoke');
    const server = await hub(hubDb);
    try {
      const replicator = new TypeDBLiteReplicator(
        spokeDb.changeLog,
        server.url,
        30,
        () => ({ authorization: 'Bearer good' }),
      );
      await replicator.replicateOnce({ direction: 'duplex' });

      assert.ok(skills(spokeDb).includes('skill/from-hub'));
      assert.ok(skills(hubDb).includes('skill/from-spoke'));
    } finally {
      await server.close();
    }
  });

  it('🔴 fails a pull that is refused, rather than reporting nothing to pull', async () => {
    const server = await hub(node());
    try {
      for (const headers of [
        () => ({}),
        () => ({ authorization: 'Bearer wrong' }),
      ]) {
        const replicator = new TypeDBLiteReplicator(
          node().changeLog,
          server.url,
          30,
          headers,
        );
        await assert.rejects(
          replicator.replicateOnce({ direction: 'pull' }),
          /pull refused: 401/,
        );
      }
    } finally {
      await server.close();
    }
  });

  it('refuses a push without the credential', async () => {
    const spokeDb = node();
    addSkill(spokeDb, 'x');
    const server = await hub(node());
    try {
      const client = new ChangeStreamClient(server.url);
      await assert.rejects(
        client.push(spokeDb.changeLog.since(0)),
        /push failed: 401/,
      );
    } finally {
      await server.close();
    }
  });

  it('asks for the credential again on every request, so a refreshed token is used', async () => {
    const server = await hub(node());
    let calls = 0;
    try {
      const client = new ChangeStreamClient(server.url, {
        headers: async () => {
          calls += 1;
          return { authorization: 'Bearer good' };
        },
      });
      await client.push([]);
      await client.push([]);
      assert.equal(calls, 2);
      assert.deepEqual(
        await new ChangeStreamClient(server.url).requestHeaders(),
        {},
      );
    } finally {
      await server.close();
    }
  });

  it('answers a path it is not mounted at with a 404', async () => {
    const stream = createChangeStreamHandler(node().changeLog, {
      path: '/orgs/acme/changes',
    });
    const server = createServer(stream.handle);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${base}/changes`)).status, 404);
      assert.equal(
        (await fetch(`${base}/orgs/acme/changes`, { method: 'PUT' })).status,
        404,
      );
    } finally {
      stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
