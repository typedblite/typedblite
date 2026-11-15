/**
 * Convergence, tested by generated edit sequences rather than by worked examples.
 *
 * 🔴 This is the phase that decides whether the feature was worth doing, and hand-written cases are
 * not enough to decide it. A wrong winner or a dropped branch does not throw — it diverges, quietly,
 * on one node. So the shape of every test here is: give two nodes the same revisions in *different
 * orders* and require them to agree.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import type { ChangeRecord } from '../src/change-log.js';
import { computeRevision } from '../src/revision.js';
import type { EntityState } from '../src/canonical.js';

const skillsSchema = `define
  entity project,
    owns project-id @key,
    owns project-name,
    owns project-summary;
  attribute project-id, value string;
  attribute project-name, value string;
  attribute project-summary, value string;`;

/**
 * A fresh node. `:memory:` is per-connection in `node:sqlite`, so two of these are genuinely two
 * databases — unlike PouchDB's memory adapter, which shares by name within a process and has caught
 * this workspace out before.
 */
const node = () => {
  const db = new TypeDBLiteInterpreter(':memory:');
  db.define(skillsSchema);
  return db;
};

const skillState = (id: string, name: string): EntityState => ({
  type: 'project',
  attributes: [
    { type: 'project-id', value: id },
    { type: 'project-name', value: name },
  ],
  roles: [],
});

/** Deterministic PRNG, so a failure is reproducible from its seed rather than "sometimes". */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

describe('leaves, not a head', () => {
  it('a linear history has exactly one leaf', () => {
    const db = node();
    db.execute('insert $s isa project, has project-id "s-1", has project-name "A";');
    db.execute(
      'match $s isa project, has project-id "s-1"; insert $s has project-summary "d";',
    );
    assert.equal(db.changeLog.leavesOf('project/s-1').length, 1);
    assert.equal(db.changeLog.conflictsOf('project/s-1').length, 0);
    db.close();
  });

  it('🔴 concurrent children of one parent are two leaves', () => {
    // Phase 01 kept a single head, which is correct only while one node writes. This is the case
    // that made a head a lie: both edits descend from the same root because neither had seen the
    // other when it was made.
    const db = node();
    db.execute('insert $s isa project, has project-id "s-1", has project-name "A";');
    const root = db.changeLog.winnerOf('project/s-1')!.rev;

    // The local edit happens first, while root is still the winner.
    db.execute(
      'match $s isa project, has project-id "s-1"; insert $s has project-summary "local";',
    );
    // The remote edit was made concurrently, so it also names root as its parent.
    const remoteState = skillState('s-1', 'B');
    db.changeLog.applyRemote({
      entityId: 'project/s-1',
      rev: computeRevision({ state: remoteState, parent: root }),
      parentRev: root,
      deleted: false,
      state: remoteState,
    });

    assert.equal(
      db.changeLog.leavesOf('project/s-1').length,
      2,
      'two children of one parent are two leaves',
    );
    assert.equal(db.changeLog.conflictsOf('project/s-1').length, 1);
    db.close();
  });

  it('a local write after seeing a remote one extends it rather than forking', () => {
    // The complement of the case above, and the reason it had to be written that way: once the
    // remote revision is the winner, a local write descends from *it*. Forking here would
    // manufacture a conflict out of a sequential edit.
    const db = node();
    db.execute('insert $s isa project, has project-id "s-1", has project-name "A";');
    const root = db.changeLog.winnerOf('project/s-1')!.rev;
    const remoteState = skillState('s-1', 'B');
    db.changeLog.applyRemote({
      entityId: 'project/s-1',
      rev: computeRevision({ state: remoteState, parent: root }),
      parentRev: root,
      deleted: false,
      state: remoteState,
    });
    db.execute(
      'match $s isa project, has project-id "s-1"; insert $s has project-summary "after";',
    );
    assert.equal(db.changeLog.leavesOf('project/s-1').length, 1);
    assert.equal(db.changeLog.conflictsOf('project/s-1').length, 0);
    db.close();
  });
});

