// 🔴 **Historical from 2026-09-01: there is no Jest in this repository any more.** The comments
// below argue for one runner over another — `tsx`/`node:test` against `ts-jest` — and that choice
// no longer exists: every suite runs under Vitest, with SWC supplying the `emitDecoratorMetadata`
// esbuild cannot and Node's real resolution supplying `node:sqlite`. The *reasoning* is kept
// because it is why the replacement had to satisfy both constraints at once, not because the
// split it describes is still real. See ADR-028.
/**
 * The change log's guarantees, against real repository schemas rather than a fixture shaped to
 * pass. Each case is a claim
 * [ADR-003](../../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)
 * makes, or an edge Phase 00 found by reading `execute()`.
 *
 * 🔴 `tsx` with `node:test`, not Jest — `node:sqlite` is a builtin only under its prefixed name and
 * Jest strips the prefix. See interpreter.test.ts's header for the full account.
 */
import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { isReplicable } from '../src/canonical.js';
import { generationOf } from '../src/revision.js';

const skillsSchema = `define
  entity skill,
    owns skill-id @key,
    owns skill-name,
    owns skill-description;
  attribute skill-id, value string;
  attribute skill-name, value string;
  attribute skill-description, value string;`;

describe('change_log storage guarantees', () => {
  it('🔴 AUTOINCREMENT burns a seq rather than reusing it', () => {
    // The cursor's correctness rests on this keyword. A reused seq makes a follower resuming from a
    // cursor either skip a change or replay a different one under the same number.
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE l(seq INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); ' +
        'CREATE TABLE p(seq INTEGER PRIMARY KEY, v TEXT)',
    );
    for (const table of ['l', 'p']) {
      db.exec(`INSERT INTO ${table}(v) VALUES ('a'),('b'),('c')`);
      db.exec(`DELETE FROM ${table} WHERE v = 'c'`);
      db.exec(`INSERT INTO ${table}(v) VALUES ('d')`);
    }
    const seqs = (t: string) =>
      (db.prepare(`SELECT seq FROM ${t} ORDER BY seq`).all() as Array<{ seq: number }>).map(
        (r) => Number(r.seq),
      );
    assert.deepEqual(seqs('l'), [1, 2, 4], 'AUTOINCREMENT must burn the deleted seq');
    assert.deepEqual(seqs('p'), [1, 2, 3], 'a plain rowid reuses it — this is why we cannot use it');
  });

  it('permits only one writer at a time, which is why a follower needs no gap handling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-log-'));
    const path = join(dir, 'w.db');
    const a = new DatabaseSync(path);
    a.exec('PRAGMA journal_mode=WAL');
    a.exec('CREATE TABLE t(x)');
    const b = new DatabaseSync(path);
    a.exec('BEGIN IMMEDIATE');
    assert.throws(
      () => b.exec('BEGIN IMMEDIATE'),
      'a second writer must be refused, or seq order could differ from commit order',
    );
    a.exec('COMMIT');
    assert.doesNotThrow(() => {
      b.exec('BEGIN IMMEDIATE');
      b.exec('COMMIT');
    });
  });
});

