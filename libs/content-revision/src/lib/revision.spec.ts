/**
 * The properties the conflict model's convergence rests on. Each case is a claim
 * conflict-model.md (in the monorepo this engine came from)
 * makes, tested rather than asserted in prose.
 *
 * 🔴 **These moved here with the code.** They used to live in
 * `typedblite-runtime`, which is `type:infrastructure` and therefore off-limits to a `type:domain`
 * library — and a downstream domain library needs this generator. The `entityId` cases stayed behind, because
 * a `local:` id is a fact about TypeDBLite's storage rather than about content.
 *
 * ⚠️ **Semantics unchanged, deliberately.** ADR-003 D3's revision behavior was proven against real
 * CouchDB 3.4.3, and `nx run typedblite-runtime:test-oracle` is what re-checks it. A move is not a
 * change, and these cases are the evidence it was not one.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { canonical, type EntityState } from './canonical.js';
import {
  computeRevision,
  conflicts,
  digestOf,
  generationOf,
  winner,
  type Leaf,
} from './revision.js';

const state = (
  attributes: Array<[string, string]>,
  roles: Array<[string, string]> = [],
  type = 'skill',
): EntityState => ({
  type,
  attributes: attributes.map(([t, value]) => ({ type: t, value })),
  roles: roles.map(([role, player]) => ({ role, player })),
});

describe('canonical', () => {
  it('is independent of the order attributes were collected in', () => {
    const a = state([
      ['skill-id', 's-1'],
      ['title', 'Start Session'],
    ]);
    const b = state([
      ['title', 'Start Session'],
      ['skill-id', 's-1'],
    ]);
    assert.equal(canonical(a), canonical(b));
  });

  it('is independent of role order', () => {
    const a = state(
      [['skill-id', 's-1']],
      [
        ['step', 'skill/s-2'],
        ['owner', 'person/p-1'],
      ],
    );
    const b = state(
      [['skill-id', 's-1']],
      [
        ['owner', 'person/p-1'],
        ['step', 'skill/s-2'],
      ],
    );
    assert.equal(canonical(a), canonical(b));
  });

  it('distinguishes an absent attribute from one present and empty', () => {
    const absent = state([['skill-id', 's-1']]);
    const empty = state([
      ['skill-id', 's-1'],
      ['title', ''],
    ]);
    assert.notEqual(canonical(absent), canonical(empty));
  });

  it('cannot be forged by a value containing the separator', () => {
    // Length-prefixing exists for this. With `name:value|name:value` the first state below could
    // encode identically to the second, silently merging unrelated data.
    const forged = state([['title', '3:foo4:bar']]);
    const real = state([
      ['foo', 'bar'],
      ['title', 'x'],
    ]);
    assert.notEqual(canonical(forged), canonical(real));
  });

  it('distinguishes types with otherwise identical state', () => {
    assert.notEqual(
      canonical(state([['id', '1']], [], 'skill')),
      canonical(state([['id', '1']], [], 'step')),
    );
  });
});

describe('computeRevision', () => {
  it('starts at generation 1 and increments from the parent', () => {
    const first = computeRevision({ state: state([['skill-id', 's-1']]) });
    assert.equal(generationOf(first), 1);
    const second = computeRevision({
      state: state([
        ['skill-id', 's-1'],
        ['title', 'x'],
      ]),
      parent: first,
    });
    assert.equal(generationOf(second), 2);
  });

  it('🔴 is derived, so the same edit on two nodes converges without a conflict', () => {
    const parent = computeRevision({ state: state([['skill-id', 's-1']]) });
    const edit = state([
      ['skill-id', 's-1'],
      ['title', 'Agreed'],
    ]);
    const nodeA = computeRevision({ state: edit, parent });
    const nodeB = computeRevision({ state: edit, parent });
    assert.equal(nodeA, nodeB);
  });

  it('differs when state, parent, or the deleted flag differ', () => {
    const parent = computeRevision({ state: state([['skill-id', 's-1']]) });
    const base = computeRevision({
      state: state([
        ['skill-id', 's-1'],
        ['t', 'a'],
      ]),
      parent,
    });
    const otherState = computeRevision({
      state: state([
        ['skill-id', 's-1'],
        ['t', 'b'],
      ]),
      parent,
    });
    const otherParent = computeRevision({
      state: state([
        ['skill-id', 's-1'],
        ['t', 'a'],
      ]),
      parent: computeRevision({ state: state([['skill-id', 's-2']]) }),
    });
    const tombstone = computeRevision({ parent, deleted: true });
    assert.equal(new Set([base, otherState, otherParent, tombstone]).size, 4);
  });

  it('rejects a malformed revision rather than guessing a generation', () => {
    assert.throws(() => generationOf('not-a-rev'), /Malformed revision/);
  });
});

describe('winner', () => {
  const leaf = (rev: string, deleted = false): Leaf => ({ rev, deleted });

  it('prefers the highest generation', () => {
    assert.equal(
      winner([leaf('1-aaa'), leaf('3-bbb'), leaf('2-ccc')])?.rev,
      '3-bbb',
    );
  });

  it('breaks a generation tie on the greatest digest, not arrival order', () => {
    const forwards = winner([leaf('2-aaa'), leaf('2-ccc'), leaf('2-bbb')])?.rev;
    const backwards = winner([
      leaf('2-bbb'),
      leaf('2-ccc'),
      leaf('2-aaa'),
    ])?.rev;
    assert.equal(forwards, '2-ccc');
    assert.equal(
      backwards,
      '2-ccc',
      'order of arrival must not change the winner',
    );
  });

  it('🔴 lets a live leaf beat a tombstone of equal generation — edit beats delete', () => {
    const won = winner([leaf('2-bbb'), leaf('2-zzz', true)]);
    assert.equal(won?.rev, '2-bbb');
    assert.equal(won?.deleted, false);
  });

  it('is deleted only when every leaf is a tombstone', () => {
    const won = winner([leaf('2-aaa', true), leaf('2-bbb', true)]);
    assert.equal(won?.deleted, true);
    assert.equal(won?.rev, '2-bbb');
  });

  it('returns nothing for an entity with no leaves', () => {
    assert.equal(winner([]), undefined);
  });
});

describe('conflicts', () => {
  it('lists every losing leaf, so Goal 2 is enumerable and not merely retained', () => {
    const leaves = [
      { rev: '2-aaa', deleted: false },
      { rev: '2-ccc', deleted: false },
      { rev: '2-bbb', deleted: false },
    ];
    assert.deepEqual(
      conflicts(leaves)
        .map((leaf) => leaf.rev)
        .sort(),
      ['2-aaa', '2-bbb'],
    );
  });

  it('is empty when there is one leaf', () => {
    assert.deepEqual(conflicts([{ rev: '1-aaa', deleted: false }]), []);
  });
});

describe('the three-way split from the conflict model reconverges', () => {
  it('agrees on a winner regardless of the order nodes met', () => {
    const root = computeRevision({ state: state([['skill-id', 's-1']]) });
    const revs = ['A', 'B', 'C'].map((v) =>
      computeRevision({
        state: state([
          ['skill-id', 's-1'],
          ['t', v],
        ]),
        parent: root,
      }),
    );
    const leaves = revs.map((rev) => ({ rev, deleted: false }));

    const orderings = [
      [leaves[0], leaves[1], leaves[2]],
      [leaves[2], leaves[0], leaves[1]],
      [leaves[1], leaves[2], leaves[0]],
    ];
    const winners = new Set(orderings.map((o) => winner(o)?.rev));
    assert.equal(winners.size, 1, 'every node must pick the same winner');
    assert.equal(conflicts(orderings[0]).length, 2);
  });

  it('resolves to a single live leaf once a child supersedes the winner', () => {
    const root = computeRevision({ state: state([['skill-id', 's-1']]) });
    const a = computeRevision({
      state: state([
        ['skill-id', 's-1'],
        ['t', 'A'],
      ]),
      parent: root,
    });
    const b = computeRevision({
      state: state([
        ['skill-id', 's-1'],
        ['t', 'B'],
      ]),
      parent: root,
    });
    const won = winner([
      { rev: a, deleted: false },
      { rev: b, deleted: false },
    ])!;
    const resolved = computeRevision({
      state: state([
        ['skill-id', 's-1'],
        ['t', 'resolved'],
      ]),
      parent: won.rev,
    });

    const after: Leaf[] = [
      { rev: resolved, deleted: false },
      { rev: a === won.rev ? b : a, deleted: true },
    ];
    assert.equal(winner(after)?.rev, resolved);
    assert.equal(conflicts(after).length, 1);
    assert.equal(generationOf(resolved), 3);
    assert.ok(digestOf(resolved).length === 32);
  });
});
