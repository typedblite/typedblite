/**
 * The `Replicator` port, implemented over a change log and a change stream.
 *
 * 🔴 Structural, not nominal. The types are re-declared here — the shapes are what must agree.
 * Any consumer that adapts this replicator satisfies the port by matching the structure, not by
 * importing from this package.
 */
import { isReplicable } from './canonical.js';
import type { ChangeLog, ChangeRecord } from './change-log.js';
import { ChangeStreamClient } from './change-stream-client.js';
import {
  replicateOnce,
  type SyncCursor,
  type SyncDirection,
} from './replicator.js';

export type SyncStatus = 'idle' | 'syncing' | 'ready' | 'failed';
export type SyncErrorClass = 'transient' | 'terminal';

export interface ReplicationOptions {
  readonly direction: SyncDirection;
  readonly from?: SyncCursor;
  /**
   * `replicateOnce` only: fail if the hub has not answered, pull and push together, within this many
   * milliseconds. Without it, a hub that accepts the connection and then says nothing (a paused
   * container, a dropped route) hangs the sync for as long as the socket lives.
   */
  readonly timeoutMs?: number;
}

export interface ReplicationEvents {
  onChange?(applied: number): void;
  onPaused?(): void;
  onActive?(): void;
  onFailed?(error: Error, classification: SyncErrorClass): void;
}

export interface ReplicationSession {
  readonly status: SyncStatus;
  cancel(): Promise<void>;
}

/**
 * Replicates a local change log against a remote hub over HTTP.
 *
 * `replicateOnce` drains in both directions and returns; `replicateContinuously` holds an SSE
 * subscription open and pushes local work as it appears.
 */
export class TypeDBLiteReplicator {
  private readonly client: ChangeStreamClient;

  public constructor(
    private readonly log: ChangeLog,
    hubUrl: string,
    private readonly pushIntervalMs = 100,
    /** Headers sent with every request: how this spoke proves who it is to its hub. */
    headers?: () => Record<string, string> | Promise<Record<string, string>>,
  ) {
    this.client = new ChangeStreamClient(hubUrl, { retryMs: 200, headers });
  }

  public async replicateOnce(options: ReplicationOptions): Promise<{
    cursor: SyncCursor;
    applied: number;
    conflicts: number;
  }> {
    const from = options.from ?? {};
    let applied = 0;
    const cursor: { pull?: number; push?: number } = {};
    const touched = new Set<string>();
    const signal = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    try {
      await this.replicateOnceWithin(options, from, cursor, touched, signal, (count) => {
        applied += count;
      });
    } catch (error) {
      if (signal?.aborted) throw new Error(`no answer from the hub within ${options.timeoutMs} ms`, { cause: error });
      throw error;
    }
    let conflicts = 0;
    for (const id of touched) conflicts += this.log.conflictsOf(id).length;
    return { cursor, applied, conflicts };
  }

  private async replicateOnceWithin(
    options: ReplicationOptions,
    from: SyncCursor,
    cursor: { pull?: number; push?: number },
    touched: Set<string>,
    signal: AbortSignal | undefined,
    count: (applied: number) => void,
  ): Promise<void> {
    if (options.direction === 'pull' || options.direction === 'duplex') {
      // A one-shot pull is a `?since=` read of the stream, not a subscription — the same endpoint,
      // read to its first caught-up marker.
      const records = await this.fetchSince(from.pull ?? 0, signal);
      for (const record of records) {
        if (this.applyRecord(record)) {
          count(1);
          touched.add(record.entityId);
        }
      }
      cursor.pull = records.length
        ? records[records.length - 1].seq
        : (from.pull ?? 0);
    }

    if (options.direction === 'push' || options.direction === 'duplex') {
      cursor.push = from.push ?? 0;
      cursor.push = await this.pushFrom(
        from.push ?? 0,
        (applied, at) => {
          count(applied);
          cursor.push = at;
        },
        () => false,
        signal,
      );
    }
  }

  /**
   * 🔴 Never stops because it has already caught up.
   *
   * "Caught up" reports `ready` and keeps the subscription. Prior art's coordinator returned early
   * once a checkpoint existed and so replicated exactly once — the failure this method is named
   * against.
   */
  public replicateContinuously(
    options: ReplicationOptions,
    events: ReplicationEvents = {},
  ): ReplicationSession {
    const session = { status: 'syncing' as SyncStatus };
    const from = options.from ?? {};

    const subscription =
      options.direction === 'push'
        ? undefined
        : this.client.subscribe(
            {
              onChange: (record) => {
                if (this.applyRecord(record)) events.onChange?.(1);
              },
              onPaused: () => {
                session.status = 'ready';
                events.onPaused?.();
              },
              onActive: () => {
                session.status = 'syncing';
                events.onActive?.();
              },
              onFailed: (error, cause) => {
                session.status = 'failed';
                // 🔴 An apply failure is terminal, and saying otherwise is worse than not
                // classifying at all. The client gives up on it — no reconnect is scheduled —
                // while `'transient'` tells the caller to expect one, so a caller that trusts the
                // classification waits forever for a session that has already stopped. It also
                // *will* recur: the same record will fail the same way. `'terminal'` existed for
                // this and was emitted nowhere.
                events.onFailed?.(
                  error,
                  cause === 'apply' ? 'terminal' : 'transient',
                );
              },
            },
            from.pull ?? 0,
          );

    let pushCursor = from.push ?? 0;
    // 🔴 One push in flight at a time.
    //
    // The timer fired on a fixed interval regardless of whether the previous push had returned, so
    // a push slower than `pushIntervalMs` overlapped the next tick. Both read the same unadvanced
    // cursor and sent the same batch, and whichever resolved *second* wrote its cursor last — so a
    // slow first push completing after a fast second one moved `pushCursor` backwards, re-sending
    // everything between. Idempotency saved correctness; nothing saved the bandwidth or the cursor.
    let pushing = false;
    let cancelled = false;
    const pushTimer =
      options.direction === 'pull'
        ? undefined
        : setInterval(() => {
            if (pushing || cancelled) return;
            pushing = true;
            void this.pushFrom(
              pushCursor,
              (_applied, at) => {
                pushCursor = at;
              },
              () => cancelled,
            )
              .catch((error: Error) => {
                if (cancelled) return;
                session.status = 'failed';
                events.onFailed?.(error, 'transient');
              })
              .finally(() => {
                pushing = false;
              });
          }, this.pushIntervalMs);

    return {
      get status() {
        return session.status;
      },
      cancel: async () => {
        // Both, always. A cleared subscription with a live push timer still holds the event loop
        // open, and the symptom is a process that will not exit rather than a test that fails.
        //
        // The flag as well as the timer: clearing the interval stops the *next* push, and a drain
        // already running would otherwise continue to exhaustion.
        cancelled = true;
        if (pushTimer) clearInterval(pushTimer);
        await subscription?.cancel();
        session.status = 'idle';
      },
    };
  }

