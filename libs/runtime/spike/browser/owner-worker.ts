/* eslint-disable @typescript-eslint/no-non-null-assertion -- messages are validated by `op` before their fields are read */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';
import {
  initWasmSqlite,
  openWasmSqlite,
  poolInfo,
  wipeOpfsPool,
} from '../wasm-sqlite.js';

/**
 * SPIKE — a Worker that OWNS the database: it opens the OPFS file and runs whatever it is sent.
 *
 * 🔴 **The op surface below is a TEST surface and must not ship as is.** `pragma` runs arbitrary SQL,
 * and `armDie` and `bench` exist for the failure and cost harnesses; any same-origin tab can send them
 * over the BroadcastChannel. A shipped owner exposes an allow-list of named operations instead.
 *
 * One of these exists per database at a time. Who may spawn it (a single tab, or whichever tab
 * wins a Web Lock) is `tab.ts`'s concern; the crash test drives it directly.
 */
declare const performance: { now(): number };
declare const self: {
  close(): void;
  onmessage: ((event: { data: Message }) => void) | null;
  postMessage(message: unknown): void;
};

interface Message {
  id: number;
  op:
    | 'init'
    | 'execute'
    | 'query'
    | 'begin'
    | 'commit'
    | 'pragma'
    | 'close'
    | 'info'
    | 'armDie'
    | 'prune'
    | 'define'
    | 'appliedCount'
    | 'bench';
  text?: string;
  /** Stable across retries. When present, an `execute` is applied at most once, across owners. */
  requestId?: string;
  wipe?: boolean;
  schema?: string;
  /** `init`: how long an applied request id is remembered. */
  retentionMs?: number;
  /** `prune`: remove ids older than this many ms (default: the retention). */
  olderThanMs?: number;
  /** `bench`: how many writes, and whether each carries a request id. */
  count?: number;
  idempotent?: boolean;
}

const DB = '/reader.db';
/** TEST HOOK: when set, the next `execute` exits the Worker after applying and before replying. */
let dieAfterNextApply = false;
/** Set once the Worker has "died": from then on it neither answers nor acts. */
let dead = false;
let engine: TypeDBLiteInterpreter | undefined;

/**
 * How long a request id is remembered. A retry can only arrive while its client is still retrying
 * (60 attempts at 1 s by default), so ten minutes is ten times that window. An id older than this
 * has lost its protection: the same request re-sent later would be applied again.
 */
let retentionMs = 600_000;
const SWEEP_EVERY = 500;
let writesSinceSweep = 0;

function prune(olderThanMs: number): number {
  const result = rawDb()
    .prepare('DELETE FROM applied_request WHERE applied_at < ?')
    .run(Date.now() - olderThanMs);
  return Number(result.changes);
}

/**
 * Apply one write. With a `requestId` it is applied at most once: the id is looked up, the write is
 * applied and the id recorded, all in one transaction in the same file, so the answer survives a
 * change of owner.
 */
function applyWrite(
  writeText: string,
  requestId: string | undefined,
): { duplicate?: true } {
  if (requestId === undefined) {
    engine!.execute(writeText);
    return {};
  }
  engine!.beginTransaction();
  try {
    if (
      rawDb()
        .prepare('SELECT 1 AS seen FROM applied_request WHERE request_id = ?')
        .get(requestId)
    ) {
      engine!.rollbackTransaction();
      return { duplicate: true };
    }
    engine!.execute(writeText);
    rawDb()
      .prepare(
        'INSERT INTO applied_request(request_id, applied_at) VALUES (?, ?)',
      )
      .run(requestId, Date.now());
    engine!.commitTransaction();
  } catch (error) {
    engine!.rollbackTransaction();
    throw error;
  }
  if (++writesSinceSweep >= SWEEP_EVERY) {
    writesSinceSweep = 0;
    prune(retentionMs);
  }
  return {};
}

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : ((value as { asString?: () => string })?.asString?.() ?? String(value));

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(): Array<Record<string, unknown>>;
    get(...p: Array<string | number>): Record<string, unknown> | undefined;
    run(...p: Array<string | number>): { changes: number | bigint };
  };
}
/**
 * One result cell as plain data, so it survives postMessage and prints in a console. An attribute or
 * value is its string; a thing or a type is a small object, because reading either as a string throws.
 */
