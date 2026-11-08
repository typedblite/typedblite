import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `@abstract` is enforced — the test that lets it leave the validator's not-enforced list.
 *
 * An abstract type has no direct instances: an insert of one is refused (`insert.feature` L199),
 * a concrete subtype inserts as usual, and `isa` still answers the subtype's instances for the
 * abstract parent. 🔴 This is also what lets `define` convert a type to abstract by looking at
 * its instances alone — no record of whether it was abstract before, which three review rounds
 * had guarded and each guard broke a neighbour. A restated `@abstract` finds no instances to
 * refuse on because none could have been inserted.
 */
describe('@abstract is enforced', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define('define attribute ref value integer; entity factory @abstract, owns ref @key; entity electronics-factory sub factory;');
  });

  afterEach(() => engine.close());

  it('refuses an instance of an abstract type — insert.feature L199', () => {
    try {
      engine.execute('insert $x isa factory, has ref 0;');
      assert.fail('expected a refusal');
    } catch (error) {
      assert.equal(diagnosticOf(error)?.code, DiagnosticCode.abstractType);
    }
    assert.equal(engine.query('match $x isa factory;').rows.length, 0, 'nothing was written');
  });

  it('inserts a concrete subtype, and the abstract parent answers it', () => {
    engine.execute('insert $x isa electronics-factory, has ref 0;');
    assert.equal(engine.query('match $x isa factory;').rows.length, 1);
  });

  it('a restated @abstract never refuses its own schema — how every repository opens', () => {
    engine.execute('insert $x isa electronics-factory, has ref 0;');
    engine.define('define entity factory @abstract;');
    engine.define('define factory @abstract;');
  });

  it('an attribute can be abstract too', () => {
    engine.define('define attribute name @abstract, value string; attribute first-name sub name; entity person owns ref @key, owns name, owns first-name;');
    engine.execute('insert $p isa person, has ref 1, has first-name "Al";');
    // The attribute is written through its owner; an abstract attribute type takes no value of its own.
    assert.throws(() => engine.execute('insert $p isa person, has ref 2, has name "Al";'), /abstract/);
  });
});
