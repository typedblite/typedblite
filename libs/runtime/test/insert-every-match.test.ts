import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * `match … insert` writes to **every** match, not the first one.
 *
 * 🔴 **The other half of the quantification defect.** Phase 03 of the defect gate fixed the delete
 * path — `d-20260905-match-delete-removes-one-match-of` — and deliberately left the insert path
 * alone, one change at a time. This is that deferral coming back: `execute` still chooses
 * `resolveMatch`, which keeps `combinations[0]`, for anything that is not a `DeleteStage`.
 *
 * ⚠️ **Verified latent before it was fixed, not assumed.** All twelve `match`-then-write statements
 * in this repository bind on a `@key` — `entity-id`, `doc-id`, `node-id`, `sprint-id`,
 * `log-key`, `register-branch`, `task-id` — so every match is a single row and every caller was
 * safe **by accident**. The delete half was equally latent right up until the defect gate's claim
 * store became the first caller to write over a non-key attribute.
 *
 * Recorded as `d-20260905-match-insert-writes-to-one-match`.
 */
const SCHEMA = `
define
attribute kid-id, value string;
attribute owner-tag, value string;
attribute note, value string;
entity kid, owns kid-id @key, owns owner-tag, owns note;
`;

describe('insert applies to every match', () => {
  let db: TypeDBLiteInterpreter;

  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(SCHEMA);
    for (const id of ['1', '2', '3']) {
      db.execute(`insert $k isa kid, has kid-id "${id}", has owner-tag "owner";`);
    }
  });

  /** 🔴 `query`, not `execute` — `execute` returns a write report with no `rows`. */
  const noted = (): string[] => {
    const { rows } = db.query('match $k isa kid, has note $n, has kid-id $i; select $i;');
    return (rows as Array<Record<string, unknown>>).map((row) => String(row['i'])).sort();
  };

  it('writes an attribute to every owner a match binds', () => {
    db.execute('match $k isa kid, has owner-tag "owner"; insert $k has note "n";');

    // The remaining set, not a count: which rows got it is the fact that matters.
    assert.deepEqual(noted(), ['1', '2', '3']);
  });

  it('leaves owners a match does not bind', () => {
    db.execute('insert $k isa kid, has kid-id "4", has owner-tag "other";');

    db.execute('match $k isa kid, has owner-tag "owner"; insert $k has note "n";');

    // 🔴 The negative half. An insert that wrote to everything would satisfy the first test
    // perfectly, and this is the one it fails.
    assert.deepEqual(noted(), ['1', '2', '3']);
  });

  it('still runs zero times for a match that binds nothing', () => {
    db.execute('match $k isa kid, has owner-tag "absent"; insert $k has note "n";');

    // The interpreter's own contract: an empty match is a SUCCESS that writes nothing, and
    // quantifying over every combination must not disturb that.
    assert.deepEqual(noted(), []);
  });
});
