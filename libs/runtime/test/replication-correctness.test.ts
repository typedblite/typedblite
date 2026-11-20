// 🔴 **Historical from 2026-09-01: there is no Jest in this repository any more.** The comments
// below argue for one runner over another — `tsx`/`node:test` against `ts-jest` — and that choice
// no longer exists: every suite runs under Vitest, with SWC supplying the `emitDecoratorMetadata`
// esbuild cannot and Node's real resolution supplying `node:sqlite`. The *reasoning* is kept
// because it is why the replacement had to satisfy both constraints at once, not because the
// split it describes is still real.
/**
 * Phase 07 — the nine findings a `/code-review` pass over `dev...feat/typeqlite-sync` produced,
 * each as a test that fails against the code as it stood.
 *
 * 🔴 **Every one of these was live while the feature was green.** Phases 01–06 closed with 36 BDD
 * scenarios and 296 steps passing, and none of them caught any of this, because all of them
 * exercise the keyed, small-batch, single-writer happy path. These cases are deliberately the
 * shapes just outside it: a keyless relation, a backlog over one window, a chunk boundary inside a
 * character, a handler that throws, a projection that arrives out of order.
 *
 * 🔴 **Every defect case here was proved against the unfixed code**, in a worktree at the commit
 * before the fixes, one test at a time. That is the parking lot's standing `#tech-debt` item —
 * "regression tests are not proven to fail against the unfixed code, and nothing does it
 * automatically" — honored by hand, because nothing yet does it automatically. Ten fail there:
 *
 *   a keyless role player is skipped · a real push leaves it behind · applyRemote refuses a local:
 *   id · applyRemote is atomic · a push backlog larger than one window · a multi-byte character
 *   split across chunks · a handler that throws does not advance · lastEventId reports the real
 *   position · an edge deferred for a missing player · a slow push does not overlap
 *
 * The `Round two` block was proved the same way against the commit holding round one's fixes — its
 * four cases are defects those fixes introduced, so the pre-phase commit is the wrong baseline for
 * them and would have passed them vacuously.
 *
 * 🔴 **Two tests were rewritten because they were not controls at all**, and both were the same
 * mistake: asserting against the test's own logic rather than the shipped path. One filtered
 * `since(0)` with `isReplicable` inside the test body, which proves only that the test can call a
 * function; it now drives a real replicator against a real hub. The other was handed the resume
 * cursor by hand, so it never exercised the reporting it existed to prove.
 *
 * 🔴 **Five others pass against the unfixed code, and are labeled rather than quietly counted.**
 * Three state a premise or a mechanism (`the tracker schema really does have keyless relations`,
 * `two nodes give the same logical relation the same id`, `a keyless relation is never sent over
 * the wire`); two guard a choice made *by* the fix and so have nothing to fail against yet
 * (`composes with an outer transaction`, `a re-projection cycle terminates`). Counting those among
 * the controls is how a suite comes to overstate what it proves.
 *
 * 🔴 `tsx` with `node:test`, not Jest — `node:sqlite` is a builtin only under its prefixed name and
 * Jest strips the prefix. See interpreter.test.ts's header for the full account.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { isReplicable } from '../src/canonical.js';
import { serveChangeStream } from '../src/change-stream.js';
import { ChangeStreamClient } from '../src/change-stream-client.js';
import { TypeDBLiteReplicator } from '../src/typedblite-replicator.js';
import { readKeyedTrackerSchema } from './fixtures/keyed-tracker-schema.js';
import { computeRevision } from '../src/revision.js';
import type { EntityState } from '../src/canonical.js';

/** A record as another store would send it: its `rev` is what its content gives (ADR-003, 2026-11-15). */
const remote = <R extends { entityId: string; parentRev: string | null; deleted: boolean; state?: EntityState }>(
  record: R,
): R & { rev: string } => ({
  ...record,
  rev: computeRevision({ state: record.state, parent: record.parentRev ?? undefined, deleted: record.deleted }),
});

