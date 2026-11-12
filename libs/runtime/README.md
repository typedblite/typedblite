# @typedblite/runtime

The TypeDBLite engine: it runs TypeQLite against a SQLite database inside your process, and keeps a
change log that replication and full-text search are built on.

```bash
npm install @typedblite/runtime
```

Requires Node.js 22.12 or later (`node:sqlite`), or a synchronous SQLite binding of your own.

## Quick usage

```ts
import { TypeDBLiteInterpreter } from '@typedblite/runtime';

const db = new TypeDBLiteInterpreter(':memory:'); // or './my.db'

db.define(`
  define
    entity person, owns name @key;
    attribute name, value string;
`);

db.execute(`insert $p isa person, has name "Alice";`);

const { rows } = db.query(`match $p isa person, has name $n; select $n;`);
rows[0]?.n.asString(); // 'Alice'
```

**Guides:** [Embedding the runtime](../../docs/guides/embedding-the-runtime.md) ·
[The TypeQLite language](../../docs/guides/typeqlite-language.md) ·
[Replication and search](../../docs/guides/replication-and-search.md)

## What this package provides

| Export | What it is |
| ------ | ---------- |
| `TypeDBLiteInterpreter` | The engine. Synchronous: `define`, `execute`, `query`, transactions, `schemaSnapshot`, `changeLog` |
| `SqliteEngine` | An `async` wrapper with a `transaction(work)` helper, for code written against an asynchronous database interface ([ADR-002](../../docs/architecture/adr-002-typeql-engine-as-a-port.md)) |
| `TypeDBLiteValue` | A result cell: an entity, relation, attribute, value or type |
| `DiagnosticCode`, `diagnosticOf` | Stable codes for every fact and refusal, and how to read one from a thrown error ([ADR-004](../../docs/architecture/adr-004-typedblite-execution-diagnostics-as-a-returned-report.md)) |
| `ChangeLog` | Reached as `db.changeLog`: every committed write, with CouchDB-style revisions ([ADR-003](../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)) |
| `replicateOnce` | One-shot push, pull or duplex replication between two change logs |
| `serveChangeStream`, `createChangeStreamHandler` | The hub: an SSE stream of changes, and a POST endpoint for spokes |
| `TypeDBLiteReplicator`, `ChangeStreamClient` | The spoke: one-shot or continuous replication with a hub over HTTP |
| `FullTextIndex` | Reached as `db.changeLog.fullText`: FTS5 search over every recorded thing |
| `SqliteDatabase`, `SqliteOpener`, `openNodeSqlite` | The binding interface, and its `node:sqlite` implementation |

## Storage

The storage model mirrors TypeDB's, not a table per type. Every store has the same fixed tables:
`thing` (one row per entity or relation), `attribute` (one row per type and value), `has`
(ownership), `role_player`, `type_parent`, and `schema_*` tables recording the schema. `@key` and
`@unique` are partial `UNIQUE` indexes, and role players have foreign keys to `thing`. A duplicate
key or a dangling role player is therefore refused by SQLite itself.
[Architecture](../../docs/development/architecture.md#the-storage-model) has the details.

## SQLite binding

Only `node-sqlite.ts` imports `node:sqlite`. Everything else uses the `SqliteDatabase` interface in
`src/sqlite-database.ts`, so another binding can be passed as `{ openDatabase }`. A binding must be
**synchronous**, bind named parameters without a prefix (`{ id }` binds `:id`), report `changes`
exactly, run several statements in one `exec`, and include **FTS5**. A WASM SQLite running
synchronously in a Web Worker qualifies.

## Development

```bash
npm exec nx -- run typedblite-runtime:build
npm exec nx -- run typedblite-runtime:test
```

Tests live in `test/*.test.ts`. See [Testing](../../docs/development/testing.md), including the
note on the two optional configurations (`vitest.oracle.config.ts` and `vitest.wasm.config.ts`) that
do not currently run.
