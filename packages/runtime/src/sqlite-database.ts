/**
 * The synchronous SQLite surface TypeDBLite's interpreter runs against.
 *
 * Measured 2026-10-22 over `interpreter.ts`, `schema-mutation.ts`, `change-log.ts` and
 * `full-text.ts`: this is every part of `node:sqlite`'s `DatabaseSync` they use, and nothing more.
 * It exists so a second binding (a WASM SQLite in a browser or a Capacitor WebView) can be handed to
 * the interpreter without the interpreter importing `node:sqlite`. Only `node-sqlite.ts` does.
 *
 * 🔴 **Synchronous on purpose.** About 250 call sites run a statement and use its result on the
 * next line, inside transactions. An async binding (the Capacitor SQLite plugin crosses a native
 * bridge, so every call is a Promise) does not satisfy this interface; it would mean making the
 * interpreter async throughout. A binding that is synchronous inside a Web Worker does satisfy it.
 *
 * What a binding must honour beyond the types:
 *
 * - **Bare named parameters.** `.all({ id })` and `.run({ keep })` bind `:id` and `:keep` — the
 *   object's keys carry no prefix. `node:sqlite` allows this by default; most WASM bindings need
 *   the keys prefixed (`{ ':id': id }`), so an adapter must translate.
 * - **Positional parameters** (`?`) as spread arguments.
 * - **Rows are plain objects keyed by column name**, and `INTEGER` columns come back as `number`.
 * - **Errors carry SQLite's own message text and a numeric `errcode`.** `translateConstraintError`
 *   matches `errcode === 2067` (`SQLITE_CONSTRAINT_UNIQUE`), and one catch matches
 *   `/UNIQUE constraint failed/` on the message. An adapter that throws a bare string or wraps the
 *   error without these silently turns a reported duplicate into an unreported one.
 * - **`run()` reports `changes`** exactly — see `SqliteStatement.run`.
 * - **`exec` runs more than one statement** when given more than one (schema DDL does).
 * - **The pragmas the constructor sets** (`busy_timeout`, `case_sensitive_like`, `journal_mode`)
 *   must be accepted. A binding with no WAL (an in-memory or single-connection OPFS database) may
 *   report a different journal mode, which the engine already tolerates; it must not throw.
 */
export type SqliteParameter = string | number | bigint | null | Uint8Array;

/** A row as SQLite returns it: column name to value. */
export type SqliteRow = Record<string, unknown>;

/** Named parameters, keyed WITHOUT the `:`/`@`/`$` prefix. */
export type SqliteNamedParameters = Record<string, SqliteParameter>;

/** What `run` reports. Only `changes` is read — see `SqliteStatement.run`. */
export interface SqliteRunResult {
  /** Rows inserted, updated or deleted. `node:sqlite` returns a `number` (a `bigint` only when asked). */
  readonly changes: number | bigint;
}

/**
 * The overloads mirror `node:sqlite`'s: positional parameters, or one named-parameter object
 * (optionally followed by positional ones).
 */
export interface SqliteStatement {
  /** The first row, or `undefined` when there is none. */
  get(...parameters: SqliteParameter[]): SqliteRow | undefined;
  get(named: SqliteNamedParameters, ...parameters: SqliteParameter[]): SqliteRow | undefined;
  all(...parameters: SqliteParameter[]): SqliteRow[];
  all(named: SqliteNamedParameters, ...parameters: SqliteParameter[]): SqliteRow[];
  /**
   * 🔴 `changes` IS read: `change-log.ts` runs an `INSERT OR IGNORE` and treats `changes > 0` as
   * "this revision was new" — the answer replication gives for whether a row was applied. A binding
   * that cannot report it exactly (many WASM wrappers expose `sqlite3_changes()` only on the
   * database, not per statement) must read it straight after the statement. `lastInsertRowid` is
   * read nowhere; do not rely on it without widening this contract first.
   */
  run(...parameters: SqliteParameter[]): SqliteRunResult;
  run(named: SqliteNamedParameters, ...parameters: SqliteParameter[]): SqliteRunResult;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /**
   * Whether a transaction is open on this handle. Optional: `node:sqlite` has it from Node 22.16
   * and 24.0, and the interpreter treats its absence as "unknown", not as "no".
   */
  readonly isTransaction?: boolean;
}

/** Opens a database at `location` (`:memory:` or a path the binding understands). */
export type SqliteOpener = (location: string) => SqliteDatabase;
