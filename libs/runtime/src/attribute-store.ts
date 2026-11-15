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
 * - `has.type` copies the attribute's type, so "does this owner have a T" reads `has` alone.
 * - `has.scope` names the type a `@key`/`@unique` holds among (`uniquenessScope`), and one partial
 *   unique index on `(attribute, scope)` enforces every such ownership — scoped per owner type, as
 *   TypeDB's are (insert.feature L1662–L1729; ADR-006 amendment).
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
  -- For a @key or @unique ownership, the type the uniqueness is among: the top-most type declaring
  -- it, whose instances and subtypes' instances may not share the value. NULL otherwise.
  scope     TEXT,
  PRIMARY KEY (owner, attribute)
);
-- @key and @unique, for every owner type at once: one owner per value within a scope (ADR-006,
-- amendment). A person and a friendship may each have ref 0; a base and its derived may not.
CREATE UNIQUE INDEX IF NOT EXISTS has_unique_in_scope ON has(attribute, scope) WHERE scope IS NOT NULL;
-- has(owner) and not (owner, type): an owner's ownerships are read in the order they were made
-- (ORDER BY rowid), and only an index on owner alone yields that order without a sort. Measured on
-- a production application's stores, the sort cost ~10% of every query (2026-11-11).
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
 * The type a `@key`/`@unique` on `(ownerType, attributeType)` holds among, or `null` when the
 * ownership is neither: the TOP-MOST type in the owner's ancestry that declares a key or unique
 * ownership of the attribute or one of its supertypes — so a `derived` and a `base` share the
 * scope `base` declared (insert.feature L1671, L1704). Read from the stored schema, so the change
 * log's replication path computes the same scope as a local write.
 */
export function uniquenessScope(db: SqliteDatabase, ownerType: string, attributeType: string): string | null {
  // A store from before `schema_owns`/`schema_annotation` records no key to scope by; its next
  // `define` (every repository re-defines on open) records them and rescopes.
  const recorded = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('schema_owns', 'schema_annotation')").get() as { n: number };
  if (Number(recorded.n) < 2) return null;
  const row = db
    .prepare(
      `WITH RECURSIVE owner_chain(type, depth) AS (
         SELECT ?, 0 UNION ALL SELECT p.parent, c.depth + 1 FROM type_parent p JOIN owner_chain c ON p.type = c.type WHERE c.depth < 64
       ),
       attribute_chain(type, depth) AS (
         SELECT ?, 0 UNION ALL SELECT p.parent, c.depth + 1 FROM type_parent p JOIN attribute_chain c ON p.type = c.type WHERE c.depth < 64
       )
       SELECT o.type AS scope FROM owner_chain o
       JOIN schema_owns so ON so.type = o.type
       JOIN attribute_chain a ON a.type = so.attribute
       JOIN schema_annotation sa ON sa.subject = so.type || char(31) || 'owns' || char(31) || so.attribute AND sa.category IN ('key', 'unique')
       ORDER BY o.depth DESC LIMIT 1`,
    )
    .get(ownerType, attributeType) as { scope: string } | undefined;
  return row === undefined ? null : String(row.scope);
}

/**
 * Every ownership's scope, recomputed — after a schema change that may add, move or remove a
 * `@key`/`@unique`. Run inside the change's transaction: a scope the data does not satisfy fails
 * the unique index and the change rolls back with it. Writes only rows whose scope changes.
 */
export function rescopeOwnerships(db: SqliteDatabase): void {
  const pairs = db.prepare('SELECT DISTINCT t.type AS owner, h.type AS attribute FROM has h JOIN thing t ON t.iid = h.owner').all() as Array<{ owner: string; attribute: string }>;
  const update = db.prepare('UPDATE has SET scope = ? WHERE type = ? AND scope IS NOT ? AND owner IN (SELECT iid FROM thing WHERE type = ?)');
  for (const pair of pairs) {
    const scope = uniquenessScope(db, String(pair.owner), String(pair.attribute));
    update.run(scope, String(pair.attribute), scope, String(pair.owner));
  }
}

/**
 * A store whose `has` predates `has.scope` — written by an earlier build of ADR-006 — gets the column
 * and the scoped index, loses the per-attribute `key_*`/`unique_*` indexes they replace, and has its
 * ownerships scoped. Idempotent; a store with no `has` is left alone.
 */
export function ensureScopedUniqueness(db: SqliteDatabase): void {
  if (!hasAttributeTables(db)) return;
  const columns = (db.prepare("SELECT name FROM pragma_table_info('has')").all() as Array<{ name: string }>).map((c) => String(c.name));
  const legacyIndexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'has'").all() as Array<{ name: string }>)
    .map((r) => String(r.name))
    .filter((name) => name.startsWith('key_') || name.startsWith('unique_'));
  if (columns.includes('scope') && legacyIndexes.length === 0) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!columns.includes('scope')) db.exec('ALTER TABLE has ADD COLUMN scope TEXT');
    for (const name of legacyIndexes) db.exec(`DROP INDEX IF EXISTS "${name}"`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS has_unique_in_scope ON has(attribute, scope) WHERE scope IS NOT NULL');
    rescopeOwnerships(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Make `owner` own the attribute; `false` when it already did — ownership is a set.
 *
 * 🔴 Checked, then a plain INSERT — never `INSERT OR IGNORE`. OR IGNORE swallows a UNIQUE-index
 * conflict too, and the `@key`/`@unique` indexes are UNIQUE indexes on `has`: a duplicate key
 * would have been dropped in silence instead of refused.
 */
export function ownAttribute(db: SqliteDatabase, owner: number, type: string, value: string, ownerType?: string): boolean {
  const { id } = ensureAttribute(db, type, value);
  if (db.prepare('SELECT 1 FROM has WHERE owner = ? AND attribute = ?').get(owner, id) !== undefined) return false;
  const thingType = ownerType ?? String((db.prepare('SELECT type FROM thing WHERE iid = ?').get(owner) as { type: string }).type);
  db.prepare('INSERT INTO has(owner, attribute, type, scope) VALUES (?, ?, ?, ?)').run(owner, id, type, uniquenessScope(db, thingType, type));
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
 * Every attribute in such a store has an owner, so nothing is swept. The per-attribute `@key`/
 * `@unique` indexes are not rebuilt: the scoped index replaces them, and every ownership is scoped
 * from the stored schema (ADR-006 amendment). ⚠️ One-way: a build from before ADR-006 cannot read
 * the store afterwards.
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
    // The per-attribute `key_*`/`unique_*` indexes go with `attr`; the scoped index replaces them.
    db.exec('DROP TABLE attr');
    rescopeOwnerships(db);
    db.exec('DELETE FROM attribute_sweep');
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
