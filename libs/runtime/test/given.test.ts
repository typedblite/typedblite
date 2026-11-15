import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter, TypeDBLiteValue } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `given` rows and `try` in writes — given.feature is the acceptance suite; this pins the checks
 * and the semantics.
 */
const SCHEMA = 'define attribute ref value integer; attribute name value string; entity person owns ref @key, owns name;';

const refusal = (attempt: () => void): { code: string; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

const int = (n: number) => TypeDBLiteValue.value('integer', String(n));
const str = (s: string) => TypeDBLiteValue.value('string', s);

describe('given rows', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute('insert $p isa person, has ref 0, has name "Ann";');
  });

  afterEach(() => engine.close());

  it('each given row seeds the stream — given L165', () => {
    const rows = engine.query('given $x: integer; match let $y = 2 * $x;', [{ x: int(3) }, { x: int(5) }]).rows;
    assert.deepEqual(rows.map((r) => r['y'].asString()), ['6', '10']);
  });

  it('a given value matches like any value — given L54', () => {
    assert.equal(engine.query('given $n: string; match $p isa person, has name == $n;', [{ n: str('Ann') }]).rows.length, 1);
  });

  it('a given value of a value type is not an attribute: `has name $n` is refused, as TypeDB refuses it', () => {
    // It used to match nothing, and said so only in an `empty-match` fact.
    const message = /The variable 'n' cannot be declared as both a 'Value' and as a 'Attribute'/;
    const attempt = (): void => void engine.query('given $n: string; match $p isa person, has name $n;', [{ n: str('Ann') }]);
    assert.equal(refusal(attempt).code, DiagnosticCode.mixedPattern);
    assert.match(refusal(attempt).message, message);
    // A write's match too, and a `let` or a `reduce` result read the same way.
    assert.match(refusal(() => engine.execute('given $n: string; match $p isa person, has name $n; update $p has name "Bea";', [{ n: str('Ann') }])).message, message);
    assert.match(refusal(() => engine.query('match let $n = "Ann"; $p isa person, has name $n;')).message, message);
    assert.match(refusal(() => engine.query('match $q isa person; reduce $n = count; match $p isa person, has name $n;')).message, message);
    // The refusal does not wait for a row: an empty store refuses it too.
    const empty = new TypeDBLiteInterpreter(':memory:');
    empty.define(SCHEMA);
    assert.match(refusal(() => empty.query('given $n: string; match $p isa person, has name $n;', [{ n: str('Ann') }])).message, message);
    empty.close();
    // The forms that say the same thing, and work.
    assert.equal(engine.query('given $n: string; match $p isa person, has name == $n;', [{ n: str('Ann') }]).rows.length, 1);
    assert.equal(engine.query('given $n: string; match $p isa person, has name $x; $x == $n;', [{ n: str('Ann') }]).rows.length, 1);
  });

  it('what the refusal must not catch: a given attribute, and an attribute an earlier stage bound', () => {
    assert.equal(engine.query('given $n: name; match $p isa person, has name $n;', [{ n: str('Ann') }]).rows.length, 1);
    assert.equal(engine.query('match $p isa person, has name $n; select $n; match $q isa person, has name $n;').rows.length, 1);
  });

  it('an integer widens to a double; a string does not decode as an integer — given L184', () => {
    assert.deepEqual(engine.query('given $x: double; match let $y = 2 * $x;', [{ x: int(3) }]).rows.map((r) => r['y'].asString()), ['6.0']);
    assert.match(refusal(() => engine.query('given $x: integer; match let $y = 2 * $x;', [{ x: str('abc') }])).message, /The provided value '"abc"' has type 'string' and could not be decoded as the value type 'integer'/);
  });

  it('refuses rows that do not fit the stage — given L127, L223, L353', () => {
    for (const [query, given, pattern] of [
      ['given $x: integer; match let $y = $x;', undefined, /contains a given stage, but no given rows were provided/],
      ['match let $y = 1;', [{ x: int(1) }], /contains no given stage, but given rows were provided/],
      ['given $x: integer, $y: integer; match let $z = $x;', [{ x: int(1) }], /missing the required variable 'y'/],
      ['given $x: integer; match let $z = $x;', [{ x: int(1), z: int(2) }], /The variable 'z' was not declared in the query/],
      ['given $x: integer; match let $z = $x;', [{ x: null }], /row '0' and column '0' was None, but the variable was not declared optional/],
      ['given $x: integer; match let $x = 6;', [{ x: int(5) }], /may not be assigned to, as it was already bound in a previous stage/],
    ] as const) {
      assert.match(refusal(() => engine.query(query, given)).message, pattern, query);
    }
  });

  it('an optional given is written only inside try — given L353', () => {
    const rows = [{ ref: int(1), name: str('Bo') }, { ref: int(2), name: null }];
    assert.equal(refusal(() => engine.execute('given $ref: integer, $name: string?; insert $p isa person, has ref == $ref, has name == $name;', rows)).code, DiagnosticCode.unboundValue);
    engine.execute('given $ref: integer, $name: string?; insert $p isa person, has ref == $ref; try { $p has name == $name; };', rows);
    const named = engine.query('match $p isa person, has ref $r, has name $n; select $r;').rows.map((r) => r['r'].asString()).sort();
    assert.deepEqual(named, ['0', '1']);
    assert.equal(engine.query('match $p isa person, has ref 2;').rows.length, 1);
  });

  it('a try inside a write try is refused — update L3042', () => {
    assert.match(refusal(() => engine.execute('match $p isa person; insert try { $p has name "x"; try { $p has name "y"; }; };')).message, /Nested try blocks/);
  });
});