describe('two nodes converge regardless of the order revisions arrive', () => {
  it('🔴 agrees on winner and conflict set across 50 shuffled deliveries', () => {
    const root = computeRevision({ state: skillState('s-1', 'root') });
    const revisions = ['A', 'B', 'C', 'D'].map((name) => {
      const state = skillState('s-1', name);
      return {
        entityId: 'project/s-1',
        rev: computeRevision({ state, parent: root }),
        parentRev: root,
        deleted: false,
        state,
      };
    });
    const rootRecord = {
      entityId: 'project/s-1',
      rev: root,
      parentRev: null,
      deleted: false,
      state: skillState('s-1', 'root'),
    };

    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 50; seed += 1) {
      const db = node();
      const random = rng(seed);
      db.changeLog.applyRemote(rootRecord);
      for (const record of shuffle(revisions, random)) {
        db.changeLog.applyRemote(record);
      }
      const won = db.changeLog.winnerOf('project/s-1');
      const losing = db.changeLog
        .conflictsOf('project/s-1')
        .map((leaf) => leaf.rev)
        .sort()
        .join(',');
      outcomes.add(`${won?.rev}|${losing}`);
      db.close();
    }
    assert.equal(
      outcomes.size,
      1,
      `every delivery order must converge, got: ${[...outcomes].join(' / ')}`,
    );
  });

  it('converges over randomly generated edit chains, not just siblings', () => {
    // Chains of varying depth from a shared root: deeper generations must win over shallower ones
    // no matter when they arrive.
    for (let seed = 1; seed <= 20; seed += 1) {
      const random = rng(seed);
      const root = computeRevision({ state: skillState('s-1', 'root') });
      const records: Array<Omit<ChangeRecord, 'seq'>> = [
        { entityId: 'project/s-1', rev: root, parentRev: null, deleted: false, state: skillState('s-1', 'root') },
      ];
      for (const branch of ['x', 'y', 'z']) {
        let parent = root;
        const depth = 1 + Math.floor(random() * 3);
        for (let level = 0; level < depth; level += 1) {
          const state = skillState('s-1', `${branch}${level}`);
          const rev = computeRevision({ state, parent });
          records.push({ entityId: 'project/s-1', rev, parentRev: parent, deleted: false, state });
          parent = rev;
        }
      }

      const results = [0, 1].map((offset) => {
        const db = node();
        for (const record of shuffle(records, rng(seed + offset * 977))) {
          db.changeLog.applyRemote(record);
        }
        const result = {
          winner: db.changeLog.winnerOf('project/s-1')?.rev,
          conflicts: db.changeLog.conflictsOf('project/s-1').map((l) => l.rev).sort(),
        };
        db.close();
        return result;
      });
      assert.deepEqual(results[0], results[1], `seed ${seed} diverged`);
    }
  });
});

describe('the conflict-model worked examples hold against the real store', () => {
  it('edit beats delete at equal generation, on both nodes', () => {
    const root = computeRevision({ state: skillState('s-1', 'A') });
    const editState = skillState('s-1', 'edited');
    const edit = computeRevision({ state: editState, parent: root });
    const tombstone = computeRevision({ parent: root, deleted: true });

    for (const order of [
      [edit, tombstone],
      [tombstone, edit],
    ]) {
      const db = node();
      db.changeLog.applyRemote({ entityId: 'project/s-1', rev: root, parentRev: null, deleted: false, state: skillState('s-1', 'A') });
      for (const rev of order) {
        db.changeLog.applyRemote({
          entityId: 'project/s-1',
          rev,
          parentRev: root,
          deleted: rev === tombstone,
          state: rev === edit ? editState : undefined,
        });
      }
      const won = db.changeLog.winnerOf('project/s-1');
      assert.equal(won?.rev, edit, 'a live leaf must beat a tombstone of equal generation');
      assert.equal(won?.deleted, false);
      db.close();
    }
  });

  it('an entity whose every leaf is a tombstone is deleted', () => {
    const db = node();
    const root = computeRevision({ state: skillState('s-1', 'A') });
    db.changeLog.applyRemote({ entityId: 'project/s-1', rev: root, parentRev: null, deleted: false, state: skillState('s-1', 'A') });
    // Two live branches, each then deleted, so that both leaves are tombstones. (Two tombstones of one parent
    // would be one revision: a tombstone carries no state, so its revision is its parent's alone.)
    for (const name of ['a', 'b']) {
      const state = skillState('s-1', name);
      const branch = computeRevision({ state, parent: root });
      db.changeLog.applyRemote({ entityId: 'project/s-1', rev: branch, parentRev: root, deleted: false, state });
      db.changeLog.applyRemote({
        entityId: 'project/s-1',
        rev: computeRevision({ parent: branch, deleted: true }),
        parentRev: branch,
        deleted: true,
      });
    }
    assert.equal(db.changeLog.leavesOf('project/s-1').length, 2, 'two leaves, both tombstones');
    assert.equal(db.changeLog.winnerOf('project/s-1')?.deleted, true);
    db.close();
  });

  it('resolution collapses the tree to one live leaf', () => {
    const db = node();
    const root = computeRevision({ state: skillState('s-1', 'root') });
    db.changeLog.applyRemote({ entityId: 'project/s-1', rev: root, parentRev: null, deleted: false, state: skillState('s-1', 'root') });
    const branches = ['A', 'B'].map((name) => {
      const state = skillState('s-1', name);
      const rev = computeRevision({ state, parent: root });
      db.changeLog.applyRemote({ entityId: 'project/s-1', rev, parentRev: root, deleted: false, state });
      return rev;
    });

    const won = db.changeLog.winnerOf('project/s-1')!.rev;
    const loser = branches.find((rev) => rev !== won)!;

    // A caller resolves: a child of the winner, and the loser marked deleted.
    const resolvedState = skillState('s-1', 'resolved');
    db.changeLog.applyRemote({
      entityId: 'project/s-1',
      rev: computeRevision({ state: resolvedState, parent: won }),
      parentRev: won,
      deleted: false,
      state: resolvedState,
    });
    db.changeLog.applyRemote({
      entityId: 'project/s-1',
      rev: computeRevision({ parent: loser, deleted: true }),
      parentRev: loser,
      deleted: true,
    });

    assert.equal(db.changeLog.conflictsOf('project/s-1').length, 1, 'only the tombstoned loser remains');
    assert.equal(db.changeLog.winnerOf('project/s-1')?.deleted, false);
    db.close();
  });
});

