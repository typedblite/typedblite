/**
 * Prepared statements are reused: the engine asks for `prepare(sql)` per row and per binding, and
 * the connection answers repeats from `cachingStatements` (`statement-cache.ts`). Before, listing
 * 7,000 observations with six `has $x` bindings prepared 42,000 statements.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { openNodeSqlite } from '../src/node-sqlite.js';
import type { SqliteDatabase, SqliteOpener } from '../src/sqlite-database.js';
import { cachingStatements } from '../src/statement-cache.js';

/** An opener that counts what reaches the real binding. */
const counting = (): { opener: SqliteOpener; prepares: () => number } => {
  let prepares = 0;
  const opener: SqliteOpener = (location) => {
    const db = openNodeSqlite(location);
    return new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => ((prepares += 1), target.prepare(sql));
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  return { opener, prepares: () => prepares };
};

describe('prepared statements are reused', () => {
  it('🔴 prepares a per-row statement once, not once per row', () => {
    const { opener, prepares } = counting();
    const db = new TypeDBLiteInterpreter(':memory:', 5000, { openDatabase: opener, trace: true });
    db.define('define entity person, owns name, owns email; attribute name, value string; attribute email, value string;');
    db.beginTransaction();
    for (let i = 0; i < 200; i++) db.execute(`insert $p isa person, has name "p${i}", has email "p${i}@x";`);
    db.commitTransaction();

    const query = 'match $p isa person, has name $n, has email $e; select $n, $e;';
    const before = prepares();
    assert.equal(db.query(query).rows.length, 200);
    const firstRun = prepares() - before;
    // The trace still counts what the engine ASKED for — one per row per binding, and more.
    const asked = db.lastQueryTrace()?.statementsPrepared ?? 0;
    assert.ok(asked >= 400, `the engine asked for ${asked} prepares`);
    assert.ok(firstRun < 50, `the binding prepared ${firstRun} statements for 200 rows`);

    const again = prepares();
    db.query(query);
    assert.equal(prepares() - again, 0, 'a repeated query prepares nothing new');
    db.close();
  });

  it('evicts the least recently used statement past its capacity', () => {
    const { opener, prepares } = counting();
    const db = cachingStatements(opener(':memory:'), 2);
    db.prepare('SELECT 1');
    db.prepare('SELECT 2');
    db.prepare('SELECT 1'); // now the most recent
    db.prepare('SELECT 3'); // evicts `SELECT 2`
    const before = prepares();
    db.prepare('SELECT 1');
    db.prepare('SELECT 3');
    assert.equal(prepares() - before, 0, 'the two most recent are still cached');
    db.prepare('SELECT 2');
    assert.equal(prepares() - before, 1, 'the evicted one is prepared again');
    db.close();
  });

  it('answers correctly from a cached statement after the schema changes under it', () => {
    const db = new TypeDBLiteInterpreter(':memory:');
    db.define('define entity person, owns name; attribute name, value string;');
    db.execute('insert $p isa person, has name "Ada";');
    const query = 'match $p isa person, has name $n; select $n;';
    assert.deepEqual(db.query(query).rows.map((r) => r['n']?.asString()), ['Ada']);
    db.define('define entity team, owns name; relation membership, relates member, relates team; person plays membership:member; team plays membership:team;');
    db.execute('insert $p isa person, has name "Grace";');
    assert.deepEqual(db.query(query).rows.map((r) => r['n']?.asString()), ['Ada', 'Grace']);
    db.close();
  });

  it('forwards what is not `prepare`: `isTransaction` is the binding\'s own', () => {
    const raw: SqliteDatabase = openNodeSqlite(':memory:');
    const db = cachingStatements(raw);
    assert.equal(db.isTransaction, false);
    db.exec('BEGIN');
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    db.close();
  });
});
