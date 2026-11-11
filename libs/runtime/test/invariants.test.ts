import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * Two invariants every phase of the conformance feature extends, written after the Phase 06 QA
 * pass found the review rounds re-discovering them one construct at a time:
 *
 * 1. **A refusal never depends on the data.** Whatever is refused over a populated store is
 *    refused, with the same code, over an empty match and over an empty store. Each case runs the
 *    same statement three times.
 * 2. **One stored spelling per value.** Two spellings of one value on a `@unique` attribute are one
 *    ownership, and a literal in either spelling matches what the other wrote.
 *
 * Add a row for every new construct; never remove one.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string;',
  'attribute age value integer;',
  'attribute weight value double;',
  'attribute price value decimal;',
  'attribute awake value boolean;',
  'attribute born value datetime;',
  'attribute stamp value datetime-tz;',
  'attribute measure @abstract;',
  'attribute height sub measure, value integer;',
  'entity person owns ref @key, owns name, owns age, owns weight, owns price, owns awake, owns born, owns stamp @unique, owns measure, owns height, plays employment:employee;',
  'entity company owns ref @key, owns name, plays employment:employer;',
  'attribute adr-status value string;',
  'entity doc @abstract, owns ref @key;',
  'entity adr sub doc, owns adr-status;',
  'entity memo sub doc;',
  'relation employment relates employee, relates employer;',
].join('\n');

const codeOf = (attempt: () => void): string | 'no refusal' => {
  try {
    attempt();
  } catch (error) {
    return String(diagnosticOf(error)?.code);
  }
  return 'no refusal';
};

describe('a refusal never depends on the data', () => {
  const POPULATED = 'insert $p isa person, has ref 1, has name "Ann", has age 5, has weight 1.5, has price 2.5dec, has awake true, has born 2000-01-01T00:00:00; $c isa company, has ref 2; $a isa adr, has ref 3; $m isa memo, has ref 4;';

  // [statement, expected code] — `has ref 1` matches the populated row; `has ref 999` an empty match.
  // [statement, code, read|write, the ref the populated leg matches (default 1)]
  const CASES: Array<[string, string, 'read' | 'write', string?]> = [
    ['match $p isa person, has ref R, has awake $b; reduce $m? = max($b);', DiagnosticCode.reducer, 'read'],
    ['match $p isa person, has ref R, has name $n; reduce $m? = mean($n);', DiagnosticCode.reducer, 'read'],
    ['match $p isa person, has ref R, has born $d; reduce $m? = std($d);', DiagnosticCode.reducer, 'read'],
    ['match $p isa person, has ref R, has name $n; reduce $s = sum($n);', DiagnosticCode.reducer, 'read'],
    ['match $p isa person, has ref R; let $v = -2020-01-01;', DiagnosticCode.notImplemented, 'read'],
    ['match $p isa person, has ref R; let $v = 2020-01-01 + 1;', DiagnosticCode.notImplemented, 'read'],
    ['match $p isa person, has ref R; let $v = len(2020-01-01);', DiagnosticCode.notImplemented, 'read'],
    ['match $p isa person, has ref R, has born $b; $b == 2000-01-01T00:00:00;', DiagnosticCode.notImplemented, 'read'],
    ['match $p isa person, has ref R, has age $b; $b == 2000-01-01;', DiagnosticCode.notImplemented, 'read'],
    // Schema functions (metadata.feature): `get_fun_…` is not implemented; the rest refuse their
    // arity, argument kinds and labels from the query's shape, before a row exists.
    ['match $p isa person, has ref R; let $v = get_fun_doc("f");', DiagnosticCode.notImplemented, 'read'],
    ['match $p isa person, has ref R; let $v = get_owns_doc(1);', DiagnosticCode.functionArity, 'read'],
    ['match $p isa person, has ref R; let $v = get_doc(1);', DiagnosticCode.valueTypeConflict, 'read'],
    ['match $p isa person, has ref R; let $v = get_meta(person, person);', DiagnosticCode.valueTypeConflict, 'read'],
    ['match $p isa person, has ref R; let $v = get_doc(nonesuch);', DiagnosticCode.unknownType, 'read'],
    ['match $p isa person, has ref R; let $v = get_all_meta(person);', DiagnosticCode.valueTypeConflict, 'read'],
    // A bare label is a function's argument only — elsewhere it does not parse (expression.feature L825).
    ['match $p isa person, has ref R; let $v = person;', DiagnosticCode.parseFailed, 'read'],
    ['match $p isa person, has ref R, has age $a; let $v = floor(person);', DiagnosticCode.valueTypeConflict, 'read'],
    ['match $p isa person, has ref R; let $a = 9223372036854775808;', DiagnosticCode.valueOutOfRange, 'read'],
    ['match $p isa person, has ref R; let $a = 1.8e308;', DiagnosticCode.valueOutOfRange, 'read'],
    ['match $p isa person, has ref R; let $a = 9223372036854775808.0dec;', DiagnosticCode.valueOutOfRange, 'read'],
    ['match $p isa person, has ref R, has age $a; let $v = $a + "x";', DiagnosticCode.valueTypeConflict, 'read'],
    ['match $p isa person, has ref R, has age $a; let $v = nope($a);', DiagnosticCode.unknownFunction, 'read'],
    ['match $p isa person, has ref R; let $v = $p + 1;', DiagnosticCode.valueTypeConflict, 'read'],
    ['match $p isa person, has ref R, has age $a; reduce $c = count, $c = sum($a);', DiagnosticCode.valueAssignedTwice, 'read'],
    ['match $p isa person, has ref R; insert $p has measure 5;', DiagnosticCode.abstractType, 'write'],
    ['match $p isa person, has ref R; let $v = 6; insert $p has measure $v;', DiagnosticCode.abstractType, 'write'],
    ['match $c isa company, has ref R; insert $c has age 1;', DiagnosticCode.unownedAttribute, 'write'],
    // `isa doc` may bind an `adr` that owns what `doc` does not: no refusal before the match, and
    // none with the adr bound (round 18); `isa! doc` binds a `doc` alone, refused before (round 19).
    ['match $d isa doc, has ref R; insert $d has adr-status "Accepted";', 'no refusal', 'write', '3'],
    ['match $d isa! doc, has ref R; insert $d has adr-status "Accepted";', DiagnosticCode.unownedAttribute, 'write', '3'],
    // Every written `isa`, whichever comes first (round 20).
    ['match $d isa! memo, isa doc, has ref R; insert $d has adr-status "x";', DiagnosticCode.unownedAttribute, 'write', '4'],
    ['match $d isa doc, isa! memo, has ref R; insert $d has adr-status "x";', DiagnosticCode.unownedAttribute, 'write', '4'],
    ['match $p isa person, has ref R; insert $p has age "x";', DiagnosticCode.valueTypeConflict, 'write'],
    ['match $p isa person, has ref R; insert $p has age $zz;', DiagnosticCode.unboundValue, 'write'],
    ['match $p isa person, has ref R; let $v = 1.5; insert $p has price $v;', DiagnosticCode.valueTypeConflict, 'write'],
    ['match $p isa person, has ref R; let $v = 1; delete $v;', DiagnosticCode.mixedPattern, 'write'],
    ['match $p isa person, has ref R, has name $a; let $v = 1; delete $a of $v;', DiagnosticCode.mixedPattern, 'write'],
    ['match $p isa $t, has ref R, has name $a; delete $a of $t;', DiagnosticCode.mixedPattern, 'write'],
    ['match $p isa person, has ref R, has name $a; delete $a of $zz;', DiagnosticCode.mixedPattern, 'write'],
    ['match $p isa person, has ref R, has name $a; delete $a;', DiagnosticCode.mixedPattern, 'write'],
  ];

  for (const [template, expected, kind, populatedRef = '1'] of CASES) {
    it(`${template.replace(' R', ' <ref>')} → ${expected}`, () => {
      const outcomes = new Map<string, string>();
      for (const [store, ref] of [['populated', populatedRef], ['empty match', '999'], ['empty store', populatedRef]] as const) {
        const engine = new TypeDBLiteInterpreter(':memory:');
        engine.define(SCHEMA);
        if (store !== 'empty store') engine.execute(POPULATED);
        const text = template.replace(' R', ` ${ref}`);
        outcomes.set(store, codeOf(() => (kind === 'read' ? engine.query(text) : engine.execute(text))));
        engine.close();
      }
      assert.deepEqual([...outcomes.values()], [expected, expected, expected], JSON.stringify([...outcomes]));
    });
  }
});

