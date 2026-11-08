// 🔴 **Historical from 2026-09-01: there is no Jest in this repository any more.** The comments
// below argue for one runner over another — `tsx`/`node:test` against `ts-jest` — and that choice
// no longer exists: every suite runs under Vitest, with SWC supplying the `emitDecoratorMetadata`
// esbuild cannot and Node's real resolution supplying `node:sqlite`. The *reasoning* is kept
// because it is why the replacement had to satisfy both constraints at once, not because the
// split it describes is still real. See ADR-028.
/**
 * 🔴 **The full-text index must be maintained by a local write, not only by replication.**
 *
 * `fullText.index` was reachable only from `projectWinnerOnce`, which only `applyRemote` calls. So
 * a store written locally and then searched returned **zero rows, for every query, with no error** —
 * exactly the "silently returns nothing" failure this engine replaced CouchDB and Nouveau to avoid,
 * and the one `downstream-store`'s capitalised status values already demonstrate.
 *
 * Nobody hit it because no consumer both wrote locally and searched. `graph-store` never searched;
 * `fts-parity.test.ts` drives `FullTextIndex` directly, bypassing the write path entirely.
 * `document-store` is the first to do both, and found it on its first search test.
 *
 * 🔴 `tsx` with `node:test`, not Jest — `node:sqlite` is a builtin only under its prefixed name and
 * Jest strips the prefix. See `interpreter.test.ts`'s header.
 */
import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const documentSchema = readFileSync(
  join(SCHEMAS, 'document-store.schema.typeqlite'),
  'utf8',
);

describe('a local write keeps the full-text index current', () => {
  let interpreter: TypeDBLiteInterpreter;

  beforeEach(() => {
    interpreter = new TypeDBLiteInterpreter();
    interpreter.define(documentSchema);
  });

  const add = (id: string, body: string, tag = 'governance') =>
    interpreter.execute(`
      insert $d isa document,
        has doc-id "${id}",
        has doc-title "A title",
        has doc-kind "note",
        has doc-path "docs/x.md",
        has doc-tag "${tag}",
        has doc-body "${body}";
    `);

  it('indexes an entity written locally, with no replication involved', () => {
    add('downstream-app:local-1', 'a document about replication and convergence');

    const hits = interpreter.changeLog.fullText.search('text:convergence');

    assert.equal(hits.length, 1);
    // Identity is `<type>/<key value>`, never `thing.iid` — canonical.ts.
    assert.equal(hits[0]?.entityId, 'document/downstream-app:local-1');
  });

  it('indexes tags, so a tag search works without replication', () => {
    add('downstream-app:local-2', 'body', 'governance');

    assert.equal(interpreter.changeLog.fullText.search('tags:governance').length, 1);
  });

  it('counts one row per entity, not one per write', () => {
    add('downstream-app:local-3', 'first');
    add('downstream-app:local-4', 'second');

    assert.equal(interpreter.changeLog.fullText.count(), 2);
  });

  /**
   * A tombstoned entity still findable by search is the divergence nobody notices until someone
   * asks why a deleted thing is in their results. `projectWinnerOnce` says exactly that about the
   * replication path; the local path now gives the same guarantee.
   */
  it('removes a locally deleted entity from the index', () => {
    add('downstream-app:local-5', 'findable for now');
    assert.equal(interpreter.changeLog.fullText.search('text:findable').length, 1);

    interpreter.execute(`
      match $d isa document, has doc-id "downstream-app:local-5";
      delete $d;
    `);

    assert.deepEqual(interpreter.changeLog.fullText.search('text:findable'), []);
  });
});
