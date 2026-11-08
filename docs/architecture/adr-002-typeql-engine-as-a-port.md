# ADR-002: A TypeQL Engine Is a Port, and SQLite Is One Adapter

- **Status:** Accepted
- **Date:** 2026-08-29
- **Decision owners:** TypeDBLite maintainers
- **Amends:** [ADR-001](adr-001-typedb-for-iam-persistence.md) and [ADR-015](adr-015-skills-as-a-bounded-context.md) — what they depend on is TypeQL, not the TypeDB product
- **Feature:** [TypeQL Language and SQLite Runtime](../planning/typeqlite/typeqlite.feature.md)

## Context

[ADR-001](adr-001-typedb-for-iam-persistence.md) chose embedded TypeDB for IAM persistence and
[ADR-015](adr-015-skills-as-a-bounded-context.md) put the Skills definition graph in it. Both did so
for a specific, narrow reason, stated in each schema's own header: **`@key` makes a duplicate
registration impossible rather than unlikely**, and a relation cannot name a role player that does
not exist, so a dangling dependency is *unrepresentable* rather than merely discouraged. That is a
store-level guarantee replacing an application-level check-then-create — the shape that produced
duplicate-email Principals in `hosted-app-ai-chat` on 2026-07-16.

Two things have since made the *product* choice uncomfortable while leaving that *reasoning* intact.

**The dependency is an opaque binary with no obtainable source.** `@downstream/typedb-wasm` ships an
11.5 MB `typedb_wasm_bg.wasm` and no Rust source. Verified 2026-08-29: crates.io has neither
`typedb-embedded` nor `typedb-wasm`, JSR reports `githubRepository: null`, GitHub code search
returns 0 results, and `typedb/typedb`'s own workspace has no such member crate. It is a
single-publisher `0.1.0` package, and [ADR-017](adr-017-globally-installed-repo-agnostic-cqrs-apps.md)
commits this repository to shipping apps that would carry it.

**The surface actually used is tiny.** Measured — twice — across every `.define`/`.execute`/`.query`
call site:

| | Constructs |
| --- | --- |
| Used | `entity`, `relation`, `attribute`, `owns`, `@key`, `relates`, `plays`, `value string`; `match`, `insert`, `put`, `delete`, `select`, `links`, `isa`, `has` |
| **Not used anywhere** | rules and inference, aggregation, negation, disjunction, `sort`/`limit`/`offset`, `fetch`, `reduce`, expressions, structs, `abstract`, `@unique`, `@card` |

Sorting is done in JavaScript. The consuming API is five methods: `define`, `execute`, `query`,
`persist`, `close`.

## Decision

1. **`TypeDbDatabase`'s five methods are a port, and every engine is an adapter behind it.**

   > 🔴 **Amended 2026-08-29: the WASM adapter was removed, and TypeQLite is now the default.**
   > Founder decision, taken after Phase 03 demonstrated drop-in. That reverses the caution below
   > — *"No decision here makes SQLite the engine"* — **for the local path only**, and the caution
   > is left as written because it was right when written and is what forced the port to exist.
   >
   > What is unchanged, and is the reason this is an amendment rather than a supersession: the port
   > is structural, `engine` still accepts any implementation with the five methods, and a **TypeDB
   > server reached over the network remains injectable**. The offline/online story this decision
   > exists to protect survives; what went is one embedded adapter, and with it an 11.5 MB opaque
   > binary with no obtainable source.
   >
   > 🔴 It was not a free removal. WASM was the only engine **Jest** could load, so six test suites
   > plus the Skills app's parity fixture moved to `tsx` + `node:test`, and three tests of Nest
   > dependency injection are **skipped** — parked in
   > [`parking-lot.tasks.md`](../sessions/parking-lot.tasks.md), not quietly dropped.

   The WASM module was one adapter, a TypeDB server reached over the network is another, and the
   SQLite implementation this feature builds is a third. 🔴 **No decision here makes SQLite *the* engine.**
   The stack is offline-first and must stay online-capable: PouchDB↔CouchDB replication and
   `downstream-monorepo`'s `runtime-routing` extension — which already resolves `local` / `cloud` /
   `syncing` / `degraded` from licence mode, connectivity and cloud health — both assume an online
   path exists. Designing it out by omission is the failure this decision exists to prevent.

2. **ADR-001 and ADR-015 are amended, not superseded, and only in one word.** Both depend on
   **TypeQL and its constraint guarantees**, not on the TypeDB product. Every line of their
   reasoning survives an engine change. Read "TypeDB" in both as "a TypeQL engine satisfying the
   guarantees in Decision 3".

