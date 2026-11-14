# @typedblite/runtime

The TypeDBLite engine: it runs TypeQLite against a SQLite database inside your process, and keeps a
change log that replication and full-text search are built on.

```bash
npm install @typedblite/runtime
```

Requires Node.js 22.16 or later (`node:sqlite`). In a browser, it runs on WASM SQLite: see
[In the browser](#in-the-browser).

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
| `SqliteDatabase`, `SqliteOpener`, `openNodeSqlite` | The binding interface, and its `node:sqlite` implementation (Node only) |
| `initWasmSqlite`, `openWasmSqlite`, `wipeOpfsPool`, `poolInfo` | From `@typedblite/runtime/wasm`: the binding on WASM SQLite, with OPFS persistence |

## Storage

The storage model mirrors TypeDB's, not a table per type. Every store has the same fixed tables:
`thing` (one row per entity or relation), `attribute` (one row per type and value), `has`
(ownership), `role_player`, `type_parent`, and `schema_*` tables recording the schema. `@key` and
`@unique` are partial `UNIQUE` indexes, and role players have foreign keys to `thing`. A duplicate
key or a dangling role player is therefore refused by SQLite itself.
[Architecture](../../docs/development/architecture.md#the-storage-model) has the details.

## In the browser

TypeDBLite runs in a browser, Electron or a Capacitor WebView on the official SQLite WASM build
([ADR-009](../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md)):

```bash
npm install @typedblite/runtime @sqlite.org/sqlite-wasm
```

```ts
// In a dedicated Web Worker:
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { initWasmSqlite, openWasmSqlite } from '@typedblite/runtime/wasm';

await initWasmSqlite({
  moduleOptions: { locateFile: (file) => `/${file}` }, // where you serve sqlite3.wasm
  sahPool: { name: 'my-app' },                         // persist in OPFS
});
const db = new TypeDBLiteInterpreter('/tasks.db', undefined, { openDatabase: openWasmSqlite });
db.define(schema); // on every open: it restores the store's key ownerships
```

- **A bundler picks the browser entry** through the `browser` export condition. It has everything
  except the `node:sqlite` binding and the SSE hub. Replicating to a hub with `TypeDBLiteReplicator`
  works from the browser.
- **Persistence is OPFS through SQLite's SAH-pool VFS.** That works in a dedicated Worker, and needs
  neither `SharedArrayBuffer` nor COOP/COEP headers. Without `sahPool`, a path is held in memory for
  the life of the page.
- **One connection per store.** The SAH pool allows one connection to a file at a time. Give a store
  one owner: a single worker, or one elected tab.
- **Browser floor: Chromium 117, Firefox 119, Safari 17.4.** The parser calls `Object.groupBy`. For
  an older engine, such as Android 14's built-in WebView (Chromium 113), add a polyfill before
  importing the runtime.
- **Serve `sqlite3.wasm`** from `@sqlite.org/sqlite-wasm/dist/`, and point `locateFile` at it.

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

Tests live in `test/*.test.ts`. Two more targets run the engine on WASM SQLite:

```bash
npm exec nx -- run typedblite-runtime:test-wasm     # the whole suite on WASM SQLite, in Node
npm exec nx -- run typedblite-runtime:test-browser  # in a real Chromium, on OPFS (needs Playwright's Chromium)
```

See [Testing](../../docs/development/testing.md).
