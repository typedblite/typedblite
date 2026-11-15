/**
 * The full-text index is maintained by rowid, through `entity_fts_key`, never by scanning it.
 *
 * 🔴 `entity_fts.entity_id` is UNINDEXED, so the old `DELETE FROM entity_fts WHERE entity_id = ?`
 * scanned the whole index on every write — half an insert's CPU, growing with the store (19 ms per
 * write at 150,000 entities; docs/development/performance.md). These tests hold the replacement
 * to the old answers, including on a store an older engine wrote to: a downstream application loads this
 * checkout's build and restarts its processes one at a time, so a store sees both.
 */
import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { openNodeSqlite } from '../src/node-sqlite.js';
import type { SqliteDatabase } from '../src/sqlite-database.js';

const SCHEMA = readFileSync(fileURLToPath(new URL('../../../test-fixtures/schemas/document-store.schema.typeqlite', import.meta.url)), 'utf8');
const dirs: string[] = [];
const tempStore = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'typedblite-fts-key-'));
  dirs.push(dir);
  return join(dir, 'store.db');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const add = (db: TypeDBLiteInterpreter, id: string, body: string): void => {
  db.execute(`insert $d isa document, has doc-id "${id}", has doc-title "T", has doc-kind "note", has doc-path "p.md", has doc-body "${body}";`);
};
const replace = (db: TypeDBLiteInterpreter, id: string, body: string): void => {
  db.execute(`match $d isa document, has doc-id "${id}"; delete $d;`);
  add(db, id, body);
};
const hits = (db: TypeDBLiteInterpreter, query: string): string[] => db.changeLog.fullText.search(query).map((h) => h.entityId).sort();
/** Index rows per entity, read straight from the file: what search would double-count. */
const rowsPerEntity = (path: string): Record<string, number> => {
  const raw = new DatabaseSync(path, { readOnly: true });
  const rows = raw.prepare('SELECT entity_id, count(*) AS n FROM entity_fts GROUP BY entity_id').all() as Array<{ entity_id: string; n: number }>;
  raw.close();
  return Object.fromEntries(rows.map((r) => [r.entity_id, Number(r.n)]));
};
/** What the engine before `entity_fts_key` did to index an entity: delete by scan, insert without a rowid. */
const olderEngineIndexes = (path: string, entityId: string, text: string): void => {
  const raw = new DatabaseSync(path);
  raw.prepare('DELETE FROM entity_fts WHERE entity_id = ?').run(entityId);
  raw.prepare(`INSERT INTO entity_fts(entity_id, doctype, status, tags, text) VALUES (?, 'document', '', '', ?)`).run(entityId, text);
  raw.close();
};

// Inspects the file through a second `DatabaseSync`, or forges what an older engine wrote: a binding
// limit under WASM, where the store is memdb (vitest.wasm.config.ts). The portable test runs there.
const onFile = it.skipIf(process.env['TYPEDBLITE_SQLITE'] === 'wasm');

