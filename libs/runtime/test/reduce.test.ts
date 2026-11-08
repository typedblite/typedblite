import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter, TypeDBLiteValue } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';
import { applyReduce } from '../src/reduce.js';
import { EmptyFileSystem } from 'langium';
import { createTypeQLiteServices } from '@typedblite/language';
import type { Pipeline, ReduceStage, TypeQLiteFile } from '@typedblite/language';

const parseReduce = (text: string): ReduceStage => {
  const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);
  const file = TypeQLite.parser.LangiumParser.parse<TypeQLiteFile>(text).value;
  const stage = (file.clauses[0] as Pipeline).reduce;
  if (!stage) throw new Error('no reduce stage');
  return stage;
};

/**
 * The `reduce` stage — Phase 06 of the conformance feature. Each `it` names the reduce.feature line
 * it answers; the conformance card is the acceptance suite, this is the unit suite that says what
 * each reducer answers, as `valueType:text`, and `none` for a variable absent from the row.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string;',
  'attribute age value integer;',
  'attribute weight value double;',
  'attribute bank-balance value decimal;',
  'attribute is-awake value boolean;',
  'attribute birth-date value datetime;',
  'attribute income value double;',
  'entity person owns ref @key, owns name, owns age, owns weight, owns bank-balance, owns is-awake, owns birth-date, owns income, plays employment:employee;',
  'entity company owns ref @key, owns name, plays employment:employer;',
  'relation employment relates employee, relates employer, owns ref @key;',
].join('\n');

const rows = (engine: TypeDBLiteInterpreter, query: string): Array<Record<string, string>> =>
  engine.query(query).rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.isThing() ? `thing:${v.type}:${v.iid}` : `${v.type}:${v.asString()}`])),
  );

const refusal = (attempt: () => void): { code: string; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('reduce', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute([
      'insert',
      '$p1 isa person, has ref 0, has name "Alice", has age 6, has weight 61.8, has bank-balance 61.8dec;',
      '$p2 isa person, has ref 1, has name "Gina", has age 30, has weight 86.5, has bank-balance 86.5dec;',
      '$p3 isa person, has ref 2, has name "Talia", has age 14, has weight 24.8, has bank-balance 24.8dec;',
    ].join('\n'));
  });

  afterEach(() => engine.close());

  it('count answers the rows, with or without an argument, and 0 for none — L48, L106', () => {
    assert.deepEqual(rows(engine, 'match $x isa person; reduce $c = count($x);'), [{ c: 'integer:3' }]);
    assert.deepEqual(rows(engine, 'match $x isa person; reduce $c = count;'), [{ c: 'integer:3' }]);
    assert.deepEqual(rows(engine, 'match $x isa person, has name "Voldemort"; reduce $c = count($x);'), [{ c: 'integer:0' }]);
  });

  it('sum keeps the operands\' type; a decimal sum is exact — L152', () => {
    assert.deepEqual(rows(engine, 'match $x isa person, has age $y; reduce $s = sum($y);'), [{ s: 'integer:50' }]);
    assert.deepEqual(rows(engine, 'match $x isa person, has bank-balance $y; reduce $s = sum($y);'), [{ s: 'decimal:173.1' }]);
    // A `select` before it narrows the columns, not the rows (L253).
    assert.deepEqual(rows(engine, 'match $x isa person, has name $n, has age $y; select $n, $y; reduce $s = sum($y);'), [{ s: 'integer:50' }]);
  });

  it('max and min keep the value; mean and median are doubles, or decimals of decimals — L156', () => {
    assert.deepEqual(rows(engine, 'match $x isa person, has age $y; reduce $max? = max($y), $min? = min($y), $mean? = mean($y), $median? = median($y);'), [
      { max: 'integer:30', min: 'integer:6', mean: 'double:16.666666666666668', median: 'double:14.0' },
    ]);
    assert.deepEqual(rows(engine, 'match $x isa person, has bank-balance $y; reduce $mean? = mean($y), $median? = median($y);'), [
      { mean: 'decimal:57.7', median: 'decimal:61.8' },
    ]);
    assert.deepEqual(rows(engine, 'match $x isa person, has name $y; reduce $max? = max($y), $min? = min($y);'), [{ max: 'string:Talia', min: 'string:Alice' }]);
  });

  it('the median of an even count is halfway; std is the sample deviation — L310, L223', () => {
    engine.execute('insert $p4 isa person, has ref 3, has age 43;');
    assert.deepEqual(rows(engine, 'match $x isa person, has age $y; reduce $m? = median($y);'), [{ m: 'double:22.0' }]);
    const [{ std }] = rows(engine, 'match $x isa person, has weight $y; reduce $std? = std($y);');
    assert.ok(Math.abs(Number(std.slice('double:'.length)) - 31.0537) < 5e-5, std);
  });

  it('over an empty set: count 0, sum 0 of the declared type, the rest none — L331', () => {
    const [row] = engine.query('match $x isa person, has income $y; reduce $c = count($y), $s = sum($y), $max? = max($y), $mean? = mean($y), $std? = std($y);').rows;
    assert.equal(row['c'].asString(), '0');
    assert.equal(row['s'].type, 'double');
    assert.equal(row['s'].asString(), '0.0');
    assert.equal(row['max'], undefined);
    assert.equal(row['mean'], undefined);
    assert.equal(row['std'], undefined);
  });

  it('review round 1: an integer sum overflows like arithmetic; an empty sum of a let is 0 of its inferred type', () => {
    engine.execute('insert $p isa person, has ref 7, has age 9223372036854775807; $q isa person, has ref 8, has age 9223372036854775807;');
    assert.equal(refusal(() => engine.query('match $x isa person, has age $a; $a > 100; reduce $s = sum($a);')).code, DiagnosticCode.valueOutOfRange);
    const [row] = engine.query('match $x isa person, has income $w; let $v = $w * 2; reduce $s = sum($v);').rows;
    assert.equal(row['s'].type, 'double');
    assert.equal(row['s'].asString(), '0.0');
  });

  it('review round 2: the double median of two near-MAX integers is halfway, not an overflow', () => {
    engine.execute('insert $p isa person, has ref 7, has age 9223372036854775807; $q isa person, has ref 8, has age 9223372036854775806;');
    const [row] = engine.query('match $x isa person, has age $a; $a > 100; reduce $m? = median($a);').rows;
    assert.equal(row['m'].type, 'double');
    // The halfway point, 9223372036854775806.5, is itself past double precision — 2^63 is the nearest double.
    assert.ok(Math.abs(row['m'].asDouble() - 2 ** 63) < 1e4, row['m'].asString());
  });

  it('review round 3: a group is a cell, not its text; a reducer over a thing is refused on an empty set too', () => {
    // The stage over rows the engine cannot yet produce (`has $n` over two attribute types is a
    // grammar gap): a `first-name "Bob"` and a `last-name "Bob"` are two groups.
    const stage = (parseReduce('match $x isa person; reduce $c = count($n) groupby $n;'));
    const bob = (type: string) => ({ n: TypeDBLiteValue.attribute(type, 'Bob') });
    const grouped = applyReduce(stage, [bob('first-name'), bob('first-name'), bob('last-name')], () => 'string', () => 'string', () => { throw new Error('no refusal expected'); });
    assert.deepEqual(grouped.map((row) => `${row['n'].type}:${row['c'].asString()}`), ['first-name:2', 'last-name:1']);
    assert.equal(refusal(() => engine.query('match $x isa person, has name "nobody"; reduce $s = sum($x);')).code, DiagnosticCode.reducer);
  });

  it('review round 5: a reducer over an isa type variable is refused before reading; an integer mean sums as doubles', () => {
    assert.equal(refusal(() => engine.query('match $x isa person, has name "nobody"; $x isa $t; reduce $m? = max($t);')).code, DiagnosticCode.reducer);
    engine.execute('insert $p isa person, has ref 7, has age 9223372036854775807; $q isa person, has ref 8, has age 9223372036854775807;');
    const [row] = engine.query('match $x isa person, has age $a; $a > 100; reduce $m? = mean($a);').rows;
    assert.equal(row['m'].type, 'double');
  });

  it('review round 6: a mean or median past the double range is refused, as a sum is', () => {
    engine.execute('insert $p isa person, has ref 7, has weight 1.7e308; $q isa person, has ref 8, has weight 1.7e308;');
    assert.equal(refusal(() => engine.query('match $x isa person, has weight $w; $w > 100.0; reduce $m? = mean($w);')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match $x isa person, has weight $w; $w > 100.0; reduce $m? = median($w);')).code, DiagnosticCode.valueOutOfRange);
  });

  it('review round 8: an attribute answered through a supertype reduces by its own value type', () => {
    engine.define('define attribute measure @abstract; attribute height sub measure, value integer; person owns measure, owns height;');
    engine.execute('insert $p isa person, has ref 30, has height 180; $q isa person, has ref 31, has height 170;');
    assert.deepEqual(rows(engine, 'match $p isa person, has measure $m; reduce $s = sum($m), $max? = max($m), $med? = median($m);'), [
      { s: 'integer:350', max: 'integer:180', med: 'double:175.0' },
    ]);
  });

  it('review round 15: a zoneless datetime orders as text, not through the host zone', () => {
    engine.execute('insert $a isa person, has ref 40, has birth-date 2024-03-31T01:30:00; $b isa person, has ref 41, has birth-date 2024-03-31T02:00:00;');
    assert.deepEqual(rows(engine, 'match $x isa person, has birth-date $d; reduce $max? = max($d), $min? = min($d);'), [
      { max: 'datetime:2024-03-31T02:00:00', min: 'datetime:2024-03-31T01:30:00' },
    ]);
  });

  it('groupby answers one row per group with the group cells; std of one value is none — L638, L665', () => {
    assert.deepEqual(rows(engine, 'match $p isa person, has name $name, has age $a; let $to25 = 25 - $a; reduce $sum = sum($to25) groupby $name;'), [
      { name: 'name:Alice', sum: 'integer:19' },
      { name: 'name:Gina', sum: 'integer:-5' },
      { name: 'name:Talia', sum: 'integer:11' },
    ]);
    const grouped = engine.query('match $x isa person, has weight $y; select $x, $y; reduce $std? = std($y) groupby $x;').rows;
    assert.equal(grouped.length, 3);
    assert.ok(grouped.every((row) => row['x'].isThing() && row['std'] === undefined));
  });

  it('refuses before reading a row: an argument nothing binds, its own variable, a thing — L376, L405, L694', () => {
    assert.equal(refusal(() => engine.query('match $x isa person; reduce $r = count($y);')).code, DiagnosticCode.unboundValue);
    assert.match(refusal(() => engine.query('match $p isa person; reduce $c = count($p) groupby $c;')).message, /The variable 'c' was not available for use in the groupby/);
    assert.match(refusal(() => engine.query('match $p isa person; reduce $c = count($c);')).message, /The variable 'c' was not available for use in the reduce/);
    assert.equal(refusal(() => engine.query('match $x isa person; reduce $m? = min($x);')).code, DiagnosticCode.reducer);
  });

  it('refuses a value type the reducer cannot take, with one operand as with many — L420, L451', () => {
    engine.execute('insert $p isa person, has ref 5, has is-awake true, has birth-date 2000-01-01T00:00:00;');
    assert.equal(refusal(() => engine.query('match $x isa person, has name $y; reduce $s = sum($y);')).code, DiagnosticCode.reducer);
    assert.equal(refusal(() => engine.query('match $x isa person, has is-awake $y; reduce $m? = max($y);')).code, DiagnosticCode.reducer);
    assert.equal(refusal(() => engine.query('match $x isa person, has birth-date $y; reduce $m? = mean($y);')).code, DiagnosticCode.reducer);
  });
});
