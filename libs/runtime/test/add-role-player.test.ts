import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * 🔴 Adding a role player to an existing relation must either work or say it did not — it works.
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
  // ✅ Implemented in the fetch-and-writes phase of the conformance work, on the three conditions
  // this file set for it: the owner is checked to be a RELATION, the role to be one it has (and one
  // the player plays), and a duplicate edge is the only failure reported as one. It was refused
  // until then — inert before 2026-09-10, and a corruption when briefly enabled without the checks.
  it('adds the player, and says so', () => {
    const report = engine.execute(
      'match $l isa link, has edge-id "e"; $b isa node, has node-id "b";' + ' insert $l links (source: $b);',
    );
    assert.deepEqual(sourcesOf('e'), ['a', 'b']);
    assert.ok(report.diagnostics.some((d) => /1 role player/.test(d.message)));
  });

  // 🔴 The case that made the first enabling a corruption rather than a feature.
  it('refuses it against an entity, where it once wrote a bogus edge', () => {
    assert.throws(
      () => engine.execute('match $a isa node, has node-id "a"; $b isa node, has node-id "b";' + ' insert $a links (source: $b);'),
      /not a relation/,
    );
    assert.deepEqual(sourcesOf('e'), ['a']);
  });

  it('refuses a role the relation does not have', () => {
    const thrown = (() => {
      try {
        engine.execute('match $l isa link, has edge-id "e"; $b isa node, has node-id "b"; insert $l links (nope: $b);');
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    assert.equal(diagnosticOf(thrown)?.code, DiagnosticCode.unknownRole);
    assert.deepEqual(sourcesOf('e'), ['a']);
  });

  // 🔴 The refusal must fire for an UNBOUND relation variable too — a refusal reachable only on the
  // half of the inputs that were already the safer half is not a refusal.
  it('refuses when the relation variable was never bound', () => {
    assert.throws(() => engine.execute('match $x isa node, has node-id "b"; insert $nope links (source: $x);'), /dangling/);
  });

  it('a duplicate edge is reported as one, and nothing else is', () => {
    assert.throws(
      () => engine.execute('match $l isa link, has edge-id "e"; $a isa node, has node-id "a"; insert $l links (source: $a);'),
      /already plays 'source'/,
    );
  });

  it('the one-statement form still works', () => {
    engine.execute(
      'match $a isa node, has node-id "a"; $b isa node, has node-id "b";' +
        ' $c isa node, has node-id "c";' +
        ' insert $l isa link, links (source: $a, source: $b, target: $c), has edge-id "two";',
    );
    assert.deepEqual(sourcesOf('two'), ['a', 'b']);
  });
});
