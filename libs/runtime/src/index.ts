/**
 * `@typedblite/runtime` on Node: everything the browser entry has, plus the `node:sqlite` binding and
 * the SSE hub ([ADR-009](../../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D3).
 *
 * The engine: TypeQLite on SQLite, with a change log, replication and full-text search. Start with
 * {@link TypeDBLiteInterpreter}.
 *
 * @module @typedblite/runtime
 */
export * from './index.browser.js';
export { createChangeStreamHandler, serveChangeStream, type ChangeStreamOptions } from './change-stream.js';
export { openNodeSqlite } from './node-sqlite.js';
