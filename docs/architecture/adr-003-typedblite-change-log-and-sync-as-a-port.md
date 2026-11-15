# ADR-003: A Change Log Belongs to the Engine, and Sync Is a Port

- **Status:** Accepted
- **Date:** 2026-08-31
- **Decision owners:** TypeDBLite maintainers
- **Extends:** [ADR-002](adr-002-typeql-engine-as-a-port.md) — the engine gains a change log; the
  port boundary it established is unchanged
- **Feature:** TypeDBLite Sync
- **Amended by:** **Amendment from Phase 07 below**, 2026-09-04. Decision 3's
  revision generator has a **second consumer outside this engine**, and therefore no longer lives in
  it: `computeRevision` and the canonical encoding moved to `@typedblite/content-revision`. The
  semantics are unchanged — the move is what the boundary rules required, not a redesign.
- **Amended, 2026-11-15:** **A store checks a peer's revision against its content** (below). Accepted by the
  maintainer on 2026-11-15.
- **Evidence:** baseline analysis, conflict model, and port-and-transport scoping (phase planning docs, not in this repo)

> ✅ **Accepted by the founder, 2026-08-31.** Drafted by Phase 00 alongside its analysis and held at
> Proposed until a person accepted it.
>
> It was accepted after two review rounds closed fifteen findings — nine from a review of the whole
> feature run before the merge decision, and six from a re-review of those fixes, four of which the
> fixes had themselves introduced. 🔴 **None of the fifteen argued this decision was wrong**; every
> one was a place the implementation did not yet honour it, which is why acceptance waited for them
> to close rather than being reconsidered.
>
> 🔴 **One consequence was found while closing them and is recorded in Consequences below**: a
> relation without `@key` has no cross-node identity and therefore does not replicate.

---

## Context

Two facts about the substrate were measured on Node v24.19.0 rather than assumed, and they shape
everything below:

- **SQLite permits one writer at a time**, so write transactions commit serially and a change log's
  `seq` allocation order equals its commit order. A follower can trust `seq > cursor` with no gap
  handling — the problem log-tailing normally has to defend against does not arise.
- **`node:sqlite` exposes no update or commit hook.** The engine cannot tell anyone a row changed,
  so change detection must come from the writer, not the store.

Replication does not exist in this repository before this ADR. The nearest prior art is a
`SyncClient` whose only implementation fabricates a checkpoint token and replicates nothing,
wrapped in a coordinator that short-circuits once a checkpoint exists and therefore never replicates
twice. Its suite is green because it exercises the coordinator, not the client.

## Decision

1. **The change log is part of the engine, written in the same transaction as the data.** The row
   lands inside the interpreter's `BEGIN`/`COMMIT`, never after it and never derived from an event
   bus. A commit followed by a lost publish is a change that never replicates and that nothing
   detects. Writing it in the interpreter also means a write that bypasses the application is logged
   anyway, which is why bypassing writes are absorbed rather than forbidden.

2. **The cursor is `seq`, an `INTEGER PRIMARY KEY AUTOINCREMENT`.** `AUTOINCREMENT` is required, not
   stylistic: measured, a plain `INTEGER PRIMARY KEY` reuses a deleted rowid (`1, 2, 3`) where
   `AUTOINCREMENT` burns it (`1, 2, 4`). A reused `seq` makes a resuming follower skip a change or
   replay a different one under the same number.

3. **Conflicts are multi-version, CouchDB's semantics, and the winner rule is total.** `rev` is
   `generation-digest` with the digest derived from the canonical state, the parent revision and the
   deleted flag — so the same edit made independently on two nodes yields the same revision and
   converges without manufacturing a conflict. Live leaves beat tombstones, then highest generation,
   then greatest digest; a tie at the last step would require equal digests, which means the same
   revision rather than two. The rule never consults insertion order, arrival order or wall-clock,
   because those are exactly what differ between nodes.

4. **Losing revisions are retained *and enumerable*.** Retaining them internally does not satisfy
   this: a query returning an entity's conflicting leaves is part of the deliverable. This follows
   the v1 policy already set in this codebase — nothing silently discarded, conflicts visible to the
   application layer as soon as they occur.

5. **CouchDB's semantics are kept; its wire protocol is not.** `_changes`, `_revs_diff`, `_bulk_get`
   and `_local` checkpoints are one implementation of those semantics, shaped by constraints we do
   not share, and both ends of this sync are ours. **Consequence, stated so it is not overclaimed:**
   differential testing against CouchDB proves *semantic* parity only. We cannot replicate with a
   real CouchDB and must not claim to.

