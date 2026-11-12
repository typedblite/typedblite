# ADR-009: TypeDBLite Runs in the Browser on WASM SQLite

- **Status:** Accepted
- **Date:** 2026-11-12
- **Decision owners:** TypeDBLite maintainers
- **Amends:** [ADR-002](adr-002-typeql-engine-as-a-port.md) Decision 9, which retired an earlier
  WASM adapter
- **Feature:** [TypeDBLite Sync Demo](../planning/sync-demo/sync-demo.feature.md)

> Accepted under the founder's decision of 2026-11-12 to promote the WASM binding from a spike to
> supported API, so that the sync demo, and anyone else, can run TypeDBLite in a browser through the
> public package.

## Context

TypeDBLite is offline-first. That only means something if the engine runs where the user is, and
in a web app the user is in the browser. The `SqliteDatabase` interface was designed for this: a WASM
build of SQLite, running synchronously in a Web Worker, satisfies it. A spike proved it.
`libs/runtime/spike/wasm-sqlite.ts` ran the runtime suite on WASM SQLite. A demo in downstream-app
then ran the real interpreter on OPFS in Chromium, in Electron, and in Android's WebView, and synced
it with a hub.

But the spike is not something a user can depend on:
- **The binding is not exported**, and `@sqlite.org/sqlite-wasm` is not a dependency of this
  repository.
- **Bundling `@typedblite/runtime` for a browser pulls in `node:sqlite`, `node:http` and
  `node:crypto`.** The entry point re-exports the `node:sqlite` binding and the SSE hub, the
  interpreter imports `openNodeSqlite` as its default opener, and `@typedblite/content-revision`
  hashes revisions with `node:crypto`. The downstream-app demo got around this with an esbuild alias
  of its own.
- **Its test configuration does not start.** It imports a shared file from a path outside this
  repository.

ADR-002 Decision 9 retired a different WASM adapter: an opaque 11.5 MB binary, with no obtainable
source, that stood in for the engine. This is not that. The engine stays this repository's
TypeScript, and only SQLite itself is WASM: SQLite's own official build, published as
`@sqlite.org/sqlite-wasm` under Apache-2.0.

## Decision

1. **WASM SQLite is a supported binding.** `@typedblite/runtime/wasm` exports `initWasmSqlite`,
   `openWasmSqlite`, `wipeOpfsPool` and `poolInfo`. Persistence is OPFS through SQLite's SAH-pool VFS,
   which works in a dedicated Worker and needs neither `SharedArrayBuffer` nor COOP/COEP headers.
   Without the pool, a path opens in SQLite's in-memory `memdb`.

2. **`@sqlite.org/sqlite-wasm` is an optional peer dependency.** A Node user never installs it, and a
   browser user chooses the version. This repository pins it as a dev dependency, at 3.54.1-build1, for
   its own tests and the demo.

3. **The runtime has a browser entry point**, selected by the `browser` export condition. It exports
   everything except the `node:sqlite` binding and the SSE hub (`serveChangeStream` and
   `createChangeStreamHandler`), which are Node-only by nature. **The spoke side of replication
   (`TypeDBLiteReplicator`, `ChangeStreamClient`, `replicateOnce`) is in both entry points.** It
   is built on `fetch`.

4. **The interpreter's default opener is a conditional import, `#default-opener`.** Under `node`,
   it is `openNodeSqlite`. Elsewhere, it is an opener that refuses with a message saying to pass
   `openDatabase`. On Node, `new TypeDBLiteInterpreter()` keeps working exactly as before.

5. **Revisions are hashed by one synchronous SHA-256, written in TypeScript, everywhere.**
   `content-revision` stops importing `node:crypto`. With one implementation there is one code path,
   so a browser and a server cannot disagree by construction. It is still *proven* identical to
   `node:crypto` by a differential test, because a revision that changes splits every store that has
   one (ADR-003 Decision 3).

6. **The browser floor is documented, not polyfilled.** The runtime, through Chevrotain, calls
   `Object.groupBy`, which needs Chromium 117, Firefox 119 or Safari 17.4. The library does not patch
   globals. An application that targets older engines, such as Android 14's built-in WebView
   (Chromium 113), adds its own polyfill, as the sync demo does.

7. **A non-OK answer from a hub is an error, never "nothing to pull".** A spoke whose hub answers
   5xx, or does not answer in time, reports a failure. A spoke that reports itself in sync when it
   is not is the silent success that ADR-002 Decision 7 forbids.

## Alternatives rejected

- **Keep the alias trick.** Every browser user would need to know which internal file to swap, and
  the alias would break silently on any rename.
- **`node:crypto` on Node and Web Crypto in the browser.** Web Crypto's `digest` is asynchronous, and
  revisions are computed inside the synchronous write path. Two implementations would also be two
  ways to disagree.
- **Polyfill `Object.groupBy` inside the library.** That mutates the host's globals for every user,
  in order to serve a minority of users who can do it themselves.
- **A separate `@typedblite/runtime-wasm` package.** That adds a package to version and publish,
  for one module and one peer dependency. A subpath export is enough.

## Consequences

- **Positive:** a web app can depend on `@typedblite/runtime`, import `@typedblite/runtime/wasm`, and
  run the real engine, offline, with its data in OPFS and replication to a hub. The sync demo
  proves this end to end.
- **Positive:** the WASM test configuration becomes a real target, so the binding is tested on
  every run instead of in a spike.
- **Constraint:** `content-revision`'s hash is now this repository's own code. It is guarded by a
  differential test against `node:crypto`. Treat any change to it as a change to the revision
  algorithm.
- **Constraint:** OPFS through the SAH pool supports one connection per file at a time. Two tabs on
  one store need coordinating, for example through a single worker or a lock. The binding documents
  this, and does not solve it.
