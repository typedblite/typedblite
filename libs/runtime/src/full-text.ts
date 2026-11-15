/**
 * Full-text search over TypeDBLite, via SQLite's FTS5.
 *
 * Goal 6 of TypeDBLite Sync (in the monorepo this engine came from):
 * a hard requirement rather than an extra. `downstream-store` needs CouchDB for three things — storage,
 * replication and **search** — so replacing the first two would leave the stack up.
 *
 * 🔴 FTS5 is a compile-time option and its presence in a bundled SQLite is not guaranteed. It was
 * measured on Node v24.19.0 rather than assumed; `assertAvailable` makes a missing build fail
 * loudly here rather than as a confusing SQL error later.
 */
import type { SqliteDatabase } from './sqlite-database.js';
import type { EntityState } from './canonical.js';

export interface SearchHit {
  readonly entityId: string;
  /** BM25 score. Lower is better, matching SQLite's convention. */
  readonly rank: number;
}

/**
 * The columns mirror what `downstream-store`'s Nouveau `_design/search` indexes, mapped onto TypeDBLite's
 * generic model:
 *
 * - `doctype` — the entity's TypeQLite type, which is what `docType` means there.
 * - `status` — an attribute named `status`, if the entity has one.
 * - `tags` — every attribute whose name ends `-tag` or is `tag`, space-joined.
 * - `text` — every attribute value, which is the union Nouveau builds from title and body.
 *
 * 🔴 **`tags` is one column holding several values**, because an FTS5 column is a single string
 * where Nouveau indexes `tag` as genuinely multi-valued. Matching still works — a token query finds
 * any of them — but an exact-cardinality question ("entities with exactly two tags") cannot be
 * asked here and can there. Recorded rather than papered over.
 */
const DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entity_fts USING fts5(
  entity_id UNINDEXED,
  doctype,
  status,
  tags,
  text,
  tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS entity_fts_key (
  entity_id TEXT PRIMARY KEY,
  fts_rowid INTEGER NOT NULL
);`;

const TAG_ATTRIBUTE = /(^|-)tags?$/;

/*
 * 🔴 **`entity_fts_key` is how a write finds an entity's row without scanning the index.**
 *
 * `entity_id` is UNINDEXED (an FTS5 column is either tokenised or a plain payload), so
 * `DELETE FROM entity_fts WHERE entity_id = ?` scanned every row — on every write, for a new entity
 * too, because `index()` removes before it inserts. It was half the CPU of an insert and grew with
 * the store: 1.8 ms at 15,000 entities, 19 ms at 150,000 (docs/development/performance.md). The
 * key table maps each entity to its FTS rowid, so a write reads and deletes by rowid.
 *
 * ⚠️ **An older engine writing the same file does not maintain the key table.** A downstream application loads
 * this checkout's build, and its processes restart one at a time, so a store can see both. Such an
 * engine deletes by scan and inserts without a rowid, which FTS5 assigns as the largest rowid + 1 —
 * so a row it wrote is always the NEWEST until something is written above it, and anything written
 * above it here first passes `reconcile()`. Checking that the newest row is accounted for is
 * therefore enough to notice any foreign write, and costs two indexed lookups. When it is not
 * accounted for, the key table is rebuilt from the index, once — which is also how a store indexed
 * before this table existed gains its keys, on its first write rather than on open.
 *
 * A key whose row an older engine deleted is harmless: every delete names the entity as well as the
 * rowid, so a stale key can never remove another entity's row.
 */

export class FullTextIndex {
  public constructor(private readonly db: SqliteDatabase) {}

  /**
   * Throws with a usable message if this SQLite lacks FTS5, rather than failing obscurely later.
   *
   * 🔴 **In the `temp` schema, and only "no such module" means no FTS5.** The probe used to create
   * and drop a table in the MAIN database: a write on every open, so every open took the write lock,
   * and on a read-only connection the write failed and was reported as a missing FTS5 — sending the
   * reader to their SQLite build for a fault in their file permissions (`fts5-probe.test.ts`).
   * `temp` is a separate database, writable even on a read-only connection and never shared with
   * another process. Creating a real FTS5 table there is still the honest test of FTS5; any other
   * failure is rethrown as itself.
   */
  public static assertAvailable(db: SqliteDatabase): void {
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts_probe USING fts5(x)');
      db.exec('DROP TABLE IF EXISTS temp.__fts_probe');
    } catch (error) {
      if (!/no such module: fts5/i.test(String((error as Error | undefined)?.message ?? error))) throw error;
      throw new Error(
        'This SQLite build has no FTS5, which TypeDBLite full-text search requires. ' +
          `FTS5 is a compile-time option. Underlying error: ${String(error)}`,
      );
    }
  }

  public ensureSchema(): void {
    FullTextIndex.assertAvailable(this.db);
    this.db.exec(DDL);
  }

  /**
   * Index an entity's current state, replacing whatever was there.
   *
   * Called from projection, inside the same transaction as the data — an index updated afterwards
   * can disagree with the store if the process dies between the two, and a search index that
   * silently lags is worse than one that is obviously absent.
   */
  public index(entityId: string, state: EntityState): void {
    this.remove(entityId);
    const status =
      state.attributes.find((attribute) => attribute.type === 'status')?.value ?? '';
    const tags = state.attributes
      .filter((attribute) => TAG_ATTRIBUTE.test(attribute.type))
      .map((attribute) => attribute.value)
      .join(' ');
    const text = state.attributes.map((attribute) => attribute.value).join(' ');

    // The rowid FTS5 would have chosen, stated, so the key table can record it: the binding contract
    // does not report `lastInsertRowid` (`sqlite-database.ts`).
    const rowid = (this.newest()?.rowid ?? 0) + 1;
    this.db
      .prepare(
        'INSERT INTO entity_fts(rowid, entity_id, doctype, status, tags, text) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(rowid, entityId, state.type, status, tags, text);
    this.db
      .prepare('INSERT OR REPLACE INTO entity_fts_key(entity_id, fts_rowid) VALUES (?, ?)')
      .run(entityId, rowid);
  }

  public remove(entityId: string): void {
    this.reconcile();
    const key = this.db
      .prepare('SELECT fts_rowid FROM entity_fts_key WHERE entity_id = ?')
      .get(entityId) as { fts_rowid: number } | undefined;
    if (key === undefined) return;
    this.db
      .prepare('DELETE FROM entity_fts WHERE rowid = ? AND entity_id = ?')
      .run(key.fts_rowid, entityId);
    this.db.prepare('DELETE FROM entity_fts_key WHERE entity_id = ?').run(entityId);
  }

  /** The row with the largest rowid: FTS5 answers it from its own b-tree, without a scan. */
  private newest(): { rowid: number; entity_id: string } | undefined {
    const row = this.db
      .prepare('SELECT rowid, entity_id FROM entity_fts ORDER BY rowid DESC LIMIT 1')
      .get() as { rowid: number; entity_id: string } | undefined;
    return row === undefined ? undefined : { rowid: Number(row.rowid), entity_id: String(row.entity_id) };
  }

  /** Rebuild the key table when the newest row is not in it — see `entity_fts_key` above. */
  private reconcile(): void {
    const newest = this.newest();
    if (newest === undefined) {
      if (this.db.prepare('SELECT 1 FROM entity_fts_key LIMIT 1').get() !== undefined) {
        this.db.exec('DELETE FROM entity_fts_key');
      }
      return;
    }
    const key = this.db
      .prepare('SELECT fts_rowid FROM entity_fts_key WHERE entity_id = ?')
      .get(newest.entity_id) as { fts_rowid: number } | undefined;
    if (key !== undefined && Number(key.fts_rowid) === newest.rowid) return;
    // One scan, once. An entity indexed twice cannot be keyed to both rows, so the older copies go
    // — no writer in any version leaves two, but a key table that silently dropped one would make
    // that a permanent duplicate hit.
    this.db.exec(`
      DELETE FROM entity_fts_key;
      INSERT INTO entity_fts_key(entity_id, fts_rowid) SELECT entity_id, max(rowid) FROM entity_fts GROUP BY entity_id;
      DELETE FROM entity_fts WHERE rowid NOT IN (SELECT fts_rowid FROM entity_fts_key);
    `);
  }

  /**
   * Search, using FTS5's own query syntax.
   *
   * Column filters are written `doctype:adr`, matching the shape `downstream-store` already issues
   * against Nouveau. Prefix is `term*`. Lucene's fuzzy (`~`), boost (`^`) and range syntax have no
   * equivalent — a query using them is a caller error here, and that gap is recorded in the phase
   * summary rather than silently returning nothing.
   */
  public search(query: string, limit = 50): readonly SearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT entity_id, bm25(entity_fts) AS rank
         FROM entity_fts WHERE entity_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Array<{ entity_id: string; rank: number }>;
    return rows.map((row) => ({ entityId: row.entity_id, rank: Number(row.rank) }));
  }

  public count(): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM entity_fts')
      .get() as { n: number };
    return Number(row.n);
  }
}