6. **Sync is a port, with direction and continuity in its signature.** `replicateOnce` and
   `replicateContinuously`, over `push` / `pull` / `duplex`, returning a cursor with a field per
   direction. A single opaque checkpoint token — prior art's shape — cannot express a duplex
   position without encoding a record inside a string.

7. **Naming and semantics must agree.** `replicateContinuously` never stops because it has already
   synced once; "already caught up" is a `paused` state, not a terminal one. Anything that is a
   promotion gate is named as one and consumes the replicator's status rather than impersonating it.
   This is a direct response to prior art, where a gate named like a replication loop passed every
   test it had.

8. **Transport is SSE hub→spoke and POST spoke→hub.** `Last-Event-ID` maps onto `seq`, so resume is
   the protocol's rather than ours. The client is hand-rolled over `fetch`: Node has no global
   `EventSource` without `--experimental-eventsource`, and this substrate already depends on one
   experimental API. Ours are named `ChangeStream` and `ChangeStreamClient` — `EventSource` already
   means something else in the events domain and keeps that meaning.

9. **One substrate, per-store policies.** The log, revision trees, cursor and transport are shared;
   store-specific adapters supply what a record is and how conflicts resolve.
   **`FileStore` is deferred to its own feature** — binary cannot ride a `text/event-stream` body,
   and resumable digest-addressed transfer is a different problem.

## Amendments from Phase 01

Both were found by building the thing, not by reading. Recorded here rather than left in a commit
message, because each changes what the decisions above mean.

10. **Identity is the `@key` attribute's value, never `thing.iid`.** The decisions above said
    "entity id" without defining it, and the obvious candidate is wrong: `thing.iid` comes from
    `last_insert_rowid()`, so two nodes both call their first entity `1` and replication would merge
    unrelated things. The `@key` value is what makes two nodes agree they are describing the same
    entity, and the schema already enforces it as unique via a partial
    `UNIQUE INDEX ON attr(value) WHERE type = <key>`. Keyless things get a `local:` prefix and are
    **not replicable** — replication must refuse them rather than invent an equivalence. Key
    attribute types are persisted in their own `key_attribute` table, because `schema_element`
    carries `CHECK (kind IN ('type', 'attribute'))` and SQLite cannot alter a CHECK in place.

11. **`PRAGMA busy_timeout` is required for a multi-process store.** Decision 2 relies on SQLite
    serialising writers, which is true — but `node:sqlite` sets no busy timeout, so a process
    blocked on the write lock **fails immediately with SQLITE_BUSY rather than waiting**. A hub and
    its spokes are a multi-process design by definition, so this would otherwise have surfaced as
    intermittent failures under load. The interpreter now sets it (5 s, configurable).

    🔴 **This was invisible until a test was fixed.** The concurrency suite used `spawnSync` inside
    a `map`, which runs each child to completion before the next starts — three "concurrent" writers
    that never contended, passing while testing serial writes.

## Amendment from Phase 07 — 2026-09-04

12. 🔴 **Decision 3's generator is no longer part of this engine, because it has a consumer outside
    it.** A second consumer of `generation-digest` appeared: one value for which version an entity
    is and what it contains. That is the same generator, and it had to be *the same one*: a second
    copy of a digest whose entire purpose is that two writers independently derive the same value is
    a contradiction in terms.

    **It could not be imported where it was needed.** `@typedblite/runtime` is infrastructure;
    the second consumer lives in the domain layer, which may depend only on domain and utilities —
    not infrastructure. So `computeRevision`, `winner`, `conflicts`, `generationOf`,
    `digestOf` and the canonical **encoding** they derive from now live in
    **`@typedblite/content-revision`**, which the runtime re-exports so no existing consumer of
    its barrel is affected.

    ⚠️ **`entityId` and `isReplicable` stayed here, and the split is the point.** A `local:` id is a
    fact about *this engine's storage* — Amendment 10's rule that a keyless thing has no cross-node
    identity — not a fact about content. Moving them would have made the new library a dumping
    ground rather than a seam.

    🔴 **The semantics are untouched, and the test count is the evidence.** This file warns that
    CouchDB's revision-tree behaviour is kept deliberately, that it was proven against **real CouchDB
    3.4.3**, and that `nx run @typedblite/runtime:test-oracle` is not in the routine suite. A move is
    not a semantics change: **157 tests before, 157 after**, redistributed 18 to the new library and
    139 left here. ⚠️ **The oracle command is unchanged** — `couchdb-oracle.test.ts` did not move.

