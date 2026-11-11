import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * 🔴 `select` must never answer zero rows and call it success.
 *
 * `match $n isa node, has node-id "a"; select $n;` is valid TypeQLite, reads correctly, and returned
 * **nothing** — because `project()` only ever emitted *attribute* bindings and then dropped rows
 * with no keys. Found 2026-09-05 building the defect gate: `TypeDBLiteDefectRepository.exists` was
 * written exactly that way, reported `false` for every record that existed, and the follow-on
 * insert hit `[CNT9] Constraint '@unique' has been violated`.
 *
 * **Until 2026-09-11 this file asserted a refusal** — the honest interim while a thing could not
 * be projected. Phase 02 of the conformance feature made a cell a concept, so `select $n` on an
 * entity now answers one row carrying it, as TypeDB does, and the expectations inverted here as the
 * old header said they would. What is still refused: a variable the `match` never bound.
 *
 * ⚠️ **Only an integration test can catch the original defect.** A unit test against a fake
 * passes, and nothing about the query looks wrong — so the thing cases below assert the *cell*,
 * never just a row count. A row count alone is what the defect produced.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute node-label, value string;',
  'attribute edge-id, value string;',
  'entity node, owns node-id @key, owns node-label, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a", has node-label "alpha";');
  engine.execute('insert $n isa node, has node-id "b", has node-label "beta";');
  engine.execute(
    'match $s isa node, has node-id "a"; $t isa node, has node-id "b"; ' +
      'insert $l isa link (source: $s, target: $t), has edge-id "ab";',
  );
});

const refusalOf = (query: string): Error => {
  let thrown: unknown;
  try {
    engine.query(query);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, `\`${query}\` did not throw — it answered`);
  return thrown as Error;
};

describe('a select that names a thing projects the thing', () => {
  it('answers an entity variable as an entity cell — the defect-gate query that once answered nothing', () => {
    const { rows } = engine.query('match $n isa node, has node-id "a"; select $n;');
    assert.equal(rows.length, 1, 'one node has node-id "a", so one row');
    const cell = rows[0]['n'];
    assert.ok(cell.isEntity(), 'the cell is an entity');
    assert.equal(cell.type, 'node');
    assert.equal(typeof cell.iid, 'number');
    assert.throws(() => cell.asString(), /Cannot extract string from entity\('node'\)/);
  });

  it('answers a relation variable as a relation cell, not an entity', () => {
    const { rows } = engine.query('match $l isa link; select $l;');
    assert.equal(rows.length, 1);
    // 🔴 The assertion that makes this case worth having: a relation is a thing whose type
    // `define` declared with `relation`, and the cell must say so — an entity cell for a link would
    // be a cell that answered, and answered wrongly.
    assert.ok(rows[0]['l'].isRelation());
    assert.ok(!rows[0]['l'].isEntity());
    assert.equal(rows[0]['l'].type, 'link');
  });

  it('projects a thing and an attribute side by side — the shape that used to drop a column silently', () => {
    const { rows } = engine.query('match $n isa node, has node-label $l; select $l, $n;');
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row['n'].isEntity(), '$n is a column, not a silently missing one');
      assert.ok(row['l'].isAttribute());
      assert.equal(row['l'].type, 'node-label');
    }
    assert.deepEqual(rows.map((row) => row['l'].asString()).sort(), ['alpha', 'beta']);
  });

  it('answers the same thing once per attribute value, and the cells are the same thing', () => {
    engine.execute('match $n isa node, has node-id "a"; insert $n has node-label "aleph";');
    const { rows } = engine.query('match $n isa node, has node-id "a", has node-label $l; select $n, $l;');
    assert.equal(rows.length, 2, 'two labels on one node: two rows');
    assert.equal(rows[0]['n'].iid, rows[1]['n'].iid, 'both rows carry the one node');
  });
});

describe('a select that names a variable the match never bound is refused', () => {
  it('refuses a variable that appears nowhere, and names what was bound', () => {
    const error = refusalOf('match $n isa node, has node-id $id; select $nowhere;');

    assert.match(error.message, /\$nowhere/);
    assert.match(error.message, /never bound/);
    // 🔴 The inventory names BOTH the thing and the attribute variable now — either is selectable.
    assert.match(error.message, /Bound here: \$id, \$n\./);
    assert.equal(diagnosticOf(error)?.code, DiagnosticCode.unprojectableVariable);
  });

  // ✅ A role player named only inside `links (...)` IS bound — `relationBindings` binds it, and it
  // is answered like any variable, as TypeDB answers it. This test asserted a refusal ("has no `isa`
  // pattern, so this `match` answers 0 rows") and named it "TypeDBLite's own gap, which the
  // conformance report card counts"; the card's negation.feature L241 is where it closed.
  it('selects a role player that has no `isa` of its own', () => {
    const { rows } = engine.query('match $l isa link, links (source: $s, target: $t), has edge-id $e; select $s;');
    assert.ok(rows.length > 0);
    for (const row of rows) assert.ok(row['s']?.isThing(), 'the cell is the player itself');
  });

  it('a typo names every bound variable, role players included', () => {
    const error = refusalOf('match $l isa link, links (source: $s, target: $t), has edge-id $e; select $typo;');
    assert.match(error.message, /Bound here: \$e, \$l, \$s, \$t\./);
    assert.doesNotMatch(error.message, /answers 0 rows/);
  });
});

describe('what still works, unchanged', () => {
  it('projects attribute variables', () => {
    const { rows } = engine.query(
      'match $n isa node, has node-id $id, has node-label $label; select $id, $label;',
    );
    assert.equal(rows.length, 2);
    const byId = rows.map((row) => [row['id']?.asString(), row['label']?.asString()]).sort();
    assert.deepEqual(byId, [
      ['a', 'alpha'],
      ['b', 'beta'],
    ]);
  });

  it('still answers zero rows when the constraints genuinely exclude everything', () => {
    // 🔴 The distinction the whole defect turns on: an empty result is legitimate here and a
    // refusal there. Turning both into errors would be the opposite mistake.
    const { rows } = engine.query(
      'match $n isa node, has node-id "nope", has node-label $label; select $label;',
    );
    assert.equal(rows.length, 0);
  });
});
