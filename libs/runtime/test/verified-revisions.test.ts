/**
 * A store accepts a revision from a peer only when the revision is derived from its content
 * (ADR-003, amendment of 2026-11-15; the replication guide's Security section).
 *
 * 🔴 What the check is for: a revision names one content, on every store. Before it, `applyRemote` stored the
 * `rev` it was given, so a peer could send a revision another store already held with different content, and the
 * two would each believe they were in sync and never converge. The refusals below are each such a record, and the
 * acceptances are what real replication sends, including from a compacted store, whose leaves name parents that no
 * longer exist anywhere. The last case pins the limit: a correctly derived revision is accepted whatever parent it
 * claims, so a peer that may write can still make its write win. That is authentication's job, not this check's.
 */
import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { revisionProblem, type ChangeRecord } from '../src/change-log.js';
import { serveChangeStream } from '../src/change-stream.js';
import { replicateOnce } from '../src/replicator.js';
import { computeRevision } from '../src/revision.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';
import { readKeyedSkillsSchema } from './fixtures/keyed-skills-schema.js';

const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const schema = readKeyedSkillsSchema(join(SCHEMAS, 'skills.schema.typeqlite'));

const open: TypeDBLiteInterpreter[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const db of open.splice(0)) db.close();
});

function store(): TypeDBLiteInterpreter {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(schema);
  open.push(db);
  return db;
}

/** A store holding one skill, edited once: two revisions of `skill/s-1`. */
function source(): { db: TypeDBLiteInterpreter; records: readonly ChangeRecord[] } {
  const db = store();
  db.execute('insert $s isa skill, has skill-id "s-1", has skill-name "first";');
  db.execute('match $s isa skill, has skill-id "s-1"; insert $s has skill-description "edited";');
  return { db, records: db.changeLog.since(0).filter((record) => record.entityId === 'skill/s-1') };
}

/** What `applyRemote` takes, from a record `since()` returned. */
const pushed = ({ entityId, rev, parentRev, deleted, state }: ChangeRecord) => ({ entityId, rev, parentRev, deleted, state });

function refusedWith(work: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'expected a refusal');
  assert.match(caught.message, pattern);
  assert.equal(diagnosticOf(caught)?.code, DiagnosticCode.revisionNotDerived, 'with a code a caller can branch on');
}

describe('what a store accepts from a peer', () => {
  it('accepts what another store sends: edits, a delete, and a tombstone', () => {
    const { db: a } = source();
    a.execute('match $s isa skill, has skill-id "s-1"; delete $s;');
    const b = store();
    const outcome = replicateOnce(b.changeLog, a.changeLog, { direction: 'pull' });
    assert.ok(outcome.applied >= 3, 'both revisions and the tombstone');
    assert.equal(b.changeLog.winnerOf('skill/s-1')?.deleted, true);
    assert.equal(b.changeLog.winnerOf('skill/s-1')?.rev, a.changeLog.winnerOf('skill/s-1')?.rev);
  });

  it('accepts the leaves of a compacted store, whose parents no longer exist anywhere', () => {
    const { db: a } = source();
    a.changeLog.compact();
    const leaf = a.changeLog.since(0).filter((record) => record.entityId === 'skill/s-1');
    assert.equal(leaf.length, 1, 'compaction kept only the leaf');
    assert.notEqual(leaf[0]?.parentRev, null, 'which names a parent that is gone');
    const b = store();
    replicateOnce(b.changeLog, a.changeLog, { direction: 'pull' });
    assert.equal(b.changeLog.winnerOf('skill/s-1')?.rev, leaf[0]?.rev);
  });
});

