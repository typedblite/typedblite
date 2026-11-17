/**
 * The SQLite binding on the official WASM build, for a browser, a Web Worker, Electron or a Capacitor WebView
 * (ADR-009). Call {@link initWasmSqlite} once, then pass {@link openWasmSqlite} as `openDatabase`.
 *
 * ```ts
 * import { TypeDBLiteInterpreter } from '@typedblite/runtime';
 * import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';
 *
 * await initWasmSqlite();
 * const db = new TypeDBLiteInterpreter(':memory:', undefined, { openDatabase: openWasmSqlite });
 * ```
 *
 * @categoryDescription SQLite binding
 * Starting SQLite's WASM build and opening a database with it, in memory or persisted to the Origin Private File System.
 *
 * @module @typedblite/runtime/wasm
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
  SqliteDatabase,
  SqliteNamedParameters,
  SqliteOpener,
  SqliteParameter,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from './sqlite-database.js';

/**
 * `@typedblite/runtime/wasm` — TypeDBLite on the official SQLite WASM build (`@sqlite.org/sqlite-wasm`)
 * ([ADR-009](../../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D1).
 *
 * It satisfies the SYNCHRONOUS interface in `sqlite-database.ts`, which holds wherever the WASM module
 * is initialised before an interpreter is constructed: a Web Worker in a browser, Electron or a
 * Capacitor WebView, and Node for tests. Initialisation is the one asynchronous step and cannot hide
 * in a synchronous opener, so callers `await initWasmSqlite()` once, first:
 *
 * ```ts
 * import { TypeDBLiteInterpreter } from '@typedblite/runtime';
 * import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';
 *
 * await initWasmSqlite({ sahPool: { name: 'my-app' } }); // OPFS, in a dedicated Worker
 * const db = new TypeDBLiteInterpreter('/tasks.db', undefined, { openDatabase: openWasmSqlite });
 * ```
 *
 * 🔴 **OPFS through the SAH pool allows one connection per file.** Two tabs on one store need one
 * owner (a single worker, or a Web Lock); this binding does not coordinate them.
 *
 * Proven in a spike first (494 of 515 runtime tests on WASM, the rest being the binding's honest
 * limits) and now tested by `vitest.wasm.config.ts` and `test-browser/`.
 */
type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Oo1Db = InstanceType<Sqlite3['oo1']['DB']>;

let sqlite3: Sqlite3 | undefined;
const keepers = new Map<string, Oo1Db>();

/**
 * How {@link initWasmSqlite} starts SQLite.
 *
 * @category SQLite binding
 */
export interface WasmSqliteOptions {
  /** Emscripten module options, for example `locateFile` when the `.wasm` is served from a URL. */
  readonly moduleOptions?: Record<string, unknown>;
  /**
   * Persist to the Origin Private File System through the SAH-pool VFS. Worker-only. It needs no
   * `SharedArrayBuffer`, so no COOP/COEP headers. When set, every path opens in OPFS and
   * persists; when absent, a path opens in SQLite's in-memory `memdb` (see `openWasmSqlite`).
   */
  readonly sahPool?: {
    readonly name?: string;
    readonly directory?: string;
    readonly clearOnInit?: boolean;
  };
}

/** Present only after `initWasmSqlite({ sahPool })`; the pool utility that opens and wipes files. */
type PoolUtil = {
  OpfsSAHPoolDb: new (path: string) => Oo1Db;
  wipeFiles(): Promise<void>;
  getFileNames(): string[];
  getFileCount(): number;
  getCapacity(): number;
};
let pool: PoolUtil | undefined;

/**
 * Initialises the WASM SQLite module, once, and optionally installs OPFS persistence. Call it, and await it, before
 * constructing an interpreter with {@link openWasmSqlite}. Calling it again returns the module already loaded.
 *
 * @param options Where to find the `.wasm`, and whether to persist to the Origin Private File System.
 * @returns The initialised `@sqlite.org/sqlite-wasm` module.
 * @category SQLite binding
 */
export async function initWasmSqlite(
  options: WasmSqliteOptions = {},
): Promise<Sqlite3> {
  // The package's typings declare `sqlite3InitModule()` with no parameters; it does take Emscripten
  // module options, which is how the output hooks are set.
  const init = sqlite3InitModule as unknown as (
    options: Record<string, unknown>,
  ) => Promise<Sqlite3>;
  sqlite3 ??= await init({
    print: () => undefined,
    printErr: () => undefined,
    ...options.moduleOptions,
  });
  if (options.sahPool !== undefined && pool === undefined) {
    const install = (
      sqlite3 as unknown as {
        installOpfsSAHPoolVfs: (o: object) => Promise<PoolUtil>;
      }
    ).installOpfsSAHPoolVfs;
    pool = await install.call(sqlite3, options.sahPool);
  }
  return sqlite3;
}

/**
 * What the SAH pool holds: for diagnosing a database that is not where it was left.
 *
 * @category SQLite binding
 */
export function poolInfo(): { files: string[]; capacity: number } | undefined {
  return pool === undefined
    ? undefined
    : { files: pool.getFileNames(), capacity: pool.getCapacity() };
}

/**
 * Remove every database file in the SAH pool (for a clean run).
 *
 * @category SQLite binding
 */
