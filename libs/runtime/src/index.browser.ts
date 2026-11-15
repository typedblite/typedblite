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
//
// 🔴 What this file exports is the public API, which semver covers (docs/guides/compatibility.md). It names what
// it exports rather than `export *` from a module, so a new helper in a module does not become a promise by
// accident. `test/public-api.test.ts` pins the list. An export marked `@internal` is there for this repository's
// own packages (the conformance suite), is left out of the API reference, and is not covered.
export {
  TypeDBLiteInterpreter,
  TypeDBLiteValue,
  type ConceptKind,
  type GivenRows,
  type QueryTrace,
  type TypeDBLiteOptions,
  type TypeDBLiteSchemaSnapshot,
  type WriteReport,
} from './interpreter.js';
export type { JsonValue } from './fetch.js';
export { instantOf, canonicalTemporal } from './temporal.js';
export {
  DiagnosticCode,
  diagnosticOf,
  attachDiagnostic,
  DIAGNOSTIC_SOURCE,
  MAX_DIAGNOSTICS,
  WHOLE_DOCUMENT,
  type DiagnosticCodeValue,
  type ExecutionReport,
} from './diagnostics.js';
// The change log is reached as `db.changeLog`, never constructed by a caller: its types only.
export type { ChangeLog, ChangeRecord, CompactionOptions, CompactionReport, EntityIdentity } from './change-log.js';
export { SqliteEngine, type EngineRow } from './sqlite-engine.js';
// Revisions are computed by `@typedblite/content-revision`; its functions are imported from there. Only the
// types the change log's own signatures use are re-exported here, and the engine's identity functions.
export { entityId, isReplicable, type CanonicalAttribute, type CanonicalRole, type EntityState } from './canonical.js';
export type { Leaf, Revision, RevisionInput } from './revision.js';
export {
  replicateOnce,
  type ReplicateOptions,
  type ReplicationEndpoint,
  type SyncCursor,
  type SyncDirection,
  type SyncOutcome,
} from './replicator.js';
export {
  ChangeStreamClient,
  type ChangeStreamClientOptions,
  type ChangeStreamHandlers,
  type ChangeStreamSubscription,
} from './change-stream-client.js';
export {
  TypeDBLiteReplicator,
  type ReplicationEvents,
  type ReplicationOptions,
  type ReplicationSession,
  type SyncErrorClass,
  type SyncStatus,
} from './typedblite-replicator.js';
export { FullTextIndex, type SearchHit } from './full-text.js';
export type {
  SqliteDatabase,
  SqliteNamedParameters,
  SqliteOpener,
  SqliteParameter,
  SqliteRow,
  SqliteRunResult,
  SqliteStatement,
} from './sqlite-database.js';
