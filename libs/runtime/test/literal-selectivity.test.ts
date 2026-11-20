/**
 * Several `has` literals on one variable: the most selective drives, the others are probed.
 *
 * 🔴 Each literal used to be its own `t.iid IN (owners of the value)`, all materialized, so one value
 * owned by thousands of things set the cost of a match another literal pinned to a single row
 * (docs/development/performance.md, finding 5). `candidateQuery` now counts each value's owners (up
 * to 256), drives from the fewest, and probes the rest with `EXISTS`.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { openNodeSqlite } from '../src/node-sqlite.js';
import type { SqliteOpener } from '../src/sqlite-database.js';

const SCHEMA = 'define entity item, owns item-id @key, owns group, owns flag; attribute item-id, value string; attribute group, value string; attribute flag, value string;';

/** Records the parameters of every candidate lookup that probes a literal. */
const recording = (): { opener: SqliteOpener; probed: unknown[][] } => {
  const probed: unknown[][] = [];
  const opener: SqliteOpener = (location) => {
    const db = openNodeSqlite(location);
    return new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith('SELECT t.iid FROM thing t') || !sql.includes('EXISTS (SELECT 1 FROM attribute v')) return statement;
            return new Proxy(statement, {
              get(s, k) {
                const value = Reflect.get(s, k, s) as unknown;
                if (k === 'all') return (...args: unknown[]) => (probed.push(args), (value as (...a: unknown[]) => unknown).apply(s, args));
                return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(s) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  return { opener, probed };
};

const store = (opener?: SqliteOpener): TypeDBLiteInterpreter => {
  const db = new TypeDBLiteInterpreter(':memory:', 5000, opener === undefined ? {} : { openDatabase: opener });
  db.define(SCHEMA);
  db.beginTransaction();
  // 400 items share one group; every seventh carries a flag; insertion order is not id order.
  for (let k = 0; k < 400; k++) {
    const i = (k * 37) % 400;
    db.execute(`insert $i isa item, has item-id "i${i}", has group "common"${i % 7 === 0 ? ', has flag "x"' : ''};`);
  }
  db.commitTransaction();
  return db;
};

const ids = (db: TypeDBLiteInterpreter, text: string): string[] => db.query(text).rows.map((r) => r['id']?.asString() ?? '?');

describe('several literals on one variable', () => {
  it('🔴 drives from the selective literal whichever order they are written in', () => {
    const { opener, probed } = recording();
    const db = store(opener);
    for (const text of [
      'match $i isa item, has group "common", has item-id "i7", has item-id $id; select $id;',
      'match $i isa item, has item-id "i7", has group "common", has item-id $id; select $id;',
    ]) {
      probed.length = 0;
      assert.deepEqual(ids(db, text), ['i7']);
      // Parameters: the `isa` label, then the driving literal's attribute and value, then the probe's.
      assert.ok(probed.length > 0, 'the candidate lookup probed a literal');
      for (const args of probed) assert.equal(args[2], 'i7', `drove from ${String(args[2])}: ${text}`);
    }
    db.close();
  });

  it('answers the same rows, in the same order, as the selective literal alone', () => {
    const db = store();
    const flagged = ids(db, 'match $i isa item, has flag "x", has item-id $id; select $id;');
    assert.equal(flagged.length, 58);
    assert.deepEqual(ids(db, 'match $i isa item, has group "common", has flag "x", has item-id $id; select $id;'), flagged);
    assert.deepEqual(ids(db, 'match $i isa item, has flag "x", has group "common", has item-id $id; select $id;'), flagged);
    db.close();
  });

  it('answers nothing when one literal has no owner, and says so', () => {
    const db = store();
    const report = db.query('match $i isa item, has group "common", has flag "absent"; select $i;');
    assert.equal(report.rows.length, 0);
    assert.ok(report.diagnostics.some((d) => d.message.includes('matched 400 candidate(s) before')));
    db.close();
  });
});
