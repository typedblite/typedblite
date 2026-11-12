import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * `@key` and `@unique` hold among the instances of the type that declares them and its subtypes —
 * not across every owner of the attribute (insert.feature L1662–L1729; ADR-006 amendment).
 */
const SCHEMA = [
  'define',
  'attribute ref value integer;',
  'attribute email value string;',
  'entity base, owns ref @key, owns email @unique;',
  'entity derived-a sub base;',
  'entity derived-b sub base;',
  'entity other, owns ref @key, owns email;',
].join('\n');

let engine: TypeDBLiteInterpreter;
beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
});

const refused = (write: () => unknown): string | undefined => {
  try {
    write();
  } catch (error) {
    return diagnosticOf(error)?.code ?? 'error';
  }
  return undefined;
};

describe('a key is unique within its declaring type and that type\'s subtypes', () => {
  it('refuses a base and a derived sharing a key, and two siblings — L1671, L1704', () => {
    engine.execute('insert $x isa base, has ref 0;');
    assert.equal(refused(() => engine.execute('insert $y isa derived-a, has ref 0;')), DiagnosticCode.constraintViolated);
    engine.execute('insert $y isa derived-a, has ref 1;');
    assert.equal(refused(() => engine.execute('insert $z isa derived-b, has ref 1;')), DiagnosticCode.constraintViolated);
  });

  it('lets two owner types that each declare the key share a value', () => {
    engine.execute('insert $x isa base, has ref 0;');
    assert.equal(refused(() => engine.execute('insert $y isa other, has ref 0;')), undefined);
  });

  it('scopes @unique the same way, and leaves an ownership without it unconstrained', () => {
    engine.execute('insert $x isa base, has ref 0, has email "a@x";');
    assert.equal(refused(() => engine.execute('insert $y isa derived-b, has ref 1, has email "a@x";')), DiagnosticCode.constraintViolated);
    engine.execute('insert $y isa other, has ref 1, has email "a@x"; $z isa other, has ref 2, has email "a@x";');
  });
});

describe('a schema change rescopes what is stored', () => {
  it('refuses a new @unique the data repeats within its scope, and accepts one it does not', () => {
    engine.execute('insert $y isa other, has ref 1, has email "a@x"; $z isa other, has ref 2, has email "a@x";');
    engine.execute('insert $x isa base, has ref 0, has email "a@x";');
    assert.equal(refused(() => engine.define('define other owns email @unique;')) !== undefined, true);
    engine.execute('match $z isa other, has ref 2; delete $z;');
    assert.equal(refused(() => engine.define('define other owns email @unique;')), undefined);
  });
});