3. **The guarantees are the contract, and they are what an adapter is tested against.** An adapter
   qualifies only if a duplicate `@key` is refused by the store and a relation naming a
   non-existent role player is refused by the store. Not checked in application code, refused.
   Anything weaker is not an adapter; it is a cache.

4. **Two packages, split on the Dependency Rule.**

   > **Paths renamed 2026-08-29:** `libs/core/typeql/*` is now `libs/core/typeqlite/*`, and the
   > packages are `@downstream/typeqlite-{language,runtime}`. The split and the tags below are
   > unchanged — only the name moved. The table is left as written because it records the decision
   > as taken; see the [feature doc](../planning/typeqlite/typeqlite.feature.md) for what the
   > rename does and does not cover.


   | Package | Tags | Contents |
   | ------- | ---- | -------- |
   | `libs/core/typeql/language` | `scope:shared`, `type:util` | Grammar, AST, parser, validators. Depends on nothing. |
   | `libs/core/typeql/runtime` | `scope:shared`, `type:infrastructure` | SQL generator, interpreter, the `TypeDbDatabase` adapter. Touches a database. |

   A grammar is genuinely a utility — no domain knowledge, usable from any layer — and an engine
   genuinely is infrastructure. The split is not ceremony:
   [ADR-001](adr-001-platform-boundaries-and-package-conventions.md) Decision 4 lets anything depend
   on `type:util`, and putting a parser behind `type:infrastructure` would deny it to the layers
   that should be allowed to parse.

5. **The library is not an app; a thin CQRS app may front it later.**

   > **Amended 2026-08-29 by Phase 04, and it reverses this decision's stated bias.** D5 leaned
   > toward "yes, make it a Domain CQRS App", reasoning that the REPL is already one of the four
   > transports. Reading the shared runtime showed the reasoning does not hold:
   > `CqrsToolRuntime.completeReplLine` tab-completes over a **fixed operation list** — an
   > *operation menu*, where you pick a named thing and supply JSON. TypeQL is a **language**;
   > its shell is `sqlite3` or `psql`, not a command palette. `typeql.query {"q": "match …"}`
   > would be worse than the tool it replaces, and completion over three operation names buys
   > nothing.
   >
   > `apps/tooling/typeql` is therefore a **plain shell**, not a `CqrsToolRuntime` app: a REPL that
   > reads raw TypeQL, plus `--file` and `--exec`. It is `scope:tooling`, beside `scm`.
   >
   > 🔴 **The concern D5 raised is still real** — *"building a bespoke REPL beside an established
   > four-transport shape is how a second way of doing things starts."* This is that second way,
   > accepted deliberately rather than by accident, because the established shape is built around a
   > fixed operation list and a language does not have one. If a TypeQL **sidecar or HTTP** surface
   > is ever wanted, that is where `CqrsToolRuntime` fits and should be used.

   `scm` and `skills` front a
   *domain*, and TypeQL is a language, so the library itself is not a Domain CQRS App. But the REPL
   the founder asked for **is one of the four transports**
   ([ADR-011](adr-011-scm-as-a-bounded-context.md), [ADR-015](adr-015-skills-as-a-bounded-context.md)),
   so "add a REPL" and "make it an app" are close to the same question. Deferred to Phase 04 with a
   bias toward yes — building a bespoke REPL beside an established four-transport shape is how a
   second way of doing things starts.

6. **Full-text search sits beside this, not inside it.** TypeQL has no full-text construct, so
   FTS5 is not smuggled into the grammar. The seam is `ContentSearchPort`, which already exists in
   `downstream-monorepo`'s `libs/platform/chat/domain`. 🔴 A second Langium grammar for FTS is **rejected
   for now**: a shared query language must target either the intersection of SQLite FTS5 and
   CouchDB's Nouveau — discarding the phrase queries FTS5 supports and Nouveau, indexed without
   position data, cannot — or their union, producing queries that fail on one backend. Prefer a
   typed query object whose adapters declare what they cannot do, so an unsupported query **errors
   instead of returning zero hits and looking like "no results"**.

7. **Unsupported TypeQL fails loudly, at three layers, and never silently succeeds.** Unknown
   syntax is a parse error; syntax we choose not to implement is a Langium validator error naming
   the construct; anything reaching the interpreter unhandled throws. The interpreter's throw is a
   backstop that must never become a no-op. This is the whole design constraint: the failure mode
   to design against is GraphQLite 0.6.1, which on 2026-08-29 answered an edge to a non-existent
   node by silently writing one between two unrelated nodes.

8. **`node:sqlite`, not `better-sqlite3`.** `better-sqlite3` is a native module needing a prebuilt
   binary per platform — reintroducing exactly the problem ADR-017 and this ADR exist to remove.
   `node:sqlite` is built into Node and emits no experimental warning on Node 24 (verified
   2026-08-29). The binding is behind the runtime package either way.