  /**
   * Push everything after `from`, in batches, until the log is exhausted. Returns the new cursor.
   *
   * 🔴 **A loop, because one read is not a backlog.** This read `log.since(cursor)` exactly once,
   * and `since()` defaults to `limit = 500` — so a spoke reconnecting with more than 500 unsent
   * revisions pushed the first 500, advanced its cursor past them, and *reported success*. The rest
   * were never sent and nothing retried them, because the cursor said they were done. Silent,
   * permanent, one-directional data loss, and worse than a failure because it looked like a sync.
   *
   * `replicator.ts`'s `drain` already loops. Two implementations of one behaviour disagreeing is
   * the finding under the finding — this now matches it.
   */
  private async pushFrom(
    from: number,
    onBatch: (applied: number, cursor: number) => void,
    stopped: () => boolean = () => false,
    signal?: AbortSignal,
  ): Promise<number> {
    let cursor = from;
    for (;;) {
      // 🔴 Checked every batch, not only at entry. The loop is now unbounded, so a `cancel()`
      // during a large drain would otherwise keep POSTing to a hub the caller has finished with,
      // and could set `status = 'failed'` after `cancel()` had already set `'idle'`.
      if (stopped()) return cursor;
      const batch = this.log.since(cursor);
      if (batch.length === 0) return cursor;

      // 🔴 Filter for sending, but take the cursor from the *scanned* window.
      //
      // A keyless entity is `local:` and has no cross-node identity, so it must not be sent. Taking
      // the cursor from the filtered batch instead would stall it: a full window of local-only rows
      // filters to nothing, which reads as "caught up", and every real change behind them is never
      // reached.
      const outgoing = batch.filter((record) => isReplicable(record.entityId));
      const applied =
        outgoing.length > 0 ? await this.client.push(outgoing, signal) : 0;
      cursor = batch[batch.length - 1].seq;
      // 🔴 Reported per batch, not only on a clean drain.
      //
      // Returning the cursor only at the end means a failure on batch N+1 discards the progress of
      // batches 1..N — so a backlog that cannot be drained in one attempt over a flaky link never
      // advances at all, and re-sends the same prefix on every retry forever. The loop fixed
      // truncation; this is what stops the loop from replacing it with a livelock.
      onBatch(applied, cursor);
    }
  }

  private applyRecord(record: ChangeRecord): boolean {
    return this.log.applyRemote({
      entityId: record.entityId,
      rev: record.rev,
      parentRev: record.parentRev,
      deleted: record.deleted,
      state: record.state,
    });
  }

  /** Read the stream once, up to its caught-up marker, rather than holding it open. */
  private async fetchSince(since: number, signal?: AbortSignal): Promise<ChangeRecord[]> {
    const response = await fetch(`${this.client.url}/changes?since=${since}`, {
      headers: {
        ...(await this.client.requestHeaders()),
        accept: 'text/event-stream',
      },
      signal,
    });
    // 🔴 A refusal is an error, not "nothing to pull". Returning an empty list on 401 made a spoke
    // with an expired token look perfectly in sync while receiving nothing.
    if (response.status === 401 || response.status === 403) {
      throw new Error(`pull refused: ${response.status}`);
    }
    // 🔴 So is every other non-OK answer (ADR-009 D7). This returned an empty list for a 502 or a 503,
    // so a spoke whose hub was down reported itself in sync while receiving nothing — found by the
    // downstream offline demo, whose "the hub goes down" step depended on seeing it.
    if (!response.ok) throw new Error(`pull failed: the hub answered ${response.status}`);
    if (!response.body) throw new Error('pull failed: the hub answered with no stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const records: ChangeRecord[] = [];
    let buffer = '';
    let caughtUp = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.startsWith(':')) {
            caughtUp = true;
            continue;
          }
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (line)
            records.push(JSON.parse(line.slice(5).trim()) as ChangeRecord);
        }
        if (caughtUp) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    // A stream that ends before the hub says it is caught up was cut off: what arrived is real (and
    // `applyRemote` is idempotent, so the next sync re-reading it is harmless), but "in sync" is not.
    if (!caughtUp) throw new Error('pull failed: the stream ended before the hub reported it was caught up');
    return records;
  }
}
