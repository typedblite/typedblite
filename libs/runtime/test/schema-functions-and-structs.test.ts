import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `define fun` and `define struct` — a function the schema stores and every query may call
 * (expression.feature L1382), and structs whose metadata the schema functions read
 * (metadata.feature L113); `#!` doc comments are their `@doc` (L189).
 */
let engine: TypeDBLiteInterpreter;
beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(['define', 'attribute name value string;', 'entity person owns name;'].join('\n'));
});

const one = (query: string, variable: string): string | undefined => engine.query(query).rows[0]?.[variable]?.asString();

describe('schema functions', () => {
  it('are callable from any query, including recursively', () => {
    engine.define([
      'define',
      'fun count_down($n: integer) -> { integer }:',
      '  match { $n > 0; let $m in count_down($n - 1); let $k = $m; } or { let $k = $n; };',
      '  return { $k };',
    ].join('\n'));
    assert.deepEqual(engine.query('match let $k in count_down(3);').rows.map((r) => r['k']?.asString()).sort(), ['0', '1', '2', '3']);
  });

  it('keep their @doc and #! doc comment, read by get_fun_doc, and an unknown one is refused before any row', () => {
    engine.define('define fun four() -> integer @doc("chosen by a fair dice roll"): match let $r = 4; return first $r;');
    engine.define(['define', '#! a constant', 'fun five() -> integer: match let $r = 5; return first $r;'].join('\n'));
    assert.equal(one('match let $d = get_fun_doc("four");', 'd'), 'chosen by a fair dice roll');
    assert.equal(one('match let $d = get_fun_doc("five");', 'd'), 'a constant');
    let refused: unknown;
    try {
      engine.query('match $p isa person; let $d = get_fun_doc("nothing");');
    } catch (error) {
      refused = error;
    }
    assert.equal(diagnosticOf(refused)?.code, DiagnosticCode.unknownFunction);
  });
});

describe('structs', () => {
  it('keep their own and their fields\' metadata', () => {
    engine.define('define struct location @doc("coordinates"): latitude value double @doc("north-south") @meta("unit", "deg"), longitude value double;');
    assert.equal(one('match let $d = get_struct_doc("location");', 'd'), 'coordinates');
    assert.equal(one('match let $d = get_struct_field_doc("location", "latitude");', 'd'), 'north-south');
    assert.equal(one('match let $d = get_struct_field_meta("unit", "location", "latitude");', 'd'), 'deg');
    assert.equal(one('match let $d = get_struct_field_doc("location", "longitude");', 'd'), '');
  });
});

describe('type doc comments', () => {
  it('are the type\'s @doc', () => {
    engine.define(['define', '#! This represents a pet', 'entity pet;'].join('\n'));
    assert.equal(one('match let $d = get_doc(pet);', 'd'), 'This represents a pet');
  });
});
