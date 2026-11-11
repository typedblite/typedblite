import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `not { … }`, `{ … } or { … }`, `try { … }`, `$x is $y`, `has $a`, `has T <op> …`, roleless and
 * role-variable players, and `$_` — negation.feature, disjunction.feature, optional.feature and
 * variables.feature are the acceptance suite; this pins each form's meaning.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string;',
  'attribute age value integer;',
  'entity person owns ref @key, owns name, owns age, plays employment:employee, plays friendship:friend;',
  'entity company owns ref @key, owns name, plays employment:employer;',
  'relation employment relates employee, relates employer, owns ref @key;',
  'relation friendship relates friend @card(0..), owns ref @key;',
].join('\n');

const refusal = (attempt: () => void): { code: string; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('nested patterns', () => {
  let engine: TypeDBLiteInterpreter;
  const refs = (query: string, variable = 'r'): string[] => engine.query(query).rows.map((row) => row[variable]?.toString() ?? '∅');

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute(
      'insert $a isa person, has ref 0, has name "Ann", has age 30; $b isa person, has ref 1, has name "Bo"; ' +
        '$c isa company, has ref 2, has name "Co"; $e isa employment, links (employee: $a, employer: $c), has ref 3;',
    );
  });

  afterEach(() => engine.close());

  it('not { … } keeps an answer only when its block matches nothing — negation L57', () => {
    assert.deepEqual(refs('match $p isa person, has ref $r; not { $e isa employment, links (employee: $p); }; select $r;'), ['1']);
  });

  it('a disjunction answers each branch, and a row both branches give once — disjunction L38, variables L126', () => {
    assert.deepEqual(refs('match { $x isa person; } or { $x isa company; }; $x has ref $r; select $r;').sort(), ['0', '1', '2']);
    assert.deepEqual(refs('match $x isa person, has ref 0, has ref $r; { $x has name "Ann"; } or { $x has age 30; }; select $r;'), ['0']);
  });

  it('try extends an answer when it matches and keeps it empty when it does not — optional L46, L66', () => {
    const rows = engine.query('match $p isa person, has ref $r; try { $e isa employment, links (employee: $p); }; select $r, $e;').rows;
    assert.deepEqual(rows.map((row) => [row['r'].toString(), row['e'] === undefined ? '∅' : 'e']).sort(), [['0', 'e'], ['1', '∅']]);
  });

  it('an empty optional variable satisfies nothing that uses it later — optional L207', () => {
    assert.deepEqual(refs('match $p isa person, has ref $r; try { $p has age $a; }; match $a > 0; select $r;'), ['0']);
  });

  it('`$x is $y` is one concept; with neither bound it is refused — match L5036', () => {
    assert.deepEqual(refs('match $p isa person, has ref $r; $q isa person, has ref 0; $p is $q; select $r;'), ['0']);
    assert.equal(refusal(() => engine.query('match $x is $y;')).code, DiagnosticCode.unboundValue);
  });

  it('has $a binds any attribute; has T op x compares the owned value — negation L436, insert L312', () => {
    assert.equal(engine.query('match $p isa person, has ref 0, has $a;').rows.length, 3);
    assert.deepEqual(refs('match $p isa person, has age > 20, has ref $r; select $r;'), ['0']);
    // A value of another kind is not equal to it — never a refusal for a type `has $a` could not know.
    assert.equal(engine.query('match $p isa person, has ref 0, has $a; not { $a == 30; };').rows.length, 2);
    engine.execute('match let $n = "Cy"; insert $p isa person, has ref 9, has name == $n;');
    assert.deepEqual(refs('match $p isa person, has name "Cy", has ref $r; select $r;'), ['9']);
  });

  it('a roleless player matches any role, and an insert infers the one it can play — optional L46, insert L996', () => {
    assert.equal(engine.query('match $e isa employment ($p, $c);').rows.length, 2);
    engine.execute('match $a isa person, has ref 0; $b isa person, has ref 1; insert $f isa friendship, links ($a, $b), has ref 4;');
    assert.equal(engine.query('match $f isa friendship, links (friend: $x, friend: $y);').rows.length, 2);
    engine.define('define company plays employment:employee;');
    const ambiguous = refusal(() => engine.execute('match $c isa company, has ref 2; insert $e isa employment, links ($c), has ref 5;'));
    assert.match(ambiguous.message, /could play employee or employer/);
  });

  it('a role variable binds the role type — negation L365', () => {
    const roles = engine.query('match $e isa employment, links ($role: $x); select $role;').rows.map((row) => row['role'].label).sort();
    assert.deepEqual(roles, ['employment:employee', 'employment:employer']);
  });

  it('each `$_` is its own variable, and never answered — disjunction L172', () => {
    engine.execute('insert $_ isa person, has ref 10; $_ isa person, has ref 11;');
    assert.equal(engine.query('match $p isa person, has ref $r; $r > 9;').rows.length, 2);
    assert.deepEqual(Object.keys(engine.query('match $p isa person, has ref $_; select $p;').rows[0]), ['p']);
  });

  it('an insert checks the player can play the role — insert L1015', () => {
    const found = refusal(() => engine.execute('match $c isa company, has ref 2; insert $e isa employment, links (employee: $c), has ref 6;'));
    assert.equal(found.code, DiagnosticCode.unknownRole);
    assert.match(found.message, /cannot play 'employment:employee'/);
  });

  it('scoping is refused before any row — variables L156, L252, optional L169, L176', () => {
    for (const [query, pattern] of [
      ['match not { let $x = 1; $x > 10; }; not { let $x = 2; $x < 0; };', /two nested blocks here use it/],
      ['match $p isa person; not { try { $p has age $a; }; };', /Optionals are not allowed in negations/],
      ['match $p isa person; try { $c isa company; }; try { $c isa company; };', /two nested blocks here use it/],
      ['match { let $x = 1; } or { let $z = 2; }; let $y = $x + 1;', /must be bound to a value before it's used/],
    ] as const) {
      assert.match(refusal(() => engine.query(query)).message, pattern, query);
    }
  });

  it('a write states what it writes: not, or, try and is are refused there by name', () => {
    assert.equal(refusal(() => engine.execute('insert $p isa person, has ref 20; not { $p has age 1; };')).code, DiagnosticCode.notImplemented);
  });
});