## Amendment — Decision 5's premise no longer holds; the wire protocol is back in scope (2026-09-09)

**Founder direction, 2026-09-09:** make TypeDBLite a drop-in replacement not only for
TypeDB/TypeQL but also for **CouchDB/PouchDB** — replicating the `_changes` feed and, where it
earns its place, the HTTP API.

### 🔴 This does not override Decision 5. It removes the reason Decision 5 gave.

D5 declined `_changes`, `_revs_diff`, `_bulk_get` and `_local` on a stated premise:

> …one implementation of those semantics, shaped by constraints we do not share, and **both ends of
> this sync are ours**.

⚠️ **A drop-in replacement means one end is precisely _not_ ours.** The clause that carried the
decision is false under the new goal, so this is an amendment on changed facts rather than a
reversal of judgement. The rest of D5 stands untouched: **the semantics were always the point**, and
they are already built — multi-version conflicts, a total winner rule, enumerable losing revisions.

D5 also says, of differential testing against CouchDB:

> We cannot replicate with a real CouchDB and **must not claim to**.

🔴 **That sentence now describes the deliverable.** Making it false — provably, against a real
server — is the work this amendment authorises. Until it is done, the sentence stays true and must
keep being said.

### What is already built, and is not re-litigated

| Piece | State |
| ----- | ----- |
| Change log, `seq` as `INTEGER PRIMARY KEY AUTOINCREMENT`, written in the data's own transaction | ✅ D1, D2 |
| CouchDB conflict semantics, total winner rule, enumerable losing revisions | ✅ D3, D4 |
| Replication as a port — `replicateOnce` / `replicateContinuously`, push/pull/duplex | ✅ D6, D7 |
| SSE hub→spoke with `Last-Event-ID` mapped onto `seq`, POST spoke→hub | ✅ D8 |
| CouchDB 3.4.3 as a differential oracle | ✅ `couchdb-oracle.test.ts` |

**So the changes feed exists.** What does not exist is the *CouchDB-shaped* one. This amendment is
about wire format and endpoint surface, not about replication semantics.

### The constraint that decides the shape

🔴 **The existing SSE transport is not replaced, and the CouchDB endpoints are not layered under
it.** D8's transport is what our own hub and spoke speak, and it resumes through a protocol feature
rather than through our own bookkeeping. A CouchDB-compatible surface is a **second, additive**
facade for foreign clients. A design that makes our own sync travel over `_changes` long-poll would
trade a working resume for a reimplemented one.

⚠️ **Compatibility is claimed only where it is proven against a real server.** D5's honesty clause
carries forward with its scope changed: no endpoint may be described as CouchDB-compatible on the
strength of shape alone. `couchdb-oracle.test.ts` is the harness, and *it is skipped when CouchDB is
not running* — so a green suite is not evidence the parity tests ran. **Any claim of compatibility
must cite a run in which the oracle was up.**

### What this amendment does not decide

- ⛔ **Which endpoints, and in what order.** `_changes` first is the obvious candidate because the
  feed already exists behind it; `_revs_diff` and `_bulk_get` are replication-protocol surface and
  only pay off if a real PouchDB is to replicate against us. That scoping is a feature's, not this
  ADR's.
- ⛔ **Whether TypeDBLite serves HTTP itself**, or a separate app puts a facade in front of the
  runtime.
- ⛔ **Attachments.** TypeDBLite has no attachment support at all. It is new work.

## Amendment — The hub's side of D8 refuses what it should, and says so (2026-11-14)

