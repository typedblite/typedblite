# ADR-001: Embedded TypeDB for Graph Persistence

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision owners:** TypeDBLite maintainers
- **Amended by:** [ADR-002](adr-002-typeql-engine-as-a-port.md) — what this ADR depends on is TypeQL and its guarantees, not the TypeDB product; the engine becomes a port
- **Engine replaced 2026-08-29** — the third-party TypeDB WASM build was removed; TypeDBLite is the engine. Decisions 1 and 2 below are left as written and annotated

## Context

Graph data needs store-level invariants: a node id is unique, a node has at most one edge of a
given kind to a given target. These are constraints a document store or key/value store makes the
application's problem — the shape of a check-then-create race that two concurrent writers both pass
before either commits.

TypeDB is built for this. `@key` makes an attribute value unique at the store level, enforced on
every write, with no application code needed. A relation cannot name a role player that does not
exist — a dangling dependency is *unrepresentable* rather than merely discouraged.

The question was which TypeDB engine to embed. A remote TypeDB server was considered and rejected
for a concrete reason: this repository has no `docker-compose.yml`, Docker here is Docker Desktop
integration driven from Windows, and it has been unreliable in practice. A test tier that cannot
run is worse than no test tier — and the whole argument for a real database over a fake is that
*something proves the TypeQL is correct*.

Embedded WASM removes the daemon from that path: schema, constraints and TypeQL are exercised
in-process, in ordinary `nx test`, with no container and no port.

## Decision

> 🔴 **Decisions 1 and 2 were overtaken on 2026-08-29.** The third-party TypeDB WASM build was removed and
> **TypeDBLite** — a TypeQL engine on SQLite — is now what `TypeDbDatabase.open` loads. The reasoning
> below is untouched and still holds: it argues for **embedded, in-process, no daemon, TypeQL with
> store-level `@key` and relation guarantees**, and every word of that describes the replacement.
> What changed is which embedded engine provides it, after the dependency turned out to be an
> 11.5 MB opaque binary with no obtainable source ([ADR-002](adr-002-typeql-engine-as-a-port.md)).
>
> Two specifics below are now false, and are called out rather than edited away:
>
> - **Decision 2's `StorageAdapter` over snapshots is gone.** TypeDBLite writes through to a SQLite
>   file as it goes, so `storagePath` replaces it and the *"snapshot durability, not write-ahead
>   durability"* caveat — which this ADR named as the thing to revisit before anything user-facing
>   depended on it — no longer applies.
> - **The fetch shim and the WASM binary at boot are gone**, along with the cost this ADR accepted
>   for them in its Consequences.

1. **The durable store is TypeDB, embedded in-process via the third-party TypeDB WASM build, not a TypeDB
   server.**

   The package came from a second registry, which needed its own line in `.npmrc` — without it
   `npm install` failed with a bare 404 against `registry.npmjs.org` that read as a typo in the
   package name.

   A server was the obvious choice and is rejected for a concrete reason rather than a
   preferential one: this repository has **no `docker-compose.yml` at all**, Docker here is Docker
   Desktop integration driven from Windows, and it has been unreliable in practice. A test tier
   that cannot run is worse than no test tier — and the whole argument for a real database over a
   fake is that *something proves the TypeQL is correct*.

   Embedded WASM removes the daemon from that path entirely: schema, constraints and TypeQL are
   exercised in-process, in ordinary `nx test`, with no container and no port.

2. **Durability is a `StorageAdapter` over the filesystem.** The WASM database is in-memory by
   default and takes a three-method snapshot adapter (`loadSnapshot` / `saveSnapshot` /
   `deleteSnapshot`). A `FileStorageAdapter` writing `<name>.snap` gives durability across a
   process restart, and `persist()` is called explicitly rather than trusted to `close()`.

   **Stated plainly: this is snapshot durability, not write-ahead durability.** Data written since
   the last `persist()` is lost on a hard kill. That is the main thing to revisit before anything
   user-facing depends on it.

3. **The TypeDB substrate is generic; the schema and repositories belong to the application.**
   WASM initialisation, the file storage adapter and the database handle are infrastructure.
   The schema and the repositories belong in the application layer.

4. **The invariants move into the schema.** Entity keys are `@key` attributes. These are
   database-enforced, not application-enforced — which is the entire reason for choosing a real
   database over a `Map`.

   A constraint violation is translated into a domain error by matching TypeDB's own error chain —
   `[CNT9] Constraint '@unique' has been violated` — **scoped to the attribute name**, so an
   unrelated constraint added later is not misreported as a duplicate.

5. **The in-memory implementations are kept, not deleted.** They remain the fast default for unit
   tests and for a consumer that does not want a store.

## Deferred

- **Write-ahead durability** (Decision 2) — superseded by TypeDBLite's SQLite backing.
- **A general graph repository adapter** — the TypeDB substrate is generic; application-specific
  schemas and repositories are out of scope for the engine itself.

## Consequences

The graph store gains database-enforced invariants. The constraint violation that application code
cannot reliably prevent under concurrency becomes impossible.

The cost is a WASM binary loaded at boot and a fetch shim to load it, because the module resolves
its `.wasm` through `fetch` even in Node. Both are gone in the TypeDBLite replacement.

## Rejected alternatives

- **A TypeDB server via `docker-compose` + testcontainers.** The conventional choice, and the one
  originally planned. Rejected because Docker is unreliable on this host — the daemon was down and
  unstartable without a Windows-side action while this was being built, so the integration tier
  could not have been run even once. A verified WASM path that runs in `nx test` beats a
  better-shaped one that does not run.
- **`typedb-driver` 2.x.** Mature and gRPC-based, but it is the previous line: the driver family
  had already moved to `@typedb/driver-http` 3.x. Adopting 2.x here would mean porting to a
  version already being left behind, and its TypeQL differs.
- **A document store.** Already present and already durable. Rejected because it cannot
  express uniqueness invariants across documents or enforce one-edge-per-pair — these are exactly
  what a document store makes the application's problem.
- **Keeping in-memory repositories and adding an application-level uniqueness check.** Two concurrent
  writes both pass a check-then-create before either commits; the check makes the race narrower,
  not absent.
