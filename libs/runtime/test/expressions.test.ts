import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * Value expressions — Phase 06 of the conformance feature. Each `it` names the expression.feature
 * line it answers; the conformance card is the acceptance suite, this is the unit suite that says
 * what each form evaluates to, as text with its value type.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string;',
  'attribute age value integer;',
  'attribute height value integer;',
  'attribute weight value double;',
  'entity person owns ref @key, owns name, owns age, owns height, owns weight;',
].join('\n');

const values = (engine: TypeDBLiteInterpreter, query: string): Array<Record<string, string>> =>
  engine.query(query).rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.isThing() ? `thing:${v.type}` : v.isType() ? `type:${v.label}` : `${v.type}:${v.asString()}`])),
  );

const refusal = (attempt: () => void): { code: string; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('value expressions', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute('insert $x isa person, has ref 0, has name "Lisa", has age 10, has height 180, has weight 60.0;');
  });

  afterEach(() => engine.close());

  it('operator definitions: integer ∘ integer is an integer, / is always a double — L352', () => {
    assert.deepEqual(values(engine, 'match let $a = 6 + 3; let $b = 6 - 3; let $c = 6 * 3; let $d = 6 / 3;'), [
      { a: 'integer:9', b: 'integer:3', c: 'integer:18', d: 'double:2.0' },
    ]);
  });

  it('any double makes a double; decimal ∘ integer is an exact decimal — L423, L441', () => {
    assert.deepEqual(values(engine, 'match let $a = 6 + 3.0; let $b = 6.0dec * 3; let $c = 6.0dec / 3.0dec;'), [
      { a: 'double:9.0', b: 'decimal:18.0', c: 'double:2.0' },
    ]);
    // 🔴 Never through a float: reduce.feature L122's `61.8dec + 86.5dec + 24.8dec` is `173.1dec`.
    assert.deepEqual(values(engine, 'match let $a = 61.8dec + 86.5dec + 24.8dec;'), [{ a: 'decimal:173.1' }]);
  });

  it('precedence and associativity: ^ binds tightest, to the right, and answers a double — L1243, L1265, L1318', () => {
    assert.deepEqual(values(engine, 'match let $a = 6 * 5 ^ 3 + 2; let $b = 2 ^ 2 ^ 2 ^ 2; let $c = 6 - 2 - 3;'), [
      { a: 'double:752.0', b: 'double:65536.0', c: 'integer:1' },
    ]);
  });

  it('round is half to even; ceil and floor answer integers — L920, L941', () => {
    assert.deepEqual(values(engine, 'match let $a = round(11.5); let $b = round(12.5); let $c = round(-11.5); let $d = ceil(11.0dec); let $e = floor(-12.5);'), [
      { a: 'integer:12', b: 'integer:12', c: 'integer:-12', d: 'integer:11', e: 'integer:-13' },
    ]);
  });

  it('len counts Unicode scalar values; string + string concatenates — L642, L978', () => {
    assert.deepEqual(values(engine, 'match let $a = len("❤️‍🔥"); let $b = "Hello, " + "world!";'), [{ a: 'integer:4', b: 'string:Hello, world!' }]);
  });

  it('a let reads attribute values, one combination per value; comparisons filter — L998, L1031', () => {
    engine.execute('insert $y isa person, has ref 1, has name "Steve", has age 20, has height 160, has weight 64.0;');
    assert.deepEqual(values(engine, 'match $p isa person, has age $a; let $twice = $a * 2; select $twice;'), [
      { twice: 'integer:20' },
      { twice: 'integer:40' },
    ]);
    assert.deepEqual(values(engine, 'match $p isa person, has name $n, has age $a; $a > 15; select $n;'), [{ n: 'name:Steve' }]);
    assert.deepEqual(values(engine, 'match $p isa person, has name $n, has height $h, has weight $w; let $bmi = $w / ($h / 100 * $h / 100); $bmi > 20; select $n;'), [
      { n: 'name:Steve' },
    ]);
  });

  it('a value variable assigned twice is refused, before any combination — L34', () => {
    const { code, message } = refusal(() => engine.query('match $x isa person, has age $a, has height $h; let $v = $a * 2; let $v = $h * 2;'));
    assert.equal(code, DiagnosticCode.valueAssignedTwice);
    assert.match(message, /Variable 'v' cannot be assigned to multiple times in the same branch\./);
  });

  it('an operand nothing binds is refused in TypeDB\'s words — L34', () => {
    const { message } = refusal(() => engine.query('match $x isa person, has age $a, has height $h; $v == $a; $v > $h; select $x, $v;'));
    assert.match(message, /The variable 'v' must be bound to a value before it's used/);
  });

  it('lets that wait on each other are a cycle — L195', () => {
    const { code, message } = refusal(() => engine.query('match let $a = $b + 1; let $b = $a + 1;'));
    assert.equal(code, DiagnosticCode.valueCycle);
    assert.match(message, /circular dependency/);
  });

  it('a let may not reuse a concept variable\'s name — L260', () => {
    const { message } = refusal(() => engine.query('match $x isa person, has age $a; let $a = 5;'));
    assert.match(message, /cannot be declared as both a 'Value' and as a 'Attribute'/);
  });

  it('arity and applicability errors carry TypeDB\'s phrasing — L902, L916, L990', () => {
    assert.match(refusal(() => engine.query('match let $x = abs();')).message, /expects '1' arguments but received '0'/);
    assert.match(refusal(() => engine.query('match let $x = min(10, 12.2);')).message, /expects matching argument types/);
    assert.match(refusal(() => engine.query('match let $x = ceil(0);')).message, /'std::math::ceil' cannot be applied to arguments of type 'integer'/);
    assert.match(refusal(() => engine.query('match let $x = len(0.0);')).message, /'std::string::len' cannot be applied to arguments of type 'double'/);
  });

  it('literals outside 64 bits are refused from their text, not a rounded number — L656, L668, L680', () => {
    assert.equal(refusal(() => engine.query('match let $a = 9223372036854775808;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match let $a = -9223372036854775809;')).code, DiagnosticCode.valueOutOfRange);
    assert.deepEqual(values(engine, 'match let $a = 9223372036854775807;'), [{ a: 'integer:9223372036854775807' }]);
    assert.equal(refusal(() => engine.query('match let $a = 1.8e308;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match let $a = 9223372036854775808.0dec;')).code, DiagnosticCode.valueOutOfRange);
  });

  it('review round 1: bounded powers, checked doubles, large doubles read back, 10-1 subtracts', () => {
    // A power is a double (round 6 read L1265 again); one past the double range is an overflow,
    // answered at once — never a loop of `exponent` multiplications (round 1).
    assert.equal(refusal(() => engine.query('match let $a = 2 ^ 9223372036854775807;')).code, DiagnosticCode.valueOutOfRange);
    assert.deepEqual(values(engine, 'match let $a = 1 ^ 3000000000; let $b = -1 ^ 3; let $c = 0 ^ 0; let $d = 2 ^ 62;'), [
      { a: 'double:1.0', b: 'double:-1.0', c: 'double:1.0', d: 'double:4611686018427388000.0' },
    ]);
    // Double arithmetic never answers an Infinity or NaN cell.
    assert.equal(refusal(() => engine.query('match let $a = 1.0e308 * 10.0;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match let $a = 5.0 % 0.0;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match let $a = ceil(1.0e308 * 10.0);')).code, DiagnosticCode.valueOutOfRange);
    // `1e+21` renders as JavaScript does and reads back; `1e+21.0` would not.
    assert.deepEqual(values(engine, 'match let $v = 1.0e21 * 1.0; $v > 0; let $w = $v;'), [{ v: 'double:1e+21', w: 'double:1e+21' }]);
    // `10-1` is a subtraction; a negative literal outside an expression keeps its sign.
    assert.deepEqual(values(engine, 'match let $a = 10-1; let $b = -10;'), [{ a: 'integer:9', b: 'integer:-10' }]);
    engine.execute('insert $y isa person, has ref 9, has age -5;');
    assert.deepEqual(values(engine, 'match $p isa person, has age $a; $a < 0; select $a;'), [{ a: 'age:-5' }]);
  });

  it('review round 2: INTEGER_MIN is reachable, decimals and abs are range-checked, a stored integer keeps its digits', () => {
    assert.deepEqual(values(engine, 'match let $a = -9223372036854775808; let $b = -9223372036854775808.0dec;'), [
      { a: 'integer:-9223372036854775808', b: 'decimal:-9223372036854775808.0' },
    ]);
    assert.equal(refusal(() => engine.query('match let $a = -9223372036854775809;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match let $a = 9223372036854775807.0dec + 1.0dec;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match let $a = abs(-9223372036854775807 - 1);')).code, DiagnosticCode.valueOutOfRange);
    engine.execute('insert $y isa person, has ref 9, has age 9223372036854775807;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 9, has age $a; let $v = $a - 1; select $a, $v;'), [
      { a: 'age:9223372036854775807', v: 'integer:9223372036854775806' },
    ]);
  });

  it('review round 2: one variable is one attribute instance — a name and a nick of the same text are two', () => {
    engine.define('define attribute nick value string; person owns nick;');
    engine.execute('insert $y isa person, has ref 9, has name "Sam", has nick "Sam";');
    assert.deepEqual(values(engine, 'match $p isa person, has name $n; $p has nick $n; select $n;'), []);
    assert.deepEqual(values(engine, 'match $p isa person, has name $n; $p has name $n; select $n;'), [{ n: 'name:Lisa' }, { n: 'name:Sam' }]);
  });

  it('review round 3: a decimal rounds exactly, an exponent double reads as a decimal, a write runs once per thing', () => {
    assert.deepEqual(values(engine, 'match let $a = floor(1234567890123456789.5dec); let $b = ceil(-0.5dec); let $c = round(2.5dec); let $d = round(-3.5dec);'), [
      { a: 'integer:1234567890123456789', b: 'integer:0', c: 'integer:2', d: 'integer:-4' },
    ]);
    engine.define('define attribute price value decimal; person owns price;');
    // A double literal on a decimal attribute is refused (QA, B3): a decimal is written `…dec`.
    assert.equal(refusal(() => engine.execute('insert $y isa person, has ref 9, has price 1.0e2;')).code, DiagnosticCode.valueTypeConflict);
    engine.execute('insert $y isa person, has ref 9, has price 100dec;');
    assert.deepEqual(values(engine, 'match $p isa person, has price $q; let $v = $q + 0.5dec; select $v;'), [{ v: 'decimal:100.5' }]);
    // Two names on one person are two combinations and ONE insert.
    engine.define('define attribute nick value string; person owns nick;');
    engine.execute('insert $y isa person, has ref 10, has name "A", has name "B";');
    engine.execute('match $x isa person, has ref 10, has name $n; insert $x has nick "z";');
    assert.deepEqual(values(engine, 'match $x isa person, has ref 10, has nick $k; select $k;'), [{ k: 'nick:z' }]);
  });

  it('review round 4: a spaced sign stores digits, booleans have equality only, NaN is named', () => {
    engine.execute('insert $y isa person, has ref 9, has age - 5;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 9, has age $a; let $v = $a + 1; select $a, $v;'), [{ a: 'age:-5', v: 'integer:-4' }]);
    engine.define('define attribute awake value boolean; person owns awake;');
    engine.execute('insert $y isa person, has ref 11, has awake true;');
    assert.deepEqual(values(engine, 'match $p isa person, has awake $w; $w == true; select $w;'), [{ w: 'awake:true' }]);
    assert.equal(refusal(() => engine.query('match $p isa person, has awake $w; $w > false;')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match $p isa person, has name $n; $n == true;')).code, DiagnosticCode.valueTypeConflict);
    assert.match(refusal(() => engine.query('match let $a = log10(-1.0);')).message, /not a number/);
  });

  it('review round 5: a write reads the value the match bound — one insert per value, one delete of that value', () => {
    engine.define('define attribute nick value string; person owns nick;');
    engine.execute('insert $y isa person, has ref 10, has name "Al", has name "Alice";');
    // `delete $n of $p` removes the value the comparison chose, not every name.
    engine.execute('match $p isa person, has ref 10, has name $n; $n == "Al"; delete $n of $p;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 10, has name $n; select $n;'), [{ n: 'name:Alice' }]);
    // `insert … has age $v` writes the computed value, once per distinct value.
    engine.execute('match $p isa person, has ref 0, has age $a; let $v = $a + 1; insert $p has age $v;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 0, has age $a; select $a;'), [{ a: 'age:10' }, { a: 'age:11' }]);
    engine.execute('match $p isa person, has ref 0, has name $n; insert $q isa person, has ref 12, has nick $n;');
    assert.deepEqual(values(engine, 'match $q isa person, has ref 12, has nick $k; select $k;'), [{ k: 'nick:Lisa' }]);
    // A value nothing binds is refused, not silently dropped; a `let` in a write stage is refused.
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 0; insert $p has age $v;')).code, DiagnosticCode.unboundValue);
    assert.equal(refusal(() => engine.execute('insert $p isa person, has ref 13; let $v = 1;')).code, DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.query('match let $a = abs(-9223372036854775808.5dec);')).code, DiagnosticCode.valueOutOfRange);
  });

  it('review round 6: a bound value is written only where its type fits; an infinite double literal is refused', () => {
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 0; let $v = 2.5; insert $p has age $v;')).code, DiagnosticCode.valueTypeConflict);
    engine.execute('match $p isa person, has ref 0; let $v = 7; insert $p has weight $v;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 0, has weight $w; $w < 10; select $w;'), [{ w: 'weight:7.0' }]);
    assert.equal(refusal(() => engine.execute('insert $y isa person, has ref 9, has weight 1.0e400;')).code, DiagnosticCode.valueOutOfRange);
    // A literal is spelt by the ATTRIBUTE's type at insert (round 10): an exponent no decimal
    // holds is refused there with a code, never stored and never a raw RangeError.
    engine.define('define attribute price value decimal; person owns price;');
    assert.equal(refusal(() => engine.execute('insert $y isa person, has ref 9, has price 1.0e-99999999999;')).code, DiagnosticCode.valueTypeConflict);
    // A decimal literal with more fractional digits than a decimal holds is refused, never zero (QA, B2).
    assert.equal(refusal(() => engine.execute('insert $y isa person, has ref 9, has price 0.00000000000000000001dec;')).code, DiagnosticCode.valueOutOfRange);
  });

  it('review round 7: string + needs two strings; a date passes through and its order is refused by name; an integer on a double attribute reads as one', () => {
    assert.equal(refusal(() => engine.query('match $p isa person, has name $n; let $v = $n + true;')).code, DiagnosticCode.valueTypeConflict);
    engine.define('define attribute born value date; person owns born;');
    engine.execute('insert $y isa person, has ref 9, has born 2000-01-01;');
    assert.deepEqual(values(engine, 'match $p isa person, has born $b; let $v = $b; select $v;'), [{ v: 'date:2000-01-01' }]);
    // Dates compare by instant now (modifiers.feature L458) — refused by name until they could.
    assert.deepEqual(values(engine, 'match $p isa person, has born $b; $b < 2001-01-01; select $b;'), [{ b: 'born:2000-01-01' }]);
    assert.equal(values(engine, 'match $p isa person, has born $b; let $v = $b; $v == $b; select $v;').length, 1);
    // A date and an integer have no `+` — a duration does (expression.feature L492).
    assert.equal(refusal(() => engine.query('match $p isa person, has born $b; let $v = $b + 1;')).code, DiagnosticCode.valueTypeConflict);
    engine.execute('match $p isa person, has ref 0; let $v = 10; insert $p has weight $v;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 0, has weight 10.0; select $p;'), [{ p: 'thing:person' }]);
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 0; insert $p has age 1; reduce $c = count;')).code, DiagnosticCode.notImplemented);
    // And over an empty match too (round 8): the refusal does not depend on the data.
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 99; insert $p has age 1; reduce $c = count;')).code, DiagnosticCode.notImplemented);
  });

  it('review round 9: one stored spelling per literal, a temporal literal compares, a thing is not an attribute value', () => {
    engine.define('define attribute balance value decimal; person owns balance;');
    engine.execute('insert $y isa person, has ref 9, has balance 5dec, has weight 1.0e2;');
    assert.deepEqual(values(engine, 'match $p isa person, has balance 5.0dec, has weight 100.0; select $p;'), [{ p: 'thing:person' }]);
    assert.deepEqual(values(engine, 'match $p isa person, has ref 9, has balance $b, has weight $w; select $b, $w;'), [{ b: 'balance:5', w: 'weight:100.0' }]);
    engine.define('define attribute born value date; person owns born;');
    engine.execute('insert $z isa person, has ref 11, has born 2020-01-01;');
    assert.deepEqual(values(engine, 'match $p isa person, has born $d; let $v = 2020-01-01; select $v;'), [{ v: 'date:2020-01-01' }]);
    assert.equal(values(engine, 'match $p isa person, has born $d; $d == 2020-01-01; select $d;').length, 1);
    // 🔴 One instant, two spellings — the reason temporal equality was refused (round 11) — are equal.
    engine.define('define attribute seen value datetime; person owns seen;');
    engine.execute('insert $w isa person, has ref 12, has seen 2020-01-01T00:00:00;');
    assert.equal(values(engine, 'match $p isa person, has seen $s; $s == 2020-01-01T00:00:00.000; select $s;').length, 1);
    assert.equal(values(engine, 'match $p isa person, has seen $s; $s == 2020-01-01; select $s;').length, 1);
    assert.equal(refusal(() => engine.query('match $p isa person; $q isa person, has name $p;')).code, DiagnosticCode.mixedPattern);
  });

  it('review round 10: one spelling per (attribute type, value) — literal or computed; put by the bound value; delete of a let refused', () => {
    engine.define('define attribute price value decimal; person owns price;');
    // A computed decimal `3.0` and the literal `3dec` are one stored text; `1.0e2` on a decimal is `100`.
    engine.execute('match $p isa person, has ref 0; let $v = 1.5dec * 2; insert $p has price $v;');
    assert.deepEqual(values(engine, 'match $p isa person, has price 3dec, has ref $r; select $r;'), [{ r: 'ref:0' }]);
    engine.execute('insert $y isa person, has ref 9, has price 100.00dec, has weight 80;');
    assert.deepEqual(values(engine, 'match $p isa person, has price 100dec, has weight 80.0, has ref $r; select $r;'), [{ r: 'ref:9' }]);
    // Leading zeros are not a second integer; an integer past 64 bits is refused at insert.
    assert.equal(refusal(() => engine.execute('insert $z isa person, has ref 000;')).code, DiagnosticCode.constraintViolated);
    assert.equal(refusal(() => engine.execute('insert $z isa person, has ref 14, has age 99999999999999999999;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.execute('insert $z isa person, has ref 14, has age "ten";')).code, DiagnosticCode.valueTypeConflict);
    // `put … has ref $a` looks up the value the match bound: an existing 9 is reused, a new 15 is written.
    engine.execute('match $p isa person, has ref 9, has ref $a; put $q isa person, has ref $a;');
    engine.execute('match $p isa person, has ref 9; let $a = 15; put $q isa person, has ref $a;');
    assert.equal(values(engine, 'match $p isa person, has ref $r; select $r;').length, 3);
    assert.deepEqual(values(engine, 'match $p isa person, has ref 15; select $p;'), [{ p: 'thing:person' }]);
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 0, has age $a; let $v = $a; delete $v of $p;')).code, DiagnosticCode.mixedPattern);
  });

  it('review round 11: refusals that do not depend on the data; own built-ins only; nineteen fractional digits', () => {
    engine.define('define attribute nick value string; person owns nick;');
    // Over an EMPTY match: an unbound value in a write, and a thing as an operand, are refused.
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 99; insert $p has nick $zz;')).code, DiagnosticCode.unboundValue);
    assert.equal(refusal(() => engine.query('match $x isa person, has ref 99; let $v = $x + 1;')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match let $v = constructor(1);')).code, DiagnosticCode.unknownFunction);
    const [{ v }] = values(engine, `match let $v = ${Array(22).fill('0.1dec').join(' * ')};`);
    assert.equal(v, 'decimal:0.0000000000000000000');
    assert.deepEqual(values(engine, 'match let $v = 0.1dec * 0.1dec * 0.1dec;'), [{ v: 'decimal:0.001' }]);
  });

  it('review round 12: a thing as an attribute value is refused over an empty store; a decimal literal fits a decimal attribute only', () => {
    engine.define('define attribute nick value string; person owns nick;');
    assert.equal(refusal(() => engine.query('match $p isa person; $q isa person, has nick $p;')).code, DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.execute('insert $z isa person, has ref 14, has age 5dec;')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.execute('insert $z isa person, has ref 14, has weight 2dec;')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match $p isa person, has weight 60.0dec;')).code, DiagnosticCode.valueTypeConflict);
  });

  it('review round 13: a date on a datetime attribute is midnight, in the datetime\'s one spelling', () => {
    engine.define('define attribute at value datetime; person owns at;');
    engine.execute('insert $y isa person, has ref 9, has at 2000-01-01;');
    assert.deepEqual(values(engine, 'match $p isa person, has at 2000-01-01T00:00:00, has ref $r; select $r;'), [{ r: 'ref:9' }]);
    assert.deepEqual(values(engine, 'match $p isa person, has at 2000-01-01, has at $a; select $a;'), [{ a: 'at:2000-01-01T00:00:00' }]);
  });

  it('review round 14: refusals over an empty match, code-point string order, one datetime spelling', () => {
    engine.define('define attribute nick value string; attribute at value datetime; person owns nick, owns at;');
    // Over an EMPTY match: a bad literal, a let in the write, a mistyped bound value, a delete of a let.
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 99; insert $p has age "x";')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 99; insert $p has age 99999999999999999999;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 99; insert $p has age 1; let $v = 1;')).code, DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 99; let $v = "x"; insert $p has age $v;')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 99; $q isa person; delete $q of $p;')).code, DiagnosticCode.mixedPattern);
    // And in a read that binds nothing: unknown function, arity, operand kinds.
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 99, has age $a; let $v = nope($a);')).code, DiagnosticCode.unknownFunction);
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 99, has age $a; let $v = abs($a, $a);')).code, DiagnosticCode.functionArity);
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 99, has age $a; let $v = $a + "x";')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 99, has age $a; $a > "x";')).code, DiagnosticCode.valueTypeConflict);
    // Strings order by code point.
    engine.execute('insert $a isa person, has ref 20, has nick "𝔸"; $b isa person, has ref 21, has nick "ﬀ";');
    assert.deepEqual(values(engine, 'match $p isa person, has nick $n; $n > "ﬀ"; select $n;'), [{ n: 'nick:𝔸' }]);
    // `…:00.000` is `…:00`.
    engine.execute('insert $c isa person, has ref 22, has at 2000-01-01T00:00:00.000;');
    assert.deepEqual(values(engine, 'match $p isa person, has at 2000-01-01, has ref $r; select $r;'), [{ r: 'ref:22' }]);
  });

  it('review round 15: an abstract attribute with no value type defers to the cells; built-in argument kinds are checked before the data', () => {
    engine.define('define attribute measure @abstract; attribute height sub measure, value integer; person owns measure, owns height;');
    engine.execute('insert $p isa person, has ref 30, has height 180;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 30, has measure $m; $m > 100; let $v = $m + 1; select $v;'), [{ v: 'integer:181' }]);
    assert.deepEqual(values(engine, 'match $p isa person, has measure 180, has ref $r; select $r;'), [{ r: 'ref:0' }, { r: 'ref:30' }]);
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 99, has age $a; let $v = len($a);')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 99, has name $n; let $v = abs($n);')).code, DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match $p isa person, has ref 99, has age $a; let $v = ceil($a);')).code, DiagnosticCode.valueTypeConflict);
  });

  it('review round 16: a literal on an abstract attribute is spelt per concrete subtype; long is integer', () => {
    engine.define('define attribute measure @abstract; attribute height sub measure, value integer; attribute mass sub measure, value double; person owns measure, owns height, owns mass;');
    engine.execute('insert $p isa person, has ref 30, has height 60, has mass 60;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 30, has measure 60, has measure $m; select $m;'), [{ m: 'height:60' }, { m: 'mass:60.0' }]);
    assert.deepEqual(values(engine, 'match $p isa person, has ref 30, has measure 180.0; select $p;'), []);
    engine.define('define attribute count value long; person owns count;');
    engine.execute('insert $q isa person, has ref 31, has count 3;');
    assert.deepEqual(values(engine, 'match $p isa person, has ref 31, has count $c; let $m = max($c, 5); select $m;'), [{ m: 'integer:5' }]);
  });

  it('review round 17: a subtype inheriting its value type is a candidate; an unreadable literal on an abstract attribute is one refusal, not stray errors', () => {
    engine.define('define attribute measure @abstract; attribute height sub measure, value integer; attribute tall-height sub height; person owns measure, owns height, owns tall-height;');
    engine.execute('insert $p isa person, has ref 30, has tall-height 60;');
    assert.deepEqual(values(engine, 'match $p isa person, has measure 60, has ref $r; select $r;'), [{ r: 'ref:30' }]);
    assert.equal(refusal(() => engine.query('match $p isa person, has measure 99999999999999999999;')).code, DiagnosticCode.valueOutOfRange);
    assert.equal(refusal(() => engine.query('match $p isa person, has measure "x";')).code, DiagnosticCode.valueTypeConflict);
    const { diagnostics } = engine.query('match $p isa person, has measure 61, has ref $r; select $r;');
    assert.equal(diagnostics.filter((d) => d.severity === 1).length, 0);
  });

  it('what this engine does not have is refused by name: schema functions — metadata L833', () => {
    assert.equal(refusal(() => engine.query('match let $d = get_fun_doc("nothing");')).code, DiagnosticCode.notImplemented);
  });

  it('a second `match` is a later stage, and reads what the first selected — variables L26, L38', () => {
    // Refused by name until stages chained (Phase 06 audit); now they do.
    assert.deepEqual(values(engine, 'match let $x = 1; select $x; match let $y = $x + 2;'), [{ x: 'integer:1', y: 'integer:3' }]);
  });
});
