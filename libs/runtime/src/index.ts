/**
 * `@typedblite/runtime` on Node: everything the browser entry has, plus the `node:sqlite` binding and
 * the SSE hub ([ADR-009](../../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D3).
 *
 * The engine: TypeQLite on SQLite, with a change log, replication and full-text search. Start with
 * {@link TypeDBLiteInterpreter}.
 *
 * ```ts
 * import { TypeDBLiteInterpreter } from '@typedblite/runtime';
 *
 * const db = new TypeDBLiteInterpreter('./app.db'); // or ':memory:'
 * db.define(`
 *   define
 *     entity person, owns name @key;
 *     attribute name, value string;
 * `);
 * db.execute(`insert $p isa person, has name "Alice";`);
 *
 * const { rows } = db.query(`
 *   match $p isa person, has name $n;
 *   select $n;
 * `);
 * console.log(rows[0].n.asString()); // Alice
 * ```
 *
 * Everything below is grouped by what it is for: the engine, what it takes and answers with, and the parts that let
 * two stores converge. The guides say how they fit together:
 * [Embedding the runtime](../../../docs/guides/embedding-the-runtime.md) covers the engine and its reports,
 * and [Replication and search](../../../docs/guides/replication-and-search.md) covers the change log, the sync hub
 * and the full-text index. For what a version promises, see
 * [Versions and compatibility](../../../docs/guides/compatibility.md).
 *
 * @categoryDescription Engine
 * The interpreter that runs TypeQLite against SQLite, the cells and reports it answers with, and `SqliteEngine`, the
 * same engine behind an `async` interface.
 *
 * @categoryDescription Diagnostics
 * How a refusal or a warning is reported: the codes a program can branch on, and the diagnostic an error carries.
 *
 * @categoryDescription Change log
 * Every committed write is recorded as a revision. The log is what replication reads and applies, and what compaction
 * trims.
 *
 * @categoryDescription Full-text search
 * The index kept current by the change log, reached as `db.changeLog.fullText`.
 *
 * @categoryDescription Replication
 * Converging two change logs: once on demand with `replicateOnce`, or continuously against a hub with
 * `TypeDBLiteReplicator`.
 *
 * @categoryDescription Change stream
 * The hub's server-sent-events stream of changes, and the client that follows it. Serving a stream needs Node;
 * following one needs only `fetch`.
 *
 * @categoryDescription Canonical form
 * Re-exported from `@typedblite/content-revision`: the state a revision covers.
 *
 * @categoryDescription Revisions
 * Re-exported from `@typedblite/content-revision`: the revision a change log records for each write, and the leaves of a
 * thing's revision tree.
 *
 * @categoryDescription SQLite binding
 * The synchronous SQLite surface the engine runs against, and the opener for Node's `node:sqlite`. A browser passes
 * `openWasmSqlite` from `@typedblite/runtime/wasm` instead.
 *
 * @module @typedblite/runtime
 */
export * from './index.browser.js';
export { createChangeStreamHandler, serveChangeStream, type ChangeStreamOptions } from './change-stream.js';
export { openNodeSqlite } from './node-sqlite.js';
