/**
 * The live subscription: delivery, resume, retry, and cancellation that leaves nothing behind.
 *
 * 🔴 Cancellation is tested for a reason the assertions cannot state on their own: a leaked timer
 * or an un-aborted request does not fail a test, it *hangs the process*. If this suite stops
 * exiting, that is the failure.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { serveChangeStream } from '../src/change-stream.js';
import { ChangeStreamClient } from '../src/change-stream-client.js';
import type { ChangeRecord } from '../src/change-log.js';
import { readKeyedTrackerSchema } from './fixtures/keyed-tracker-schema.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const SCHEMA_PATH = join(SCHEMAS, 'tracker.schema.typeqlite');
const schema = readKeyedTrackerSchema(SCHEMA_PATH);

const node = () => {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(schema);
  return db;
};

const addSkill = (db: TypeDBLiteInterpreter, id: string) =>
  db.execute(`insert $s isa project, has project-id "${id}", has project-name "n";`);

/** Wait for a condition, or fail with what was actually seen rather than a bare timeout. */
async function eventually(
  predicate: () => boolean,
  describeState: () => string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition not met within ${timeoutMs}ms — ${describeState()}`);
}

describe('live delivery', () => {
  it('🔴 delivers a change made after the subscription started', async () => {
    const hub = node();
    const stream = serveChangeStream(hub.changeLog, { pollMs: 40 });
    const port = await stream.port;
    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`);

    const received: ChangeRecord[] = [];
    const subscription = client.subscribe({ onChange: (r) => received.push(r) });

    // Write *after* subscribing — the point is that nothing polled for it in the test.
    await new Promise((resolve) => setTimeout(resolve, 100));
    addSkill(hub, 's-1');

    await eventually(
      () => received.some((r) => r.entityId === 'project/s-1'),
      () => `received ${JSON.stringify(received.map((r) => r.entityId))}`,
    );

    await subscription.cancel();
    await stream.close();
    hub.close();
  });

  it('reports paused when caught up, and paused is not terminal', async () => {
    const hub = node();
    addSkill(hub, 's-1');
    const stream = serveChangeStream(hub.changeLog, { pollMs: 40 });
    const port = await stream.port;
    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`);

    let paused = 0;
    const received: ChangeRecord[] = [];
    const subscription = client.subscribe({
      onChange: (r) => received.push(r),
      onPaused: () => (paused += 1),
    });

    await eventually(() => paused > 0, () => `paused=${paused}`);

    // Still live: a change after pausing must still arrive.
    addSkill(hub, 's-2');
    await eventually(
      () => received.some((r) => r.entityId === 'project/s-2'),
      () => `received ${JSON.stringify(received.map((r) => r.entityId))}`,
    );

    await subscription.cancel();
    await stream.close();
    hub.close();
  });
});

describe('resume', () => {
  it('a subscription starting from a cursor does not replay what came before', async () => {
    const hub = node();
    addSkill(hub, 'old-1');
    addSkill(hub, 'old-2');
    const cursor = hub.changeLog.since(0).slice(-1)[0].seq;

    const stream = serveChangeStream(hub.changeLog, { pollMs: 40 });
    const port = await stream.port;
    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`);

    const received: ChangeRecord[] = [];
    const subscription = client.subscribe({ onChange: (r) => received.push(r) }, cursor);

    addSkill(hub, 'new-1');
    await eventually(
      () => received.some((r) => r.entityId === 'project/new-1'),
      () => `received ${JSON.stringify(received.map((r) => r.entityId))}`,
    );

    assert.deepEqual(
      received.map((r) => r.entityId),
      ['project/new-1'],
      'resuming from a cursor must not replay history',
    );

    await subscription.cancel();
    await stream.close();
    hub.close();
  });

  it('🔴 survives the hub restarting, with no gap and no duplicate', async () => {
    const hub = node();
    const first = serveChangeStream(hub.changeLog, { pollMs: 40 });
    const port = await first.port;
    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`, { retryMs: 50 });

    const received: ChangeRecord[] = [];
    const subscription = client.subscribe({ onChange: (r) => received.push(r) });

    addSkill(hub, 's-1');
    await eventually(
      () => received.length === 1,
      () => `received ${received.length}`,
    );

    // Drop the hub, write while it is down, then bring it back on the same port.
    await first.close();
    addSkill(hub, 's-2');
    // Same port, so the client's retry finds it — resume is about position, not address.
    const reopened = serveChangeStream(hub.changeLog, { pollMs: 40, port });
    await reopened.port;

    await eventually(
      () => received.some((r) => r.entityId === 'project/s-2'),
      () => `received ${JSON.stringify(received.map((r) => r.entityId))}`,
      6000,
    );

    const ids = received.map((r) => r.entityId);
    assert.equal(new Set(ids).size, ids.length, 'a reconnect must not duplicate');
    assert.deepEqual(ids, ['project/s-1', 'project/s-2'], 'and must not skip');

    await subscription.cancel();
    await reopened.close();
    hub.close();
  });
});

describe('cancellation', () => {
  it('stops delivery and leaves no timer or request behind', async () => {
    const hub = node();
    const stream = serveChangeStream(hub.changeLog, { pollMs: 40 });
    const port = await stream.port;
    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`);

    const received: ChangeRecord[] = [];
    const subscription = client.subscribe({ onChange: (r) => received.push(r) });
    addSkill(hub, 's-1');
    await eventually(() => received.length === 1, () => `received ${received.length}`);

    await subscription.cancel();
    const countAtCancel = received.length;

    addSkill(hub, 's-2');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(received.length, countAtCancel, 'a canceled subscription must stop delivering');

    await stream.close();
    hub.close();
    // If this suite hangs rather than exiting, a timer or request outlived its subscription.
  });
});

