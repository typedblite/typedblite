import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';

/**
 * 🔴 An anonymous relation is a **test**, not a binding, and must not multiply the answer.
 *
 * `(source: $s, target: $t) isa link` names no variable for the relation itself, so two links
 * between the same pair are two ways of satisfying one indistinguishable condition — and TypeQLite
 * answers it once.
 *
 * ✅ **Verified against real TypeDB 3 on 2026-09-10, not asserted.** Neither oracle suite in this
 * repository covers TypeDB query semantics — both compare against CouchDB's conflict model — so
 * this claim had nothing behind it when the fix was written. Against a TypeDB database holding two
 * parallel a→b links the anonymous form answers **once** and the named form answers **twice**,
 * which is the asymmetry the last case here holds.
 *
 * `relationBindings` selected `t.iid` regardless, so `SELECT DISTINCT` kept both rows and every
 * downstream combination doubled.
 *
 * ⚠️ **The write is the dangerous half.** A read returning `["a", "a"]` is visibly odd; a
 * `match … insert` that reports two attributes written where one was intended is not, and it
 * happens silently. Introduced by this branch's relation rewrite — `relationHolds` had been a
 * boolean filter — so this is a regression against `dev`, not an inherited defect.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute edge-id, value string;',
  'attribute tag, value string;',
  'entity node, owns node-id @key, owns tag, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a";');
  engine.execute('insert $n isa node, has node-id "b";');
  // Two links between the SAME pair — the only shape that can duplicate.
  for (const id of ['e1', 'e2']) {
    engine.execute(
      'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
        ` insert $l isa link, links (source: $s, target: $t), has edge-id "${id}";`,
    );
  }
});

describe('an anonymous relation does not multiply the answer', () => {
  it('answers once when two relations satisfy the same anonymous condition', () => {
    const { rows } = engine.query(
      'match $s isa node, has node-id $sid; $t isa node, has node-id "b";' +
        ' (source: $s, target: $t) isa link; select $sid;',
    );
    assert.deepEqual(rows.map((row) => row['sid']?.asString()), ['a']);
  });

  it('writes once through an anonymous relation', () => {
    // 🔴 The half that does damage quietly.
    const report = engine.execute(
      'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
        ' (source: $s, target: $t) isa link; insert $s has tag "T";',
    );
    const wrote = report.diagnostics.find((d) => d.code === DiagnosticCode.wrote);
    assert.ok(wrote);
    assert.match(wrote.message, /1 attribute\(s\)/, 'one tag was asked for, one must be written');

    const { rows } = engine.query('match $s isa node, has tag $t; select $t;');
    assert.deepEqual(rows.map((row) => row['t']?.asString()), ['T']);
  });

  it('still yields a row per relation when the relation IS named', () => {
    // 🔴 The opposite failure. A named relation variable distinguishes the two links, so both are
    // genuine answers — collapsing them would lose data.
    const { rows } = engine.query(
      'match $s isa node, has node-id "a"; $t isa node;' +
        ' $l isa link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );
    assert.deepEqual(rows.map((row) => row['x']?.asString()).sort(), ['e1', 'e2']);
  });
});