describe('one stored spelling per value', () => {
  let engine: TypeDBLiteInterpreter;
  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
  });
  afterEach(() => engine.close());

  const SPELLINGS: Array<[string, string[]]> = [
    ['stamp', ['2000-01-01T00:00:00Z', '2000-01-01T00:00:00+00:00', '2000-01-01T00:00:00+0000', '2000-01-01T00:00:00-00:00', '2000-01-01T00:00:00.000Z']],
    ['stamp', ['2000-01-01T01:00:00+01:00', '2000-01-01T01:00:00+0100', '2000-01-01T01:00:00.0+01:00']],
    ['born', ['2000-01-01', '2000-01-01T00:00:00', '2000-01-01T00:00:00.000']],
    ['weight', ['80', '80.0', '8.0e1', '080.00']],
    ['price', ['1.5dec', '1.50dec', '01.5dec']],
    ['age', ['7', '007', '-0'.replace('-0', '7')]],
  ];

  for (const [attribute, spellings] of SPELLINGS) {
    it(`${attribute}: ${spellings.join(' = ')}`, () => {
      engine.execute(`insert $p isa person, has ref 1, has ${attribute} ${spellings[0]};`);
      for (const spelling of spellings.slice(1)) {
        // Written again in another spelling: the same ownership, not a second row.
        engine.execute(`match $p isa person, has ref 1; insert $p has ${attribute} ${spelling};`);
        assert.equal(engine.query(`match $p isa person, has ref 1, has ${attribute} ${spelling}; select $p;`).rows.length, 1, spelling);
      }
      assert.equal(engine.query(`match $p isa person, has ${attribute} $v; select $v;`).rows.length, 1, 'one stored value');
    });
  }

  it('a value written twice on one owner is one ownership, and reduce counts it once', () => {
    engine.execute('insert $p isa person, has ref 1, has age 5;');
    engine.execute('match $p isa person, has ref 1; insert $p has age 5;');
    const [row] = engine.query('match $p isa person, has age $a; reduce $c = count, $s = sum($a);').rows;
    assert.equal(row['c'].asString(), '1');
    assert.equal(row['s'].asString(), '5');
  });

  it('an integer literal past 64 bits is refused on a double attribute as in a let; the decimal floor bound holds', () => {
    assert.equal(codeOf(() => engine.execute('insert $p isa person, has ref 1, has weight 99999999999999999999;')), DiagnosticCode.valueOutOfRange);
    assert.equal(codeOf(() => engine.query('match let $a = -9223372036854775808.5dec;')), DiagnosticCode.valueOutOfRange);
    assert.equal(codeOf(() => engine.query('match let $a = -9223372036854775808.0dec;')), 'no refusal');
  });
});