describe('the interpreter logs what it writes', () => {
  let db: TypeDBLiteInterpreter;
  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(skillsSchema);
  });

  const insertSkill = (id: string, title = 'Start Session') =>
    db.execute(`insert $s isa skill, has skill-id "${id}", has skill-name "${title}";`);

  it('records a creation as generation 1, identified by its @key and not by iid', () => {
    insertSkill('s-1');
    const changes = db.changeLog.since(0);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].entityId, 'skill/s-1');
    assert.equal(generationOf(changes[0].rev), 1);
    assert.equal(changes[0].parentRev, null);
    assert.equal(changes[0].deleted, false);
    assert.ok(isReplicable(changes[0].entityId));
  });

  it('🔴 identity does not depend on insertion order across databases', () => {
    // thing.iid is last_insert_rowid(): both databases call their first entity 1. If identity used
    // it, replication would merge unrelated skills.
    const other = new TypeDBLiteInterpreter();
    other.define(skillsSchema);
    other.execute('insert $s isa skill, has skill-id "s-9", has skill-name "Other";');
    insertSkill('s-1');
    assert.notEqual(
      db.changeLog.since(0)[0].entityId,
      other.changeLog.since(0)[0].entityId,
    );
  });

  it('chains a second write onto the first as its parent', () => {
    insertSkill('s-1');
    const first = db.changeLog.since(0)[0];
    db.execute(
      'match $s isa skill, has skill-id "s-1"; insert $s has skill-description "added";',
    );
    const changes = db.changeLog.since(0);
    const latest = changes[changes.length - 1];
    assert.equal(latest.parentRev, first.rev);
    assert.equal(generationOf(latest.rev), 2);
  });

  it('🔴 an empty match writes zero rows and logs nothing', () => {
    // TypeQLite quantifies the write over the match's results, so no results is a successful no-op —
    // it must not produce a log entry for a change that did not happen.
    insertSkill('s-1');
    const before = db.changeLog.since(0).length;
    db.execute(
      'match $s isa skill, has skill-id "nonexistent"; insert $s has skill-description "x";',
    );
    assert.equal(db.changeLog.since(0).length, before);
  });

  it('does not re-log an entity whose state is unchanged', () => {
    // One TypeQLite insert touches the thing, then each attribute, then each role — the same entity is
    // "touched" repeatedly. A derived revision plus UNIQUE(entity_id, rev) absorbs that.
    insertSkill('s-1');
    const after = db.changeLog.since(0).length;
    assert.equal(after, 1, 'one insert must produce exactly one log entry');
  });

  it('logs each pipeline of a multi-pipeline execute separately', () => {
    db.execute(
      'insert $a isa skill, has skill-id "s-1", has skill-name "A";' +
        'insert $b isa skill, has skill-id "s-2", has skill-name "B";',
    );
    const ids = db.changeLog.since(0).map((c) => c.entityId).sort();
    assert.deepEqual(ids, ['skill/s-1', 'skill/s-2']);
  });

  it('records a delete as a tombstone, not as an absence', () => {
    insertSkill('s-1');
    db.execute('match $s isa skill, has skill-id "s-1"; delete $s;');
    const changes = db.changeLog.since(0);
    const last = changes[changes.length - 1];
    assert.equal(last.entityId, 'skill/s-1');
    assert.equal(last.deleted, true);
    assert.equal(generationOf(last.rev), 2, 'a tombstone is a revision, with a parent');
  });

  it('a failed write leaves no log entry behind', () => {
    // The @key unique index rejects the duplicate. The log row is written inside the same
    // transaction, so it must roll back with the data — this is the phase's reason to exist.
    insertSkill('s-1');
    const before = db.changeLog.since(0);
    assert.throws(() => insertSkill('s-1', 'Duplicate'));
    assert.deepEqual(db.changeLog.since(0), before, 'a rolled-back write must not log');
  });
});

describe('the log survives a reopen', () => {
  it('preserves seq and the entity identity across processes', () => {
    // Assert against the files, not an in-process handle — a "close and reopen" test that reuses a
    // handle passes while testing nothing.
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-reopen-'));
    const path = join(dir, 'store.db');

    const first = new TypeDBLiteInterpreter(path);
    first.define(skillsSchema);
    first.execute('insert $s isa skill, has skill-id "s-1", has skill-name "A";');
    const before = first.changeLog.since(0);
    first.close();

    const second = new TypeDBLiteInterpreter(path);
    const after = second.changeLog.since(0);
    assert.deepEqual(after, before, 'the log must survive a reopen unchanged');

    // 🔴 The reopened process must still know which attribute is the @key, or identity silently
    // falls back to a node-local id. loadSchema restores types and attributes only, which is why
    // key_attribute is persisted separately.
    second.execute(
      'match $s isa skill, has skill-id "s-1"; insert $s has skill-description "second process";',
    );
    const latest = second.changeLog.since(0).slice(-1)[0];
    assert.equal(latest.entityId, 'skill/s-1');
    assert.equal(latest.parentRev, before[before.length - 1].rev);
    second.close();
  });
});
