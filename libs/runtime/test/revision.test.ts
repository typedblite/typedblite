/**
 * Replication identity — the half of the old `revision.test.ts` that did not move.
 *
 * 🔴 **The canonical encoding and the revision generator moved to
 * `@typedblite/content-revision`**, and their cases went with them.
 * What is left is `entityId`, which is about *this engine's* storage: a keyless thing has no
 * cross-node identity and is marked `local:` so replication refuses it rather than inventing an
 * equivalence.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { entityId, isReplicable } from '../src/canonical.js';

describe('entityId', () => {
  it('is the @key value, so two nodes agree on the same entity', () => {
    const key = { type: 'project-id', value: 's-1' };
    assert.equal(entityId('project', key, 1), 'project/s-1');
    assert.equal(entityId('project', key, 999), 'project/s-1');
  });

  it('marks a keyless thing local, because iid is node-local', () => {
    // thing.iid comes from last_insert_rowid(): two nodes both call their first entity 1.
    const id = entityId('note', undefined, 1);
    assert.equal(isReplicable(id), false);
    assert.equal(isReplicable(entityId('project', { type: 'project-id', value: 's-1' }, 1)), true);
  });
});
