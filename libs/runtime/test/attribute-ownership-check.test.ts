import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * 🔴 A pattern that constrains an attribute its type does not own can never match, and must say so.
 *
 * `match $n isa node, has edge-id $e;` answered **zero rows at exit code 0**. Two attempts to derive
 * the cause from candidate counts reported a *data* problem for a *schema* fault, in different wrong
 * ways, before the inference was deleted as underivable — and it was, from what `SchemaModel` held:
 * `types` and `attributes` as two flat sets with no relation between them. The schema AST always
 * carried ownership; nothing had written it down. `schema_owns` does.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute node-label, value string;',
  'attribute edge-id, value string;',
  'entity node, owns node-id @key, owns node-label;',
  'relation link, relates source, relates target, owns edge-id @key;',
].join('\n');

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const filePath = (): string => {
  directory = mkdtempSync(join(tmpdir(), 'typedblite-owns-'));
  return join(directory, 'store.db');
};

const engineWith = (schema = SCHEMA): TypeDBLiteInterpreter => {
  const engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(schema);
  return engine;
};

describe('an attribute constraint is checked against ownership', () => {
  it('refuses an attribute the type does not own, naming both', () => {
    const engine = engineWith();
    let thrown: unknown;
    try {
      engine.query('match $n isa node, has edge-id $e; select $e;');
    } catch (error) {
      thrown = error;
    }
    engine.close();

    assert.ok(thrown instanceof Error, 'a pattern that can never match must not answer nothing');
    assert.match((thrown as Error).message, /'node' does not own 'edge-id'/);
    assert.equal(diagnosticOf(thrown)?.code, DiagnosticCode.unownedAttribute);
  });

  it('allows an attribute inherited from a supertype', () => {
    // 🔴 `isa doc` is answered by an `adr`, and ownership declared on the parent is inherited —
    // A real documentation store depends on exactly this. Checking only the named type would refuse a valid query.
    const engine = engineWith(
      [
        'define',
        'attribute doc-id, value string;',
        'attribute doc-title, value string;',
        'entity doc, owns doc-id @key, owns doc-title;',
        'entity adr sub doc;',
      ].join('\n'),
    );
    engine.execute('insert $d isa adr, has doc-id "a-1", has doc-title "Ported";');
    const { rows } = engine.query('match $d isa adr, has doc-title $t; select $t;');
    engine.close();
    assert.deepEqual(rows.map((row) => row['t']?.asString()), ['Ported']);
  });

  // 🔴 The case that made an upward-only walk a live regression. `isa doc` is satisfied by an `adr`,
  // and the `adr` owns the attribute — so the query is valid and used to answer. Refusing only when
  // NOTHING in the hierarchy owns it is the conservative reading, and conservative is the right
  // bias: a false refusal breaks a working query, a missed one leaves the old silence.
  // A real documentation store's schema has several subtype-owned attributes, so this is not academic.
  it('allows an attribute a SUBTYPE owns, matched through the parent', () => {
    const engine = engineWith(
      [
        'define',
        'attribute doc-id, value string;',
        'attribute doc-title, value string;',
        'attribute adr-status, value string;',
        'entity doc, owns doc-id @key, owns doc-title;',
        'entity adr sub doc, owns adr-status;',
      ].join('\n'),
    );
    engine.execute(
      'insert $d isa adr, has doc-id "a-1", has doc-title "Ported", has adr-status "accepted";',
    );

    // Matched through the PARENT, naming an attribute only the CHILD owns.
    const viaParent = engine.query('match $d isa doc, has adr-status $s; select $s;');
    // And the inherited direction still works: the child, naming the parent's attribute.
    const inherited = engine.query('match $d isa adr, has doc-title $t; select $t;');
    engine.close();

    assert.deepEqual(viaParent.rows.map((row) => row['s']?.asString()), ['accepted']);
    assert.deepEqual(inherited.rows.map((row) => row['t']?.asString()), ['Ported']);
  });

  it('still refuses an attribute nothing in the hierarchy owns', () => {
    const engine = engineWith(
      [
        'define',
        'attribute doc-id, value string;',
        'attribute edge-id, value string;',
        'entity doc, owns doc-id @key;',
        'entity adr sub doc;',
      ].join('\n'),
    );
    assert.throws(
      () => engine.query('match $d isa doc, has edge-id $e; select $e;'),
      /does not own 'edge-id'/,
    );
    engine.close();
  });

  // 🔴 The attach form bypassed the guard. `insert $n has edge-id "e";` against a bound `$n` reaches
  // `runInsert` with no `isa`, so `constraint.type` is undefined and `checkOwns` returned early —
  // the row was written, and every later read naming it was refused as "can never match". A store
  // shared across branches showed the class live: 363 `task` rows the schema did not own.
  it('refuses the attach form of insert too, and writes nothing', () => {
    const path = filePath();
    const engine = new TypeDBLiteInterpreter(path);
    engine.define(SCHEMA);
    engine.execute('insert $n isa node, has node-id "a", has node-label "alpha";');
    let thrown: unknown;
    try {
      engine.execute('match $n isa node, has node-id "a"; insert $n has edge-id "e";');
    } catch (error) {
      thrown = error;
    }
    const still = engine.query('match $n isa node, has node-id "a", has node-label $l; select $l;');
    engine.close();
    // A write the engine accepts must be one it can read back — so the row must not exist. Read
    // through SQLite directly: the engine's own read of `edge-id` on a node is the refusal.
    const store = new DatabaseSync(path);
    const rows = store
      .prepare("SELECT COUNT(*) AS n FROM has WHERE type = 'edge-id'")
      .get() as { n: number };
    store.close();

    assert.ok(thrown instanceof Error, 'the attach form must refuse what the isa form refuses');
    assert.match((thrown as Error).message, /'node' does not own 'edge-id'/);
    assert.equal(diagnosticOf(thrown)?.code, DiagnosticCode.unownedAttribute);
    assert.equal(Number(rows.n), 0, 'the unowned attribute must not have been written');
    assert.deepEqual(still.rows.map((row) => row['l']?.asString()), ['alpha']);
  });

  it('refuses the attach form of put the same way', () => {
    const engine = engineWith();
    engine.execute('insert $n isa node, has node-id "a";');
    assert.throws(
      () => engine.execute('match $n isa node, has node-id "a"; put $n has edge-id "e";'),
      /does not own 'edge-id'/,
    );
    engine.close();
  });

  // 🔴 A write's type is CONCRETE. `match` walks the hierarchy both ways because `isa doc` may be
  // answered by an `adr` — but a row inserted as, or bound as, a `doc` IS a `doc`, and `adr`'s
  // ownership says nothing about it. Walking downward on a write accepted a `doc` row carrying an
  // attribute only `adr` owns, which the read side then refuses on `isa doc`.
  it('refuses a write of an attribute only a SUBTYPE owns, in both forms', () => {
    const engine = engineWith(
      [
        'define',
        'attribute doc-title, value string;',
        'attribute adr-status, value string;',
        'entity doc, owns doc-title @key;',
        'entity adr sub doc, owns adr-status;',
      ].join('\n'),
    );
    assert.throws(
      () => engine.execute('insert $d isa doc, has doc-title "t", has adr-status "Accepted";'),
      /'doc' does not own 'adr-status'/,
    );
    engine.execute('insert $d isa doc, has doc-title "t";');
    assert.throws(
      () => engine.execute('match $d isa doc, has doc-title "t"; insert $d has adr-status "Accepted";'),
      /'doc' does not own 'adr-status'/,
    );
    // The inherited direction still applies to a write: an adr owns what doc owns.
    engine.execute('insert $a isa adr, has doc-title "u", has adr-status "Proposed";');
    engine.execute('match $a isa adr, has doc-title "u"; insert $a has adr-status "Accepted";');
    engine.close();
  });

  // A refused write was told it "can never match" — nothing was being matched. The wording now
  // follows what the statement is.
  it('tells a refused write that it is a write, not a match', () => {
    const engine = engineWith();
    let thrown: unknown;
    try {
      engine.execute('insert $n isa node, has node-id "x", has edge-id "e";');
    } catch (error) {
      thrown = error;
    }
    engine.close();
    assert.ok(thrown instanceof Error);
    assert.doesNotMatch((thrown as Error).message, /can never match/);
    assert.match((thrown as Error).message, /'node' does not own 'edge-id'/);
    assert.match((thrown as Error).message, /could never be read back/);
  });

  it('allows a pattern whose isa arrives in a LATER pattern', () => {
    // 🔴 `constraintsOf` merges patterns naming the same variable, so the type may be declared after
    // the `has`. Checking mid-walk would accuse this of naming an unowned attribute purely because
    // the type had not been seen yet — which is why the check runs after merging.
    const engine = engineWith();
    engine.execute('insert $n isa node, has node-id "a", has node-label "alpha";');
    const { rows } = engine.query(
      'match $n has node-label $l; $n isa node, has node-id "a"; select $l;',
    );
    engine.close();
    assert.deepEqual(rows.map((row) => row['l']?.asString()), ['alpha']);
  });

  it('still allows an attribute the type does own', () => {
    const engine = engineWith();
    engine.execute('insert $n isa node, has node-id "a", has node-label "alpha";');
    const { rows } = engine.query('match $n isa node, has node-label $l; select $l;');
    engine.close();
    assert.deepEqual(rows.map((row) => row['l']?.asString()), ['alpha']);
  });

  // 🔴 The guard this test file was written for. An older database has no `schema_owns` rows, and
  // an empty ownership set means "never recorded" — never "owns nothing". Reading it the other way
  // would make every pattern in every pre-existing store throw on first open by a new build.
  it('stays silent when ownership was never recorded, rather than accusing everything', () => {
    const path = filePath();
    const first = new TypeDBLiteInterpreter(path);
    first.define(SCHEMA);
    first.execute('insert $n isa node, has node-id "a", has node-label "alpha";');
    first.close();

    // Exactly what a database written before `schema_owns` existed looks like.
    const older = new DatabaseSync(path);
    older.exec('DROP TABLE schema_owns');
    older.close();

    const reopened = new TypeDBLiteInterpreter(path);
    const owned = reopened.query('match $n isa node, has node-label $l; select $l;');
    // The pattern the check exists to refuse — and here it must NOT, because nothing is recorded.
    const unowned = reopened.query('match $n isa node, has edge-id $e; select $e;');
    reopened.close();

    assert.deepEqual(owned.rows.map((row) => row['l']?.asString()), ['alpha']);
    assert.equal(unowned.rows.length, 0, 'it answers nothing, as it did before — but it answers');
  });
});
