import type { SqliteDatabase } from './sqlite-database.js';

/**
 * Attribute instances and ownership — ADR-006.
 *
 * An attribute is stored ONCE per type and canonical value (`attribute`), and an owner holds it
 * through an edge (`has`). It replaced `attr(owner, type, value)`, which stored a value per owner and
 * so could hold no attribute without an owner, and no single instance two owners share.
 *
 * - `attribute.id` is a local join key. It never appears in an answer, a change-log document or a
 *   replicated revision — an attribute's identity is its type and value, the same on every node.
 * - `has.type` copies the attribute's type so `@key`/`@unique` stay partial unique indexes on
 *   `has(attribute)`, and "does this owner have a T" reads `has` alone.
 * - A lookup by value starts from the value: `attribute(type, value)` finds the one instance and
 *   `has(attribute)` its owners — see `OWNERS_OF_VALUE`.
 * - `attribute_sweep` collects every attribute that was created or lost an ownership, by trigger, so
 *   no write path can forget to: a foreign-key cascade from a deleted owner fires the `has` trigger
 *   too (measured, node:sqlite 2026-11-11). `sweepAttributes` empties it.
 *
 * (No backticks in the DDL: `sqlite-generator.ts` interpolates it into a template literal.)
 */
export const ATTRIBUTE_DDL = `CREATE TABLE IF NOT EXISTS attribute (
  id    INTEGER PRIMARY KEY,
  type  TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (type, value)
);

CREATE TABLE IF NOT EXISTS has (
  owner     INTEGER NOT NULL REFERENCES thing(iid) ON DELETE CASCADE,
  attribute INTEGER NOT NULL REFERENCES attribute(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  PRIMARY KEY (owner, attribute)
);
-- has(owner) and not (owner, type): an owner's ownerships are read in the order they were made
-- (ORDER BY rowid), and only an index on owner alone yields that order without a sort. Measured on
-- the downstream-app stores, the sort cost ~10% of every query (2026-11-11).
CREATE INDEX IF NOT EXISTS has_owner ON has(owner);
CREATE INDEX IF NOT EXISTS has_attribute ON has(attribute);

-- The attributes a write created or unlinked, for the end-of-statement sweep. Always empty between
-- statements; a row left behind by a path that never swept is only swept later, never wrongly.
CREATE TABLE IF NOT EXISTS attribute_sweep (
  id INTEGER PRIMARY KEY
);
CREATE TRIGGER IF NOT EXISTS attribute_created AFTER INSERT ON attribute
BEGIN
  INSERT OR IGNORE INTO attribute_sweep(id) VALUES (NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS has_removed AFTER DELETE ON has
BEGIN
  INSERT OR IGNORE INTO attribute_sweep(id) VALUES (OLD.attribute);
END;`;

/** An owner's attributes, joined: `h` is the ownership, `v` the attribute it holds. */
export const OWNED = 'has h JOIN attribute v ON v.id = h.attribute';

/**
 * The owners of a value, as a subquery for `t.iid IN (…)`, with the WHERE on `v` supplied by the
 * caller. Value first: the old `EXISTS (… WHERE a.owner = t.iid …)` probed every candidate thing,
 * and this finds the one attribute by its unique index and then its owners.
 */
export const ownersOfValue = (where: string): string => `SELECT h.owner FROM attribute v JOIN has h ON h.attribute = v.id WHERE ${where}`;

/** The attribute with this type and canonical value, created if it does not exist yet. */
export function ensureAttribute(db: SqliteDatabase, type: string, value: string): { id: number; created: boolean } {
  const created = db.prepare('INSERT OR IGNORE INTO attribute(type, value) VALUES (?, ?)').run(type, value).changes > 0;
  const row = db.prepare('SELECT id FROM attribute WHERE type = ? AND value = ?').get(type, value) as { id: number };
  return { id: Number(row.id), created };
}

/** The id of an existing attribute, or `undefined`. */
export function attributeId(db: SqliteDatabase, type: string, value: string): number | undefined {
  const row = db.prepare('SELECT id FROM attribute WHERE type = ? AND value = ?').get(type, value) as { id: number } | undefined;
  return row === undefined ? undefined : Number(row.id);
}