const cell = (value: unknown): unknown => {
  if (typeof value === 'string') return value;
  const v = value as {
    isThing(): boolean;
    isEntity(): boolean;
    isType(): boolean;
    type: string;
    iid: number;
    label: string;
    asString(): string;
  };
  if (v.isThing())
    return {
      kind: v.isEntity() ? 'entity' : 'relation',
      type: v.type,
      iid: v.iid,
    };
  if (v.isType()) return { kind: 'type', label: v.label };
  return v.asString();
};

const rawDb = (): RawDb => (engine as unknown as { db: RawDb }).db;

function exitIfArmed(): void {
  if (!dieAfterNextApply) return;
  dieAfterNextApply = false;
  dead = true; // the write is applied; this Worker never replies again
  self.close();
}

async function handle(message: Message): Promise<Record<string, unknown>> {
  switch (message.op) {
    case 'init': {
      await initWasmSqlite({
        moduleOptions: { locateFile: (file: string) => `/${file}` },
        sahPool: {
          name: 'typedblite-spike',
          directory: '/typedblite-spike',
          clearOnInit: false,
        },
      });
      if (message.wipe) await wipeOpfsPool();
      engine = new TypeDBLiteInterpreter(DB, 5000, {
        openDatabase: openWasmSqlite,
      });
      const hadSchema = engine.hasSchema;
      if (!hadSchema && message.schema !== undefined)
        engine.define(message.schema);
      // Requests already applied. It lives in the same file, so a write and its record commit together
      // and the answer survives a change of owner.
      rawDb().exec(
        'CREATE TABLE IF NOT EXISTS applied_request(request_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
      );
      rawDb().exec(
        'CREATE INDEX IF NOT EXISTS applied_request_at ON applied_request(applied_at)',
      );
      if (message.retentionMs !== undefined) retentionMs = message.retentionMs;
      prune(retentionMs); // a new owner starts by clearing what expired while there was none
      return { hadSchema, pool: poolInfo() };
    }
    case 'execute': {
      const result = applyWrite(message.text!, message.requestId);
      if (result.duplicate !== true) exitIfArmed();
      return result;
    }
    case 'prune':
      return { removed: prune(message.olderThanMs ?? retentionMs) };
    case 'appliedCount':
      return {
        count: Number(
          rawDb().prepare('SELECT count(*) AS n FROM applied_request').get()![
            'n'
          ],
        ),
      };
    case 'bench': {
      // Timed inside the Worker, so message passing is not part of the number.
      const run = String(Date.now());
      const started = performance.now();
      for (let i = 0; i < message.count!; i++) {
        applyWrite(
          `insert $p isa ping, has created-at "bench-${run}-${i}";`,
          message.idempotent ? `bench-${run}-${i}` : undefined,
        );
      }
      const ms = performance.now() - started;
      return { ms, perWriteMs: ms / message.count! };
    }
    case 'query': {
      const { rows } = engine!.query(message.text!);
      return {
        rows: rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, cell(value)]),
          ),
        ),
      };
    }
    case 'define':
      engine!.define(message.text!);
      return {};
    case 'begin':
      engine!.beginTransaction();
      return {};
    case 'commit':
      engine!.commitTransaction();
      return {};
    case 'pragma':
      return {
        rows: rawDb()
          .prepare(message.text!)
          .all()
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [k, text(v)]),
            ),
          ),
      };
    case 'close':
      engine?.close();
      engine = undefined;
      return {};
    case 'info':
      return { pool: poolInfo() };
    case 'armDie':
      dieAfterNextApply = true;
      return {};
  }
}

self.onmessage = async (event) => {
  if (dead) return;
  const message = event.data;
  try {
    const result = await handle(message);
    if (dead) return;
    self.postMessage({ id: message.id, ok: true, ...result });
  } catch (error) {
    if (dead) return;
    const e = error as Error;
    self.postMessage({
      id: message.id,
      ok: false,
      error: `${e.name}: ${e.message}`.split('\n')[0],
    });
  }
};
