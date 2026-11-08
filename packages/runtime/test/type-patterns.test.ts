import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * Type variables in `match` — Phase 05 of the conformance feature. Each `it` names the
 * match.feature line it answers; the conformance card is the acceptance suite, this is the unit
 * suite that says what each form answers, by label.
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute name value string;',
  'entity person owns ref @key, owns name, plays employment:employee;',
  'entity writer sub person;',
  'entity scifi-writer sub writer;',
  'relation employment relates employee, relates employer;',
  'relation part-time-employment sub employment;',
].join('\n');

const labels = (engine: TypeDBLiteInterpreter, query: string, variable = 'x'): string[] =>
  engine.query(query).rows.map((row) => row[variable].label).sort();

const refusal = (attempt: () => void): string | undefined => {
  try {
    attempt();
  } catch (error) {
    return String(diagnosticOf(error)?.code);
  }
  throw new Error('expected a refusal');
};

describe('type patterns', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute('insert $x isa person, has ref 0; $y isa writer, has ref 1;');
  });

  afterEach(() => engine.close());

  it('label matches the one type — L50', () => {
    assert.deepEqual(labels(engine, 'match $x label writer;'), ['writer']);
    const [cell] = engine.query('match $x label writer;').rows.map((r) => r['x']);
    assert.ok(cell.isType());
    assert.throws(() => cell.asString(), /Cannot extract string from type/);
  });

  it('sub is reflexive and transitive downward; sub! one step — L69', () => {
    assert.deepEqual(labels(engine, 'match $x sub person;'), ['person', 'scifi-writer', 'writer']);
    assert.deepEqual(labels(engine, 'match $x sub! person;'), ['writer']);
  });

  it('a label subject with sub $x answers the type and its ancestors — L90', () => {
    assert.deepEqual(labels(engine, 'match writer sub $x;'), ['person', 'writer']);
    assert.deepEqual(labels(engine, 'match scifi-writer sub! $x;'), ['writer']);
  });

  it('owns reads the schema, inherited included, both ways', () => {
    assert.deepEqual(labels(engine, 'match $x owns name;'), ['person', 'scifi-writer', 'writer']);
    assert.deepEqual(labels(engine, 'match person owns $x;'), ['name', 'ref']);
    assert.deepEqual(labels(engine, 'match writer owns $x;'), ['name', 'ref']);
  });

  it('plays reads the schema; a role type is labelled relation:role', () => {
    assert.deepEqual(labels(engine, 'match $x plays employment:employee;'), ['person', 'scifi-writer', 'writer']);
    assert.deepEqual(labels(engine, 'match person plays $x;'), ['employment:employee']);
  });

  it('relates answers the declaring relation and its subtypes — define.feature L515', () => {
    assert.deepEqual(labels(engine, 'match $x relates employee;'), ['employment', 'part-time-employment']);
    assert.deepEqual(labels(engine, 'match employment relates $x;'), ['employment:employee', 'employment:employer']);
    // An inherited role is the declaring relation's.
    assert.deepEqual(labels(engine, 'match part-time-employment relates $x;'), ['employment:employee', 'employment:employer']);
  });

  it('kind patterns filter the universe, with and without properties', () => {
    assert.deepEqual(labels(engine, 'match entity $x;'), ['person', 'scifi-writer', 'writer']);
    assert.deepEqual(labels(engine, 'match relation $x;'), ['employment', 'part-time-employment']);
    assert.deepEqual(labels(engine, 'match attribute $x;'), ['name', 'ref']);
    assert.deepEqual(labels(engine, 'match relation $x label employment;'), ['employment']);
    assert.deepEqual(labels(engine, 'match entity $x; $x owns name; $x plays employment:employee;'), ['person', 'scifi-writer', 'writer']);
  });

  it('isa $t binds the thing\'s own type and every ancestor when unbound, and reads it when bound — L842, L146', () => {
    const rows = engine.query('match $x isa $t;').rows;
    assert.deepEqual(rows.map((r) => `${r['x'].type}→${r['t'].label}`).sort(), ['person→person', 'writer→person', 'writer→writer']);
    assert.equal(engine.query('match $t label person; $x isa $t;').rows.length, 2, 'bound to person: the closure');
    assert.equal(engine.query('match $t label writer; $x isa $t;').rows.length, 1);
    // The two readings agree: `entity $t; $x isa $t` is the same set of (type, thing) pairs.
    assert.equal(engine.query('match entity $t; $x isa $t; select $x;').rows.length, 3);
    assert.equal(engine.query('match $x isa $t; entity $t;').rows.length, 3);
    // `isa!` — the own type only, whichever way round the patterns come (review, round 1).
    assert.deepEqual(engine.query('match $x isa! $t;').rows.map((r) => r['t'].label).sort(), ['person', 'writer']);
    assert.equal(engine.query('match $x has ref $r; $x isa! person;').rows.length, 1, 'isa! survives the merge');
    assert.equal(engine.query('match $x has ref $r; $x isa $t;').rows.length, 3, 'isa $t survives the merge');
  });

  it('a relation\'s type through a type variable — review round 1', () => {
    engine.execute('insert $p isa person, has ref 7; (employee: $p) isa employment; (employee: $p) isa part-time-employment;');
    assert.equal(engine.query('match $t label part-time-employment; $r isa $t, links (employee: $p); $p isa person;').rows.length, 1);
    const rows = engine.query('match $p isa person, has ref 7; $r isa $t, links (employee: $p);').rows;
    assert.deepEqual(rows.map((r) => r['t'].label).sort(), ['employment', 'employment', 'part-time-employment']);
  });

  it('a repeated sub narrows; contradictory labels or kinds answer nothing — review round 1', () => {
    assert.deepEqual(labels(engine, 'match $x sub writer; $x sub person;'), ['scifi-writer', 'writer']);
    assert.deepEqual(labels(engine, 'match $x sub person; $x sub employment;'), []);
    assert.deepEqual(labels(engine, 'match $x label person; $x label writer;'), []);
    assert.deepEqual(labels(engine, 'match entity $x; relation $x;'), []);
  });

  it('refuses a variable used as a type in one pattern and a thing in another, a thing property on a type subject, an unknown role, and a write through a type variable — review round 1', () => {
    assert.equal(refusal(() => engine.query('match $x sub person; $x has ref $r;')), DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.query('match person has name $n;')), DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.query('match $x plays employment:ceo;')), DiagnosticCode.unknownRole);
    assert.equal(refusal(() => engine.query('match $x relates ceo;')), DiagnosticCode.unknownRole);
    assert.equal(refusal(() => engine.execute('match $t label person; insert $x isa $t, has ref 9;')), DiagnosticCode.notImplemented);
    assert.equal(refusal(() => engine.execute('insert $x sub person;')), DiagnosticCode.notImplemented);
  });

  it('two isa on one variable are two filters, in either order — review round 2', () => {
    assert.equal(engine.query('match $x isa person; $x isa! writer;').rows.length, 1);
    assert.equal(engine.query('match $x isa! writer; $x isa person;').rows.length, 1);
    assert.deepEqual(engine.query('match $x isa $t; $x isa! writer;').rows.map((r) => r['t'].label).sort(), ['person', 'writer']);
    // The writer binds $t and $u independently (2 × 2), the person once: five rows, not none.
    assert.deepEqual(engine.query('match $x isa $t; $x isa $u; select $u;').rows.map((r) => r['u'].label).sort(), ['person', 'person', 'person', 'writer', 'writer']);
  });

  it('a variable used through isa $t and headed as a thing is refused, at the conflicting pattern — review round 2', () => {
    assert.equal(refusal(() => engine.query('match $x isa $t; $t isa person;')), DiagnosticCode.mixedPattern);
    try {
      engine.query('match $y isa writer; $x isa person; $x sub person;');
      assert.fail('expected a refusal');
    } catch (error) {
      assert.equal(diagnosticOf(error)?.range?.start.line, 0);
      assert.ok((diagnosticOf(error)?.range?.start.character ?? 0) > 'match $y isa writer; '.length - 1, 'points past the first pattern');
    }
  });

  it('a contradiction does not hide a typo — review round 2', () => {
    assert.equal(refusal(() => engine.query('match $x label person; $x label writer; $y sub nonexistent;')), DiagnosticCode.unknownType);
  });

  it('every isa is one filter or binding — on things, on relations, in one pattern or across — review round 3', () => {
    engine.execute('insert $p isa person, has ref 7; (employee: $p) isa employment; (employee: $p) isa part-time-employment;');
    // A relation's later `isa!` filters; its type variable binds.
    assert.equal(engine.query('match $r isa employment, links (employee: $y); $y isa person; $r isa! part-time-employment;').rows.length, 1);
    assert.deepEqual(engine.query('match $r isa employment, links (employee: $y); $y isa person; $r isa $t; select $t;').rows.map((r) => r['t'].label).sort(), ['employment', 'employment', 'part-time-employment']);
    // Ownership is checked whichever order the `isa` come in — a defined attribute person does not own.
    engine.define('define attribute reg-no value string; entity vehicle owns reg-no;');
    assert.equal(refusal(() => engine.query('match $x isa $t; $x isa person, has reg-no $p;')), DiagnosticCode.unownedAttribute);
    assert.equal(refusal(() => engine.query('match $x isa person, isa! vehicle, has ref $r;')), DiagnosticCode.unownedAttribute);
    assert.equal(refusal(() => engine.query('match $x isa! vehicle, isa person, has ref $r;')), DiagnosticCode.unownedAttribute);
    // A write names exactly one type (round 4), and a bound variable is not re-typed (round 5).
    assert.equal(refusal(() => engine.execute('put $q isa person, isa writer, has ref 6;')), DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.execute('insert $x isa person, has ref 8; $x isa writer;')), DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.execute('match $x isa person, has ref 0; insert $x isa writer, has name "n";')), DiagnosticCode.mixedPattern);
    assert.equal(engine.query('match $x isa person;').rows.length, 3, 'nothing was written by the refused statements');
    // Every type variable is projected without a select.
    assert.ok(engine.query('match $x isa person; $x isa $t;').rows.every((r) => r['t'] !== undefined && r['x'] !== undefined));
    // The same unbound type variable twice sees its own binding — no cross product.
    assert.equal(engine.query('match $x isa $t; $x isa $t;').rows.length, engine.query('match $x isa $t;').rows.length);
    assert.equal(engine.query('match $x isa $t; $x isa! $t;').rows.length, engine.query('match $x isa! $t;').rows.length);
    // Two `isa` inside one pattern are two filters too.
    assert.equal(engine.query('match $x isa! writer, isa person;').rows.length, 1);
  });

  it('isa! matches the exact type only — L899', () => {
    assert.equal(engine.query('match $x isa! person;').rows.length, 1);
    assert.equal(engine.query('match $x isa person;').rows.length, 2);
  });

  it('refuses an unknown label, and a variable used as both type and thing', () => {
    assert.equal(refusal(() => engine.query('match $x sub ghost;')), DiagnosticCode.unknownType);
    assert.equal(refusal(() => engine.query('match $x label ghost;')), DiagnosticCode.unknownType);
    assert.equal(refusal(() => engine.query('match $x sub person, has name $n;')), DiagnosticCode.mixedPattern);
    assert.equal(refusal(() => engine.query('match $x owns ghost;')), DiagnosticCode.unknownAttribute);
  });

  it('a select may name a type variable, and the projection is one type cell per binding', () => {
    const rows = engine.query('match $x sub person; select $x;').rows;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r['x'].isType()));
    assert.deepEqual(labels(engine, 'match person owns $a; select $a;', 'a'), ['name', 'ref']);
  });

  it('a type pattern with a compound of properties narrows', () => {
    assert.deepEqual(labels(engine, 'match $x label writer, owns $y;', 'y'), ['name', 'ref']);
    assert.deepEqual(labels(engine, 'match $x label part-time-employment, relates $r;', 'r'), ['employment:employee', 'employment:employer']);
  });
});
