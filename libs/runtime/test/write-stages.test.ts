import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * Writes that answer, `update`, and the `delete` forms — update.feature, delete.feature and
 * put.feature are the acceptance suite; this pins each behaviour.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string;',
  'attribute nick value string;',
  'entity person owns ref @key, owns name, owns nick @card(0..), plays friendship:friend, plays parentship:parent, plays parentship:child;',
  'relation friendship relates friend, owns ref @key;',
  'relation parentship relates parent, relates child;',
].join('\n');

const refusal = (attempt: () => void): { code: string; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('write stages', () => {
  let engine: TypeDBLiteInterpreter;
  const names = (): string[] => engine.query('match $p isa person, has name $n; select $n;').rows.map((row) => row['n'].asString()).sort();

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute('insert $a isa person, has ref 0, has name "Ann"; $b isa person, has ref 1, has name "Bo";');
  });

  afterEach(() => engine.close());

  it('a write answers the rows its stream ends with — update.feature', () => {
    const { rows } = engine.execute('match $p isa person, has ref 0; insert $p has nick "A";');
    assert.equal(rows.length, 1);
    assert.ok(rows[0]['p'].isThing());
    assert.deepEqual(engine.execute('match $p isa person, has ref 9; insert $p has nick "Z";').rows, []);
  });

  it('update replaces a single-valued has, and only that attribute type — update L238, L959', () => {
    engine.execute('match $p isa person, has ref 0; update $p has name "Anna";');
    assert.deepEqual(names(), ['Anna', 'Bo']);
    // The same value again is no change.
    engine.execute('match $p isa person, has ref 0; update $p has name "Anna";');
    assert.deepEqual(names(), ['Anna', 'Bo']);
  });

  it('update refuses a multi-valued has, an unbound or anonymous variable, an isa, a schema statement', () => {
    for (const [query, pattern] of [
      ['match $p isa person; update $p has nick "x";', /cardinality should not exceed 1/],
      ['match $p isa person; update $q has name "x";', /referenced in the update stage is unavailable/],
      ['match $p isa person, has name $_; update $_ has name "x";', /anonymous/],
      ['match $p isa person; update $p isa person;', /Illegal 'isa' provided for variable 'p'/],
      ['match $p isa person; update $p owns name;', /Illegal statement provided for an update stage/],
    ] as const) {
      assert.match(refusal(() => engine.execute(query)).message, pattern, query);
    }
  });

  it('update replaces a role player, inferring an unambiguous role — update L1556, L1616, L1712', () => {
    engine.execute('match $a isa person, has ref 0; insert $f isa friendship, links (friend: $a), has ref 2;');
    engine.execute('match $f isa friendship; $b isa person, has ref 1; update $f links (friend: $b);');
    const friends = engine.query('match $f isa friendship, links (friend: $x); $x has ref $r; select $r;').rows.map((row) => row['r'].toString());
    assert.deepEqual(friends, ['1']);
    engine.execute('match $a isa person, has ref 0; $b isa person, has ref 1; insert $r isa parentship, links (parent: $a, child: $b);');
    assert.match(refusal(() => engine.execute('match $r isa parentship; $b isa person, has ref 1; update $r links ($b);')).message, /requires unambiguous role type/);
  });

  it('delete has … of, delete links … of, and a relation emptied of players goes too — delete L855', () => {
    engine.execute('match $p isa person, has ref 0, has name $n; delete has $n of $p;');
    assert.deepEqual(names(), ['Bo']);
    engine.execute('match $a isa person, has ref 0; insert $f isa friendship, links (friend: $a), has ref 2;');
    engine.execute('match $f isa friendship, links (friend: $x); delete links (friend: $x) of $f;');
    assert.equal(engine.query('match $f isa friendship;').rows.length, 0);
  });

  it('a delete names what the match bound, never a value — delete L1100', () => {
    assert.equal(refusal(() => engine.execute('match $p isa person, has ref 0; delete has name "Ann" of $p;')).code, DiagnosticCode.parseFailed);
  });
});
