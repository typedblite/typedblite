/**
 * One-shot replication: push, pull, duplex, and resume.
 *
 * 🔴 Each direction is exercised on its own. A duplex implementation that happens to satisfy both
 * is not evidence for either — a push that quietly also pulled would pass a duplex-only suite.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { replicateOnce } from '../src/replicator.js';
import { readKeyedSkillsSchema } from './fixtures/keyed-skills-schema.js';

const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const schema = readKeyedSkillsSchema(join(SCHEMAS, 'skills.schema.typeqlite'));

const node = () => {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(schema);
  return db;
};

const addSkill = (db: TypeDBLiteInterpreter, id: string, name: string) =>
  db.execute(`insert $s isa skill, has skill-id "${id}", has skill-name "${name}";`);

const skillNames = (db: TypeDBLiteInterpreter) =>
  db
    .query('match $s isa skill, has skill-id $id; select $id;')
    .rows.map((row) => row['id']?.asString())
    .sort();

describe('direction', () => {
  it('pull brings the remote in and leaves the remote untouched', () => {
    const local = node();
    const remote = node();
    addSkill(local, 'local-1', 'Local');
    addSkill(remote, 'remote-1', 'Remote');

    const outcome = replicateOnce(local.changeLog, remote.changeLog, { direction: 'pull' });

    assert.deepEqual(skillNames(local), ['local-1', 'remote-1']);
    assert.deepEqual(skillNames(remote), ['remote-1'], 'pull must not push');
    assert.equal(outcome.applied, 1);
    assert.equal(outcome.cursor.push, undefined, 'a pull reports no push position');
    local.close();
    remote.close();
  });

  it('push sends the local out and leaves the local unchanged', () => {
    const local = node();
    const remote = node();
    addSkill(local, 'local-1', 'Local');
    addSkill(remote, 'remote-1', 'Remote');

    const outcome = replicateOnce(local.changeLog, remote.changeLog, { direction: 'push' });

    assert.deepEqual(skillNames(local), ['local-1'], 'push must not pull');
    assert.deepEqual(skillNames(remote), ['local-1', 'remote-1']);
    assert.equal(outcome.cursor.pull, undefined, 'a push reports no pull position');
    local.close();
    remote.close();
  });

  it('duplex converges both sides', () => {
    const local = node();
    const remote = node();
    addSkill(local, 'local-1', 'Local');
    addSkill(remote, 'remote-1', 'Remote');

    const outcome = replicateOnce(local.changeLog, remote.changeLog, { direction: 'duplex' });

    assert.deepEqual(skillNames(local), ['local-1', 'remote-1']);
    assert.deepEqual(skillNames(remote), ['local-1', 'remote-1']);
    assert.ok(outcome.cursor.pull !== undefined && outcome.cursor.push !== undefined);
    local.close();
    remote.close();
  });
});

describe('a replicated revision becomes queryable, not just recorded', () => {
  it('projects the winner into the tables TypeQLite reads', () => {
    const local = node();
    const remote = node();
    addSkill(remote, 'r-1', 'Remote');

    replicateOnce(local.changeLog, remote.changeLog, { direction: 'pull' });

    // The point: `match` sees it, not only `stateOf`.
    const rows = local.query(
      'match $s isa skill, has skill-id "r-1", has skill-name $n; select $n;',
    ).rows;
    assert.equal(rows[0]?.['n']?.asString(), 'Remote');
    local.close();
    remote.close();
  });

  it('🔴 applying a change is not a change — no new local revision is logged', () => {
    // Otherwise two nodes ping-pong revisions forever, each treating the other's projection as
    // fresh local work.
    const local = node();
    const remote = node();
    addSkill(remote, 'r-1', 'Remote');
    const remoteRevs = remote.changeLog.since(0).map((c) => c.rev);

    replicateOnce(local.changeLog, remote.changeLog, { direction: 'pull' });
    const localRevs = local.changeLog.since(0).map((c) => c.rev);

    assert.deepEqual(localRevs, remoteRevs, 'the local log must hold exactly what arrived');

    // And a second duplex round must be a no-op rather than generating fresh work.
    const second = replicateOnce(local.changeLog, remote.changeLog, { direction: 'duplex' });
    assert.equal(second.applied, 0, 'a settled pair must have nothing left to exchange');
    local.close();
    remote.close();
  });

  it('a tombstone win removes the entity locally', () => {
    const local = node();
    const remote = node();
    addSkill(remote, 'r-1', 'Remote');
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'pull' });
    assert.deepEqual(skillNames(local), ['r-1']);

    remote.execute('match $s isa skill, has skill-id "r-1"; delete $s;');
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'pull' });

    assert.deepEqual(skillNames(local), [], 'a replicated delete must delete');
    local.close();
    remote.close();
  });

  it('a deleted entity does not resurrect on the next round', () => {
    const local = node();
    const remote = node();
    addSkill(local, 's-1', 'A');
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'duplex' });
    local.execute('match $s isa skill, has skill-id "s-1"; delete $s;');
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'duplex' });
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'duplex' });

    assert.deepEqual(skillNames(local), []);
    assert.deepEqual(skillNames(remote), [], 'the tombstone must stay winning');
    local.close();
    remote.close();
  });
});

describe('conflicts survive replication rather than being resolved by it', () => {
  it('a concurrent edit on both sides is reported, not silently merged', () => {
    const local = node();
    const remote = node();
    addSkill(local, 's-1', 'A');
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'duplex' });

    // Now both edit the same entity without seeing each other.
    local.execute('match $s isa skill, has skill-id "s-1"; insert $s has skill-description "mine";');
    remote.execute(
      'match $s isa skill, has skill-id "s-1"; insert $s has skill-description "theirs";',
    );

    const outcome = replicateOnce(local.changeLog, remote.changeLog, { direction: 'duplex' });

    assert.equal(outcome.conflicts, 1, 'the losing revision must be reported');
    assert.equal(
      local.changeLog.winnerOf('skill/s-1')?.rev,
      remote.changeLog.winnerOf('skill/s-1')?.rev,
      'both sides must agree on the winner',
    );
    local.close();
    remote.close();
  });
});

describe('resume', () => {
  it('picks up from the cursor without duplicating or dropping', () => {
    const local = node();
    const remote = node();
    for (let i = 0; i < 5; i += 1) addSkill(remote, `r-${i}`, 'Remote');

    // First run with a small batch, then resume from where it stopped.
    const first = replicateOnce(local.changeLog, remote.changeLog, {
      direction: 'pull',
      limit: 2,
    });
    assert.equal(first.applied, 5);

    for (let i = 5; i < 8; i += 1) addSkill(remote, `r-${i}`, 'Remote');
    const second = replicateOnce(local.changeLog, remote.changeLog, {
      direction: 'pull',
      from: first.cursor,
    });

    assert.equal(second.applied, 3, 'only the new revisions must be applied');
    assert.equal(skillNames(local).length, 8);
    local.close();
    remote.close();
  });

  it('re-running from an old cursor is absorbed rather than duplicating', () => {
    const local = node();
    const remote = node();
    addSkill(remote, 'r-1', 'Remote');
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'pull' });

    // A crash after applying but before storing the cursor replays the same revisions.
    replicateOnce(local.changeLog, remote.changeLog, { direction: 'pull', from: { pull: 0 } });

    assert.equal(local.changeLog.since(0).length, 1, 'a replayed revision must not duplicate');
    local.close();
    remote.close();
  });
});
