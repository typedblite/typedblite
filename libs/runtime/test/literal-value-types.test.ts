import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * Boolean and datetime literals, end to end.
 *
 * 🔴 **The grammar accepting them is half the feature.** `literalText` in the interpreter and
 * `literal` in the generator each convert a literal node to storage text, and until this change
 * *both* returned a silent placeholder for anything they did not recognise — `''` and `NULL`. A
 * boolean would have been stored as an empty string and every later match on it would simply never
 * fire, with no error anywhere. These tests are the roundtrip that proves it does not.
 *
 * The schema below is a downstream application's, reduced to the attributes that made this necessary:
 * `is-latest` (boolean) and `created-at` (datetime), which no schema in this repository had before.
 */
const SCHEMA = `
define
attribute version-id, value string;
attribute is-latest, value boolean;
attribute created-at, value datetime;
attribute version-number, value integer;
entity prompt-version,
    owns version-id @key,
    owns is-latest,
    owns created-at,
    owns version-number;
`;

describe('boolean and datetime literals survive a round trip', () => {
  let db: TypeDBLiteInterpreter;
  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(SCHEMA);
  });

  it('stores and matches a boolean written as `true`', () => {
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00;',
    );

    const { rows } = db.query(
      'match $v isa prompt-version, has is-latest true, has version-id $id;\nselect $id;',
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]['id'].asString(), 'v-1');
  });

  it('distinguishes true from false rather than matching any boolean', () => {
    // 🔴 The test that would have caught the `''` fallback. With both stored as an empty string,
    // "matched one row" still passes — only asking for the *other* value shows the difference.
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00;',
    );
    db.execute(
      'insert $v isa prompt-version, has version-id "v-2", has is-latest false, has created-at 2026-09-03T11:00:00;',
    );

    const latest = db.query(
      'match $v isa prompt-version, has is-latest true, has version-id $id;\nselect $id;',
    );
    const superseded = db.query(
      'match $v isa prompt-version, has is-latest false, has version-id $id;\nselect $id;',
    );

    assert.equal(latest.rows.length, 1);
    assert.equal(latest.rows[0]['id'].asString(), 'v-1');
    assert.equal(superseded.rows.length, 1);
    assert.equal(superseded.rows[0]['id'].asString(), 'v-2');
  });

  it('reads a boolean back as its written text, not as an empty value', () => {
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00;',
    );

    const { rows } = db.query(
      'match $v isa prompt-version, has version-id "v-1", has is-latest $l;\nselect $l;',
    );

    assert.equal(rows[0]['l'].asString(), 'true');
    assert.notEqual(rows[0]['l'].asString(), '');
  });

  it('stores and matches a datetime', () => {
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00;',
    );

    const { rows } = db.query(
      'match $v isa prompt-version, has created-at 2026-09-03T10:00:00, has version-id $id;\nselect $id;',
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]['id'].asString(), 'v-1');
  });

  it('does not match a different instant', () => {
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00;',
    );

    const { rows } = db.query(
      'match $v isa prompt-version, has created-at 2026-09-03T10:00:01, has version-id $id;\nselect $id;',
    );

    assert.equal(rows.length, 0);
  });

  it('reads a datetime back verbatim — one spelling in, the same spelling out', () => {
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00;',
    );

    const { rows } = db.query(
      'match $v isa prompt-version, has version-id "v-1", has created-at $c;\nselect $c;',
    );

    assert.equal(rows[0]['c'].asString(), '2026-09-03T10:00:00');
  });

  it('still stores an integer alongside them, unchanged', () => {
    // The DATETIME terminal sits in front of INT in the lexer. This is the regression that would
    // fire if it ever swallowed a plain number.
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00, has version-number 3;',
    );

    const { rows } = db.query(
      'match $v isa prompt-version, has version-number 3, has version-id $id;\nselect $id;',
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]['id'].asString(), 'v-1');
  });

  it('refuses a quoted datetime where a datetime literal is due', () => {
    // Both are the text `2026-09-03T10:00:00`, and until Phase 06 of the conformance feature they
    // matched each other — pinned then as a consequence of storing values as text. A string is
    // not a datetime on TypeDB, and since the Phase 06 review (round 12) a literal must be of the
    // kind the attribute holds, on a read as on a write.
    db.execute(
      'insert $v isa prompt-version, has version-id "v-1", has is-latest true, has created-at 2026-09-03T10:00:00;',
    );

    assert.throws(
      () => db.query('match $v isa prompt-version, has created-at "2026-09-03T10:00:00", has version-id $id;\nselect $id;'),
      /'created-at' holds a datetime, and this is a string/,
    );
    const { rows } = db.query(
      'match $v isa prompt-version, has created-at 2026-09-03T10:00:00, has version-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 1);
  });
});
