import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';

/**
 * 🔴 A `match` with no `select` is a query, and it is evaluated.
 *
 * `query()` used to `continue` past any pipeline without a `select`, so `match $x isa person;`
 * answered `(0 rows)` at exit 0 — and so did `match $x isa ganesh;`, because the unknown-type check
 * lives inside the evaluation that was skipped. Found 2026-09-11 by the conformance harness: every
 * read in `typedb-behaviour`'s `query/language/` is a bare match, and 65 scenarios stopped on it
 * after Phase 01 (`d-20260911-a-match-pipeline-with-no-select`).
 *
 * TypeDB 3 answers a bare match with one row per binding, every named variable projected, and a
 * thing variable carries the *thing* — its iid and type — not an attribute of it. These tests are
 * the three claims on the record, in the record's order.
 *
 * ⚠️ The row-count assertion comes before the cell-shape assertion on purpose: against the unfixed
 * code the count is what fails, and that is the defect's own symptom. A test that failed first on
 * a missing method would be red for the wrong reason.
 */
const SCHEMA = [
  'define',
  'attribute ref, value integer;',
  'attribute name, value string;',
  'entity person, owns ref @key, owns name;',
  'entity writer sub person;',
  // 🔴 Unrelated to `person` on purpose: the no-`isa` test below must discriminate "every owner"
  // from "person and its subtypes", which two related owners cannot.
  'entity company, owns ref @key, owns name;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $x isa person, has ref 0, has name "Alice";');
  engine.execute('insert $y isa writer, has ref 1;');
});

describe('a bare match is evaluated', () => {
  it('answers one row per binding, and the row carries the thing', () => {
    const { rows, diagnostics } = engine.query('match $x isa person;');
    assert.equal(rows.length, 2, 'a bare match over two people answers two rows, not none');
    assert.ok(
      diagnostics.some((d) => d.code === DiagnosticCode.projected),
      'the pipeline was projected, and said so',
    );
    const cells = rows.map((row) => row['x']);
    assert.ok(cells.every((cell) => cell.isEntity()), 'every $x is an entity cell');
    assert.deepEqual(
      cells.map((cell) => cell.type).sort(),
      ['person', 'writer'],
      'the cell carries the actual type of the thing, subtype included',
    );
    assert.throws(
      () => cells[0].asString(),
      /Cannot extract string/,
      'a thing is not a string, and reading it as one throws as the driver does',
    );
  });

  it('projects every named variable — thing and attribute alike — when there is no select', () => {
    const { rows } = engine.query('match $x isa person, has name $n;');
    assert.equal(rows.length, 1);
    assert.ok(rows[0]['x'].isEntity());
    assert.ok(rows[0]['n'].isAttribute());
    assert.equal(rows[0]['n'].type, 'name');
    assert.equal(rows[0]['n'].asString(), 'Alice');
  });

  it('binds every owner of an attribute when there is no isa — `match $x has name $n;`', () => {
    // No `isa` on `$x`: TypeDB answers every thing owning a `name`, whatever its type. Here the
    // `EXISTS` clause on the binding is the only constraint `candidates()` applies, which is the
    // same answer — and this test is what makes that defined rather than incidental.
    engine.execute('insert $y isa writer, has ref 2, has name "Bob";');
    engine.execute('insert $c isa company, has ref 3, has name "Acme";');
    const { rows } = engine.query('match $x has name $n;');
    assert.deepEqual(
      rows.map((row) => [row['x'].type, row['n'].asString()]).sort(),
      [
        ['company', 'Acme'],
        ['person', 'Alice'],
        ['writer', 'Bob'],
      ],
    );
  });

  it('refuses an unknown type, as the select form always did', () => {
    assert.throws(
      () => engine.query('match $x isa ganesh;'),
      /ganesh/,
      'an unknown type in a bare match is refused, not answered with zero rows',
    );
  });

  it('refuses an unknown attribute, as the select form always did', () => {
    assert.throws(
      () => engine.query('match $x isa person, has no-such-thing $y;'),
      /no-such-thing/,
      'an unknown attribute in a bare match is refused, not answered with zero rows',
    );
  });
});