describe('the full-text index is maintained by rowid', () => {
  onFile('🔴 no statement a write prepares scans the index', () => {
    const path = tempStore();
    const prepared = new Set<string>();
    const recording = (location: string): SqliteDatabase => {
      const db = openNodeSqlite(location);
      return new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return (sql: string) => (prepared.add(sql), target.prepare(sql));
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    // Every SQL text the run prepares, from the first write on: the recorder sits beneath the
    // statement cache (`statement-cache.ts`), which prepares each distinct text once.
    const db = new TypeDBLiteInterpreter(path, 5000, { openDatabase: recording });
    db.define(SCHEMA);
    for (let i = 0; i < 20; i++) add(db, `doc-${i}`, `body ${i}`);
    replace(db, 'doc-3', 'rewritten');
    add(db, 'doc-new', 'fresh');
    db.execute('match $d isa document, has doc-id "doc-7"; delete $d;');
    db.close();

    const plans = new DatabaseSync(path, { readOnly: true });
    const touching = [...prepared].filter((sql) => /\bentity_fts\b/.test(sql));
    assert.ok(touching.length >= 3, `expected the write path to touch entity_fts: ${touching.join(' | ')}`);
    for (const sql of touching) {
      const parameters = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 1);
      const plan = (plans.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>).map((r) => r.detail);
      // FTS5's plan names its strategy: `INDEX 0:` with nothing after it is a full scan; `0:=` is a
      // rowid lookup and `192:` the rowid-ordered `LIMIT 1`.
      assert.ok(!plan.some((d) => /^SCAN entity_fts VIRTUAL TABLE INDEX 0:$/.test(d)), `scans the index: ${sql} → ${plan.join('; ')}`);
    }
    plans.close();
  });

  it('replaces an entity on re-index and removes it on delete', () => {
    const db = new TypeDBLiteInterpreter();
    db.define(SCHEMA);
    add(db, 'a', 'original wording');
    add(db, 'b', 'other wording');
    replace(db, 'a', 'revised wording');
    assert.deepEqual(hits(db, 'original'), []);
    assert.deepEqual(hits(db, 'revised'), ['document/a']);
    assert.deepEqual(hits(db, 'wording'), ['document/a', 'document/b']);
    db.execute('match $d isa document, has doc-id "b"; delete $d;');
    assert.deepEqual(hits(db, 'wording'), ['document/a']);
    assert.equal(db.changeLog.fullText.count(), 1, 'one index row, for the one document left');
    db.close();
  });

  onFile('🔴 gives a store indexed before the key table its keys, without a duplicate', () => {
    const path = tempStore();
    const db = new TypeDBLiteInterpreter(path);
    db.define(SCHEMA);
    for (const id of ['a', 'b', 'c']) add(db, id, `about ${id}`);
    db.close();
    // As an older build left it: the index populated, the key table absent.
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE entity_fts_key');
    raw.close();

    const reopened = new TypeDBLiteInterpreter(path);
    replace(reopened, 'b', 'about b again');
    add(reopened, 'd', 'about d');
    assert.deepEqual(rowsPerEntity(path), { 'document/a': 1, 'document/b': 1, 'document/c': 1, 'document/d': 1 });
    assert.deepEqual(hits(reopened, 'again'), ['document/b']);
    assert.equal(reopened.changeLog.fullText.count(), 4);
    reopened.close();
  });

  onFile('🔴 keeps one row per entity when an older engine writes the same store in between', () => {
    const path = tempStore();
    const db = new TypeDBLiteInterpreter(path);
    db.define(SCHEMA);
    for (const id of ['a', 'b', 'c']) add(db, id, `about ${id}`);
    // An older process re-indexes `a` (so its row moves above the others) and indexes a new `x`.
    olderEngineIndexes(path, 'document/a', 'older engine wording');
    olderEngineIndexes(path, 'document/x', 'written elsewhere');
    // This engine then rewrites both: neither may be left with the older engine's row beside its own.
    replace(db, 'a', 'about a, current');
    db.changeLog.fullText.index('document/x', { type: 'document', attributes: [{ type: 'doc-body', value: 'x, current' }] } as never);
    assert.deepEqual(rowsPerEntity(path), { 'document/a': 1, 'document/b': 1, 'document/c': 1, 'document/x': 1 });
    assert.deepEqual(hits(db, 'older'), []);
    assert.deepEqual(hits(db, 'current'), ['document/a', 'document/x']);
    db.close();
  });

  onFile('🔴 never deletes another entity\'s row through a key an older engine left stale', () => {
    const path = tempStore();
    const db = new TypeDBLiteInterpreter(path);
    db.define(SCHEMA);
    add(db, 'a', 'about a');
    add(db, 'b', 'about b');
    // The older engine removes `b`, the newest row, then indexes `c` — which FTS5 gives `b`'s rowid.
    const raw = new DatabaseSync(path);
    raw.prepare('DELETE FROM entity_fts WHERE entity_id = ?').run('document/b');
    raw.close();
    olderEngineIndexes(path, 'document/c', 'about c');
    // The key table still says `b` is at that rowid. Removing `b` here must not take `c` with it.
    db.changeLog.fullText.remove('document/b');
    assert.deepEqual(hits(db, 'about'), ['document/a', 'document/c']);
    db.close();
  });
});
