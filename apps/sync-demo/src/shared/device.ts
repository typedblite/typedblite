import { DiagnosticCode, TypeDBLiteReplicator, diagnosticOf, isReplicable, type SyncCursor, type TypeDBLiteInterpreter } from '@typedblite/runtime';

import { flag, readTasks, SCHEMA, text, type Task } from './schema.js';

/** The bearer token every device presents to the demo hub — the replicator's `headers` hook, shown. */
export const DEMO_TOKEN = 'typedblite-sync-demo';

export interface DeviceOptions {
  /** The cursor saved by the last session, so a restarted device resumes rather than starts over. */
  readonly cursor?: SyncCursor;
  /** A sync the hub has not answered within this long has failed. */
  readonly timeoutMs?: number;
}

export interface DeviceState {
  readonly device: string;
  readonly tasks: Task[];
  /** Tasks with a change the hub has not been sent yet: the offline journal, counted. */
  readonly pending: number;
  /** `undefined` until the first sync has finished either way. */
  readonly online: boolean | undefined;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly cursor: SyncCursor;
}

/**
 * One device of the demo: a TypeDBLite store, and a sync with the hub.
 *
 * Platform-neutral on purpose — it imports only `@typedblite/runtime`, so the same class runs in a
 * browser Web Worker (on WASM SQLite and OPFS), in Electron and Android's WebViews, and in Node for
 * the headless smoke run. **Every write lands in the local store first**; the engine records it in
 * the change log in the same transaction; `syncOnce` replicates that log with the hub, both ways.
 * Offline, the change log *is* the journal: the next successful sync sends everything after the push
 * cursor.
 */
export class DemoDevice {
  private cursor: SyncCursor;
  private online: boolean | undefined;
  private lastSyncedAt: string | undefined;
  private lastError: string | undefined;
  private syncing = false;
  private readonly replicator: TypeDBLiteReplicator;

  constructor(
    readonly name: string,
    private readonly db: TypeDBLiteInterpreter,
    hubUrl: string,
    private readonly options: DeviceOptions = {},
  ) {
    // Define on every open: it is idempotent, and it restores what a reopened store needs.
    db.define(SCHEMA);
    this.cursor = options.cursor ?? {};
    this.replicator = new TypeDBLiteReplicator(db.changeLog, hubUrl, 100, () => ({ authorization: `Bearer ${DEMO_TOKEN}` }));
  }

  addTask(title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.db.execute(
      'given $id: string, $title: string, $at: string, $origin: string, $by: string; ' +
        'insert $t isa task, has task-id $id, has title $title, has done false, has created-at $at, has origin $origin, has edited-by $by;',
      [{ id: text(globalThis.crypto.randomUUID()), title: text(trimmed), at: text(new Date().toISOString()), origin: text(this.name), by: text(this.name) }],
    );
  }

  setDone(id: string, done: boolean): void {
    // `has task-id == $id`, not `has task-id $id`: a given `$id` is a string VALUE, and `has … $id`
    // would bind an attribute — matching nothing, and writing nothing.
    //
    // 🔴 `edited-by` is written in the same `update` as `done`, so the change and its author are one revision and travel
    // together: every device can say who made the latest change. And a write that changes nothing is not made: setting
    // `done` to what it already is would still change `edited-by`, and show as an edit by this device that no one sees.
    if (this.tasks().find((task) => task.id === id)?.done === done) return;
    const report = this.db.execute(
      'given $id: string, $done: boolean, $by: string; match $t isa task, has task-id == $id; update $t has done $done, has edited-by $by;',
      [{ id: text(id), done: flag(done), by: text(this.name) }],
    );
    // An update that matched nothing reports it as a fact, not a refusal; here it is a bug, so say so.
    if (report.diagnostics.some((diagnostic) => diagnostic.code === DiagnosticCode.emptyMatch)) {
      throw new Error(`No task '${id}' on this device.`);
    }
  }

  tasks(): Task[] {
    return readTasks(this.db);
  }

  /** Tasks changed here and not yet pushed: distinct replicable entities after the push cursor. */
  pending(): number {
    const ids = new Set<string>();
    for (const record of this.db.changeLog.since(this.cursor.push ?? 0, 100_000)) {
      if (isReplicable(record.entityId)) ids.add(record.entityId);
    }
    return ids.size;
  }

  /**
   * Replicate with the hub, both ways. Never throws: a failed sync is the device being offline, which
   * the demo shows, and which the next successful sync recovers from. Returns how many changes it
   * applied, or `undefined` when the sync failed.
   */
  async syncOnce(): Promise<number | undefined> {
    if (this.syncing) return 0;
    this.syncing = true;
    try {
      const outcome = await this.replicator.replicateOnce({ direction: 'duplex', from: this.cursor, timeoutMs: this.options.timeoutMs ?? 8_000 });
      this.cursor = { ...this.cursor, ...outcome.cursor };
      this.online = true;
      this.lastError = undefined;
      this.lastSyncedAt = new Date().toISOString();
      return outcome.applied;
    } catch (error) {
      this.online = false;
      // A refusal carries its diagnostic code; a network failure is just the error.
      const code = diagnosticOf(error)?.code;
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = code === undefined ? message : `${String(code)}: ${message}`;
      return undefined;
    } finally {
      this.syncing = false;
    }
  }

  state(): DeviceState {
    return {
      device: this.name,
      tasks: this.tasks(),
      pending: this.pending(),
      online: this.online,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      cursor: this.cursor,
    };
  }
}