export async function wipeOpfsPool(): Promise<void> {
  await pool?.wipeFiles();
}

const isNamed = (value: unknown): value is SqliteNamedParameters =>
  typeof value === 'object' && value !== null && !(value instanceof Uint8Array);

/**
 * 🔴 `node:sqlite` surfaces SQLite's extended result code as `errcode`; this binding calls it
 * `resultCode`. `translateConstraintError` reads `errcode === 2067`, so without this copy a
 * duplicate `@unique` registration would stop being reported as one.
 */
const withErrcode = (error: unknown): unknown => {
  if (typeof error === 'object' && error !== null && 'resultCode' in error) {
    (error as { errcode?: unknown }).errcode = (
      error as { resultCode: unknown }
    ).resultCode;
  }
  return error;
};

function bind(
  statement: ReturnType<Oo1Db['prepare']>,
  parameters: unknown[],
): void {
  if (parameters.length === 0) return;
  const [first, ...rest] = parameters;
  if (isNamed(first)) {
    if (rest.length > 0)
      throw new Error(
        'Named parameters mixed with positional ones are not supported.',
      );
    // Bare names, as `node:sqlite` takes them; this binding wants the `:` the SQL spells.
    const named: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(first)) named[`:${key}`] = value;
    statement.bind(named as never);
    return;
  }
  statement.bind(parameters as never);
}

class WasmStatement implements SqliteStatement {
  constructor(
    private readonly db: Oo1Db,
    private readonly sql: string,
  ) {}

  /**
   * Prepares per call and finalises in `finally`: `node:sqlite` frees statements with the garbage
   * collector, and a WASM statement is leaked heap memory until it is finalised. The interpreter
   * prepares inline at ~250 call sites, so holding them would leak on every call.
   */
  private use<T>(
    parameters: unknown[],
    body: (statement: ReturnType<Oo1Db['prepare']>) => T,
  ): T {
    try {
      const statement = this.db.prepare(this.sql);
      try {
        bind(statement, parameters);
        return body(statement);
      } finally {
        statement.finalize();
      }
    } catch (error) {
      throw withErrcode(error);
    }
  }

  get(...parameters: unknown[]): SqliteRow | undefined {
    return this.use(parameters, (statement) =>
      statement.step() ? (statement.get({}) as SqliteRow) : undefined,
    );
  }

  all(...parameters: unknown[]): SqliteRow[] {
    return this.use(parameters, (statement) => {
      const rows: SqliteRow[] = [];
      while (statement.step()) rows.push(statement.get({}) as SqliteRow);
      return rows;
    });
  }

  run(...parameters: unknown[]): SqliteRunResult {
    return this.use(parameters, (statement) => {
      while (statement.step()) {
        // A statement that returns rows (`RETURNING`) is stepped to completion.
      }
      // `sqlite3_changes()` is per connection; reading it straight after the step, before the next
      // statement runs, makes it this statement's count.
      return { changes: this.db.changes() };
    });
  }
}

class WasmDatabase implements SqliteDatabase {
  constructor(
    private readonly sqlite: Sqlite3,
    private readonly db: Oo1Db,
  ) {}

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (error) {
      throw withErrcode(error);
    }
  }

  prepare(sql: string): SqliteStatement {
    return new WasmStatement(this.db, sql);
  }

  close(): void {
    this.db.close();
  }

  /** `node:sqlite`'s `isTransaction` is `!sqlite3_get_autocommit()`. */
  get isTransaction(): boolean {
    return this.sqlite.capi.sqlite3_get_autocommit(this.db) === 0;
  }
}

/**
 * A synchronous opener. Throws if `initWasmSqlite()` has not completed.
 *
 * @category SQLite binding
 */
export const openWasmSqlite: SqliteOpener = (
  location: string,
): SqliteDatabase => {
  if (sqlite3 === undefined)
    throw new Error(
      'initWasmSqlite() must complete before a database is opened.',
    );
  // With the OPFS SAH pool installed every path persists in OPFS; there is deliberately no quiet
  // fallback to memory from here, because a database that silently is not durable passes every
  // test that does not restart the browser.
  if (pool !== undefined) {
    return new WasmDatabase(
      sqlite3,
      new pool.OpfsSAHPoolDb(
        location.startsWith('/') ? location : `/${location}`,
      ),
    );
  }
  // `c`: create. A path has no real file behind it here. SQLite's `memdb` VFS keeps a database
  // alive by name for the life of the process, so closing and reopening the same path sees the
  // same data — enough to exercise reopen logic, and NOT durability: nothing survives a restart,
  // and a second process cannot see it. Real persistence needs OPFS in a browser or WebView.
  if (location === ':memory:')
    return new WasmDatabase(sqlite3, new sqlite3.oo1.DB(location, 'c'));
  const filename = `file:${location}?vfs=memdb`;
  // `memdb` frees a database when its LAST connection closes, which a real file does not do. A
  // keeper connection per path, never closed, stands in for the file staying on disk. It holds one
  // connection per distinct path for the life of the process: without OPFS, that is what a path is.
  if (!keepers.has(location))
    keepers.set(location, new sqlite3.oo1.DB(filename, 'c'));
  return new WasmDatabase(sqlite3, new sqlite3.oo1.DB(filename, 'c'));
};

export type { SqliteParameter };