D8 defined the hub's transport: SSE out, POST in. It said nothing about what a hub does with a request it
should not honour, and a review of the hub on 2026-11-14 (the replication guide's Security section) found it
honoured nearly everything. This changes the hub's side of the wire. **The spoke's side and the protocol's
shape are unchanged**, and `TypeDBLiteReplicator` needs no change.

- **POST** must be `application/json` (415 otherwise). The body is limited by `maxBodyBytes` (default 64 MiB;
  413, before it is read when its length is declared and as it arrives when it is not). A malformed batch is a
  400 that names the problem, and it is checked as a whole before any record is applied. A valid batch is
  applied **all or none** (`ChangeLog.applyRemoteBatch`, one savepoint around the per-record ones). A failure
  while applying is a 500 with no detail, reported to the new `onError` option.
- **GET** past `maxStreams` (default 256) is a 503 with `retry-after`.
- **Not changed, deliberately:** a pushed `rev` is still stored as given. Verifying it against the content
  would change what a store accepts from its peers, so it is a decision of its own: it needs tests, and
  an amendment here. Authentication and TLS stay the mounting server's job, as D8 left them.

## Amendment — A store checks a peer's revision against its content (accepted, 2026-11-15)

> ✅ **Accepted by the maintainer, 2026-11-15.** Drafted with its implementation and tests
> (`verified-revisions.test.ts`), and held at Proposed until a person accepted it, because it changes what every store
> accepts from its peers.

**The problem.** Decision 3 derives a revision from its content, but nothing checked that a revision a peer sent
*was* derived from what it carried: `applyRemote` stored the `rev` it was given. The amendment above left this open
deliberately. Two things followed:

- **A revision could name two contents.** A peer could send a revision another store already holds, with different
  content. Each store then holds one revision with a different state, each believes it is in sync, and they never
  converge: the divergence Decision 3's derivation exists to prevent, reached from outside.
- **Any string was a revision.** `999999-deadbeef` was stored, and won by its generation.

**Decision.** `ChangeLog.applyRemote` accepts a revision from a peer only if it equals
`computeRevision({ state, parent: parentRev, deleted })` of what the record carries, and only if a live revision
carries its state. Otherwise it throws, with the diagnostic code `typedblite.revision-not-derived` and a message that
names the entity and the revision. That is a refusal, not a skip: skipping would leave two stores believing they are
in sync.

- **The hub** checks every record of a pushed batch first, so a bad one is a **400** that names it (`change 1 is
  refused: …`) and none of the batch is applied, as for any malformed batch.
- **A pull** stops at the bad record with that error. `TypeDBLiteReplicator` reports an apply failure as terminal,
  which this is: the same record will fail the same way.
- A `local:` id is still skipped before the check, as before.

**What it does not do, and why.** The parent a revision claims is **not** required to be known to the store.
`compact()` deletes non-leaf revisions, so a store pulling from a compacted one legitimately receives leaves whose
parents exist nowhere. Requiring a known parent would break that. So a peer can still claim any parent, and a
correctly derived revision with a high-generation parent wins. **This check does not, and cannot, stop a peer that may
write from making its write win.** Such a peer can always write a legitimate child of the current winner, which wins
by its generation anyway. Who may push is authentication, which D8 leaves to the mounting server.

**A stateless live revision is refused** because it can be neither checked nor projected, and as a winner it would
freeze the entity on every store that took it. ⚠️ A store whose change log predates its `state` column holds such
rows. They could never project anywhere, and they now stop a pull from that store at the first one, naming it.

**Consequences.** A client that pushed hand-made revisions is refused. `TypeDBLiteReplicator` and `replicateOnce`
send what `since()` returns, which is derived, so they are unaffected. The revision algorithm itself is unchanged.

## Alternatives considered

**SQLite's session extension** (`createSession` / `applyChangeset`, present in `node:sqlite`).
Rejected for the change log: a changeset is a row-level diff carrying no generation, no parent and
no revision tree, and its conflict handling is an apply-time `OMIT`/`REPLACE` callback — last-write-
wins by another name, which contradicts Decision 3. Kept in view for seeding a brand-new spoke,
where there is no history to reconcile.

**Deriving the log from the EventBus.** Rejected by Decision 1's reasoning. It is the design that
looks cleanest right up to the first crash between commit and publish.

## Consequences

- **A second experimental dependency is now load-bearing.** `node:sqlite` emits
  `ExperimentalWarning: SQLite is an experimental feature and might change at any time` on every
  use, and a change-log format is a long-lived on-disk commitment. Pin the Node version for anything
  holding real data; treat a Node upgrade as a substrate change to be tested, not a routine bump.
- **The single-writer property becomes something we depend on.** Decision 2's "no gap handling" is
  true because SQLite serialises writers. Moving the hub to a multi-writer engine would invalidate
  it silently.
- 🔴 **A relation without `@key` cannot replicate.** Decision 3 makes identity the `@key`
  attribute's value, so a keyless thing falls back to `last_insert_rowid()`. Its *role players* are
  keyed and encode perfectly, which is why nothing about such a record looks wrong.

  Before Phase 07 these replicated **and were wrong**: two nodes' unrelated relations merged under
  one id. They are now refused at the boundary, which is what Decision 3 always implied.

  **Refusing is correct without being sufficient.** The remedy is in the schema's own vocabulary —
  a derived composite projected into an attribute that can carry `@key`. That is a schema decision
  this ADR does not make.