const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const SCHEMA = readKeyedTrackerSchema(join(SCHEMAS, 'tracker.schema.typeqlite'));
/**
 * 🔴 `membership` is this repository's only relation that carries `@key`, and therefore the only
 * one that replicates at all once a keyless id is refused. Every relation in the tracker schema is
 * keyless — see the first case in Tier 1 — so the deferred-edge case can only be reached here.
 */
const IAM_SCHEMA = readFileSync(join(SCHEMAS, 'people.schema.typeqlite'), 'utf8');

const freshIam = () => {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(IAM_SCHEMA);
  return db;
};

/** The interpreter's own handle. Reached into deliberately — these are tests of its internals. */
const handleOf = (db: TypeDBLiteInterpreter): DatabaseSync =>
  (db as unknown as { db: DatabaseSync }).db;

const fresh = () => {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(SCHEMA);
  return db;
};

/** A `project` and two `task`s, joined by the keyless `project-task` relation. */
const withComposition = (db: TypeDBLiteInterpreter) => {
  db.execute('insert $s isa project, has project-id "s-1", has project-name "A";');
  db.execute('insert $t isa task, has task-id "step-1", has ordinal 1;');
  db.execute(
    'match $s isa project, has project-id "s-1"; $t isa task, has task-id "step-1";' +
      'insert (owner: $s, task: $t) isa project-task;',
  );
};