/**
 * Make `owner` own the attribute; `false` when it already did — ownership is a set.
 *
 * 🔴 Checked, then a plain INSERT — never `INSERT OR IGNORE`. OR IGNORE swallows a UNIQUE-index
 * conflict too, and the `@key`/`@unique` indexes are UNIQUE indexes on `has`: a duplicate key
 * would have been dropped in silence instead of refused.
 */
export function ownAttribute(db: SqliteDatabase, owner: number, type: string, value: string): boolean {
  const { id } = ensureAttribute(db, type, value);
  if (db.prepare('SELECT 1 FROM has WHERE owner = ? AND attribute = ?').get(owner, id) !== undefined) return false;
  db.prepare('INSERT INTO has(owner, attribute, type) VALUES (?, ?, ?)').run(owner, id, type);
  return true;
}

/**
 * Remove every attribute that has no owner and whose type is not `@independent`, declared or
 * inherited through `sub` (match.feature L4214) — at the end of the statement, not at commit: a
 * later query in the same transaction must not find it (ADR-006 Decision 4).
 *
 * `scope: 'touched'` looks only at what `attribute_sweep` collected since the last sweep; `'all'`
 * looks at every attribute, for a schema change that may have removed `@independent` (delete.feature
 * L1329) or an ownership. Independence is read from the stored schema, so the change log's
 * replication path can sweep without the interpreter.
 */
export function sweepAttributes(db: SqliteDatabase, scope: 'touched' | 'all' = 'touched'): number {
  const candidates = scope === 'all' ? '' : 'id IN (SELECT id FROM attribute_sweep) AND ';
  const removed = db
    .prepare(
      `WITH RECURSIVE independent(type) AS (
         SELECT subject FROM schema_annotation WHERE category = 'independent'
         UNION
         SELECT tp.type FROM type_parent tp JOIN independent i ON tp.parent = i.type
       )
       DELETE FROM attribute
       WHERE ${candidates}NOT EXISTS (SELECT 1 FROM has h WHERE h.attribute = attribute.id)
         AND type NOT IN (SELECT type FROM independent)`,
    )
    .run();
  db.exec('DELETE FROM attribute_sweep');
  return Number(removed.changes);
}

/** Does this database hold the tables at all — `false` before the first `define`. */
export function hasAttributeTables(db: SqliteDatabase): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attribute'").get() !== undefined;
}

/**
 * Move a store written before ADR-006 off `attr`, once, in one transaction (ADR-006 Decision 6).
 *
 * Every attribute in such a store has an owner, so nothing is swept. The `@key`/`@unique` indexes
 * are rebuilt from their own SQL — the same name and the same `WHERE type = …`, now on
 * `has(attribute)` — so no schema knowledge is needed here. ⚠️ One-way: a build from before ADR-006
 * cannot read the store afterwards.
 */
export function migrateAttrTable(db: SqliteDatabase): boolean {
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attr'").get();
  if (legacy === undefined) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(ATTRIBUTE_DDL);
    db.exec('INSERT OR IGNORE INTO attribute(type, value) SELECT type, value FROM attr ORDER BY rowid');
    db.exec(
      'INSERT OR IGNORE INTO has(owner, attribute, type) ' +
        'SELECT a.owner, v.id, a.type FROM attr a JOIN attribute v ON v.type = a.type AND v.value = a.value ORDER BY a.rowid',
    );
    const indexes = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attr' AND sql IS NOT NULL " +
          "AND (name LIKE 'key\\_%' ESCAPE '\\' OR name LIKE 'unique\\_%' ESCAPE '\\')",
      )
      .all() as Array<{ name: string; sql: string }>;
    db.exec('DROP TABLE attr');
    for (const index of indexes) {
      const rebuilt = String(index.sql).replace(/\bON\s+"?attr"?\s*\(\s*value\s*\)/i, 'ON has(attribute)');
      if (rebuilt === index.sql) throw new Error(`TypeDBLite: cannot move index '${index.name}' off attr: ${index.sql}`);
      db.exec(rebuilt);
    }
    db.exec('DELETE FROM attribute_sweep');
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