describe('the safety-net poll', () => {
  it('🔴 picks up a write that bypassed the application entirely', async () => {
    // A CLI, a migration or a repair script emits no domain event, and `node:sqlite` has no update
    // hook — so nothing can *tell* the stream. Polling the log is what covers that, and this proves
    // it rather than assuming it.
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-bypass-'));
    const path = join(dir, 'hub.db');

    const hub = new TypeDBLiteInterpreter(path);
    hub.define(schema);
    const stream = serveChangeStream(hub.changeLog, { pollMs: 40 });
    const port = await stream.port;
    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`);

    const received: ChangeRecord[] = [];
    const subscription = client.subscribe({ onChange: (r) => received.push(r) });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A separate connection to the same file — the "CLI" the hub never hears about.
    const bypasser = new TypeDBLiteInterpreter(path);
    bypasser.execute('insert $s isa project, has project-id "by-pass", has project-name "n";');
    bypasser.close();

    await eventually(
      () => received.some((r) => r.entityId === 'project/by-pass'),
      () => `received ${JSON.stringify(received.map((r) => r.entityId))}`,
    );

    await subscription.cancel();
    await stream.close();
    hub.close();
  });
});

describe('two live spokes, separate processes', () => {
  it('🔴 both converge on each other’s work through the hub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-live-hub-'));
    const hub = new TypeDBLiteInterpreter(join(dir, 'hub.db'));
    hub.define(schema);
    const stream = serveChangeStream(hub.changeLog, { pollMs: 40 });
    const port = await stream.port;
    const url = `http://127.0.0.1:${port}`;

    const spokes = ['alpha', 'beta'];
    const results = await Promise.all(
      spokes.map(
        (prefix) =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(process.execPath, [
              '--import',
              'tsx',
              join(HERE, 'fixtures', 'live-spoke.ts'),
              join(dir, `${prefix}.db`),
              SCHEMA_PATH,
              url,
              prefix,
              String(spokes.length),
            ]);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (c) => (stdout += String(c)));
            child.stderr.on('data', (c) => (stderr += String(c)));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
          }),
      ),
    );

    for (const [index, result] of results.entries()) {
      assert.equal(
        result.code,
        0,
        `spoke ${spokes[index]} did not converge: ${result.stderr || result.stdout}`,
      );
      const seen = JSON.parse(result.stdout) as string[];
      assert.deepEqual(
        seen,
        ['project/alpha', 'project/beta'],
        `spoke ${spokes[index]} saw ${result.stdout}`,
      );
    }

    await stream.close();
    hub.close();
  });
});
