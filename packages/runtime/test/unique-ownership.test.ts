import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';

/**
 * `@unique` is enforced — the test that lets it leave the validator's not-enforced list.
 *
 * It is `@key`'s UNIQUE index without the identity: a second owner of the same value is refused
 * at write, and putting `@unique` on an ownership whose existing rows repeat is refused at
 * `define` — TypeDB's *"data does not conform"* (`define.feature` L2949). ⚠️ Per attribute type,
 * as the `@key` index is; TypeDB's is per owner type. What a `@unique` value does NOT do is name
 * the thing: `keys-registered` counts `@key` only, and replication identity is unchanged.
 */
describe('@unique is enforced', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
  });

  afterEach(() => engine.close());

  it('refuses a second owner of the same value at write', () => {
    engine.define('define attribute ref value integer; attribute email value string; entity person owns ref @key, owns email @unique;');
    engine.execute('insert $p isa person, has ref 0, has email "a@x";');
    assert.throws(() => engine.execute('insert $p isa person, has ref 1, has email "a@x";'), /@unique.*email/);
    assert.equal(engine.query('match $p isa person;').rows.length, 1, 'the refused insert wrote nothing');
  });

  it('is not a key — nothing is registered for identity', () => {
    const report = engine.define('define attribute email value string; entity person owns email @unique;');
    const registered = report.diagnostics.find((d) => d.code === DiagnosticCode.keysRegistered);
    assert.match(registered?.message ?? '', /Registered 0 key/);
  });

  it('is refused at define when the existing data repeats — L2949', () => {
    engine.define('define attribute ref value integer; attribute name value string; entity person owns ref @key, owns name;');
    engine.execute('insert $p isa person, has ref 0, has name "Alice";');
    engine.execute('insert $p isa person, has ref 1, has name "Alice";');
    assert.throws(() => engine.define('define person owns name @unique;'), /does not conform.*'name'/);
    // And nothing of the refused statement stayed behind: the index does not exist, so a third
    // Alice is still accepted.
    engine.execute('insert $p isa person, has ref 2, has name "Alice";');
  });

  it('converting @unique to @key is refused when an owner holds no value, and accepted when every owner holds one — L3056', () => {
    engine.define('define attribute ref value integer; attribute phone value string; entity person owns ref @key, owns phone @unique;');
    engine.execute('insert $p isa person, has ref 0;');
    assert.throws(() => engine.define('define person owns phone @key;'), /do not hold exactly one 'phone'/);
    engine.execute('match $p isa person, has ref 0; insert $p has phone "1";');
    engine.define('define person owns phone @key;');
  });

  it('a restated @key over existing rows never refuses itself — how every repository opens', () => {
    const SCHEMA = 'define attribute ref value integer; entity person owns ref @key;';
    engine.define(SCHEMA);
    // `@key`'s cardinality is not enforced at insert: a person with no ref exists.
    engine.execute('insert $p isa person;');
    engine.define(SCHEMA);
  });
});
