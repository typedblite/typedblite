import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `redefine` — one statement, one change, and it must BE a change. Each `it` names the
 * `redefine.feature` line it answers; the conformance card is the acceptance suite, this is the
 * unit suite that says which rule fired, by code.
 */
const BACKGROUND = [
  'define',
  'entity person plays employment:employee, plays income:earner, owns name @card(0..) @regex("^.*$"), owns email @key, owns phone-nr @unique;',
  'relation employment relates employee @card(1..), plays income:source, owns start-date @card(0..), owns employment-reference-code @key;',
  'relation income relates earner, relates source;',
  'attribute name value string;',
  'attribute email value string @regex("^.*@.*$");',
  'attribute start-date value datetime;',
  'attribute employment-reference-code value string;',
  'attribute phone-nr value string;',
  'entity child sub person;',
  'entity empty-entity;',
].join('\n');

const refusal = (attempt: () => void): { code: string | undefined; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('redefine', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(BACKGROUND);
  });

  afterEach(() => engine.close());

  it('an empty redefine is valid — L46', () => {
    engine.define('redefine');
  });

  describe('a change, and only a change', () => {
    it('refuses what is stated as it is — "already defined" — L81, L147', () => {
      const r = refusal(() => engine.define('redefine entity person plays employment:employee;'));
      assert.equal(r.code, DiagnosticCode.nothingRedefined);
      const s = refusal(() => engine.define('redefine child sub person;'));
      assert.equal(s.code, DiagnosticCode.alreadyDefined);
      assert.match(s.message, /already defined/);
      const t = refusal(() => engine.define('redefine entity person owns name @card(0..);'));
      assert.equal(t.code, DiagnosticCode.alreadyDefined);
      // And one change at a time: two annotations in one redefine are refused (L1831).
      assert.match(refusal(() => engine.define('redefine entity person owns name @regex("^.*$") @card(0..);')).message, /one change/);
    });

    it('refuses what was never defined — "Try define instead" — L171, L289', () => {
      const r = refusal(() => engine.define('redefine person sub empty-entity;'));
      assert.equal(r.code, DiagnosticCode.notDefined);
      assert.match(r.message, /Try define instead/);
      const s = refusal(() => engine.define('redefine person owns start-date @card(0..1);'));
      assert.equal(s.code, DiagnosticCode.notDefined);
      assert.match(s.message, /Try define instead/);
      const t = refusal(() => engine.define('redefine entity person owns name @values("a");'));
      assert.equal(t.code, DiagnosticCode.notDefined);
    });

    it('changes an annotation, and the record says so', () => {
      engine.define('redefine entity person owns name @card(0..1);');
      const r = refusal(() => engine.define('redefine entity person owns name @card(0..1);'));
      assert.equal(r.code, DiagnosticCode.alreadyDefined);
      engine.define('redefine person owns name @regex("^[a-z]+$");');
    });

    it('refuses relates on an entity — L222', () => {
      assert.equal(refusal(() => engine.define('redefine entity child relates employee;')).code, DiagnosticCode.relatesOnNonRelation);
    });

    it('refuses a kind that does not match', () => {
      assert.equal(refusal(() => engine.define('redefine relation person owns name @card(0..1);')).code, DiagnosticCode.kindChanged);
    });
  });

  describe('sub', () => {
    it('changes a supertype, and the closure follows — L147', () => {
      engine.execute('insert $c isa child;'); // holding nothing the old parent gave
      engine.define('redefine child sub empty-entity;');
      assert.equal(engine.query('match $x isa person;').rows.length, 0, 'child is no longer a person');
      assert.equal(engine.query('match $x isa empty-entity;').rows.length, 1);
    });

    it('keeps the kind and the value-type rules — L892, L1009', () => {
      engine.define('define attribute code @abstract, value integer; attribute size @abstract, value string; attribute shoe-size sub code, value integer;');
      assert.equal(refusal(() => engine.define('redefine attribute shoe-size sub size;')).code, DiagnosticCode.valueTypeConflict);
      engine.define('define attribute abstract-integer @abstract, value integer;');
      engine.define('redefine attribute shoe-size sub abstract-integer;');
      assert.equal(refusal(() => engine.define('redefine child sub employment;')).code, DiagnosticCode.supertypeKind);
      assert.equal(refusal(() => engine.define('redefine person sub child;')).code, DiagnosticCode.notDefined, 'person has no supertype');
    });
  });

  describe('value', () => {
    it('changes a value type — L932, L1047', () => {
      engine.define('define attribute id value integer;');
      engine.define('redefine attribute id value string;');
      assert.equal(refusal(() => engine.define('redefine attribute id value string;')).code, DiagnosticCode.alreadyDefined);
    });

    it('refuses a value on a thing type — L327', () => {
      assert.equal(refusal(() => engine.define('redefine entity person value double;')).code, DiagnosticCode.valueTypeOnThing);
    });

    it('refuses a value type its subtype contradicts', () => {
      engine.define('define attribute base @abstract, value integer; attribute size sub base; attribute shoe-size sub size, value integer;');
      assert.equal(refusal(() => engine.define('redefine attribute base value double;')).code, DiagnosticCode.valueTypeConflict);
    });

    it('changes the value type\'s annotations', () => {
      engine.define('redefine attribute email value string @regex("^.+@.+$");');
      assert.equal(refusal(() => engine.define('redefine attribute email value string @regex("^.+@.+$");')).code, DiagnosticCode.alreadyDefined);
    });
  });

  describe('label', () => {
    it('renames a type everywhere, and refuses a label in use — L106', () => {
      engine.define('define entity cannot-rename-to; entity parent-of-rename; entity before-rename sub parent-of-rename, owns name; entity before-child sub before-rename;');
      const r = refusal(() => engine.define('redefine entity before-rename label cannot-rename-to;'));
      assert.equal(r.code, DiagnosticCode.duplicateLabel);
      assert.match(r.message, /Label 'cannot-rename-to' should be unique, but is already used by 'entity'/);
      engine.define('redefine entity before-rename label after-rename;');
      engine.execute('insert $x isa after-rename, has name "n";'); // the ownership followed the label
      assert.equal(engine.query('match $x isa parent-of-rename, has name $n;').rows.length, 1, 'still under its parent');
      engine.execute('insert $y isa before-child;'); // and the subtype still hangs under it
      assert.equal(engine.query('match $x isa after-rename;').rows.length, 2);
      engine.define('define entity after-child sub after-rename;');
      assert.equal(refusal(() => engine.query('match $x isa before-rename;')).code, DiagnosticCode.unknownType);
    });

    it('renames an attribute with its key index', () => {
      engine.define('redefine attribute email label e-mail;');
      engine.execute('insert $p isa person, has e-mail "a@x", has name "A";');
      assert.throws(() => engine.execute('insert $p isa person, has e-mail "a@x";'), /@unique.*e-mail/);
    });

    it('renames a role through its relation — L575', () => {
      engine.define('define relation relation-of-rename relates before-rename, relates sibling-role; entity before-player plays relation-of-rename:before-rename; relation child-of-rename sub relation-of-rename, relates child-role;');
      const r = refusal(() => engine.define('redefine relation-of-rename:before-rename label sibling-role;'));
      assert.equal(r.code, DiagnosticCode.roleRedeclared);
      assert.match(r.message, /Role name of 'relation-of-rename:sibling-role' should be unique in relation type hierarchy of 'relation-of-rename'/);
      const s = refusal(() => engine.define('redefine relation-of-rename:before-rename label child-role;'));
      assert.match(s.message, /Role name of 'child-of-rename:child-role' should be unique in relation type hierarchy of 'child-of-rename'/);
      engine.define('redefine relation-of-rename:before-rename label after-rename;');
      engine.define('define entity after-player plays relation-of-rename:after-rename;');
    });
  });

  describe('review round 1', () => {
    it('a role rename reaches the instances of sub-relations', () => {
      engine.define('define relation part-time-employment sub employment;');
      engine.execute('insert $p isa person, has email "p@x"; (employee: $p) isa part-time-employment;');
      engine.define('redefine employment:employee label worker;');
      assert.equal(engine.query('match $p isa person; $r isa part-time-employment, links (worker: $p);').rows.length, 1);
    });

    it('a type with instances or history keeps its label — identity is type/key', () => {
      engine.execute('insert $p isa person, has email "p@x";');
      const r = refusal(() => engine.define('redefine entity person label human;'));
      assert.equal(r.code, DiagnosticCode.hasInstances);
      engine.execute('match $p isa person; delete $p;');
      assert.equal(refusal(() => engine.define('redefine entity person label human;')).code, DiagnosticCode.hasInstances, 'the change log remembers');
      engine.define('redefine entity empty-entity label void-entity;');
    });

    it('a value type does not change over instances', () => {
      engine.execute('insert $p isa person, has email "p@x", has phone-nr "3";');
      assert.equal(refusal(() => engine.define('redefine attribute phone-nr value integer;')).code, DiagnosticCode.hasInstances);
    });

    it('a supertype change over instances that hold what the old one gave is refused', () => {
      engine.execute('insert $c isa child, has email "c@x", has name "C";');
      assert.equal(refusal(() => engine.define('redefine child sub empty-entity;')).code, DiagnosticCode.hasInstances);
    });

    it('a redefined annotation\'s arguments must fit', () => {
      engine.define('define attribute age value integer; person owns age @values(1, 2);');
      assert.equal(refusal(() => engine.define('redefine person owns age @values("x");')).code, DiagnosticCode.annotationArguments);
    });

    it('renaming a type does not touch a role of the same name', () => {
      engine.define('define entity parent; relation parentship relates parent @card(0..2);');
      engine.define('redefine entity parent label guardian;');
      assert.equal(refusal(() => engine.define('redefine parentship relates parent @card(0..2);')).code, DiagnosticCode.alreadyDefined, 'the relates annotation survived the rename');
    });
  });

  describe('review round 2', () => {
    it('a relation losing an ancestor loses its roles — refused over played instances', () => {
      engine.define('define relation empty-relation; relation part-time-employment sub employment;');
      engine.execute('insert $p isa person, has email "p@x"; (employee: $p) isa part-time-employment;');
      assert.equal(refusal(() => engine.define('redefine relation part-time-employment sub empty-relation;')).code, DiagnosticCode.hasInstances);
    });

    it('a value-type change counts stored values of subtypes too', () => {
      engine.define('define attribute code value string; attribute sub-code sub code; person owns sub-code;');
      engine.execute('insert $p isa person, has email "p@x", has sub-code "abc";');
      assert.equal(refusal(() => engine.define('redefine attribute code value integer;')).code, DiagnosticCode.hasInstances);
    });

    it('labels are case-sensitive in every LIKE', () => {
      engine.define('define entity Person; entity human;');
      engine.execute('insert $p isa person, has email "p@x";');
      engine.define('redefine entity Person label individual;'); // `person/…` history is not `Person`'s
    });

    it('a value-type change with annotations validates them against the NEW type', () => {
      engine.define('define attribute age value integer @values(1, 2);');
      engine.define('redefine attribute age value string @values("a", "b");');
    });

    it('a subtype that redeclares an ownership keeps it through a re-parenting', () => {
      engine.define('define entity worker sub child, owns name;');
      engine.execute('insert $w isa worker, has name "W";'); // holding only what worker owns itself
      engine.define('redefine child sub empty-entity;'); // worker still owns name itself
      assert.equal(engine.query('match $w isa worker, has name $n;').rows.length, 1);
    });

    it('an attribute with only an inherited value type is not re-parented over its values', () => {
      engine.define('define attribute code value string; attribute other value integer; attribute sub-code sub code; person owns sub-code;');
      engine.execute('insert $p isa person, has email "p@x", has sub-code "abc";');
      assert.equal(refusal(() => engine.define('redefine attribute sub-code sub other;')).code, DiagnosticCode.hasInstances);
      assert.equal(refusal(() => engine.define('undefine sub code from sub-code;')).code, DiagnosticCode.hasInstances);
    });
  });

  describe('review round 3', () => {
    it('re-parenting an attribute checks its descendants\' declared value types against the new parent', () => {
      engine.define('define attribute other value integer; attribute top @abstract, value string; attribute mid sub top; attribute leaf sub mid, value string;');
      // `mid` declares nothing; `leaf` below it declares string — re-parenting `mid` under integer is refused for `leaf`.
      assert.equal(refusal(() => engine.define('redefine attribute mid sub other;')).code, DiagnosticCode.valueTypeConflict);
    });

    it('names "no value type" rather than undefined, whichever side has none', () => {
      engine.define('define attribute code value string; attribute bare @abstract; attribute sub-code sub code; person owns sub-code;');
      engine.execute('insert $p isa person, has email "p@x", has sub-code "abc";');
      const r = refusal(() => engine.define('redefine attribute sub-code sub bare;'));
      assert.equal(r.code, DiagnosticCode.hasInstances);
      assert.match(r.message, /under 'string' and would take no value type from 'bare'/);
    });

    it('a subtype that restates its value type keeps its values out of the count — round 4', () => {
      engine.define('define attribute code @abstract, value string; attribute sub-code sub code, value string; person owns sub-code;');
      engine.execute('insert $p isa person, has email "p@x", has sub-code "abc";');
      engine.define('undefine value string from code;'); // sub-code keeps string; nothing is left untyped
      engine.define('define attribute code value string;');
      assert.equal(refusal(() => engine.define('redefine attribute code value integer;')).code, DiagnosticCode.valueTypeConflict, 'sub-code declares string — a conflict, not a data question');
      // And `bare` re-parented under `code` with a restating subtype holding values: nothing reinterpreted.
      engine.define('define attribute root @abstract; attribute bare @abstract, sub root; attribute restated sub bare, value string; person owns restated;');
      engine.execute('insert $q isa person, has email "q@x", has restated "x";');
      engine.define('define attribute strings @abstract, value string;');
      engine.define('redefine attribute bare sub strings;');
    });
  });

  it('a redefine survives a reopen — the tables are the record', () => {
    const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const directory = mkdtempSync(join(tmpdir(), 'typedblite-redefine-'));
    try {
      const path = join(directory, 'db.sqlite');
      const first = new TypeDBLiteInterpreter(path);
      first.define(BACKGROUND);
      first.define('redefine child sub empty-entity;');
      first.close();
      const second = new TypeDBLiteInterpreter(path);
      try {
        assert.equal(refusal(() => second.define('redefine child sub empty-entity;')).code, DiagnosticCode.alreadyDefined);
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
