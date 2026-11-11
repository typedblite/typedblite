import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `fetch` — a JSON document per answer. Each `it` names the fetch.feature line it answers; the
 * conformance card is the acceptance suite, this is the unit suite for the shapes and the refusals.
 */
const SCHEMA = [
  'define',
  'entity person plays friendship:friend, owns person-name @card(0..), owns age @card(0..1), owns karma @card(0..2), owns ref @key;',
  'entity company owns company-name @card(1..1), owns achievement @card(0..1), owns company-achievement @card(0..), owns ref @key;',
  'relation friendship relates friend @card(0..), owns ref @key;',
  'attribute name @abstract, value string;',
  'attribute person-name sub name;',
  'attribute company-name sub name;',
  'attribute age value integer;',
  'attribute karma value double;',
  'attribute ref value integer;',
  'attribute achievement @abstract;',
  'attribute company-achievement sub achievement, value string;',
  'attribute price value decimal;',
  'attribute born value datetime;',
  'entity thing owns price, owns born, owns ref @key;',
].join('\n');

const refusal = (attempt: () => void): { code: string; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('fetch', () => {
  let engine: TypeDBLiteInterpreter;
  const documents = (query: string) => engine.query(query).documents;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute(
      'insert $a isa person, has person-name "Alice", has person-name "Allie", has age 10, has ref 0; ' +
        '$b isa person, has person-name "Bob", has ref 1; ' +
        '$c isa company, has company-name "TypeDB", has company-achievement "Green", has ref 2; ' +
        '$f links (friend: $a, friend: $b), isa friendship, has ref 3; ' +
        '$t isa thing, has price 1.50dec, has born 2021-01-01T10:00:00, has ref 4;',
    );
  });

  afterEach(() => engine.close());

  it('answers a document per answer, and no rows — L96', () => {
    const result = engine.query('match $t label person; fetch { "label": $t };');
    assert.deepEqual(result.documents, [{ label: 'person' }]);
    assert.deepEqual(result.rows, []);
  });

  it('a scalar projection is null or the one value; a list is every value — L280, L332, L395', () => {
    assert.deepEqual(documents('match $p isa person, has ref $r; fetch { "r": $r, "age": $p.age, "names": [ $p.person-name ] };'), [
      { r: 0, age: 10, names: ['Alice', 'Allie'] },
      { r: 1, age: null, names: ['Bob'] },
    ]);
  });

  it('a supertype’s @card(0..1) makes a subtype scalar — L280, L597', () => {
    assert.deepEqual(documents('match $c isa company; fetch { "a": $c.company-achievement };'), [{ a: 'Green' }]);
  });

  it('{ $p.* } keys each attribute type, scalar or list by the ownership’s cardinality — L597', () => {
    assert.deepEqual(documents('match $p isa person, has ref 0; fetch { "all": { $p.* } };'), [
      { all: { 'person-name': ['Alice', 'Allie'], age: 10, ref: 0 } },
    ]);
  });

  it('decimals keep their dec; datetimes are written to the nanosecond — L746', () => {
    assert.deepEqual(documents('match $t isa thing; fetch { $t.* };'), [
      { price: '1.5dec', born: '2021-01-01T10:00:00.000000000', ref: 4 },
    ]);
  });

  it('a sub-query is answered for each parent answer, with the parent’s bindings — L1159', () => {
    assert.deepEqual(
      documents('match $p isa person, has person-name $n; fetch { "n": $n, "others": [ match $p has person-name $o; $o != $n; fetch { "o": $o }; ] };'),
      [
        { n: 'Alice', others: [{ o: 'Allie' }] },
        { n: 'Allie', others: [{ o: 'Alice' }] },
        { n: 'Bob', others: [] },
      ],
    );
  });

  it('values and expressions — L1644, L1665', () => {
    assert.deepEqual(documents('match $p isa person, has ref 0, has age $a; fetch { "c": 100, "x": $a * 2 };'), [{ c: 100, x: 20 }]);
  });

  it('refuses, before any row, what TypeDB refuses — L85, L177, L384, L478, L1346, L1478', () => {
    for (const [query, code, pattern] of [
      ['match entity $t; fetch { "x": $name };', DiagnosticCode.fetch, /variable 'name' is not available/],
      ['match $p isa person, has ref $r; select $r; fetch { "x": [ $p.age ] };', DiagnosticCode.fetch, /variable 'p' is not available/],
      ['match $p isa person; fetch { "x": $p };', DiagnosticCode.fetch, /Fetching entities is not supported/],
      ['match $f isa friendship; fetch { "x": $f };', DiagnosticCode.fetch, /Fetching relations is not supported/],
      ['match $p isa person; fetch { "x": $p.person-name };', DiagnosticCode.fetch, /can be owned more than 1 time/],
      ['match $p isa person; fetch { "x": $p.company-name };', DiagnosticCode.fetch, /attribute 'company-name' cannot be/],
      ['match $p isa person, has ref $r; fetch { "x": $r, "x": $r };', DiagnosticCode.fetch, /multiple mappings for one key/],
      ['match $p isa person; fetch { "x": [ match $p has ref $r; ] };', DiagnosticCode.fetch, /sub-query: no fetch/],
      ['match entity $t; $p isa! $t; fetch { "x": [ match relation $t; fetch { "y": $t }; ] };', DiagnosticCode.mixedPattern, /Type-inference/],
    ] as const) {
      // An empty store refuses it too: a refusal never depends on the data.
      for (const store of [engine, new TypeDBLiteInterpreter(':memory:')]) {
        if (store !== engine) store.define(SCHEMA);
        const found = refusal(() => store.query(query));
        assert.equal(found.code, code, query);
        assert.match(found.message, pattern, query);
        if (store !== engine) store.close();
      }
    }
  });

  it('a spread is an entry, never a value; a fetch needs an object — L76, L597', () => {
    assert.equal(refusal(() => engine.query('match $p isa person; fetch;')).code, DiagnosticCode.parseFailed);
    assert.equal(refusal(() => engine.query('match $p isa person; fetch { "x": $p.* };')).code, DiagnosticCode.parseFailed);
  });

  it('what later phases own is refused by name — fetch after a write, return', () => {
    assert.equal(refusal(() => engine.execute('insert $p isa person, has ref 9; fetch { "r": [ $p.ref ] };')).code, DiagnosticCode.notImplemented);
    assert.equal(refusal(() => engine.query('match $p isa person; fetch { "x": [ match $p has ref $r; return { $r }; ] };')).code, DiagnosticCode.notImplemented);
  });
});
