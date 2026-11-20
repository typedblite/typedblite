import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';
import { diagnosticOf } from '../src/diagnostics.js';

/**
 * The schema rules TypeDB applies at `define` — `schema-rules.ts`, one `it` per rule, each
 * naming the `define.feature` line it answers. The conformance card is the acceptance suite; this
 * is the unit suite that says which rule fired, by code, so a rule that stops firing is a red test
 * here before it is a lower number there.
 */
const BACKGROUND = [
  'define',
  'entity person plays employment:employee, owns name, owns email @key;',
  'relation employment relates employee, owns start-date;',
  'attribute name value string;',
  'attribute email value string;',
  'attribute start-date value datetime;',
].join('\n');

const refusal = (attempt: () => void): { code: string | undefined; message: string } => {
  try {
    attempt();
  } catch (error) {
    return { code: String(diagnosticOf(error)?.code), message: (error as Error).message };
  }
  throw new Error('expected a refusal');
};

describe('define refuses what TypeDB refuses', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(BACKGROUND);
  });

  afterEach(() => engine.close());

  describe('what may be owned, played and related', () => {
    it('owns an unknown attribute — L132', () => {
      const r = refusal(() => engine.define('define entity book owns pages;'));
      assert.equal(r.code, DiagnosticCode.unknownAttribute);
    });

    it('owns an entity or a relation — L139, L146, L167', () => {
      assert.equal(refusal(() => engine.define('define entity house owns person;')).code, DiagnosticCode.ownsNotAttribute);
      assert.equal(refusal(() => engine.define('define entity company owns employment;')).code, DiagnosticCode.ownsNotAttribute);
      assert.equal(refusal(() => engine.define('define entity passport owns person @key;')).code, DiagnosticCode.ownsNotAttribute);
    });

    it('plays a role of an unknown relation, or a role the relation does not declare — L153', () => {
      assert.equal(refusal(() => engine.define('define entity house plays constructed:something;')).code, DiagnosticCode.unknownType);
      assert.equal(refusal(() => engine.define('define entity house plays employment:ceo;')).code, DiagnosticCode.unknownRole);
    });

    it('plays an inherited role via the subtype — L770', () => {
      const r = refusal(() =>
        engine.define('define relation part-time-employment sub employment; person plays part-time-employment:employee;'),
      );
      assert.equal(r.code, DiagnosticCode.unknownRole);
      assert.match(r.message, /employment:employee/);
    });

    it('relates on an entity — L2852', () => {
      assert.equal(refusal(() => engine.define('define person relates employee;')).code, DiagnosticCode.relatesOnNonRelation);
    });

    it('re-declares an inherited role — L1003, with the message the scenario matches on', () => {
      engine.define('define relation parentship relates parent; relation fathership sub parentship, relates father;');
      const r = refusal(() => engine.define('define fathership relates parent;'));
      assert.equal(r.code, DiagnosticCode.roleRedeclared);
      assert.match(r.message, /'parentship:parent' should be unique in relation type hierarchy/);
    });

    it('a relation subtype may declare a new role of its own', () => {
      engine.define('define relation part-time-employment sub employment, relates contractor;');
    });
  });

  describe('a label keeps its kind — L2610, L2619, L2626', () => {
    it.each([
      ['define relation person relates body-part;'],
      ['define attribute employment value string;'],
      ['define entity name;'],
    ])('%s', (text) => {
      assert.equal(refusal(() => engine.define(text)).code, DiagnosticCode.kindChanged);
    });
  });

  describe('a supertype changes by redefine only', () => {
    it('refuses a switch, with or without instances — L3197, L3263, L3337', () => {
      engine.define('define entity bird; entity pigeon sub bird; entity animal;');
      assert.equal(refusal(() => engine.define('define entity pigeon sub animal;')).code, DiagnosticCode.supertypeChanged);
      engine.execute('insert $p isa pigeon;');
      assert.equal(refusal(() => engine.define('define pigeon sub animal;')).code, DiagnosticCode.supertypeChanged);
    });

    it('accepts a first parent on a parentless type, and the same parent restated', () => {
      engine.define('define entity parent @abstract; person sub parent;');
      engine.define('define entity person sub parent;');
    });

    it('refuses a cycle — L3474, L3467', () => {
      engine.define('define entity giant sub person; entity green-giant sub giant;');
      // `person` already has no parent, so this is a first assignment — and a cycle.
      assert.equal(refusal(() => engine.define('define entity person sub green-giant;')).code, DiagnosticCode.cyclicHierarchy);
      assert.equal(refusal(() => engine.define('define entity dog sub dog;')).code, DiagnosticCode.cyclicHierarchy);
      // In one statement, the definition that closes the loop is the one named — not the first
      // member of it.
      const r = refusal(() =>
        engine.define('define entity a sub b; entity b sub c; entity c sub a;'),
      );
      assert.equal(r.code, DiagnosticCode.cyclicHierarchy);
      assert.match(r.message, /'c sub a'/);
    });
  });

  describe('the data must conform', () => {
    it('@abstract on a type with instances — L3142, L3159, L3177', () => {
      engine.execute('insert $p isa person, has email "a", has name "Al";');
      assert.equal(refusal(() => engine.define('define person @abstract;')).code, DiagnosticCode.abstractWithInstances);
      assert.equal(refusal(() => engine.define('define name @abstract;')).code, DiagnosticCode.abstractWithInstances);
      // A subtype's instances are not the parent's own: `entity writer sub creator` with a writer
      // leaves `creator` abstract-able. (An abstract type under a concrete one is refused — L2366.)
      engine.define('define entity creator, owns name; entity writer sub creator;');
      engine.execute('insert $w isa writer, has name "b";');
      engine.define('define creator @abstract;');
    });

    it('@key on an ownership whose data repeats — L2735, with a diagnostic and nothing half-applied', () => {
      engine.define('define attribute barcode value string; entity product owns name, owns barcode;');
      engine.execute('insert $x isa product, has name "Cheese", has barcode "10000"; $y isa product, has name "Ham", has barcode "10000";');
      const r = refusal(() => engine.define('define product owns barcode @key; entity leftover;'));
      assert.equal(r.code, DiagnosticCode.dataDoesNotConform);
      assert.match(r.message, /'barcode'/);
      assert.equal(refusal(() => engine.query('match $l isa leftover;')).code, DiagnosticCode.unknownType, 'the rolled-back statement defined nothing');
    });
  });

  describe('owns arguments fit the attribute — L1622', () => {
    it.each([
      ['define attribute description value integer; entity player owns description @regex("A");', /constrains a string/],
      ['define attribute description; entity player owns description @values(0);', /no value type/],
      ['define attribute description value integer; entity player owns description @values("A", 2);', /a string \("A"\)/],
      ['define attribute description value string; entity player owns description @range(1..2);', /an integer \(1\)/],
      ['define attribute description value duration; entity player owns description @values("year");', /a string \("year"\)/],
    ])('%s', (text, message) => {
      const r = refusal(() => engine.define(text));
      assert.equal(r.code, DiagnosticCode.annotationArguments);
      assert.match(r.message, message);
    });

    it('reads the value type through the attribute hierarchy', () => {
      engine.define('define attribute code @abstract, value integer; attribute door-code sub code;');
      assert.equal(
        refusal(() => engine.define('define entity house owns door-code @regex("A");')).code,
        DiagnosticCode.annotationArguments,
      );
      engine.define('define entity flat owns door-code @range(1..9);');
    });
  });

  describe('review round 1 — the rules read the statement so far, and what is restated is not new', () => {
    it('a restated @abstract never refuses its own schema — how every repository opens', () => {
      // Since round 4 an instance of an abstract type cannot get in at all (`abstract-types.test.ts`),
      // which is what makes a restatement indistinguishable from nothing: no instances, no refusal.
      engine.define('define entity ghost @abstract; entity poltergeist sub ghost;');
      engine.execute('insert $g isa poltergeist;');
      engine.define('define entity ghost @abstract;');
      engine.define('define ghost @abstract;');
    });

    it('a parent gaining a value type is checked against its subtypes', () => {
      engine.define('define attribute code @abstract; attribute door-code sub code, value integer;');
      assert.equal(refusal(() => engine.define('define attribute code value string;')).code, DiagnosticCode.valueTypeConflict);
      engine.define('define attribute code value integer;');
    });

    it('a value-type conflict inside one statement is refused, whichever way round', () => {
      assert.equal(
        refusal(() => engine.define('define attribute color value string; color value integer;')).code,
        DiagnosticCode.valueTypeConflict,
      );
      assert.equal(
        refusal(() => engine.define('define attribute size value integer; attribute size-code sub size, value string;')).code,
        DiagnosticCode.valueTypeConflict,
      );
    });

    it('a supertype switch inside one statement is a switch', () => {
      engine.define('define entity a; entity b;');
      assert.equal(refusal(() => engine.define('define entity c sub a; c sub b;')).code, DiagnosticCode.supertypeChanged);
      engine.define('define entity c sub a; c sub a;');
    });

    it('a parent is of its child\'s kind', () => {
      assert.equal(refusal(() => engine.define('define entity contractor sub employment;')).code, DiagnosticCode.supertypeKind);
      assert.equal(refusal(() => engine.define('define person sub employment;')).code, DiagnosticCode.supertypeKind);
      assert.equal(refusal(() => engine.define('define relation contract sub person, relates side;')).code, DiagnosticCode.supertypeKind);
      assert.equal(refusal(() => engine.define('define attribute nick sub person;')).code, DiagnosticCode.unknownAttribute);
      engine.define('define relation contract sub employment;');
    });

    it('a second owner type taking @key on an already-keyed attribute is checked against its own instances', () => {
      engine.define('define entity company owns email;');
      engine.execute('insert $c isa company;');
      // `email` is already `person`'s key; `company owns email @key` is new for company.
      assert.equal(refusal(() => engine.define('define company owns email @key;')).code, DiagnosticCode.dataDoesNotConform);
      // And a restated key ownership over a keyless instance is not new.
      engine.execute('insert $p isa person;');
      engine.define('define person owns email @key;');
    });
  });

  describe('review rounds 2–4 — a database from before this phase reopens and re-defines', () => {
    const legacy = (run: (path: string) => void): void => {
      const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
      const { tmpdir } = require('node:os') as typeof import('node:os');
      const { join } = require('node:path') as typeof import('node:path');
      const directory = mkdtempSync(join(tmpdir(), 'typedblite-legacy-'));
      try {
        run(join(directory, 'db.sqlite'));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };

    it('a restated @key over a keyless owner from before schema_key_owns is not a conversion, in any number of statements', () => {
      legacy((path) => {
        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
        const SCHEMA = 'define attribute ref value integer; entity person owns ref @key;';
        const first = new TypeDBLiteInterpreter(path);
        first.define(SCHEMA);
        first.execute('insert $p isa person;'); // `@key`'s cardinality is not enforced at insert.
        first.close();
        // What a database written before this phase looks like: the table does not exist.
        const raw = new DatabaseSync(path);
        raw.exec('DROP TABLE schema_key_owns;');
        raw.close();

        const second = new TypeDBLiteInterpreter(path);
        try {
          // Refused on every open before round 2; refused again after a first statement before
          // round 3; refused when the restatement was the FIRST statement before round 5, because
          // the backfill ran after the rules. The ownerships are derived at open and written
          // down by whichever define comes first.
          second.define(SCHEMA);
          second.define('define person owns ref @key;');
        } finally {
          second.close();
        }
        // And the persistence itself: an older database whose first define after reopen does NOT
        // restate the key — so the table is created and filled only by the derivation — and a
        // later process restates it. Without the persist loop this reopen is the round-2 refusal.
        const raw2 = new DatabaseSync(path);
        raw2.exec('DROP TABLE schema_key_owns;');
        raw2.close();
        const third = new TypeDBLiteInterpreter(path);
        try {
          third.define('define entity bystander;');
        } finally {
          third.close();
        }
        const fourth = new TypeDBLiteInterpreter(path);
        try {
          fourth.define(SCHEMA);
        } finally {
          fourth.close();
        }
      });
    });

    it('a second owner taking @key on an already-keyed attribute is checked after a reopen too — round 4', () => {
      legacy((path) => {
        const first = new TypeDBLiteInterpreter(path);
        first.define('define attribute email value string; entity person owns email @key; entity company owns email;');
        first.execute('insert $c isa company;');
        first.close();
        const second = new TypeDBLiteInterpreter(path);
        try {
          // `email` is person's key and company's plain ownership; the key is new for company.
          assert.equal(refusal(() => second.define('define company owns email @key;')).code, DiagnosticCode.dataDoesNotConform);
        } finally {
          second.close();
        }
      });
    });

    it('a same-statement subtype with the wrong value type is refused at its own line, not the parent\'s', () => {
      const r = refusal(() => engine.define('define attribute size value integer; attribute size-code sub size, value string;'));
      assert.equal(r.code, DiagnosticCode.valueTypeConflict);
      assert.match(r.message, /'size-code sub size' cannot have value type 'string'/);
    });

    it('a conflict through a parent chain completed later in the statement is still refused — round 3', () => {
      engine.define('define attribute z value integer;');
      assert.equal(
        refusal(() => engine.define('define attribute x sub y, value string; attribute y sub z;')).code,
        DiagnosticCode.valueTypeConflict,
      );
      assert.equal(
        refusal(() => engine.define('define attribute x2 sub y2, value string; attribute y2 sub z2; attribute z2 value integer;')).code,
        DiagnosticCode.valueTypeConflict,
      );
      // And a parent GAINING a parent over an applied subtype: `y sub z` with x: string below y.
      engine.define('define attribute y3; attribute x3 sub y3, value string;');
      assert.equal(refusal(() => engine.define('define y3 sub z;')).code, DiagnosticCode.valueTypeConflict);
      engine.define('define attribute s value string; y3 sub s;');
    });
  });

  describe('a re-open is checked against the kind it names', () => {
    it('@independent on a re-opened entity', () => {
      assert.equal(refusal(() => engine.define('define person @independent;')).code, DiagnosticCode.annotationNotAdmitted);
      engine.define('define name @independent;');
    });

    it('value on a re-opened entity — the re-open form of L392', () => {
      assert.equal(refusal(() => engine.define('define person value string;')).code, DiagnosticCode.valueTypeOnThing);
    });
  });
});
