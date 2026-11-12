import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter, type TypeDBLiteValue } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * ADR-006: an attribute is an instance in its own right — stored once per type and value, able to
 * exist with no owner when its type is `@independent`, and gone at the end of the statement that
 * leaves it ownerless when it is not.
 */
const SCHEMA = [
  'define',
  'attribute ref, value integer;',
  'attribute name @independent, value string;',
  'attribute nick sub name;',
  'attribute email, value string;',
  'attribute age, value integer;',
  'entity person, owns ref @key, owns name, owns email, owns age, plays friendship:friend;',
  'relation friendship, relates friend @card(0..), owns ref @key;',
].join('\n');

let engine: TypeDBLiteInterpreter;
beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
});

const column = (rows: ReadonlyArray<Record<string, TypeDBLiteValue>>, variable: string): string[] =>
  rows.map((row) => String(row[variable]?.asString())).sort();
const values = (query: string, variable: string): string[] => column(engine.query(query).rows, variable);
const refusal = (write: () => unknown): string | undefined => {
  try {
    write();
  } catch (error) {
    return diagnosticOf(error)?.code ?? 'error';
  }
  return undefined;
};

describe('an attribute instance with no owner', () => {
  it('is inserted, answered by the insert, and found by a match when its type is independent', () => {
    const inserted = engine.execute('insert $n isa name "John";').rows;
    assert.equal(inserted[0]?.['n']?.isAttribute(), true);
    assert.deepEqual(values('match $n isa name;', 'n'), ['John']);
    assert.deepEqual(values('match $p has name $n;', 'n'), [], 'no one owns it');
  });

  it('is answered by its insert, then gone, when its type is not independent — match.feature L4214', () => {
    const inserted = engine.execute('insert $e isa email "a@x";').rows;
    assert.equal(inserted[0]?.['e']?.asString(), 'a@x');
    assert.deepEqual(values('match $e isa email;', 'e'), []);
  });

  it('is one instance however many owners share its value', () => {
    engine.execute('insert $a isa person, has ref 1, has name "Ann"; $b isa person, has ref 2, has name "Ann";');
    assert.deepEqual(values('match $n isa name "Ann";', 'n'), ['Ann']);
    assert.equal(engine.query('match $p isa person, has name $n; $n isa name "Ann";').rows.length, 2);
  });

  it('matches through its subtypes, and isa! does not', () => {
    engine.execute('insert $a isa name "A"; $b isa nick "B";');
    assert.deepEqual(values('match $n isa name;', 'n'), ['A', 'B']);
    assert.deepEqual(values('match $n isa! name;', 'n'), ['A']);
  });

  it('is compared by its own value, and a numeric literal of another kind matches by value', () => {
    engine.execute('insert $p isa person, has ref 1, has age 17; $q isa person, has ref 2, has age 25;');
    assert.deepEqual(values('match $a isa age > 18;', 'a'), ['25']);
    assert.deepEqual(values('match $a isa age 25.0;', 'a'), ['25'], 'insert.feature L1550');
    assert.deepEqual(values('match $a isa age 25.5;', 'a'), [], 'no integer is 25.5: nothing, not a refusal');
  });
});

describe('writing attribute instances', () => {
  it('takes its value from a variable, and owners can then own it in the same insert', () => {
    engine.execute('match let $v = "Bo"; insert $n isa name == $v; $p isa person, has ref 1, has name $n;');
    assert.deepEqual(values('match $p isa person, has name $n;', 'n'), ['Bo']);
  });

  it('refuses an insert with no value, or with a predicate — insert.feature L1605, L1619', () => {
    assert.equal(refusal(() => engine.execute('insert $x isa age;')), DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.execute('insert $x isa age > 18;')), DiagnosticCode.mixedPattern);
  });

  it('refuses an attribute given an owner-side property', () => {
    assert.equal(refusal(() => engine.query('match $n isa name, has email $e;')), DiagnosticCode.mixedPattern);
  });
});

describe('deleting attribute instances', () => {
  it('removes the attribute and every ownership of it — delete.feature L1019', () => {
    engine.execute('insert $a isa person, has ref 1, has age 18; $b isa person, has ref 2, has age 18;');
    engine.execute('match $x isa age 18; delete $x;');
    assert.deepEqual(values('match $p has age $a;', 'a'), []);
    assert.deepEqual(values('match $p isa person, has ref $r;', 'r'), ['1', '2'], 'the owners stay');
  });

  it('deletes every attribute a match binds, not one — delete.feature L275', () => {
    engine.execute('insert $a isa name "A"; $b isa name "B"; $c isa nick "C";');
    engine.execute('match $n isa name; delete $n;');
    assert.deepEqual(values('match $n isa name;', 'n'), []);
  });

  it('refuses to delete an owner\'s @key — delete.feature L2755', () => {
    engine.execute('insert $p isa person, has ref 1;');
    assert.equal(refusal(() => engine.execute('match $r isa ref 1; delete $r;')), DiagnosticCode.constraintViolated);
    assert.deepEqual(values('match $p isa person, has ref $r;', 'r'), ['1']);
  });

  it('removes a dependent attribute with its last owner, and keeps an independent one', () => {
    engine.execute('insert $p isa person, has ref 1, has email "e@x", has name "Ann";');
    engine.execute('match $p isa person, has ref 1; delete $p;');
    assert.deepEqual(values('match $e isa email;', 'e'), []);
    assert.deepEqual(values('match $n isa name;', 'n'), ['Ann']);
  });

  it('removes what nothing owns when its type stops being independent — delete.feature L1329', () => {
    engine.execute('insert $n isa name "Loose"; $p isa person, has ref 1, has name "Held";');
    engine.define('undefine @independent from name;');
    assert.deepEqual(values('match $n isa name;', 'n'), ['Held']);
  });
});

describe('attribute instances through a type variable', () => {
  it('answers attributes as instances of their types — insert.feature L276', () => {
    engine.execute('insert $p isa person, has ref 0, has name "W";');
    assert.deepEqual(values('match attribute $t; $x isa $t; select $x;', 'x'), ['0', 'W']);
  });

  it('never offers an attribute as a role player', () => {
    engine.execute('insert $p isa person, has ref 1; $f isa friendship, links (friend: $p), has ref 2;');
    const players = engine.query('match $x isa $t; $f isa friendship, links (friend: $x); select $x;').rows;
    assert.ok(players.every((row) => row['x']?.isEntity()));
    assert.equal(players.length, 1, 'the person, and none of its attributes');
  });
});
