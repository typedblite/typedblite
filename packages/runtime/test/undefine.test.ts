import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `undefine` — removes one thing, and refuses when instances, subtypes or inheritance stand in
 * the way. Each `it` names the `undefine.feature` line it answers; the conformance card is the
 * acceptance suite, this is the unit suite that says which rule fired, by code.
 *
 * 🔴 Data is never cascaded (founder, 2026-09-11): a schema statement that removed rows would be
 * the silent success ADR-018 D7 forbids. Deleting data is a write's job.
 */
const BACKGROUND = [
  'define',
  'entity person plays employment:employee, plays income:earner, owns name, owns email @key;',
  'relation employment relates employee, relates employer, plays income:source, owns start-date;',
  'relation income relates earner, relates source;',
  'attribute name value string;',
  'attribute email value string @regex("^.*@.*$");',
  'attribute start-date value datetime;',
  'entity child sub person;',
].join('\n');

const refusal = (attempt: () => void): { code: string | undefined; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('undefine', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(BACKGROUND);
  });

  afterEach(() => engine.close());

  it('an empty undefine is valid — L34', () => {
    engine.define('undefine');
  });

  describe('a type', () => {
    it('removes a type, and its capabilities with it — L92, L388', () => {
      engine.define('undefine child;');
      assert.equal(refusal(() => engine.query('match $x isa child;')).code, DiagnosticCode.unknownType);
      engine.define('define entity child;'); // and the label is free again
    });

    it('refuses a type with instances — "must be deleted" — L334, L678, L909', () => {
      engine.execute('insert $p isa person, has email "a@x", has name "A";');
      const s = refusal(() => engine.define('undefine person;'));
      assert.equal(s.code, DiagnosticCode.hasInstances);
      assert.match(s.message, /must be deleted/);
      const t = refusal(() => engine.define('undefine name;'));
      assert.equal(t.code, DiagnosticCode.hasInstances);
    });

    it('refuses a supertype with subtypes — L203', () => {
      assert.equal(refusal(() => engine.define('undefine person;')).code, DiagnosticCode.hasSubtypes);
    });

    it('refuses a type that does not exist', () => {
      assert.equal(refusal(() => engine.define('undefine ghost;')).code, DiagnosticCode.unknownType);
    });

    it('undefining a relation detaches its players — L727', () => {
      engine.define('undefine income;');
      // `person plays income:earner` is gone with the relation; the type may be re-defined bare.
      engine.define('define relation income relates earner;');
      engine.define('define person plays income:earner;');
    });
  });

  describe('a statement is atomic', () => {
    it('a refusal on the last line leaves the first lines unapplied — L566', () => {
      engine.execute('insert $p isa person, has email "h@x", has name "H"; (employee: $p) isa employment;');
      const r = refusal(() =>
        engine.define('undefine relates employer from employment; plays income:source from employment; employment;'),
      );
      assert.equal(r.code, DiagnosticCode.hasInstances);
      // `relates employer` and `plays income:source` are still there: restating them is a no-op define.
      assert.equal(refusal(() => engine.define('undefine @card from employment relates employer;')).code, DiagnosticCode.notDefined);
      engine.define('undefine plays income:source from employment;'); // still there to remove
    });

    it('the model is reloaded between lines — `sub` then the parent', () => {
      engine.define('undefine sub person from child; person;');
      assert.equal(refusal(() => engine.query('match $x isa person;')).code, DiagnosticCode.unknownType);
      engine.query('match $x isa child;');
    });
  });

  describe('sub', () => {
    it('removes the direct supertype, keeping the type — L136', () => {
      engine.define('undefine sub person from child;');
      engine.execute('insert $c isa child;');
      assert.equal(engine.query('match $x isa person;').rows.length, 0);
      assert.equal(engine.query('match $x isa child;').rows.length, 1);
    });

    it('refuses an indirect or absent supertype, in TypeDB\'s words — L117, L118, L130', () => {
      engine.define('define entity grandchild sub child;');
      const r = refusal(() => engine.define('undefine sub person from grandchild;'));
      assert.equal(r.code, DiagnosticCode.notDefined);
      assert.match(r.message, /there is no defined 'grandchild sub person', while/);
      const s = refusal(() => engine.define('undefine sub child from person;'));
      assert.match(s.message, /there is no defined 'person sub child'/);
    });
  });

  describe('a capability', () => {
    it('removes an ownership, and refuses one instances hold — L264, L1412', () => {
      engine.execute('insert $p isa person, has email "a@x", has name "A";');
      assert.equal(refusal(() => engine.define('undefine owns name from person;')).code, DiagnosticCode.hasInstances);
      engine.execute('match $p isa person, has name $n; delete $n of $p;');
      engine.define('undefine owns name from person;');
      assert.equal(refusal(() => engine.execute('insert $p isa person, has email "b@x", has name "B";')).code, DiagnosticCode.unownedAttribute);
    });

    it('refuses an inherited ownership — "not allowed" — L1351, L1444', () => {
      const r = refusal(() => engine.define('undefine owns name from child;'));
      assert.equal(r.code, DiagnosticCode.inheritedCapability);
      assert.match(r.message, /not allowed/);
    });

    it('refuses a capability that is not defined, in TypeDB\'s words — L246, L217, L588', () => {
      const r = refusal(() => engine.define('undefine owns start-date from person;'));
      assert.equal(r.code, DiagnosticCode.notDefined);
      assert.match(r.message, /there is no defined 'person owns start-date'/);
      assert.equal(refusal(() => engine.define('undefine plays employment:employer from person;')).code, DiagnosticCode.notDefined);
      assert.equal(refusal(() => engine.define('undefine relates mentor from employment;')).code, DiagnosticCode.notDefined);
    });

    it('removes a plays, and refuses one instances use — L1214, L1276', () => {
      engine.execute('insert $p isa person, has email "a@x"; (employee: $p) isa employment;');
      assert.equal(refusal(() => engine.define('undefine plays employment:employee from person;')).code, DiagnosticCode.hasInstances);
      engine.define('undefine plays income:earner from person;');
    });

    it('removes a role, detaching its players, and refuses one played — L964, L1086, L1059', () => {
      engine.execute('insert $p isa person, has email "a@x"; (employee: $p) isa employment;');
      assert.equal(refusal(() => engine.define('undefine relates employee from employment;')).code, DiagnosticCode.hasInstances);
      engine.define('undefine relates employer from employment;');
      assert.equal(refusal(() => engine.define('define person plays employment:employer;')).code, DiagnosticCode.unknownRole);
    });

    it('removes a key ownership and its index — L1365', () => {
      engine.define('undefine owns email from person;');
      engine.define('define person owns email;');
      engine.execute('insert $p isa person, has email "same";');
      engine.execute('insert $p isa person, has email "same";'); // no longer unique
    });
  });

  describe('a value type', () => {
    it('removes it, and refuses when instances exist — L886, L845', () => {
      assert.equal(refusal(() => engine.define('undefine value integer from name;')).code, DiagnosticCode.notDefined);
      engine.execute('insert $p isa person, has email "a@x", has name "A";');
      assert.equal(refusal(() => engine.define('undefine value string from name;')).code, DiagnosticCode.hasInstances);
      engine.execute('match $p isa person, has name $n; delete $n of $p;');
      engine.define('undefine value string from name;');
    });
  });

  describe('an annotation', () => {
    it('removes one, and refuses one that is not there — "no defined" — L1514, L858', () => {
      engine.define('define entity player @abstract;');
      engine.define('undefine @abstract from player;');
      engine.execute('insert $x isa player;'); // no longer abstract
      const r = refusal(() => engine.define('undefine @abstract from player;'));
      assert.equal(r.code, DiagnosticCode.notDefined);
      assert.match(r.message, /no defined/);
      engine.define('undefine @regex from email value string;');
      assert.equal(refusal(() => engine.define('undefine @regex from email value string;')).code, DiagnosticCode.notDefined);
    });

    it('removes @key, and the index goes with it', () => {
      engine.define('undefine @key from person owns email;');
      engine.execute('insert $p isa person, has email "same";');
      engine.execute('insert $p isa person, has email "same";');
    });

    it('refuses an annotation the type could never carry — "Illegal annotation" — L858', () => {
      const r = refusal(() => engine.define('undefine @regex from email;'));
      assert.equal(r.code, DiagnosticCode.annotationNotAdmitted);
      assert.match(r.message, /Illegal annotation/);
    });

    it('refuses an annotation on an inherited capability — L1458', () => {
      assert.equal(refusal(() => engine.define('undefine @key from child owns email;')).code, DiagnosticCode.inheritedCapability);
    });
  });

  describe('review round 1', () => {
    it('@unique undefined from one owner keeps the index another owner still declares', () => {
      engine.define('define attribute code value string; entity a owns code @unique; entity b owns code @unique;');
      engine.define('undefine @unique from a owns code;');
      engine.execute('insert $x isa b, has code "same";');
      assert.throws(() => engine.execute('insert $y isa b, has code "same";'), /@unique/);
      engine.define('undefine @unique from b owns code;');
      engine.execute('insert $y isa b, has code "same";');
    });

    it('a supertype removed over instances that hold what it gave is refused', () => {
      engine.execute('insert $c isa child, has email "c@x", has name "C";');
      assert.equal(refusal(() => engine.define('undefine sub person from child;')).code, DiagnosticCode.hasInstances);
      engine.execute('match $c isa child; delete $c;');
      engine.define('undefine sub person from child;');
    });

    it('a value type is not undefined over a subtype\'s stored values — round 3', () => {
      engine.define('define attribute code value string; attribute sub-code sub code; person owns sub-code;');
      engine.execute('insert $p isa person, has email "p@x", has sub-code "abc";');
      assert.equal(refusal(() => engine.define('undefine value string from code;')).code, DiagnosticCode.hasInstances);
    });

    it('a label with an underscore is not a wildcard', () => {
      engine.define('define entity a_b plays employment:employee; entity axb plays employment:employee @card(0..1);');
      engine.define('undefine a_b;');
      engine.define('undefine @card from axb plays employment:employee;'); // still recorded, so removable
    });
  });

  it('role specialisation is not this engine\'s — refused by name', () => {
    assert.equal(refusal(() => engine.define('undefine as employee from employment relates employer;')).code, DiagnosticCode.notImplemented);
  });
});