describe('Tier 1 — identity, which the feature claimed and did not enforce', () => {
  it('🔴 the tracker schema really does have keyless relations, so this is not hypothetical', () => {
    // The premise of every case below. If a future schema change gave these relations a @key the
    // findings would be unreachable and these tests would be testing nothing — so assert it.
    const keyless = ['project-task', 'subproject', 'task-dependency', 'task-log'];
    for (const relation of keyless) {
      const block = SCHEMA.slice(SCHEMA.indexOf(`relation ${relation},`));
      const body = block.slice(0, block.indexOf(';'));
      assert.ok(
        !body.includes('@key'),
        `${relation} is expected to be keyless — the finding depends on it`,
      );
    }
  });

  it('🔴 a keyless relation is never sent over the wire', () => {
    // 🔴 The reachable half of the identity finding, and the one that mattered.
    //
    // A keyless *relation* takes its own id from `last_insert_rowid()` — measured here, the
    // `project-task` above is `local:project-task/3`. Its role players are keyed and
    // encode correctly, so nothing about the record looks wrong; the id itself is the corruption.
    // It was logged, pushed and applied like any other, so two nodes' unrelated relations merged
    // under one id, and because `localIid` cannot resolve a `local:` id, every arriving revision
    // inserted another `thing` row.
    const db = fresh();
    withComposition(db);

    const relations = db.changeLog
      .since(0)
      .filter((c) => c.state?.type === 'project-task');
    assert.ok(relations.length > 0, 'precondition: the relation is logged locally');
    for (const record of relations) {
      assert.ok(
        record.entityId.startsWith('local:'),
        'precondition: a keyless relation has no cross-node identity',
      );
    }

    db.close();
  });

  it('🔴 and a real push leaves it behind, hub-side', async () => {
    // The previous case states the property; this one drives the actual replicator against an
    // actual hub, because a filter asserted in a test proves nothing about the code path that ships.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const spoke = fresh();
    withComposition(spoke);
    assert.ok(
      spoke.changeLog.since(0).some((c) => c.entityId.startsWith('local:')),
      'precondition: the spoke holds a local-only revision to leave behind',
    );

    const replicator = new TypeDBLiteReplicator(spoke.changeLog, `http://127.0.0.1:${port}`);
    await replicator.replicateOnce({ direction: 'push' });

    const landed = hubDb.changeLog.since(0, 10_000).map((c) => c.entityId).sort();
    assert.deepEqual(
      landed,
      ['project/s-1', 'task/step-1'],
      'the keyed entities must arrive and the local-only relation must not',
    );

    await hub.close();
    spoke.close();
    hubDb.close();
  });

  it('🔴 two nodes give the same logical relation the same id for different things', () => {
    // Why refusing is the only safe answer rather than a conservative one. Node B's relation is
    // between *different* entities, and lands on the identical id purely because the rowid matched.
    const a = fresh();
    withComposition(a);

    const b = fresh();
    b.execute('insert $s isa project, has project-id "s-99", has project-name "Z";');
    b.execute('insert $t isa task, has task-id "step-99", has ordinal 9;');
    b.execute(
      'match $s isa project, has project-id "s-99"; $t isa task, has task-id "step-99";' +
        'insert (owner: $s, task: $t) isa project-task;',
    );

    const idOf = (db: TypeDBLiteInterpreter) =>
      db.changeLog.since(0).find((c) => c.state?.type === 'project-task')?.entityId;

    assert.equal(
      idOf(a),
      idOf(b),
      'two unrelated relations collide on one id — this is the equivalence that must never be made',
    );
    assert.ok(!isReplicable(idOf(a) ?? ''), 'and neither may replicate');
    a.close();
    b.close();
  });

  it('🔴 a keyless role player is skipped rather than encoded as a node-local rowid', () => {
    // `identify`'s comment promised this and the code did the opposite: `entityId` is total, so it
    // answered `local:<type>/<rowid>` and that was returned unchecked.
    //
    // 🔴 **Constructed at the storage layer on purpose.** No schema in this repository lets a
    // relation play a role, so this shape is unreachable through TypeQLite today — the guard is
    // against a schema that has not been written yet, and the honest way to test it is to build the
    // row directly rather than to pretend a query produced it.
    const db = fresh();
    withComposition(db);
    const raw = handleOf(db);

    const keyless = raw
      .prepare("SELECT iid FROM thing WHERE type = 'project-task' LIMIT 1")
      .get() as { iid: number } | undefined;
    assert.ok(keyless, 'precondition: a keyless thing exists');

    raw.exec("INSERT INTO thing(type) VALUES ('subproject')");
    const host = Number(
      (raw.prepare('SELECT last_insert_rowid() AS iid').get() as { iid: number }).iid,
    );
    raw
      .prepare('INSERT INTO role_player(rel, role, player) VALUES (?, ?, ?)')
      .run(host, 'parent-task', Number(keyless.iid));

    const identity = db.changeLog.identify(host);
    assert.ok(identity, 'the host relation still resolves');
    assert.deepEqual(
      identity.state.roles,
      [],
      'a player with no cross-node identity must be dropped, never encoded as a local rowid',
    );
    db.close();
  });

  it('🔴 applyRemote refuses a local: id rather than inventing an equivalence', () => {
    const db = fresh();
    const before = db.changeLog.since(0).length;
    const accepted = db.changeLog.applyRemote({
      entityId: 'local:project-task/1',
      rev: '1-abc',
      parentRev: null,
      deleted: false,
      state: { type: 'project-task', attributes: [], roles: [] },
    });
    assert.equal(accepted, false, 'a local: id names a rowid on another node — refuse it');
    assert.equal(
      db.changeLog.since(0).length,
      before,
      'and it must not be written to the log either',
    );
    db.close();
  });

  it('🔴 applyRemote is atomic: a failed projection leaves no orphaned log row', () => {
    // The permanence is what made this severe. The log row committed, the projection did not, and
    // redelivery returns isNew=false and skips projection — so the entity could never be projected
    // again. Forced here by making the projection throw.
    const db = fresh();
    const log = db.changeLog;
    const boom = new Error('projection failed');
    const original = log.projectWinner.bind(log);
    (log as unknown as { projectWinner: (id: string) => void }).projectWinner = () => {
      throw boom;
    };

    assert.throws(
      () =>
        log.applyRemote(remote({
          entityId: 'project/s-remote',
          parentRev: null,
          deleted: false,
          state: {
            type: 'project',
            attributes: [{ type: 'project-id', value: 's-remote' }],
            roles: [],
          },
        })),
      /projection failed/,
    );

    (log as unknown as { projectWinner: (id: string) => void }).projectWinner = original;
    assert.equal(
      log.since(0).filter((c) => c.entityId === 'project/s-remote').length,
      0,
      'the change-log row must roll back with the projection, or the entity is stranded forever',
    );

    // And having rolled back, a redelivery still works — which is the point.
    assert.equal(
      log.applyRemote(remote({
        entityId: 'project/s-remote',
        parentRev: null,
        deleted: false,
        state: {
          type: 'project',
          attributes: [{ type: 'project-id', value: 's-remote' }],
          roles: [],
        },
      })),
      true,
      'redelivery must be able to succeed after a rolled-back attempt',
    );
    db.close();
  });

  it('composes with an outer transaction rather than failing on a nested BEGIN', () => {
    // SAVEPOINT, not BEGIN: execute() already holds a transaction on this handle, and SQLite
    // rejects a nested BEGIN. Proved on a real interpreter handle rather than a bare ChangeLog,
    // because the projection inside needs the storage tables to exist.
    const db = fresh();
    const raw = handleOf(db);
    raw.exec('BEGIN');
    assert.doesNotThrow(() =>
      db.changeLog.applyRemote(remote({
        entityId: 'project/s-inner',
        parentRev: null,
        deleted: false,
        state: {
          type: 'project',
          attributes: [{ type: 'project-id', value: 's-inner' }],
          roles: [],
        },
      })),
    );
    raw.exec('COMMIT');
    assert.equal(
      db.changeLog.since(0).filter((c) => c.entityId === 'project/s-inner').length,
      1,
      'and the row must survive the outer commit',
    );
    db.close();
  });
});

