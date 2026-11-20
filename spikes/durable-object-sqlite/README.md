# Spike: TypeDBLite on a Durable Object's SQLite storage

**Question.** Can TypeDBLite's interpreter run with a Cloudflare Durable Object's SQLite storage as its database, so
that apps running in Cloudflare Containers (which have no bindings of their own) can keep their TypeDBLite stores on
Cloudflare?

**Answer: yes, locally, with no change to the runtime.** A `SqliteDatabase` binding over `ctx.storage.sql`
(`src/durable-object-sqlite.ts`, about 340 lines with its comments) runs the unmodified interpreter. The same programs give the same
answers as on `node:sqlite`, failed writes leave nothing behind, and the store survives a restart. 17 of 17 checks
pass. Not yet measured: a deployed object, and a Container calling it.

Run on 2026-11-19 from `main` at `85f8144`, with wrangler 4.162.0 (local workerd).

```bash
cd spikes/durable-object-sqlite
npm install
npm run build    # bundles src/store.ts for workerd, and the Node baseline
npm run check    # starts `wrangler dev`, runs the checks against it over HTTP
```

It needs the runtime built first (`npm exec nx -- run typedblite-runtime:build` at the repository root). The spike
is not an Nx project and not in the gate.

## Why a Durable Object and not D1

The interpreter needs a **synchronous** SQLite (`libs/runtime/src/sqlite-database.ts`: about 250 call sites use a
statement's result on the next line, inside transactions). D1 is reachable only asynchronously, over a network, and
commits each statement on its own: `batch()` is atomic only for a list fixed in advance, and Cloudflare's D1 docs
don't describe interactive transactions. A Durable Object's `ctx.storage.sql.exec()` is synchronous and in-process, with
`?` parameters, FTS5 and `transactionSync()`.

## What the binding has to bridge

| Difference | What the binding does | Found by |
| --- | --- | --- |
| `sql.exec()` refuses `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` | The host runs each engine call as one `ctx.storage.transactionSync()` (`unitOfWork`). The interpreter's own transaction statements are absorbed as bookkeeping. Every rollback site in the runtime rethrows, so the error unwinds out of `transactionSync`, which rolls the call back | Cloudflare's docs; the rollback sites read on 2026-11-19 |
| A rollback the engine swallows could not be honoured | Refused loudly (`PartialRollbackError`) and counted. **0** in every check | The checks |
| The `temp` schema is refused (`SQLITE_AUTH`) | The FTS5 probe, the runtime's only use of `temp`, runs in `main` (the table is dropped straight away) | The first run |
| `PRAGMA busy_timeout` and `PRAGMA journal_mode` are refused | Answered by the binding: the object is its storage's only connection, so neither applies | The first run |
| No named parameters, only `?` | `:name` is rewritten to `?` once per SQL text, outside strings, identifiers and comments | Cloudflare's docs |
| No `changes`, and the cursor's `rowsWritten` is not the same number (it disagreed on 1,008 of the load test's writes; it counts index and FTS rows too) | `run()` reads `SELECT changes()` straight after the statement, as the WASM binding does | The checks |
| No `errcode` on errors | Restored from SQLite's message (`UNIQUE constraint failed` is 2067), so a duplicate `@key` is still reported as one | The checks |
| Blobs are `ArrayBuffer`s; there is no close | Converted both ways; `close()` does nothing | Cloudflare's docs |

`case_sensitive_like` and `foreign_keys` are accepted as they are.

## What the checks show

- **Parity with `node:sqlite`.** The playground's three examples and both notebooks (`try-it.tql.md`, nine cells,
  and the five-minute tour, seven) run through the playground's own runner (`apps/playground/src/run.ts`) on
  `node:sqlite` and in a Durable Object. The two results are deep-equal, including the refusal each notebook ends on.
- **Atomic writes.** A duplicate `@key` is refused with TypeDB's `CNT9`. A pipeline whose second insert fails keeps
  nothing of its first. Three units of work were rolled back by the platform, and none needed a partial rollback.
- **Transactions across several writes.** A request of several writes runs as one unit of work: when the last write
  fails none is kept, and when all succeed all are kept. This is what `SqliteEngine.transaction(work)` becomes when
  the caller is across a network: the work is sent whole, because no transaction can stay open between requests.
- **Full-text search** works: FTS5 is there, and the change log keeps the index.
- **Durable.** The store reads back the same after `wrangler dev` is stopped and started on the same storage.
- **Bundle:** 2.2 MiB, 389 KiB gzipped (the runtime's browser entry, Langium and the language package).

Numbers from the load test, local workerd, timed from outside over HTTP. These are not production latencies:

| | SQL statements | Time per request |
| --- | ---: | ---: |
| Insert one task (with `@key`, the change log and FTS) | 45 | 12.7 ms |
| Read one task by key | 2 | 8.5 ms |
| Read all 201 tasks | 202 | |

The read path runs one statement per row (`known-limitations.md`). On a Durable Object every statement is in-process,
so that costs CPU time, not round trips. On D1 each would be a network round trip.

## What this means for lean-agile-os

- **Shape:** one Durable Object per store, a Worker in front, and the CQRS app in a Container calling it over HTTP.
  lean-agile-os already reaches TypeDBLite only through the async five-method engine (`SqliteEngine`), so a small
  remote engine that sends those calls to the object would replace it without touching anything above the
  persistence layer (ADR-002 expects other engines behind that interface).
- **Transactions must be sent whole.** `libs/core/persistence/.../typedblite-database.ts` holds
  `engine.transaction(async work)` open across awaits. Across a network that becomes "send these statements as one
  transaction" (the spike's `transaction` operation). Work that reads in the middle of a transaction and decides
  what to write next would have to run inside the object.
- **A caller-held transaction across requests is not possible** (`Session`'s manual `begin`/`commit`), for the same
  reason.
- **One writer per store, by construction:** an object runs one request at a time, as SQLite allows one writer.

## Not answered here

1. Latency and CPU time on a **deployed** object, and from a **Container** through a Worker.
2. Cloudflare's per-object storage and CPU limits against real stores.
3. Replication: whether each object can act as a TypeDBLite hub or spoke, given that the change stream uses
   Server-Sent Events.
4. The runtime's own test suite against this binding (the WASM binding was proven that way, 494 of 515 tests). That is
   the step before moving it into `@typedblite/runtime` as an entry point of its own.