describe("The read-then-insert race, carried in as a scenario", () => {
  it('🔴 two nodes registering the same @key converge instead of duplicating', () => {
    // The best-documented concurrency invariant in this repository: people.schema.typeqlite states the
    // @key constraints "are what make a duplicate registration impossible rather than unlikely".
    // Replication must not reintroduce the duplicate the constraint forbids locally.
    const registration = skillState('shared-key', 'registered');
    const rev = computeRevision({ state: registration });

    const nodes = [node(), node()];
    for (const db of nodes) {
      // Both nodes independently "register" the same entity — same key, same state.
      db.changeLog.applyRemote({
        entityId: 'project/shared-key',
        rev,
        parentRev: null,
        deleted: false,
        state: registration,
      });
    }
    // Derived revisions mean both computed the same rev, so replicating produces one leaf, not two.
    for (const db of nodes) {
      assert.equal(db.changeLog.leavesOf('project/shared-key').length, 1);
      assert.equal(db.changeLog.conflictsOf('project/shared-key').length, 0);
      db.close();
    }
  });

  it('a genuinely different edit under one key is a conflict, not a silent overwrite', () => {
    const db = node();
    const mine = skillState('shared-key', 'mine');
    const theirs = skillState('shared-key', 'theirs');
    for (const state of [mine, theirs]) {
      db.changeLog.applyRemote({
        entityId: 'project/shared-key',
        rev: computeRevision({ state }),
        parentRev: null,
        deleted: false,
        state,
      });
    }
    assert.equal(db.changeLog.leavesOf('project/shared-key').length, 2);
    assert.equal(db.changeLog.conflictsOf('project/shared-key').length, 1);
    db.close();
  });
});

describe('revisions carry their state', () => {
  it('a replicated revision can be read back, which replication needs', () => {
    const db = node();
    const state = skillState('s-1', 'carried');
    const rev = computeRevision({ state });
    db.changeLog.applyRemote({ entityId: 'project/s-1', rev, parentRev: null, deleted: false, state });
    assert.deepEqual(db.changeLog.stateOf('project/s-1', rev), state);
    db.close();
  });

  it('a tombstone carries none', () => {
    const db = node();
    db.execute('insert $s isa project, has project-id "s-1", has project-name "A";');
    db.execute('match $s isa project, has project-id "s-1"; delete $s;');
    const won = db.changeLog.winnerOf('project/s-1')!;
    assert.equal(won.deleted, true);
    assert.equal(db.changeLog.stateOf('project/s-1', won.rev), undefined);
    db.close();
  });
});
