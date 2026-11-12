/**
 * `@typedblite/runtime` under the `browser` export condition
 * ([ADR-009](../../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D3):
 * everything except what is Node by nature — the `node:sqlite` binding and the SSE hub
 * (`serveChangeStream`, `createChangeStreamHandler`, which need `node:http`).
 *
 * The spoke side of replication — `TypeDBLiteReplicator`, `ChangeStreamClient`, `replicateOnce` — is
 * here: it is built on `fetch`. Open a store with `openWasmSqlite` from `@typedblite/runtime/wasm`.
 *
 * 🔴 `index.ts` re-exports this file and adds the Node-only modules, so the two entry points cannot
 * drift apart. Nothing reachable from here may import `node:` — `browser-entry.test.ts` bundles it
 * for the browser and fails on any.
 */
export * from './sqlite-generator.js';
export * from './interpreter.js';
export type { JsonValue } from './fetch.js';
export { instantOf, canonicalTemporal } from './temporal.js';
export * from './diagnostics.js';
export * from './sqlite-engine.js';
export * from './canonical.js';
export * from './revision.js';
export * from './replicator.js';
export * from './change-stream-client.js';
export * from './typedblite-replicator.js';
export * from './full-text.js';
export * from './sqlite-database.js';