describe('Tier 2 — loss and corruption under load', () => {
  it('🔴 a push backlog larger than one window is pushed in full', async () => {
    // `since()` defaults to limit 500 and the push half read it exactly once, advanced its cursor
    // past what it sent, and reported success. Everything behind the window was lost silently.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const spoke = fresh();
    const total = 620; // > the 500 default, deliberately
    for (let i = 0; i < total; i += 1) {
      spoke.execute(
        `insert $s isa project, has project-id "s-${i}", has project-name "N${i}";`,
      );
    }
    assert.ok(spoke.changeLog.since(0, 10_000).length >= total);

    const replicator = new TypeDBLiteReplicator(spoke.changeLog, `http://127.0.0.1:${port}`);
    const result = await replicator.replicateOnce({ direction: 'push' });

    const landed = hubDb.changeLog.since(0, 10_000).length;
    assert.equal(
      landed,
      total,
      `all ${total} revisions must reach the hub, not just the first window (got ${landed})`,
    );
    assert.ok(
      result.cursor.push !== undefined && result.cursor.push > 0,
      'and the cursor must reflect what was actually sent',
    );

    await hub.close();
    spoke.close();
    hubDb.close();
  });

  it('🔴 a multi-byte character split across chunks survives the push', async () => {
    // `body += String(chunk)` decoded each TCP chunk independently, so a character straddling a
    // read became two replacement characters, JSON.parse threw, the hub answered 400, and the
    // client retried the identical batch forever. One accented letter stopped replication dead.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    // Long enough that the body is certain to span more than one chunk, and dense in the
    // multi-byte characters this repository's own documents are full of.
    const name = '🔴 Café — Ünicode ✅ '.repeat(4000);
    const spoke = fresh();
    spoke.execute(
      `insert $s isa project, has project-id "s-utf8", has project-name "${name}";`,
    );

    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`);
    const applied = await client.push(spoke.changeLog.since(0));
    assert.ok(applied > 0, 'the push must be accepted, not 400d on a split character');

    const landed = hubDb.changeLog
      .since(0)
      .find((c) => c.entityId === 'project/s-utf8');
    assert.ok(landed, 'the revision must have landed');
    const value = landed.state?.attributes.find((a) => a.type === 'project-name')?.value;
    assert.equal(value, name, 'and its text must survive byte-identical');
    assert.ok(!value?.includes('�'), 'no replacement characters');

    await hub.close();
    spoke.close();
    hubDb.close();
  });

  it('🔴 a handler that throws does not advance the resume cursor past the record', async () => {
    // The transport catch absorbed an applyRemote failure, reported it as a reconnect-worthy blip,
    // and resumed *past* the record that had just failed. A permanent failure looked transient and
    // dropped data.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    hubDb.execute('insert $s isa project, has project-id "s-1", has project-name "A";');
    hubDb.execute('insert $s isa project, has project-id "s-2", has project-name "B";');
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`, { retryMs: 20 });
    const failures: Array<string | undefined> = [];
    const subscription = client.subscribe({
      onChange: () => {
        throw new Error('apply failed');
      },
      onFailed: (_error, cause) => failures.push(cause),
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(failures, ['apply'], 'an apply failure is not a transport failure');
    assert.equal(
      subscription.lastEventId,
      0,
      'and the cursor must not have moved past the record that failed',
    );

    await subscription.cancel();
    await hub.close();
    hubDb.close();
  });
});

describe('Round two — findings the fixes themselves introduced', () => {
  // 🔴 A second `/code-review` over this phase's own diff. Four of its six findings were introduced
  // by the first round's fixes, which is the reason a re-review is asked for at all:
  // each round's fixes are themselves unreviewed code.

  it('🔴 an apply failure is reported terminal, because no reconnect is coming', async () => {
    // The client gives up on an apply failure and schedules no reconnect, while `'transient'` tells
    // the caller to expect one — so a caller trusting the classification waits forever for a
    // session that has already stopped.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    hubDb.execute('insert $s isa project, has project-id "s-1", has project-name "A";');
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const spoke = fresh();
    const replicator = new TypeDBLiteReplicator(spoke.changeLog, `http://127.0.0.1:${port}`);
    // Force the apply to throw, which is what an apply failure is.
    (spoke.changeLog as unknown as { applyRemote: () => boolean }).applyRemote = () => {
      throw new Error('apply failed');
    };

    const classes: string[] = [];
    const session = replicator.replicateContinuously(
      { direction: 'pull' },
      { onFailed: (_error, classification) => classes.push(classification) },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.deepEqual(classes, ['terminal'], 'an apply failure is terminal, not transient');
    await session.cancel();
    await hub.close();
    spoke.close();
    hubDb.close();
  });

  it('🔴 a push that fails midway does not re-send the batches that succeeded', async () => {
    // Returning the cursor only on a clean drain discards batches 1..N when N+1 fails, so a backlog
    // that cannot be drained in one attempt re-sends the same prefix on every retry. The loop fixed
    // truncation; without per-batch progress it replaces truncation with a livelock.
    //
    // 🔴 The continuous path, deliberately. `replicateOnce` throws its cursor away with the stack
    // either way — a caller cannot resume from a value it was never handed — so the one-shot form
    // cannot distinguish the fix, and testing it there would prove nothing.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const spoke = fresh();
    for (let i = 0; i < 1200; i += 1) {
      spoke.execute(`insert $s isa project, has project-id "s-${i}", has project-name "N";`);
    }

    const replicator = new TypeDBLiteReplicator(spoke.changeLog, `http://127.0.0.1:${port}`, 20);
    const client = (replicator as unknown as { client: ChangeStreamClient }).client;
    const realPush = client.push.bind(client);
    let calls = 0;
    const firstSeqSent: number[] = [];
    client.push = async (records) => {
      calls += 1;
      firstSeqSent.push(records[0].seq);
      // Drop the second batch, mid-drain, after the first has already landed.
      if (calls === 2) throw new Error('link dropped');
      return realPush(records);
    };

    const session = replicator.replicateContinuously({ direction: 'push' });
    // Wait for the backlog to land, not for a fixed time: the drain takes ~0.3 s on node:sqlite and
    // ~1.5 s on WASM SQLite, so a fixed window passed on one binding and failed on the other. A
    // livelock still fails, because the hub then never reaches 1200 before the deadline.
    const deadline = Date.now() + 15_000;
    while (hubDb.changeLog.since(0, 10_000).length < 1200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await session.cancel();

    const resentPrefix = firstSeqSent.filter((seq) => seq === firstSeqSent[0]).length;
    assert.equal(
      resentPrefix,
      1,
      `the batch that succeeded must never be sent again (sent ${resentPrefix} times, starts: ${firstSeqSent.join()})`,
    );
    assert.equal(
      hubDb.changeLog.since(0, 10_000).length,
      1200,
      'and the backlog must still complete once the link recovers',
    );

    await hub.close();
    spoke.close();
    hubDb.close();
  });

  it('🔴 an edge waiting on a player is drawn when that player is written locally', () => {
    // `drawDeferredEdgesNaming` was reachable only from `applyRemote`. A relation waiting on a
    // player someone then created *locally* stayed unlinked forever, because `recordWrite` never
    // projects and the hub's echo comes back isNew=false and skips projection too.
    const target = freshIam();
    target.changeLog.applyRemote(remote({
      entityId: 'membership/p-9::o-9',
      parentRev: null,
      deleted: false,
      state: {
        type: 'membership',
        attributes: [{ type: 'membership-key', value: 'p-9::o-9' }],
        roles: [
          { role: 'member', player: 'person/p-9' },
          { role: 'team', player: 'team/o-9' },
        ],
      },
    }));

    // Both players arrive by ordinary local writes, never by replication.
    target.execute(
      'insert $p isa person, has person-id "p-9", has person-kind "user";',
    );
    target.execute('insert $o isa team, has team-id "o-9";');

    const rows = target.query(
      'match\n  $p isa person, has person-id $pid;\n' +
        '  $o isa team, has team-id "o-9";\n' +
        '  $m isa membership, links (member: $p, team: $o);\nselect $pid;',
    ).rows;
    assert.equal(rows.length, 1, 'a locally written player must draw the edges waiting on it');
    assert.equal(rows[0]['pid'].asString(), 'p-9');
    target.close();
  });

  it('🔴 cancel stops a drain that is already running', async () => {
    // `pushFrom` is now an unbounded loop, so a canceled session would otherwise keep POSTing to a
    // hub the caller has finished with, and could set status 'failed' after cancel set 'idle'.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const spoke = fresh();
    for (let i = 0; i < 3000; i += 1) {
      spoke.execute(`insert $s isa project, has project-id "s-${i}", has project-name "N";`);
    }

    const replicator = new TypeDBLiteReplicator(spoke.changeLog, `http://127.0.0.1:${port}`, 10);
    const client = (replicator as unknown as { client: ChangeStreamClient }).client;
    const realPush = client.push.bind(client);
    let pushes = 0;
    client.push = async (records) => {
      pushes += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return realPush(records);
    };

    const session = replicator.replicateContinuously({ direction: 'push' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await session.cancel();
    const atCancel = pushes;
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(
      pushes - atCancel <= 1,
      `a canceled drain must stop, not run to exhaustion (${pushes - atCancel} pushes after cancel)`,
    );
    assert.equal(session.status, 'idle', 'and must not be flipped to failed after cancelling');

    await hub.close();
    spoke.close();
    hubDb.close();
  });
});

describe('Tier 3 — contract and liveness', () => {
  it('🔴 lastEventId reports the real position, so a restart resumes where it stopped', async () => {
    // Hardcoded `return 0`. A caller persisting it — the entire reason it is exposed — replayed the
    // whole log on every restart, defeating Phase 04's resume.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    for (let i = 0; i < 3; i += 1) {
      hubDb.execute(`insert $s isa project, has project-id "s-${i}", has project-name "N";`);
    }
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const client = new ChangeStreamClient(`http://127.0.0.1:${port}`, { retryMs: 20 });
    const seen: string[] = [];
    const subscription = client.subscribe({
      onChange: (record) => seen.push(record.entityId),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(seen.length, 3, 'precondition: all three arrived');
    assert.equal(
      subscription.lastEventId,
      3,
      'the subscription must report the seq it actually reached',
    );
    assert.equal(
      subscription.lastEventId,
      client.lastEventId,
      'and must agree with the client it came from',
    );

    await subscription.cancel();
    await hub.close();
    hubDb.close();
  });

  it('🔴 an edge deferred for a missing player is drawn when that player arrives', () => {
    // The comment promised the relation reappears once the player is projected, and nothing
    // re-projected it — so the edge stayed missing for the life of the replica. Delivered here in
    // the worst order on purpose: the relation first, both its players afterwards.
    const source = freshIam();
    source.execute(
      'insert $p isa person, has person-id "p-1", has person-kind "user";',
    );
    source.execute('insert $o isa team, has team-id "o-1";');
    source.execute(
      'match $p isa person, has person-id "p-1"; $o isa team, has team-id "o-1";' +
        'insert $m isa membership, links (member: $p, team: $o),' +
        ' has membership-key "p-1::o-1", has role-name "admin";',
    );

    const records = source.changeLog.since(0);
    const relation = records.filter((c) => c.state?.type === 'membership');
    const players = records.filter((c) => c.state?.type !== 'membership');
    assert.ok(relation.length > 0, 'precondition: the keyed relation is logged and replicable');
    for (const record of relation) {
      assert.ok(isReplicable(record.entityId), 'precondition: it replicates at all');
      assert.ok(
        (record.state?.roles ?? []).length > 0,
        'precondition: its role players are carried',
      );
    }

    const target = freshIam();
    // Relation first — the order that leaves both players unresolvable at projection time.
    for (const record of [...relation, ...players]) {
      target.changeLog.applyRemote({
        entityId: record.entityId,
        rev: record.rev,
        parentRev: record.parentRev,
        deleted: record.deleted,
        state: record.state,
      });
    }

    const rows = target.query(
      'match\n  $p isa person, has person-id $pid;\n' +
        '  $o isa team, has team-id "o-1";\n' +
        '  $m isa membership, links (member: $p, team: $o);\nselect $pid;',
    ).rows;
    assert.equal(
      rows.length,
      1,
      'the deferred edge must be drawn once its players arrive, not left missing forever',
    );
    assert.equal(rows[0]['pid'].asString(), 'p-1');

    source.close();
    target.close();
  });

  it('a re-projection cycle terminates rather than recursing without bound', () => {
    // Re-projecting when a player arrives is recursive, and a relation can itself play a role.
    // Without a guard the first cycle is a stack overflow rather than a missing edge.
    const db = freshIam();
    assert.doesNotThrow(() => {
      db.changeLog.applyRemote(remote({
        entityId: 'membership/self',
        parentRev: null,
        deleted: false,
        state: {
          type: 'membership',
          attributes: [{ type: 'membership-key', value: 'self' }],
          roles: [{ role: 'member', player: 'membership/self' }],
        },
      }));
    }, 'a self-referencing projection must terminate');
    db.close();
  });

  it('🔴 a slow push does not overlap the next tick and regress the cursor', async () => {
    // The interval fired regardless of whether the previous push had returned. Two overlapping
    // pushes read the same unadvanced cursor, sent the same batch, and whichever resolved second
    // wrote its cursor last — so a slow first push completing after a fast second moved the cursor
    // backwards and resent everything between.
    const hubDb = new TypeDBLiteInterpreter(':memory:');
    hubDb.define(SCHEMA);
    const hub = serveChangeStream(hubDb.changeLog, { pollMs: 20 });
    const port = await hub.port;

    const spoke = fresh();
    const replicator = new TypeDBLiteReplicator(spoke.changeLog, `http://127.0.0.1:${port}`, 10);

    let inFlight = 0;
    let maxConcurrent = 0;
    const client = (replicator as unknown as { client: ChangeStreamClient }).client;
    const realPush = client.push.bind(client);
    client.push = async (records) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        // Far slower than the 10ms interval, so overlap is certain if nothing prevents it.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return await realPush(records);
      } finally {
        inFlight -= 1;
      }
    };

    const session = replicator.replicateContinuously({ direction: 'push' });
    for (let i = 0; i < 40; i += 1) {
      spoke.execute(`insert $s isa project, has project-id "s-${i}", has project-name "N";`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(maxConcurrent, 1, 'only one push may be in flight at a time');
    assert.equal(
      hubDb.changeLog.since(0, 10_000).length,
      40,
      'and every revision must still land exactly once',
    );

    await session.cancel();
    await hub.close();
    spoke.close();
    hubDb.close();
  });
});
