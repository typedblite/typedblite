import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 An attribute subtype is a subtype. `attribute first-name sub name;` was accepted by `define`
 * and then forgotten: no parent recorded, no `type_parent` row, and `has name $n` answered zero
 * rows for a first-name where TypeDB 3.10.4 answers the row
 * (`d-20260911-an-attribute-subtype-is-accepted-by`, found by Phase 02's review on Phase 01's
 * lines, placed here by the digest).
 *
 * These are the record's claims, in the record's order: the read answers through the closure, the
 * closure survives a reopen (so it was written down, not merely remembered), and a subtype cannot
 * carry a value type its parent does not have — `define.feature` L1198.
 *
 * ⚠️ Ownership stays exact. TypeDB 3 needs `person owns first-name` to insert a first-name on a
 * person (`match.feature` L4063 declares every subtype's `owns`), so the schema below declares
 * both, and nothing here claims `owns name` admits `has first-name`.
 */
const SCHEMA = [
  'define',
  'attribute ref, value integer;',
  'attribute name, value string;',
  'attribute first-name sub name;',
  'entity person, owns ref @key, owns name, owns first-name;',
].join('\n');

describe('an attribute subtype is a subtype', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    engine.execute('insert $p isa person, has ref 0, has first-name "Alice";');
    engine.execute('insert $q isa person, has ref 1, has name "Bob";');
  });

  afterEach(() => engine.close());

  it('`has name $n` answers a first-name, with the cell carrying its actual type', () => {
    const { rows } = engine.query('match $p isa person, has name $n;');
    assert.equal(rows.length, 2, 'a name binding answers the first-name as well as the name');
    assert.deepEqual(
      rows.map((row) => row['n'].type).sort(),
      ['first-name', 'name'],
      'the cell says what the attribute actually is, not what the query asked for',
    );
  });

  it('`has name "Alice"` matches through the closure', () => {
    const { rows } = engine.query('match $p isa person, has name "Alice";');
    assert.equal(rows.length, 1, 'a literal on the parent type matches the subtype instance');
  });

  it('`has first-name $n` answers only the subtype', () => {
    const { rows } = engine.query('match $p isa person, has first-name $n;');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['n'].asString(), 'Alice');
  });
});

describe('the attribute parent is written down', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'typedblite-attribute-sub-'));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('survives a reopen — a fresh process answers through the closure too', () => {
    const path = join(directory, 'db.sqlite');
    const first = new TypeDBLiteInterpreter(path);
    first.define(SCHEMA);
    first.execute('insert $p isa person, has ref 0, has first-name "Alice";');
    first.close();

    // No `define` on reopen: what the first process wrote is all the second one has.
    const second = new TypeDBLiteInterpreter(path);
    try {
      const { rows } = second.query('match $p isa person, has name $n;');
      assert.equal(rows.length, 1, 'the parent chain was persisted, not held in one process');
      assert.equal(rows[0]['n'].type, 'first-name');
    } finally {
      second.close();
    }
  });
});

describe('a subtype takes its value type from its parent', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
  });

  afterEach(() => engine.close());

  it('refuses a different value type — define.feature L1198', () => {
    engine.define('define attribute name @abstract, value string; entity person @abstract;');
    assert.throws(
      () => engine.define('define attribute code-name sub name, value integer;'),
      /value type/,
      "`code-name sub name, value integer` under a string `name` is refused, as TypeDB refuses it",
    );
  });

  it('accepts the same value type restated, and a subtype with none', () => {
    engine.define('define attribute name @abstract, value string; entity person @abstract;');
    engine.define('define attribute code-name sub name, value string;');
    engine.define('define attribute nick-name sub name;');
  });

  it('refuses a value type on a subtype already applied without one — L1198, the third step', () => {
    engine.define('define attribute name @abstract, value string;');
    engine.define('define attribute code-name sub name;');
    assert.throws(() => engine.define('define attribute code-name value integer;'), /value type/);
  });

  it('refuses a new parent whose value type differs — L1198, the last step', () => {
    engine.define('define attribute name @abstract, value string; attribute code value integer;');
    assert.throws(() => engine.define('define attribute code sub name;'), /value type/);
  });

  it('refuses a re-declaration with a different value type, naming what is already defined — L2780', () => {
    engine.define('define attribute name value string;');
    assert.throws(
      () => engine.define('define attribute name value integer;'),
      /a different 'name value string' is already defined/,
    );
    engine.define('define attribute name value string;');
  });

  it('constrains nothing when no ancestor declares a value type', () => {
    engine.define('define attribute name @abstract;');
    engine.define('define attribute code-name sub name, value integer; attribute nick-name sub name, value string;');
  });
});
