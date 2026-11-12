import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * ADR-006 Decision 6: a store written before attributes were stored once per type and value keeps
 * them in `attr(owner, type, value)`, and is moved to `attribute` + `has` the first time it is
 * opened — in one transaction, with nothing lost, `@key`/`@unique` still enforced.
 *
 * The legacy layout is made by writing a store with this engine and then rewriting it into the old
 * tables with the old prelude's DDL, verbatim — so the test needs no second engine build, and the
 * store it migrates holds exactly what an older build would have written for the same statements.
 */
const SCHEMA = [
  'define',
  'attribute ref, value integer;',
  'attribute name, value string;',
  'attribute email, value string;',
  'entity person, owns ref @key, owns name, owns email @unique;',
].join('\n');

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const storePath = (): string => {
  directory = mkdtempSync(join(tmpdir(), 'typedblite-migrate-'));
  return join(directory, 'store.db');
};

/** Rewrite a current store into the pre-ADR-006 layout: `attr`, and its indexes on `attr(value)`. */
function downgrade(path: string): void {
  const db = new DatabaseSync(path);
  const indexes = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'has' AND (name LIKE 'key_%' OR name LIKE 'unique_%')")
    .all() as Array<{ name: string; sql: string }>;
  db.exec(`
    CREATE TABLE attr (
      owner INTEGER NOT NULL REFERENCES thing(iid) ON DELETE CASCADE,
      type  TEXT NOT NULL,
      value TEXT NOT NULL
    );
    CREATE INDEX attr_owner ON attr(owner);
    CREATE INDEX attr_lookup ON attr(type, value);
    INSERT INTO attr(owner, type, value)
      SELECT h.owner, v.type, v.value FROM has h JOIN attribute v ON v.id = h.attribute ORDER BY h.rowid;
    DROP TRIGGER attribute_created;
    DROP TRIGGER has_removed;
    DROP TABLE has;
    DROP TABLE attribute;
    DROP TABLE attribute_sweep;
  `);
  for (const index of indexes) db.exec(String(index.sql).replace('ON has(attribute)', 'ON attr(value)'));
  db.close();
}

const tables = (path: string): string[] => {
  const db = new DatabaseSync(path);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => String(r.name));
  db.close();
  return names;
};

const count = (path: string, sql: string): number => {
  const db = new DatabaseSync(path);
  const n = Number((db.prepare(sql).get() as { n: number }).n);
  db.close();
  return n;
};

const legacyStore = (): string => {
  const path = storePath();
  const engine = new TypeDBLiteInterpreter(path);
  engine.define(SCHEMA);
  engine.execute('insert $a isa person, has ref 1, has name "Ann", has email "ann@x";');
  engine.execute('insert $b isa person, has ref 2, has name "Ann", has email "bo@x";');
  engine.execute('insert $c isa person, has ref 3, has name "Cy";');
  engine.close();
  downgrade(path);
  return path;
};

describe('a store written before ADR-006 is migrated when it is opened', () => {
  it('starts in the legacy layout', () => {
    const path = legacyStore();
    assert.ok(tables(path).includes('attr'));
    assert.ok(!tables(path).includes('attribute'));
    assert.equal(count(path, 'SELECT COUNT(*) AS n FROM attr'), 8);
  });

  it('moves every value to one attribute and every row to one ownership, and drops attr', () => {
    const path = legacyStore();
    new TypeDBLiteInterpreter(path).close();
    assert.ok(!tables(path).includes('attr'));
    // Eight ownerships; seven distinct values, because both persons are named "Ann".
    assert.equal(count(path, 'SELECT COUNT(*) AS n FROM has'), 8);
    assert.equal(count(path, 'SELECT COUNT(*) AS n FROM attribute'), 7);
    assert.equal(count(path, "SELECT COUNT(*) AS n FROM attribute WHERE type = 'name' AND value = 'Ann'"), 1);
    assert.equal(count(path, 'SELECT COUNT(*) AS n FROM attribute_sweep'), 0);
  });

  it('answers what it answered before', () => {
    const path = legacyStore();
    const engine = new TypeDBLiteInterpreter(path);
    const rows = engine.query('match $p isa person, has ref $r, has name $n; select $r, $n; sort $r;').rows;
    const named = engine.query('match $p isa person, has name "Ann", has ref $r; select $r; sort $r;').rows;
    engine.close();
    assert.deepEqual(rows.map((row) => [row['r']?.asString(), row['n']?.asString()]), [['1', 'Ann'], ['2', 'Ann'], ['3', 'Cy']]);
    assert.deepEqual(named.map((row) => row['r']?.asString()), ['1', '2']);
  });

  it('still refuses a duplicate @key and a repeated @unique value', () => {
    const path = legacyStore();
    const engine = new TypeDBLiteInterpreter(path);
    const refusal = (query: string): unknown => {
      try {
        engine.execute(query);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const key = refusal('insert $d isa person, has ref 1;');
    const unique = refusal('insert $d isa person, has ref 4, has email "ann@x";');
    engine.close();
    assert.equal(diagnosticOf(key)?.code, DiagnosticCode.constraintViolated);
    assert.equal(diagnosticOf(unique)?.code, DiagnosticCode.constraintViolated);
  });

  it('is done once: reopening a migrated store changes nothing', () => {
    const path = legacyStore();
    new TypeDBLiteInterpreter(path).close();
    const before = [count(path, 'SELECT COUNT(*) AS n FROM has'), count(path, 'SELECT COUNT(*) AS n FROM attribute')];
    new TypeDBLiteInterpreter(path).close();
    assert.deepEqual([count(path, 'SELECT COUNT(*) AS n FROM has'), count(path, 'SELECT COUNT(*) AS n FROM attribute')], before);
  });

  it('leaves a store define never reached alone', () => {
    const path = storePath();
    new TypeDBLiteInterpreter(path).close();
    assert.ok(!tables(path).includes('attr'));
    assert.ok(!tables(path).includes('attribute'));
  });
});