describe('what it refuses, leaving the store as it was', () => {
  it('refuses a revision that is not derived from its content: 999999-deadbeef', () => {
    const { records } = source();
    const b = store();
    const forged = { ...pushed(records[0]!), rev: '999999-deadbeef' };
    refusedWith(() => b.changeLog.applyRemote(forged), /skill\/s-1: revision 999999-deadbeef is not derived from its content, which gives 1-/);
    assert.equal(b.changeLog.winnerOf('skill/s-1'), undefined, 'nothing was stored');
  });

  it('refuses a held revision sent with different content, the one that would split two stores for good', () => {
    const { records } = source();
    const b = store();
    const original = pushed(records[0]!);
    const tampered = {
      ...original,
      state: { ...original.state!, attributes: original.state!.attributes.map((a) => (a.type === 'skill-name' ? { ...a, value: 'not what was written' } : a)) },
    };
    refusedWith(() => b.changeLog.applyRemote(tampered), /is not derived from its content/);
    assert.equal(b.changeLog.applyRemote(original), true, 'and the real one is still accepted');
  });

  it('refuses a changed parent, and a flipped deleted flag', () => {
    const { records } = source();
    const b = store();
    b.changeLog.applyRemote(pushed(records[0]!));
    const edit = pushed(records[1]!);
    refusedWith(() => b.changeLog.applyRemote({ ...edit, parentRev: null }), /is not derived from its content/);
    refusedWith(() => b.changeLog.applyRemote({ ...edit, deleted: true }), /is not derived from its content/);
    assert.equal(b.changeLog.leavesOf('skill/s-1').length, 1, 'only the first revision is held');
  });

  it('refuses a live revision with no state: nothing to check, and nothing to project', () => {
    const b = store();
    const rev = computeRevision({ deleted: false });
    refusedWith(() => b.changeLog.applyRemote({ entityId: 'skill/s-9', rev, parentRev: null, deleted: false }), /live revision .* carries no state/);
  });

  it('refuses a malformed parent revision', () => {
    const { records } = source();
    const b = store();
    refusedWith(
      () => b.changeLog.applyRemote({ ...pushed(records[0]!), parentRev: 'not-a-revision' }),
      /names a malformed parent revision, not-a-revision/,
    );
  });

  it('refuses a batch with one bad record as a whole', () => {
    const { db: a, records } = source();
    a.execute('insert $s isa skill, has skill-id "s-2", has skill-name "other";');
    const good = pushed(a.changeLog.since(0).find((record) => record.entityId === 'skill/s-2')!);
    const b = store();
    refusedWith(() => b.changeLog.applyRemoteBatch([good, { ...pushed(records[0]!), rev: '1-deadbeef' }]), /is not derived from its content/);
    assert.equal(b.changeLog.winnerOf('skill/s-2'), undefined, 'the good record went with it');
  });

  it('refuses on a pull too, and says which record', () => {
    const { records } = source();
    const forged = { ...records[0]!, rev: '7-deadbeef' };
    const hostile = { since: (cursor = 0) => (cursor === 0 ? [forged] : []), applyRemote: () => false };
    const b = store();
    refusedWith(() => replicateOnce(b.changeLog, hostile, { direction: 'pull' }), /skill\/s-1: revision 7-deadbeef/);
  });
});

describe('the hub', () => {
  it('answers a pushed batch with a bad revision 400, naming the change, and applies none of it', async () => {
    const { records } = source();
    const hubDb = store();
    const served = serveChangeStream(hubDb.changeLog, { pollMs: 30 });
    closers.push(served.close);
    const url = `http://127.0.0.1:${await served.port}/changes`;
    const body = JSON.stringify([pushed(records[0]!), { ...pushed(records[1]!), rev: '2-deadbeef' }]);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.match(text, /change 1 is refused: revision 2-deadbeef is not derived from its content/);
    assert.equal(hubDb.changeLog.winnerOf('skill/s-1'), undefined, 'the good first change was not applied either');
  });
});

describe('the limit, stated so it is not overclaimed', () => {
  it('accepts a correctly derived revision whatever parent it claims: a peer that may write can still win', () => {
    const { records } = source();
    const b = store();
    b.changeLog.applyRemote(pushed(records[0]!));
    const state = { type: 'skill', attributes: [{ type: 'skill-id', value: 's-1' }, { type: 'skill-name', value: 'mine' }], roles: [] };
    const parentRev = '999998-0123456789abcdef0123456789abcdef';
    const rev = computeRevision({ state, parent: parentRev });
    assert.equal(revisionProblem({ rev, parentRev, deleted: false, state }), undefined);
    assert.equal(b.changeLog.applyRemote({ entityId: 'skill/s-1', rev, parentRev, deleted: false, state }), true);
    assert.equal(b.changeLog.winnerOf('skill/s-1')?.rev, rev, 'it wins by its generation: only authentication stops this');
  });
});