9. ~~**[ADR-017](adr-017-globally-installed-repo-agnostic-cqrs-apps.md) Decision 10 is deferred, not
   superseded.**~~ **Resolved 2026-08-29.** Phase 03 proved the adapter — 13 parity tests against
   the real repositories — so the condition below was met and ADR-017 Decision 10 was retired the
   same day. Original text kept:

   **[ADR-017](adr-017-globally-installed-repo-agnostic-cqrs-apps.md) Decision 10 is deferred, not
   superseded.** The commitment to fork `@downstream/typedb-wasm` as `@downstream/typedb-wasm`
   stands as a **fallback** until this feature's Phase 03 proves the SQLite adapter against the real
   IAM and Skills suites. Retiring the fallback before the replacement is proven is how a project
   ends up with neither.

## Consequences

### Positive

- The engine becomes replaceable, which is what ADR-001 and ADR-015 needed and did not have.
- Removing the TypeDB container also removes Docker from `downstream-store` entirely once CouchDB→PouchDB
  and Nouveau→FTS5 follow — four long-lived containers to none.
- Every guarantee is enforced by SQLite's own `UNIQUE`, `FOREIGN KEY` and `CHECK` machinery, which
  is older and better tested than anything we would write.
- A Langium grammar gives `.typeql` files real editor support as a by-product.

### Negative / Constraints

- 🔴 **`@key` semantics are not identical, and the difference is real.** The generator emits a
  unique index on the attribute *type*, making a value globally unique. TypeDB's `@key` is unique
  *per owning type* and also mandatory. Today these coincide — `step-id`'s own comment says it is
  deliberately globally unique — but a schema where two entity types own the same attribute type
  would expose the gap. Closing it needs the owner's type on the `attr` row.
- 🔴 **Deletion semantics differ.** `role_player.rel` cascades, `role_player.player` does not, so
  deleting a thing that still plays a role is refused where TypeDB would delete the relation with
  it. Defensible, and **not the same behaviour**.
- **`plays` and `relates` are parsed and not enforced.** A wrong-typed role player is structurally
  impossible in TypeDB and possible here until a validator or a storage change closes it.
- **Nothing is measured for performance.** The model is one row per attribute, so a match with
  several constraints becomes several `EXISTS` subqueries.
- **This is a second implementation of somebody else's language**, and TypeQL will move without us.
  The mitigation is Decision 7 — failing loudly on anything unrecognised — not keeping pace.

## Amendment — 2026-09-11: "drop-in" is a measured claim, and the measure is ADR-005

Phase 03 demonstrated drop-in for **this repository's repositories** — the real IAM and Skills
suites ran unmodified. It did not, and could not, measure conformance to **TypeQL as TypeDB
specifies it**: nothing here checked TypeQL semantics until
[ADR-005](adr-005-typedb-s-behaviour-specification-is-typeqlite-s-conformance-oracle.md) adopted
TypeDB's own behaviour specification as the oracle. 🔴 **Surveyed 2026-09-10, the honest score is
0 of 791 language scenarios**, because every scenario's schema declares annotations TypeQLite
refuses. From ADR-005's acceptance, any statement that TypeQLite is a drop-in TypeDB replacement
cites a conformance run and its number. Nothing above is rewritten: it was right about the port and
right about the repositories, and it never claimed the language.

## What Phase 00's verification changed

The scope survey this ADR rests on was **wrong the first time**, and the verification step was what
found it. `skills-projection-target.ts` was never surveyed; it uses `delete $i;` — deleting a thing —
where the grammar supported only `delete $old of $p;`. Confirmed by running it, not by reading it.
Both the grammar and generator were corrected before this ADR was written.

That is worth recording because the "measured surface" claim is load-bearing for the entire feature,
and it survived one round of scrutiny only after failing it.

## References

- [ADR-001](adr-001-typedb-for-iam-persistence.md), [ADR-015](adr-015-skills-as-a-bounded-context.md)
  — amended by Decision 2
- [ADR-017](adr-017-globally-installed-repo-agnostic-cqrs-apps.md) — Decision 10 deferred by
  Decision 9; its global-install constraint drives Decision 8
- [ADR-001](adr-001-platform-boundaries-and-package-conventions.md) — the tag and layering rules
  Decision 4 applies
- [ADR-011](adr-011-scm-as-a-bounded-context.md) — the four-transport shape Decision 5 weighs
- [Feature doc](../planning/typeqlite/typeqlite.feature.md) and
  [Phase 00 checklist](../planning/typeqlite/phases/00-scope-and-adr/checklist.md)
