/**
 * One-shot replication between two change logs.
 *
 * Implements [ADR-003](../../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)
 * Decisions 5 and 6. Continuous replication is deliberately **not** here — it is a subscription
 * lifecycle with its own failure modes, and folding it in behind a `live` flag would let it be
 * called done when the happy path emits one event.
 */
import type { ChangeRecord } from './change-log.js';

/** Which way a replication moves changes: `push` sends the local ones, `pull` takes the remote ones, `duplex` does both. */
export type SyncDirection = 'push' | 'pull' | 'duplex';

/**
 * A position in each direction's log.
 *
 * @privateRemarks
 * 🔴 Not a single opaque token. A duplex replication has two independent positions — how far we
 * have pulled and how far we have pushed — and one string cannot carry both without encoding a
 * record inside it, which is an opaque token pretending not to be one. Prior art's
 * `SyncResult { checkpointToken: string }` is exactly that shape, and it is why it was rejected.
 */
export interface SyncCursor {
  /** How far the local store has pulled: the last `seq` of the remote's log it applied. */
  readonly pull?: number;
  /** How far the local store has pushed: the last `seq` of its own log the remote has. */
  readonly push?: number;
}

/** What one replication did. */
export interface SyncOutcome {
  /** Where each direction got to: keep it and pass it as `from` to resume. */
  readonly cursor: SyncCursor;
  /** How many revisions were new to the store that received them. A pair that is already in sync applies none. */
  readonly applied: number;
  /** How many conflicts the local store holds on the things this run touched. */
  readonly conflicts: number;
}

/** What replication needs of a store. `ChangeLog` satisfies it structurally. */
export interface ReplicationEndpoint {
  /** The changes after `cursor` (default 0), at most `limit`, in order. */
  since(cursor?: number, limit?: number): readonly ChangeRecord[];
  /** Returns whether the revision was new to this endpoint. */
  applyRemote(record: {
    entityId: string;
    rev: string;
    parentRev?: string | null;
    deleted: boolean;
    state?: ChangeRecord['state'];
  }): boolean;
  /** The leaves of a thing that did not win: the conflicts it holds. */
  conflictsOf(entityId: string): readonly { rev: string; deleted: boolean }[];
}

/** How {@link replicateOnce} replicates. */
export interface ReplicateOptions {
  /** Which way to move changes. */
  readonly direction: SyncDirection;
  /** Where each direction resumes. Absent, it starts from the beginning of the log. */
  readonly from?: SyncCursor;
  /** Batch size. Bounded so a large backlog does not become one enormous read. */
  readonly limit?: number;
}

function drain(
  source: ReplicationEndpoint,
  target: ReplicationEndpoint,
  from: number,
  limit: number,
): { cursor: number; applied: number; touched: Set<string> } {
  let cursor = from;
  let applied = 0;
  const touched = new Set<string>();

  for (;;) {
    const batch = source.since(cursor, limit);
    if (batch.length === 0) break;
    for (const record of batch) {
      const isNew = target.applyRemote({
        entityId: record.entityId,
        rev: record.rev,
        parentRev: record.parentRev,
        deleted: record.deleted,
        state: record.state,
      });
      // 🔴 `applied` counts revisions that were *new to the target*, not records transferred.
      // Counting re-sent duplicates would make a settled pair report work it did not do, and a
      // caller asking "did anything change?" would always hear yes.
      if (isNew) {
        touched.add(record.entityId);
        applied += 1;
      }
    }
    cursor = batch[batch.length - 1].seq;
  }

  return { cursor, applied, touched };
}

/**
 * Replicate once, in the requested direction, and report where to resume.
 *
 * Idempotent: applying a revision twice is absorbed by `UNIQUE (entity_id, rev)`, so a run that is
 * interrupted after applying but before its caller stores the cursor repeats work rather than
 * losing or duplicating it.
 */
export function replicateOnce(
  local: ReplicationEndpoint,
  remote: ReplicationEndpoint,
  options: ReplicateOptions,
): SyncOutcome {
  const limit = options.limit ?? 500;
  const from = options.from ?? {};
  const touched = new Set<string>();
  let applied = 0;
  const cursor: { pull?: number; push?: number } = {};

  if (options.direction === 'pull' || options.direction === 'duplex') {
    const result = drain(remote, local, from.pull ?? 0, limit);
    cursor.pull = result.cursor;
    applied += result.applied;
    for (const id of result.touched) touched.add(id);
  }

  if (options.direction === 'push' || options.direction === 'duplex') {
    const result = drain(local, remote, from.push ?? 0, limit);
    cursor.push = result.cursor;
    applied += result.applied;
    for (const id of result.touched) touched.add(id);
  }

  // Counted after both directions, because a duplex round can *create* a conflict: each side
  // learns of the other's concurrent edit only once both have been applied.
  let conflicts = 0;
  for (const id of touched) {
    conflicts += local.conflictsOf(id).length;
  }

  return { cursor, applied, conflicts };
}
