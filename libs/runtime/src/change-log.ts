// 🔴 **If you change the semantics in this file, re-run the parity oracle.**
// CouchDB's revision-tree behaviour is kept here on purpose (ADR-003), and it was proven against
// real CouchDB 3.4.3 in TypeDBLite Sync Phase 03. That check is **no longer part of the routine
// suite** — it skipped on every CI run for want of the stack, reporting nothing. Bring the stack up
// and run `nx run typedblite-runtime:test-oracle`. Nothing else will tell you the semantics drifted.
/**
 * The change log — TypeDBLite's record of what changed, in the order it committed.
 *
 * Implements [ADR-003](../../../../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)
 * Decisions 1 and 2. The rows are written by `TypeDBLiteInterpreter` **inside its existing
 * transaction**, never after it — a row committed and then published loses the change entirely if
 * the process dies between the two.
 */
import type { SqliteDatabase } from './sqlite-database.js';
import {
  canonical,
  entityId,
  isReplicable,
  type EntityState,
} from './canonical.js';
import { FullTextIndex } from './full-text.js';
import {
  computeRevision,
  conflicts as conflictsOfLeaves,
  winner as winnerOfLeaves,
  type Leaf,
  type Revision,
} from './revision.js';

export interface ChangeRecord {
  readonly seq: number;
  readonly entityId: string;
  readonly rev: Revision;
  readonly parentRev: string | null;
  readonly deleted: boolean;
  /** The revision's content. Absent for a tombstone, which has no state. */
  readonly state?: EntityState;
}

/** What a thing is, resolved to node-independent terms. Captured before a delete removes it. */
/** How much history `compact` may keep behind each leaf. */
export interface CompactionOptions {
  /** Non-leaf revisions retained per entity, most recent first. Default 0 — leaves only. */
  readonly keepAncestors?: number;
}

export interface CompactionReport {
  readonly entities: number;
  readonly revisionsBefore: number;
  readonly revisionsAfter: number;
  readonly removed: number;
  /** Bytes of revision *state* dropped. Not the file size change — see `vacuum`. */
  readonly bytesReclaimed: number;
}

export interface EntityIdentity {
  readonly entityId: string;
  readonly state: EntityState;
}

