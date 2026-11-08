# ADR-001: Embedded TypeDB for IAM Persistence

- **Status:** Accepted
- **Date:** 2026-08-28
- **Decision owners:** TypeDBLite maintainers
- **Feature:** [IAM TypeDB Persistence](../planning/iam-typedb-persistence/iam-typedb-persistence.feature.md)
- **Amended by:** [ADR-002](adr-002-typeql-engine-as-a-port.md) — what this ADR depends on is TypeQL and its guarantees, not the TypeDB product; the engine becomes a port
- **Engine replaced 2026-08-29** — `@downstream/typedb-wasm` removed; TypeQLite is the engine. Decisions 1 and 2 below are left as written and annotated

## Context

IAM's Phase 05 shipped the vocabulary and an `oidc-provider` server ([ADR-004](adr-004-oidc-provider-strategy.md)),
but every repository behind it is a `Map`: `InMemoryPrincipalRepository`,
`InMemoryMembershipRepository`, `InMemoryOidcModelAdapter`. Restart the gateway and every
principal, membership, session and grant is gone.

Two further gaps come with that. `IamApplicationModule` hard-wires
`{ provide: PRINCIPAL_REPOSITORY, useClass: InMemoryPrincipalRepository }`, so there is no seam to
swap an implementation in. And `RegisterPrincipalHandler` does a bare `save` with no existence
check — the same shape as the check-then-create race that produced duplicate-email Principals in
`hosted-app-ai-chat` on 2026-07-16.

[`VISION.md`](../VISION.md) already commits TypeDB as the **Graph** storage kind of three
(Documents → PouchDB, Graphs → TypeDB, Attachments → PouchDB attachments), and
[ADR-013](adr-013-pouchdb-persistence-for-durable-workflows.md) Decision 3 has
`PouchDbRepositoryAdapter` **refuse** `type: 'graph'` outright — *"that is TypeDB's shape"* — while
its Deferred section says *"Nothing here needs it yet."*

IAM is what needs it. Principals, organizations, memberships and roles are a graph, and the
invariants that matter — a principal id is unique, a principal has at most one membership per
organization — are exactly the class `downstream-monorepo`'s ADR-068 gives to TypeDB.

## Decision

> 🔴 **Decisions 1 and 2 were overtaken on 2026-08-29.** `@downstream/typedb-wasm` was removed and
> **TypeQLite** — a TypeQL engine on SQLite — is now what `TypeDbDatabase.open` loads. The reasoning
> below is untouched and still holds: it argues for **embedded, in-process, no daemon, TypeQL with
> store-level `@key` and relation guarantees**, and every word of that describes the replacement.
> What changed is which embedded engine provides it, after the dependency turned out to be an
> 11.5 MB opaque binary with no obtainable source ([ADR-002](adr-002-typeql-engine-as-a-port.md)).
>
> Two specifics below are now false, and are called out rather than edited away:
>
> - **Decision 2's `StorageAdapter` over snapshots is gone.** TypeQLite writes through to a SQLite
>   file as it goes, so `storagePath` replaces it and the *"snapshot durability, not write-ahead
>   durability"* caveat — which this ADR named as the thing to revisit before anything user-facing
>   depended on it — no longer applies.
> - **The fetch shim and the WASM binary at boot are gone**, along with the cost this ADR accepted
>   for them in its Consequences.

1. **IAM's durable store is TypeDB, embedded in-process via `@downstream/typedb-wasm`, not a TypeDB
   server.**

   The package is `@downstream/typedb-wasm`, installed under the `@downstream` alias, and needs
   `@jsr:registry=https://npm.jsr.io` in `.npmrc` — without it `npm install` fails with a bare 404
   against `registry.npmjs.org` that reads as a typo in the package name.

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
   the last `persist()` is lost on a hard kill. That is acceptable for IAM at this stage and it is
   the main thing to revisit before anything user-facing depends on it.

3. **The TypeDB substrate is generic; only the schema and repositories are IAM's.** WASM
   initialisation, the file storage adapter and the database handle live in
   `libs/core/persistence/infrastructure` beside the PouchDB adapter. The `iam.schema.typeql` and
   the repositories live in `libs/platform/iam/infrastructure`.

