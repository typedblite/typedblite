/**
 * Change-log compaction — ADR-003 Decision 4 is the constraint, not an afterthought.
 *
 * The log retains every revision for replication. This repository has one node, and its store had
 * grown to eighteen times the corpus it mirrors: 60 MB of database for 3.3 MB of documents, because
 * `documentation.ingest` writes a tombstone and a fresh insert per document on every run.
 *
 * 🔴 The assertions that matter are the ones about what compaction **refuses** to remove. Dropping
 * a conflicting leaf would satisfy every size expectation here and quietly break the guarantee
 * ADR-003 D4 calls part of the deliverable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { ChangeLog } from '../src/change-log.js';
import { computeRevision } from '../src/revision.js';
import type { EntityState } from '../src/canonical.js';

const state = (value: string): EntityState => ({
  type: 'document',
  attributes: [{ type: 'doc-id', value }],
  roles: [],
});

describe('ChangeLog.compact', () => {
  let db: DatabaseSync;
  let log: ChangeLog;

  /**
   * Rows written straight into `change_log`, rather than through `applyRemote`.
   *
   * 🔴 Deliberate, not a shortcut. `applyRemote` also *projects* the winner into `thing`/`has`,
   * which needs a full interpreter and a real schema. Compaction — and every query it must not
   * break, `leavesOf`, `winnerOf`, `conflictsOf`, `stateOf` — reads `change_log` and nothing else,
   * so a log built directly is the faithful fixture and a smaller one.
   */
  const put = (
    id: string,
    rev: string,
    parent: string | null,
    body: EntityState | null,
  ): void => {
    db.prepare(
      `INSERT INTO change_log (entity_id, rev, parent_rev, deleted, state)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, rev, parent, body ? 0 : 1, body ? JSON.stringify(body) : null);
  };

  /** A linear chain of `depth` revisions for one entity, oldest first. */
  const chain = (id: string, depth: number): string[] => {
    const revs: string[] = [];
    let parent: string | undefined;
    for (let generation = 1; generation <= depth; generation += 1) {
      const body = state(`${id}-v${generation}`);
      const rev = computeRevision({ state: body, ...(parent ? { parent } : {}) });
      put(id, rev, parent ?? null, body);
      revs.push(rev);
      parent = rev;
    }
    return revs;
  };

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    log = new ChangeLog(db);
    log.ensureSchema();
  });

  it('removes ancestors and keeps the leaf', () => {
    const revs = chain('document/a', 5);

    const report = log.compact();

    expect(report.entities).toBe(1);
    expect(report.revisionsBefore).toBe(5);
    expect(report.revisionsAfter).toBe(1);
    expect(report.removed).toBe(4);
    expect(log.leavesOf('document/a').map((l) => l.rev)).toEqual([revs[4]]);
  });

  it('keeps the winner readable — the state survives, not just the row', () => {
    chain('document/a', 4);

    log.compact();

    const winner = log.winnerOf('document/a');
    expect(winner).toBeDefined();
    expect(log.stateOf('document/a', winner!.rev)).toBeDefined();
  });

  /**
   * 🔴 ADR-003 Decision 4. A conflicting loser is a leaf, and losing it would take `conflictsOf`
   * with it — the guarantee the ADR calls part of the deliverable rather than a convenience.
   */
  it('keeps every conflicting leaf, not only the winner', () => {
    const [first] = chain('document/a', 1);
    // A second branch from the same parent: two leaves, one of which must lose.
    const rival = state('document/a-rival');
    put('document/a', computeRevision({ state: rival, parent: first }), first ?? null, rival);
    const branch = state('document/a-branch');
    put('document/a', computeRevision({ state: branch, parent: first }), first ?? null, branch);

    const leavesBefore = log.leavesOf('document/a').map((l) => l.rev).sort();
    expect(leavesBefore).toHaveLength(2);
    expect(log.conflictsOf('document/a')).toHaveLength(1);

    log.compact();

    expect(log.leavesOf('document/a').map((l) => l.rev).sort()).toEqual(leavesBefore);
    expect(log.conflictsOf('document/a')).toHaveLength(1);
    // The loser is still readable, which is what "enumerable" is worth.
    for (const leaf of log.leavesOf('document/a')) {
      expect(log.stateOf('document/a', leaf.rev)).toBeDefined();
    }
  });

  it('keeps a tombstone leaf, which has no state to keep', () => {
    const [first] = chain('document/a', 1);
    const dead = computeRevision({ parent: first, deleted: true });
    put('document/a', dead, first ?? null, null);

    log.compact();

    expect(log.leavesOf('document/a')).toEqual([{ rev: dead, deleted: true }]);
  });

  it('compacts every entity, and counts them', () => {
    chain('document/a', 3);
    chain('document/b', 4);
    chain('document/c', 2);

    const report = log.compact();

    expect(report.entities).toBe(3);
    expect(report.revisionsBefore).toBe(9);
    expect(report.revisionsAfter).toBe(3);
  });

  it('retains the most recent ancestors when asked', () => {
    chain('document/a', 5);

    const report = log.compact({ keepAncestors: 2 });

    // 1 leaf + 2 retained ancestors.
    expect(report.revisionsAfter).toBe(3);
  });

  it('reports the state bytes it dropped', () => {
    chain('document/a', 4);

    const report = log.compact();

    expect(report.bytesReclaimed).toBeGreaterThan(0);
  });

  /** Compaction of an already-compact log is a no-op, so it is safe to run on a schedule. */
  it('is idempotent', () => {
    chain('document/a', 4);
    log.compact();

    const second = log.compact();

    expect(second.removed).toBe(0);
    expect(second.bytesReclaimed).toBe(0);
  });

  it('handles an empty log without dividing by anything', () => {
    const report = log.compact();

    expect(report).toEqual({
      entities: 0,
      revisionsBefore: 0,
      revisionsAfter: 0,
      removed: 0,
      bytesReclaimed: 0,
    });
  });

  it('vacuums without disturbing the leaves', () => {
    const revs = chain('document/a', 4);
    log.compact();

    log.vacuum();

    expect(log.leavesOf('document/a').map((l) => l.rev)).toEqual([revs[3]]);
  });
});