/**
 * 🔴 `AUTOINCREMENT` is required and is not stylistic.
 *
 * Measured on Node v24.19.0: with it, deleting the row holding `seq 3` and inserting again yields
 * `1, 2, 4` — the value is burned. With a plain `INTEGER PRIMARY KEY` the same sequence yields
 * `1, 2, 3`, reusing the rowid. A reused `seq` makes a follower resuming from a cursor either skip
 * a change or replay a different one under the same number.
 *
 * `key_attribute` exists separately rather than as a third `schema_element.kind` because that
 * table carries `CHECK (kind IN ('type', 'attribute'))`, and SQLite cannot alter a CHECK in place.
 * Additive is what keeps re-applying a schema safe, per ADR-002.
 *
 * `pending_role` records an edge a projection could not draw because the player had not arrived
 * yet. Without it, "the relation reappears once the player's own revision arrives" is a promise
 * nothing keeps: projecting the player does not re-project the relation, so the edge stays missing
 * for as long as the replica lives. Rows are the *deferred work*, not state — each is deleted the
 * moment its edge is drawn.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  TEXT    NOT NULL,
  rev        TEXT    NOT NULL,
  parent_rev TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  state      TEXT,
  UNIQUE (entity_id, rev)
);
CREATE INDEX IF NOT EXISTS change_log_entity ON change_log(entity_id, seq);

CREATE TABLE IF NOT EXISTS key_attribute (
  type TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS pending_role (
  rel_id    TEXT NOT NULL,
  role      TEXT NOT NULL,
  player_id TEXT NOT NULL,
  PRIMARY KEY (rel_id, role, player_id)
);
CREATE INDEX IF NOT EXISTS pending_role_player ON pending_role(player_id);`;

export class ChangeLog {
  /** Full-text search over the projected state (Goal 6). Kept current inside projection. */
  public readonly fullText: FullTextIndex;

  /**
   * Entities whose projection is already on the stack.
   *
   * Re-projecting a relation when its player arrives is a *recursive* step, and a relation that
   * plays a role in another relation can form a cycle. Without this the first such cycle is an
   * unbounded recursion rather than a missing edge.
   */
  private readonly projecting = new Set<string>();

  public constructor(private readonly db: SqliteDatabase) {
    this.fullText = new FullTextIndex(db);
  }

  public ensureSchema(): void {
    this.db.exec(DDL);
    this.migrate();
    this.fullText.ensureSchema();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a database written
   * by Phase 01 has no `state` column. Adding it is additive and safe to re-run — the same property
   * that lets a schema be re-applied (ADR-002).
   */
  private migrate(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('change_log')")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'state')) {
      this.db.exec('ALTER TABLE change_log ADD COLUMN state TEXT');
    }
  }

  /**
   * Remember which attribute types carry `@key`. Identity depends on this, and `loadSchema` only
   * restores types and attributes — so without persisting it, a reopened database could not tell
   * which attribute names an entity.
   */
  public rememberKeys(keys: readonly string[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO key_attribute(type) VALUES (?)',
    );
    for (const key of keys) insert.run(key);
  }

  /** Public since Phase 03 of the conformance feature: `loadSchema` derives key ownerships from it for a database that predates `schema_key_owns`. */
  public keyTypes(): ReadonlySet<string> {
    const rows = this.db
      .prepare('SELECT type FROM key_attribute')
      .all() as Array<{ type: string }>;
    return new Set(rows.map((row) => row.type));
  }

  /**
   * Resolve a thing to its node-independent identity and state.
   *
   * Returns `undefined` when the thing does not exist — which is normal, not an error: a delete
   * cascade may already have removed it.
   */
  public identify(iid: number): EntityIdentity | undefined {
    const thing = this.db
      .prepare('SELECT type FROM thing WHERE iid = ?')
      .get(iid) as { type: string } | undefined;
    if (!thing) return undefined;

    const attributes = this.db
      .prepare('SELECT type, value FROM attr WHERE owner = ?')
      .all(iid) as Array<{ type: string; value: string }>;

    // Roles name their players by *entity id*, never by iid — see canonical.ts. A player whose own
    // identity cannot be resolved is skipped rather than encoded as a local rowid, which would make
    // the digest node-dependent and every replicated revision differ.
    const rolePlayers = this.db
      .prepare('SELECT role, player FROM role_player WHERE rel = ?')
      .all(iid) as Array<{ role: string; player: number }>;
    const keys = this.keyTypes();
    const roles = rolePlayers.flatMap((row) => {
      const player = this.identityOf(row.player, keys);
      return player ? [{ role: row.role, player }] : [];
    });

    const state: EntityState = { type: thing.type, attributes, roles };
    // `entityId` is total once the type is known, so this cannot be undefined — but deriving it
    // through the same helper keeps one definition of identity rather than two.
    const id = entityId(
      thing.type,
      attributes.find((a) => keys.has(a.type)),
      iid,
    );
    return { entityId: id, state };
  }

  private identityOf(
    iid: number,
    keys: ReadonlySet<string>,
    type?: string,
    attributes?: Array<{ type: string; value: string }>,
  ): string | undefined {
    const resolvedType =
      type ??
      (
        this.db.prepare('SELECT type FROM thing WHERE iid = ?').get(iid) as
          | { type: string }
          | undefined
      )?.type;
    if (resolvedType === undefined) return undefined;
    const owned =
      attributes ??
      (this.db
        .prepare('SELECT type, value FROM attr WHERE owner = ?')
        .all(iid) as Array<{ type: string; value: string }>);
    const key = owned.find((a) => keys.has(a.type));
    const id = entityId(resolvedType, key, iid);
    // 🔴 The guard, actually applied. `entityId` is total — it answers `local:<type>/<rowid>` for a
    // keyless thing — so returning it unchecked is what made `identify`'s "skipped rather than
    // encoded as a local rowid" comment false. A rowid is `last_insert_rowid()`: node-local, so the
    // same logical relation digests differently on two nodes, and `localIid` can never resolve the
    // id back, so every arriving revision inserts another `thing` row.
    return isReplicable(id) ? id : undefined;
  }

  /**
   * The leaves of an entity's revision tree — every revision that is nobody's parent.
   *
   * 🔴 Phase 01 kept a single head, which is correct only while one node writes. The moment a
   * revision arrives from elsewhere with a parent that is not the current head, the entity has a
   * *set* of leaves, and a head is a lie that silently picks a winner by arrival order.
   */
  public leavesOf(id: string): readonly Leaf[] {
    const rows = this.db
      .prepare(
        `SELECT rev, deleted FROM change_log
         WHERE entity_id = :id
           AND rev NOT IN (
             SELECT parent_rev FROM change_log
             WHERE entity_id = :id AND parent_rev IS NOT NULL
           )
         ORDER BY seq`,
      )
      .all({ id }) as Array<{ rev: string; deleted: number }>;
    return rows.map((row) => ({ rev: row.rev, deleted: row.deleted === 1 }));
  }

  /** The winning leaf, by ADR-003 D3's total rule. */
  public winnerOf(id: string): Leaf | undefined {
    return winnerOfLeaves(this.leavesOf(id));
  }

  /**
   * Every losing leaf — the equivalent of CouchDB's `_conflicts`.
   *
   * 🔴 Goal 2 is not met by retaining losers internally. If nothing can enumerate them the data is
   * present and the guarantee is not, so this is part of the deliverable rather than a convenience.
   */
  public conflictsOf(id: string): readonly Leaf[] {
    return conflictsOfLeaves(this.leavesOf(id));
  }

  /** The state a revision carried, if it carried any. */
  public stateOf(id: string, rev: Revision): EntityState | undefined {
    const row = this.db
      .prepare('SELECT state FROM change_log WHERE entity_id = ? AND rev = ?')
      .get(id, rev) as { state: string | null } | undefined;
    return row?.state ? (JSON.parse(row.state) as EntityState) : undefined;
  }

  /**
   * Record a write. Idempotent by construction: a revision is derived from its state and parent, so
   * re-recording an unchanged entity computes the same `rev` and the `UNIQUE (entity_id, rev)`
   * constraint absorbs it. That matters because one TypeQLite insert touches a thing, then each of its
   * attributes, then each of its roles — the same entity is "touched" several times per pipeline.
   */
  public recordWrite(iid: number): void {
    const identity = this.identify(iid);
    if (!identity) return;
    this.append(identity.entityId, {
      state: identity.state,
      parent: this.winnerOf(identity.entityId)?.rev,
      deleted: false,
    });
    // 🔴 A player can arrive by a *local* write, not only by replication.
    //
    // `drawDeferredEdgesNaming` was reachable only from `applyRemote`, so a relation waiting on a
    // player that someone then created locally stayed unlinked forever: `recordWrite` never
    // projects, and the hub's echo of that same revision comes back `isNew = false` and skips
    // projection too. The same defect `pending_role` exists to fix, reached by the other door.
    this.drawDeferredEdgesNaming(identity.entityId);
    this.reindex(identity.entityId);
  }

  /**
   * 🔴 **The index is maintained on a local write too, for the same reason as the line above it.**
   *
   * `fullText.index` was reachable only from `projectWinnerOnce`, which only `applyRemote` calls —
   * so **the full-text index was populated by replication and by nothing else.** A store written
   * locally and then searched returned zero rows, for every query, with no error: exactly the
   * "silently returns nothing" failure this engine replaced CouchDB and Nouveau to avoid.
   *
   * Nobody hit it because no consumer both wrote locally and searched. `graph-store` never
   * searched, and the FTS parity suite drives `FullTextIndex` directly. `document-store` is the
   * first to do both, and found it on its first search test.
   *
   * It indexes the **winner's** state, not the state just written, because a remote revision may
   * already win here — mirroring `projectWinnerOnce` rather than assuming the local write is
   * current. Purely additive: this touches `entity_fts` and nothing else.
   */
  private reindex(id: string): void {
    const won = this.winnerOf(id);
    if (!won || won.deleted) {
      this.fullText.remove(id);
      return;
    }
    const state = this.stateOf(id, won.rev);
    if (state) this.fullText.index(id, state);
  }

  /**
   * Record a tombstone. Takes an identity captured **before** the delete ran, because afterwards
   * there is nothing left to read.
   */
  public recordTombstone(identity: EntityIdentity): void {
    this.append(identity.entityId, {
      parent: this.winnerOf(identity.entityId)?.rev,
      deleted: true,
    });
    // A tombstoned entity still findable by search is the kind of divergence nobody notices until
    // someone asks why a deleted thing is in their results — `projectWinnerOnce` says exactly that
    // about the replication path, and the local path deserves the same guarantee.
    this.reindex(identity.entityId);
  }

  private append(
    id: string,
    input: { state?: EntityState; parent?: Revision; deleted: boolean },
  ): void {
    const rev = computeRevision(input);
    this.write(id, rev, input.parent, input.deleted, input.state);
  }

  /** Returns whether the revision was new here — `INSERT OR IGNORE` absorbs one already held. */
  private write(
    id: string,
    rev: Revision,
    parent: Revision | undefined,
    deleted: boolean,
    state?: EntityState,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO change_log(entity_id, rev, parent_rev, deleted, state)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        rev,
        parent ?? null,
        deleted ? 1 : 0,
        state ? JSON.stringify(state) : null,
      );
    return Number(result.changes) > 0;
  }

  /**
   * Find the local row id for an entity id, if this node holds the entity at all.
   *
   * Identity is `type/keyValue`, so the lookup is by key attribute value scoped to the type — the
   * same partial unique index `@key` compiles to.
   */
  private localIid(id: string): number | undefined {
    const slash = id.indexOf('/');
    if (slash < 0) return undefined;
    const type = id.slice(0, slash);
    const keyValue = id.slice(slash + 1);
    const row = this.db
      .prepare(
        `SELECT t.iid AS iid FROM thing t
         JOIN attr a ON a.owner = t.iid
         WHERE t.type = ? AND a.value = ? AND a.type IN (SELECT type FROM key_attribute)
         LIMIT 1`,
      )
      .get(type, keyValue) as { iid: number } | undefined;
    return row ? Number(row.iid) : undefined;
  }

  /**
   * Make the winning revision visible to TypeQLite.
   *
   * 🔴 Writes rows directly rather than going through `TypeDBLiteInterpreter.execute()`, and that is
   * the point: `execute` logs what it writes, so projecting a replicated revision through it would
   * append a *new* local revision for a change that originated elsewhere. Two nodes would then
   * ping-pong revisions forever, each treating the other's projection as fresh local work.
   * **Applying a change is not a change.**
   */
  public projectWinner(id: string): void {
    if (this.projecting.has(id)) return;
    this.projecting.add(id);
    try {
      this.projectWinnerOnce(id);
    } finally {
      this.projecting.delete(id);
    }
  }

  private projectWinnerOnce(id: string): void {
    const won = this.winnerOf(id);
    if (!won) return;
    const existing = this.localIid(id);

    if (won.deleted) {
      // The deferred edges go with it. A tombstoned relation that later "reappears" because a
      // player finally arrived is exactly the divergence the tombstone exists to prevent.
      this.db.prepare('DELETE FROM pending_role WHERE rel_id = ?').run(id);
      // The index goes with the entity. A tombstoned entity still findable by search is the kind of
      // divergence nobody notices until a user asks why a deleted thing is in their results.
      this.fullText.remove(id);
      if (existing !== undefined) {
        this.db
          .prepare('DELETE FROM thing WHERE iid IN (SELECT rel FROM role_player WHERE player = ?)')
          .run(existing);
        this.db.prepare('DELETE FROM thing WHERE iid = ?').run(existing);
      }
      return;
    }

    const state = this.stateOf(id, won.rev);
    if (!state) return;

    // Same transaction as the rows below, for the reason Phase 01 established: an index updated
    // afterwards can disagree with the store if the process dies in between.
    this.fullText.index(id, state);

    let iid = existing;
    if (iid === undefined) {
      this.db.prepare('INSERT INTO thing(type) VALUES (?)').run(state.type);
      iid = Number(
        (this.db.prepare('SELECT last_insert_rowid() AS iid').get() as { iid: number }).iid,
      );
    }

    // Replace rather than merge: the winning revision *is* the state, and a merge would leave
    // attributes from a losing revision behind with nothing naming them.
    this.db.prepare('DELETE FROM attr WHERE owner = ?').run(iid);
    const insertAttr = this.db.prepare(
      'INSERT INTO attr(owner, type, value) VALUES (?, ?, ?)',
    );
    for (const attribute of state.attributes) {
      insertAttr.run(iid, attribute.type, attribute.value);
    }

    this.db.prepare('DELETE FROM role_player WHERE rel = ?').run(iid);
    this.db.prepare('DELETE FROM pending_role WHERE rel_id = ?').run(id);
    const insertRole = this.db.prepare(
      'INSERT OR IGNORE INTO role_player(rel, role, player) VALUES (?, ?, ?)',
    );
    const defer = this.db.prepare(
      'INSERT OR IGNORE INTO pending_role(rel_id, role, player_id) VALUES (?, ?, ?)',
    );
    for (const role of state.roles) {
      // A player this node has never seen cannot be linked. Skipped rather than invented — and
      // *recorded*, so the edge is drawn when the player's own revision arrives. Skipping without
      // recording is how the relation stayed permanently half-linked.
      const player = this.localIid(role.player);
      if (player !== undefined) insertRole.run(iid, role.role, player);
      else defer.run(id, role.role, role.player);
    }

    this.drawDeferredEdgesNaming(id);
  }

  /**
   * Draw every edge that was deferred for want of this entity, now that it exists locally.
   *
   * Re-projects each waiting relation rather than inserting the row directly: the relation's
   * winning revision is the authority on its edges, and inserting one edge from a `pending_role`
   * row would trust a record written by a projection that may since have been superseded.
   */
  private drawDeferredEdgesNaming(playerId: string): void {
    const waiting = this.db
      .prepare('SELECT DISTINCT rel_id FROM pending_role WHERE player_id = ?')
      .all(playerId) as Array<{ rel_id: string }>;
    for (const row of waiting) this.projectWinner(row.rel_id);
  }

  /**
   * Apply a revision that originated elsewhere.
   *
   * Its parent may be any revision in the tree, not the local winner — which is precisely how a
   * branch appears. Idempotent: `UNIQUE (entity_id, rev)` absorbs a revision delivered twice, which
   * an at-least-once transport will do.
   */
  public applyRemote(record: {
    entityId: string;
    rev: Revision;
    parentRev?: string | null;
    deleted: boolean;
    state?: EntityState;
  }): boolean {
    // 🔴 Refused at the boundary, not merely never sent. A `local:<type>/<rowid>` id names a rowid
    // on *some other* node, so accepting one asserts an equivalence between two things that have
    // never been shown to be the same. Two peers' unrelated keyless relations collide on one id,
    // and `localIid` cannot resolve it, so every revision inserts another `thing` row. Refusing is
    // the behaviour `canonical.ts` documents; until now nothing performed it.
    if (!isReplicable(record.entityId)) return false;

    // 🔴 One transaction over the log row *and* the projection it implies.
    //
    // These ran as two auto-committed statements. A throw in between — a constraint violation, a
    // disk error, a process killed — left the change-log row committed and the entity unprojected,
    // and because redelivery of an already-held revision returns `isNew = false` and skips
    // projection, that entity could never be projected again. Invisible, permanent, and on the
    // at-least-once path that is expected to redeliver.
    //
    // `SAVEPOINT` rather than `BEGIN`: `TypeDBLiteInterpreter.execute()` already holds a transaction
    // on this handle, and SQLite rejects a nested `BEGIN`. A savepoint composes either way —
    // standalone it opens and commits its own transaction, nested it is a rollback point.
    const savepoint = 'apply_remote';
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const isNew = this.write(
        record.entityId,
        record.rev,
        record.parentRev ?? undefined,
        record.deleted,
        record.state,
      );
      // Project only when something actually arrived. Re-projecting on a duplicate would rewrite
      // identical rows for no reason, and on a large resync that is the whole store.
      if (isNew) this.projectWinner(record.entityId);
      this.db.exec(`RELEASE ${savepoint}`);
      return isNew;
    } catch (error) {
      // 🔴 The unwind must not throw over the failure that caused it. SQLite may already have torn
      // the transaction down — `SQLITE_FULL` and `SQLITE_IOERR` both do — and then `ROLLBACK TO`
      // raises `no such savepoint`, which would replace a real disk error with a confusing one and
      // lose the only useful diagnostic.
      try {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
      } catch {
        // Nothing to do: the transaction is gone, which is the outcome the rollback wanted.
      }
      throw error;
    }
  }

  /**
   * Everything after `cursor`, in commit order.
   *
   * No gap handling, and that is safe rather than lazy: SQLite permits one writer at a time, so
   * write transactions commit serially and `seq` allocation order equals commit order. There is no
   * window where `seq 6` is visible while `seq 5` is still uncommitted.
   */
  public since(cursor = 0, limit = 500): readonly ChangeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT seq, entity_id, rev, parent_rev, deleted, state
         FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(cursor, limit) as Array<{
      seq: number;
      entity_id: string;
      rev: string;
      parent_rev: string | null;
      deleted: number;
      state: string | null;
    }>;
    return rows.map((row) => ({
      seq: Number(row.seq),
      entityId: row.entity_id,
      rev: row.rev,
      parentRev: row.parent_rev,
      deleted: row.deleted === 1,
      state: row.state ? (JSON.parse(row.state) as EntityState) : undefined,
    }));
  }

  /**
   * Drop revision history that nothing can read, keeping every leaf.
   *
   * 🔴 **What it may never remove, and why.** [ADR-003](../../../../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)
   * Decision 4 requires losing revisions to be *retained and enumerable* — `conflictsOf` is part of
   * the deliverable, not a convenience. So every **leaf** survives with its state: the winner and
   * every conflicting loser. Only revisions that are somebody's parent are candidates, and
   * `stateOf` is called internally with nothing but `winnerOf(...).rev`, so an ancestor's body is
   * already read by no one.
   *
   * ⚠️ **This truncates replication history, and that is the point rather than a side effect.**
   * `since(0)` replays the log to build a peer from nothing; after compaction it replays leaves.
   * CouchDB's own compaction has exactly this property. Nothing here has a peer — ADR-003 D5 is
   * explicit that this cannot replicate with a real CouchDB — so the history being truncated is
   * history of a conversation that never happened.
   *
   * `keepAncestors` retains the most recent N non-leaf revisions per entity, for anyone who wants
   * a shallow tree rather than none. It defaults to 0, which is what a single node wants.
   *
   * 🔴 **Reclaiming the file is a separate act.** SQLite frees pages to its own freelist on DELETE
   * and returns nothing to the filesystem without `VACUUM`, which cannot run inside a transaction.
   * `vacuum()` is therefore its own method and the report says how many bytes of state were dropped
   * rather than how much the file shrank — those are different numbers and conflating them would
   * overstate the result.
   */
  public compact(options: CompactionOptions = {}): CompactionReport {
    const keepAncestors = Math.max(0, Math.trunc(options.keepAncestors ?? 0));

    const before = this.revisionStats();
    const entities = (
      this.db.prepare('SELECT COUNT(DISTINCT entity_id) c FROM change_log').get() as {
        c: number;
      }
    ).c;

    // One statement, so the leaf set is computed against the same snapshot it deletes from.
    // `NOT IN (SELECT parent_rev …)` is the same predicate `leavesOf` uses, applied to every entity
    // at once rather than one at a time.
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `DELETE FROM change_log
           WHERE seq IN (
             SELECT seq FROM (
               SELECT seq,
                      ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY seq DESC) AS recency
               FROM change_log AS ancestor
               WHERE EXISTS (
                 SELECT 1 FROM change_log AS child
                 WHERE child.entity_id = ancestor.entity_id
                   AND child.parent_rev = ancestor.rev
               )
             )
             WHERE recency > :keep
           )`,
        )
        .run({ keep: keepAncestors });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const after = this.revisionStats();
    return {
      entities,
      revisionsBefore: before.revisions,
      revisionsAfter: after.revisions,
      removed: before.revisions - after.revisions,
      bytesReclaimed: before.stateBytes - after.stateBytes,
    };
  }

  /**
   * Return freed pages to the filesystem. Not part of `compact` because `VACUUM` cannot run inside
   * a transaction, and because a caller may reasonably want the rows gone without paying for a
   * whole-file rewrite.
   */
  public vacuum(): void {
    this.db.exec('VACUUM');
  }

  private revisionStats(): { revisions: number; stateBytes: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS revisions, COALESCE(SUM(LENGTH(state)), 0) AS bytes FROM change_log`,
      )
      .get() as { revisions: number; bytes: number };
    return { revisions: Number(row.revisions), stateBytes: Number(row.bytes) };
  }

  /** Canonical form of an entity's current state — exposed for tests and diagnostics. */
  public canonicalOf(iid: number): string | undefined {
    const identity = this.identify(iid);
    return identity ? canonical(identity.state) : undefined;
  }
}
