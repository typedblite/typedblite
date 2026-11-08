/**
 * Full-text search over TypeDBLite, via SQLite's FTS5.
 *
 * Goal 6 of [TypeDBLite Sync](../../../../../docs/planning/typeqlite-sync/typeqlite-sync.feature.md):
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
);`;

const TAG_ATTRIBUTE = /(^|-)tags?$/;

export class FullTextIndex {
  public constructor(private readonly db: SqliteDatabase) {}

  /** Throws with a usable message if this SQLite lacks FTS5, rather than failing obscurely later. */
  public static assertAvailable(db: SqliteDatabase): void {
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)');
      db.exec('DROP TABLE IF EXISTS __fts_probe');
    } catch (error) {
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

    this.db
      .prepare(
        'INSERT INTO entity_fts(entity_id, doctype, status, tags, text) VALUES (?, ?, ?, ?, ?)',
      )
      .run(entityId, state.type, status, tags, text);
  }

  public remove(entityId: string): void {
    this.db.prepare('DELETE FROM entity_fts WHERE entity_id = ?').run(entityId);
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
