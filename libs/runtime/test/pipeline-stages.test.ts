import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * A pipeline is an ordered list of stages, and each one reads the stream the stages before it
 * answered (pipelines.feature, modifiers.feature). The conformance card is the acceptance suite;
 * this pins the semantics stage by stage.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string;',
  'attribute age value integer;',
  'attribute score @abstract;',
  'attribute points sub score, value integer;',
  'attribute rating sub score, value double;',
  'attribute label-text sub score, value string;',
  'entity person owns ref @key, owns name @card(0..), owns age, owns points, owns rating, owns label-text;',
].join('\n');

const refusal = (attempt: () => void): { code: string; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('pipeline stages', () => {
  let engine: TypeDBLiteInterpreter;
  const column = (query: string, variable: string): string[] => engine.query(query).rows.map((row) => row[variable].toString());

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute(
      'insert $a isa person, has ref 0, has name "Cy", has age 6; ' +
        '$b isa person, has ref 1, has name "Ann", has age 2; ' +
        '$c isa person, has ref 2, has name "Bo", has age 6; ' +
        '$d isa person, has ref 3, has name "Di", has age 2;',
    );
  });

  afterEach(() => engine.close());

  it('a second match reads the first’s answers — pipelines L38', () => {
    assert.deepEqual(column('match $p isa person, has age 6; match $p has name $n; select $n;', 'n'), ['Cy', 'Bo']);
  });

  it('sort is ascending by default, stable on ties, and takes several keys — modifiers L126, L207, L382', () => {
    assert.deepEqual(column('match $p isa person, has age $a, has ref $r; sort $a;', 'r'), ['1', '3', '0', '2']);
    assert.deepEqual(column('match $p isa person, has age $a, has ref $r; sort $a desc, $r desc;', 'r'), ['2', '0', '3', '1']);
  });

  it('offset, limit and a second sort compose in order — pipelines L167', () => {
    assert.deepEqual(column('match $p isa person, has ref $r; sort $r desc; offset 1; limit 2; sort $r;', 'r'), ['1', '2']);
    assert.deepEqual(column('match $p isa person, has ref $r; limit 0;', 'r'), []);
    assert.deepEqual(column('match $p isa person, has ref $r; offset 9;', 'r'), []);
  });

  it('distinct removes repeated answers; select narrows what the next stage sees', () => {
    assert.deepEqual(column('match $p isa person, has age $a; select $a; distinct; sort $a;', 'a'), ['2', '6']);
  });

  it('sort refuses a variable no earlier stage answers, a thing, and incomparable kinds — modifiers L419, L439', () => {
    assert.equal(refusal(() => engine.query('match $p isa person, has age $a; select $p; sort $a;')).code, DiagnosticCode.unboundValue);
    assert.equal(refusal(() => engine.query('match $p isa person; sort $p;')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match $p isa person, has score $s; sort $s;')).code, DiagnosticCode.valueTypeConflict);
  });

  it('a match reads an abstract attribute through its subtypes — modifiers L565', () => {
    engine.execute('match $p isa person, has ref 0; insert $p has points 4;');
    engine.execute('match $p isa person, has ref 1; insert $p has rating 0.5;');
    assert.deepEqual(column('match $p isa person, has score $s, has ref $r; $s > 1; select $r;', 'r'), ['0']);
  });

  it('an anonymous variable cannot be selected, sorted or grouped by — pipelines L287', () => {
    for (const query of ['match let $x = 5; select $_;', 'match let $x = 5; sort $_;', 'match let $x = 5; reduce $s = sum($x) groupby $_;']) {
      assert.match(refusal(() => engine.query(query)).message, /A non-anonymous variable is expected/, query);
    }
  });

  it('a variable a reduce or a delete dropped is not available after it — pipelines L324, L336', () => {
    assert.match(refusal(() => engine.query('match $p isa person; reduce $c = count($p); select $p;')).message, /was not available in the stage/);
    assert.match(refusal(() => engine.execute('match $p isa person; delete $p; select $p;')).message, /was not available in the stage/);
  });

  it('a write runs once per row it receives — after sort and limit too — modifiers L777', () => {
    engine.execute('match $p isa person, has ref $r; sort $r desc; limit 1; insert $p has name "Last";');
    assert.deepEqual(column('match $p isa person, has name "Last", has ref $r; select $r;', 'r'), ['3']);
  });

  it('match, delete and insert chain — the update an emulated pipeline makes — pipelines L104', () => {
    engine.execute('match $p isa person, has ref 1, has age $a; delete $a of $p; insert $p has age 3;');
    assert.deepEqual(column('match $p isa person, has ref 1, has age $a; select $a;', 'a'), ['3']);
  });

  it('query() reads: a write stage is refused, not skipped', () => {
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 0; insert $p has name "x";')).code, DiagnosticCode.writeInRead);
  });

  it('a later stage is refused even when an earlier one answers nothing — a refusal never depends on the data', () => {
    for (const [query, code] of [
      ['match $p isa person, has ref 99; match let $v = $nope + 1;', DiagnosticCode.unboundValue],
      ['match $p isa person, has ref 99; sort $p;', DiagnosticCode.valueTypeConflict],
      ['match $p isa person, has ref 99; match $q isa person, has nonesuch $x;', DiagnosticCode.unknownAttribute],
    ] as const) {
      assert.equal(refusal(() => engine.query(query)).code, code, query);
    }
  });

  it('`end;` closes a pipeline, so one text can hold several writes', () => {
    engine.execute('insert $x isa person, has ref 10; end; insert $y isa person, has ref 11;');
    assert.deepEqual(column('match $p isa person, has ref $r; $r > 9; select $r;', 'r'), ['10', '11']);
  });
});
