import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * 🔴 Adding a role player to an existing relation must either work or say it did not.
 *
 * `insert $l links (source: $b);` against a matched relation parses, runs, reports
 * `Wrote 0 thing(s), 0 attribute(s), 0 role player(s).` and exits successfully — the store is
 * unchanged and nothing says so. Found while writing the guard for the repeated-role-name fix: the
 * guard's premise was that this call added an edge, and the fix looked like an over-constraint
 * until the stored rows were read.
 *
 * ⚠️ The workaround is real and is what the guard uses: naming both players in ONE insert
 * (`links (source: $a, source: $b, target: $c)`) writes three role players correctly. So the
 * capability exists; only the incremental form is inert.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute edge-id, value string;',
  'entity node, owns node-id @key, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  for (const id of ['a', 'b', 'c']) {
    engine.execute(`insert $n isa node, has node-id "${id}";`);
  }
  engine.execute(
    'match $s isa node, has node-id "a"; $t isa node, has node-id "c";' +
      ' insert $l isa link, links (source: $s, target: $t), has edge-id "e";',
  );
});

const sourcesOf = (edge: string): string[] =>
  engine
    .query(
      `match $l isa link, links (source: $x), has edge-id "${edge}"; $x has node-id $xid; select $xid;`,
    )
    .rows.map((row) => row['xid']?.asString() ?? '')
    .sort();

describe('adding a role player to an existing relation', () => {
  // 🔴 Refused, and deliberately not implemented.
  //
  // It was inert before 2026-09-10 — the statement reported
  // `Wrote 0 thing(s), 0 attribute(s), 0 role player(s).` at exit 0 with the store unchanged. It
  // was then briefly ENABLED, and that was worse: nothing on this path knows the bound owner is a
  // relation, so `insert $a links (source: $b);` with `$a` matched as an entity wrote a
  // `role_player` row keyed on the entity and reported success. A corruption where there had only
  // been a no-op.
  //
  // Implementing it needs a relation check, `checkKnown` on the role name, and an error path that
  // does not report a foreign-key or busy failure as a duplicate edge. Until then it refuses —
  // the same trade `select` takes on a variable it cannot project.
  it('refuses rather than reporting success having written nothing', () => {
    let thrown: unknown;
    try {
      engine.execute(
        'match $l isa link, has edge-id "e"; $b isa node, has node-id "b";' +
          ' insert $l links (source: $b);',
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, 'a write that cannot happen must say so');
    assert.match((thrown as Error).message, /not supported/);
    assert.match((thrown as Error).message, /Name every player in one/);
    assert.equal(
      diagnosticOf(thrown)?.code,
      DiagnosticCode.unsupportedIncrementalRole,
    );
    // 🔴 And the store is untouched — a refusal that half-wrote would be worse than either.
    assert.deepEqual(sourcesOf('e'), ['a']);
  });

  // 🔴 The case that made enabling it a corruption rather than a feature.
  it('refuses it against an entity too, where it used to write a bogus edge', () => {
    assert.throws(
      () =>
        engine.execute(
          'match $a isa node, has node-id "a"; $b isa node, has node-id "b";' +
            ' insert $a links (source: $b);',
        ),
      /not supported/,
    );
  });

  // 🔴 The refusal must fire for an UNBOUND relation variable too. `if (owner === undefined)
  // return;` ran first, so the half of the inputs that never named a real relation still reported
  // success having written nothing — a refusal reachable only on the safer half is not a refusal.
  it('refuses even when the relation variable was never bound', () => {
    assert.throws(
      () =>
        engine.execute(
          'match $x isa node, has node-id "b"; insert $nope links (source: $x);',
        ),
      /not supported/,
    );
  });

  it('the one-statement form already works, and must keep working', () => {
    engine.execute(
      'match $a isa node, has node-id "a"; $b isa node, has node-id "b";' +
        ' $c isa node, has node-id "c";' +
        ' insert $l isa link, links (source: $a, source: $b, target: $c), has edge-id "two";',
    );
    assert.deepEqual(sourcesOf('two'), ['a', 'b']);
  });
});
