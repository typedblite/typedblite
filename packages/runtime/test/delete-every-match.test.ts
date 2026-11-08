import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * `match … delete` deletes **every** match, not the first one.
 *
 * 🔴 **Found by the defect-resolution gate's own construction**, 2026-09-05: replacing a defect
 * record kept two of its three claims. `TypeDBLiteDefectRepository` works around it by deleting on a
 * `@key`, so each of its matches is a single row — and every other TypeDBLite caller in this
 * repository is safe by the same accident. `TypeDBLiteRegisterRepository.deleteRow` matches on
 * `register-branch @key`; nothing here had ever deleted over a set.
 *
 * ⚠️ **The failure was silent in the direction that matters.** The statement succeeded, the
 * pipeline reported `ok`, and the process exited 0 — with two of the three rows still there. A
 * caller has no signal at all.
 *
 * Recorded as `d-20260905-match-delete-removes-one-match-of`; the red run of this file is the
 * evidence `defect.red` holds.
 */
const SCHEMA = `
define
attribute kid-id, value string;
attribute owner-tag, value string;
entity kid, owns kid-id @key, owns owner-tag;
`;

describe('delete applies to every match', () => {
  let db: TypeDBLiteInterpreter;

  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(SCHEMA);
    for (const id of ['1', '2', '3']) {
      db.execute(`insert $k isa kid, has kid-id "${id}", has owner-tag "owner";`);
    }
  });

  // 🔴 `query`, not `execute`. `execute` returns a write report with no `rows`, so a read written
  // through it throws `Cannot read properties of undefined` — which is a test failing for a reason
  // that has nothing to do with the defect. It did, and the first recorded red run said otherwise.
  const remaining = (): string[] => {
    const { rows } = db.query('match $k isa kid, has kid-id $i; select $i;');
    return (rows as Array<Record<string, unknown>>).map((row) => String(row['i']));
  };

  it('deletes every entity a match binds, not just the first', () => {
    assert.deepEqual(remaining(), ['1', '2', '3']);

    db.execute('match $k isa kid, has owner-tag "owner"; delete $k;');

    // 🔴 The assertion is the *remaining set*, not a count. A count of zero and "the right rows
    // went" are the same here only because the set is small; the set is what the caller cares about.
    assert.deepEqual(remaining(), []);
  });

  it('deletes an attribute from every owner a match binds', () => {
    // The same `[0]` indexing sits in the `delete $attr of $owner` branch, and nothing exercised it
    // over more than one owner either.
    db.execute('match $k isa kid, has owner-tag $t; delete $t of $k;');

    const tagged = db.query('match $k isa kid, has owner-tag $t; select $t;');
    assert.equal(tagged.rows.length, 0);
  });

  it('leaves rows a match does not bind', () => {
    db.execute('insert $k isa kid, has kid-id "4", has owner-tag "other";');

    db.execute('match $k isa kid, has owner-tag "owner"; delete $k;');

    // 🔴 The negative half. A `delete` that removed everything would satisfy the first test
    // perfectly, and this is the one it fails.
    assert.deepEqual(remaining(), ['4']);
  });
});