4. **ADR-013's `'graph'` refusal stands, unamended.** This does **not** implement the
   `RepositoryAdapter` contract's `'graph'` branch. That contract is document-shaped per-document
   CRUD, and forcing TypeQL through it would produce a lowest-common-denominator interface that
   serves neither. TypeDB is reached through its own `TypeDbDatabase` handle. `PouchDbRepositoryAdapter`
   continues to throw on `'graph'`, and correctly.

5. **The invariants move into the schema.** `principal-id` and `org-id` are `@key`. A membership
   carries a `membership-key` of `"<principalId>::<organizationId>"`, also `@key`, so one principal
   cannot hold two memberships of one organization. These are database-enforced, not
   application-enforced — which is the entire reason for choosing a real database over a `Map`.

   `RegisterPrincipalHandler` becomes genuinely idempotent rather than check-then-create, and a
   constraint violation is translated into a domain error by matching TypeDB's own error chain —
   `[CNT9] Constraint '@unique' has been violated` — **scoped to the attribute name**, so an
   unrelated constraint added later is not misreported as a duplicate registration.

6. **The in-memory repositories are kept, not deleted.** They remain the fast default for unit
   tests and for a consumer that does not want a store. `IamApplicationModule` stops hard-wiring
   `useClass` and takes providers, following `ScmApplicationModule.withPorts`.

## Deferred

- **Enforcing authorization.** `AuthorizationService`, `PolicyEvaluator` and `roleAllows` currently
  have **zero consumers** outside their own library: there is no guard, no interceptor, and every
  `api-gateway` route is unauthenticated today. That is a larger gap than persistence and it is
  explicitly **not** closed here — it is called out so the next decision is taken deliberately
  rather than discovered.
- **Persisting OIDC sessions, grants and tokens.** `InMemoryOidcModelAdapter` is unchanged, so
  tokens still die with the process. Principals outliving a restart while their sessions do not is
  an improvement, not a finished story.
- **A general `'graph'` adapter** in `libs/core/persistence` (Decision 4).
- **Write-ahead durability** (Decision 2).
- **Widening `Principal`** with `email`/`displayName`, which OIDC's `findAccount` would need to
  return real claims — it returns only `sub` today.

## Consequences

IAM gains a durable store and, more importantly, invariants the database enforces. The duplicate
registration that application code cannot reliably prevent under concurrency becomes impossible.

The cost is a WASM binary loaded at boot and a fetch shim to load it, because the module resolves
its `.wasm` through `fetch` even in Node. That shim is ported from `downstream-monorepo` and is ugly in a
way worth naming rather than hiding.

This is also the first `@jsr` dependency in the repository, so `.npmrc` grows a second reason to
exist beyond `legacy-peer-deps` — its comment previously said a JSR registry line was "not copied
here, because this repo has no @jsr dependencies", which is now false and has been corrected.

## Rejected alternatives

- **A TypeDB server via `docker-compose` + testcontainers.** The conventional choice, and the one
  originally planned. Rejected because Docker is unreliable on this host — the daemon was down and
  unstartable without a Windows-side action while this was being built, so the integration tier
  could not have been run even once. A verified WASM path that runs in `nx test` beats a
  better-shaped one that does not run.
- **`typedb-driver` 2.x.** Mature and gRPC-based, but it is the previous line: `downstream-monorepo` has
  45 source files on `@typedb/driver-http` 3.x against 2 legacy files on 2.x. Adopting 2.x here
  would mean porting to a version this family is already leaving, and its TypeQL differs.
- **PouchDB for IAM.** It is already present and already durable. Rejected because it cannot
  express either invariant — uniqueness across documents and one-membership-per-pair are exactly
  what a document store makes the application's problem, which is the bug being fixed.
- **Keeping the in-memory repositories and adding an application-level uniqueness check.** This is
  what `hosted-app-ai-chat` had. Two concurrent registrations both pass a check-then-create before
  either commits; the check makes the race narrower, not absent.
