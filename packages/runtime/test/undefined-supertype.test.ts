import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `sub <unknown>` is refused, as TypeDB refuses it with `[SYR1] The type … was not found`.
 *
 * 🔴 It was applied silently. The interpreter parses without linking, so the parent named by a
 * `sub` was only ever a string, recorded into `schema.parents` and `type_parent` unchecked — and
 * every later `isa` on the child resolved through a parent that did not exist. Found 2026-09-11
 * by the conformance harness's own fixture (`d-20260911-define-accepts-a-supertype-that-does`).
 *
 * ⚠️ A parent defined LATER IN THE SAME `define` is fine — TypeDB resolves within the statement,
 * and so must this: the names are collected before the parents are checked.
 */
describe('a re-opened type must exist', () => {
  // Round 1 of the Phase 01 review: `nobody owns ref @key;` — a TypeExtensionDef naming a type the
  // schema never defined — was applied silently, writing schema_owns and a UNIQUE index for a
  // type that does not exist, and `insert $x isa nobody` then succeeded because `schema.types`
  // was still empty and checkKnown short-circuits on an empty set. TypeDB refuses it.
  it('refuses a re-open of an unknown type, and applies nothing', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    engine.define('define attribute ref, value integer; entity person;');
    assert.throws(() => engine.define('define nobody owns ref @key;'), /Unknown type 'nobody'/);
    assert.throws(() => engine.execute('insert $x isa nobody, has ref 1;'), /Unknown type 'nobody'/);
    engine.close();
  });

  it('accepts a re-open of an ATTRIBUTE — the spec writes `name @abstract;` and `email @independent;`', () => {
    // Round 2 of the Phase 01 review: the re-open check consulted only types, so an attribute
    // re-open — delete.feature:281, put.feature:454, define.feature:1095 — was refused as an
    // unknown type. An attribute is a type here too.
    const engine = new TypeDBLiteInterpreter(':memory:');
    engine.define('define attribute email, value string;');
    assert.doesNotThrow(() => engine.define('define email @independent;'));
    assert.doesNotThrow(() => engine.define('define attribute name, value string; name @abstract;'));
    engine.close();
  });

  it('refuses traits on an attribute re-open — an attribute owns, relates and plays nothing', () => {
    // Round 3 of the Phase 01 review: admitting attributes to the re-open check admitted every
    // trait with them, so `email owns name @key;` wrote schema_owns and a UNIQUE index on `name`
    // from a statement TypeDB refuses. Annotations on an attribute re-open are fine; traits are not.
    const engine = new TypeDBLiteInterpreter(':memory:');
    engine.define('define attribute email, value string; attribute name, value string;');
    let thrown: unknown;
    try {
      engine.define('define email owns name @key;');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /attribute 'email' cannot own/);
    // Not `unknownType`: the attribute is known, and a consumer branching on the code must not be
    // steered toward defining it.
    assert.equal(diagnosticOf(thrown)?.code, DiagnosticCode.traitOnAttribute);
    assert.throws(() => engine.define('define email relates x;'), /attribute 'email' cannot/);
    // Nothing applied: two names of the same value still insert.
    engine.define('define entity person, owns name;');
    engine.execute('insert $a isa person, has name "x"; $b isa person, has name "x";');
    engine.close();
  });

  it('accepts a re-open of a type defined earlier, or earlier in the same define', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    engine.define('define attribute ref, value integer; entity person;');
    assert.doesNotThrow(() => engine.define('define person owns ref @key;'));
    assert.doesNotThrow(() => engine.define('define entity company; company owns ref;'));
    engine.close();
  });
});

describe('a supertype must exist', () => {
  it('refuses an unknown parent with the unknown-type diagnostic, and applies nothing', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    engine.define('define entity person;');
    let thrown: unknown;
    try {
      engine.define('define entity writer sub nothing-of-the-kind;');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, 'the define must be refused');
    assert.match(thrown.message, /nothing-of-the-kind/);
    assert.equal(diagnosticOf(thrown)?.code, DiagnosticCode.unknownType);
    // Nothing applied: `writer` is not a type either — the refusal came before the DDL.
    assert.throws(() => engine.execute('insert $w isa writer;'), /Unknown type 'writer'/);
    engine.close();
  });

  it.each([
    ['entity', 'define entity person; entity writer sub person;'],
    ['entity, parent defined later in the same define', 'define entity writer sub person; entity person;'],
    ['relation', 'define relation r, relates x; relation s sub r;'],
    ['attribute', 'define attribute name, value string; attribute first-name sub name;'],
  ])('accepts a known parent — %s', (_label, schema) => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    assert.doesNotThrow(() => engine.define(schema));
    engine.close();
  });

  it('accepts a parent defined in an EARLIER define, in the same process and after a reopen', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    engine.define('define entity person;');
    assert.doesNotThrow(() => engine.define('define entity writer sub person;'));
    engine.close();
  });
});
