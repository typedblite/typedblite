# ADR-002: A TypeQL Engine Is a Port, and SQLite Is One Adapter

- **Status:** Accepted
- **Date:** 2026-08-29
- **Decision owners:** TypeDBLite maintainers
- **Amends:** [ADR-001](adr-001-typedb-for-graph-persistence.md) — what it depends on is TypeQL, not the TypeDB product
- **Feature:** [TypeQL Language and SQLite Runtime](../planning/typeqlite/typeqlite.feature.md)

## Context

[ADR-001](adr-001-typedb-for-graph-persistence.md) chose embedded TypeDB for graph persistence. It
did so for a specific, narrow reason, stated in each schema's own header: **`@key` makes a duplicate
impossible rather than unlikely**, and a relation cannot name a role player that does not exist, so
a dangling dependency is *unrepresentable* rather than merely discouraged. That is a store-level
guarantee replacing an application-level check-then-create.

Two things have since made the *product* choice uncomfortable while leaving that *reasoning* intact.

**The dependency is an opaque binary with no obtainable source.** `@downstream/typedb-wasm` ships an
11.5 MB `typedb_wasm_bg.wasm` and no Rust source. Verified 2026-08-29: crates.io has neither
`typedb-embedded` nor `typedb-wasm`, JSR reports `githubRepository: null`, GitHub code search
returns 0 results, and `typedb/typedb`'s own workspace has no such member crate. It is a
single-publisher `0.1.0` package.

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
   > moved to `tsx` + `node:test`, and three tests of dependency injection are **skipped** — parked
   > in the planning directory, not quietly dropped.

   The WASM module was one adapter, a TypeDB server reached over the network is another, and the
   SQLite implementation this feature builds is a third. 🔴 **No decision here makes SQLite *the* engine.**
   The stack is offline-first and must stay online-capable: the engine is a port precisely so an
   online adapter can be substituted. Designing it out by omission is the failure this decision
   exists to prevent.

2. **ADR-001 is amended, not superseded, and only in one word.** It depends on
   **TypeQL and its constraint guarantees**, not on the TypeDB product. Every line of its
   reasoning survives an engine change. Read "TypeDB" in it as "a TypeQL engine satisfying the
   guarantees in Decision 3".

3. **The guarantees are the contract, and they are what an adapter is tested against.** An adapter
   qualifies only if a duplicate `@key` is refused by the store and a relation naming a
   non-existent role player is refused by the store. Not checked in application code, refused.
   Anything weaker is not an adapter; it is a cache.

4. **Two packages, split on the Dependency Rule.**

   | Package | Contents |
   | ------- | -------- |
   | `@typedblite/language` | Grammar, AST, parser, validators. Depends on nothing. |
   | `@typedblite/runtime` | SQL generator, interpreter, the `TypeDbDatabase` adapter. Touches a database. |

   A grammar is genuinely a utility — no domain knowledge, usable from any layer — and an engine
   genuinely is infrastructure. The split is not ceremony: a parser belongs in every layer that
   needs to parse, and putting it behind the same module as the database would prevent that.

5. **The library is not an app; a thin shell app fronts it.**

   TypeQL is a language, not a fixed operation list, so its shell is `sqlite3` or `psql`-shaped —
   a REPL that reads raw TypeQL, plus `--file` and `--exec`. A command-palette shape (`typeql.query
   {"q": "match …"}`) would be worse than the tool it replaces, and completion over three operation
   names buys nothing.

6. **Full-text search sits beside this, not inside it.** TypeQL has no full-text construct, so
   FTS5 is not smuggled into the grammar. 🔴 A second Langium grammar for FTS is **rejected
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
   binary per platform — reintroducing exactly the kind of binary dependency this ADR exists to
   remove. `node:sqlite` is built into Node and emits no experimental warning on Node 24 (verified
   2026-08-29). The binding is behind the runtime package either way.

9. ~~**A WASM fallback is deferred, not superseded.**~~ **Resolved 2026-08-29.** Phase 03 proved the
   SQLite adapter, so the fallback was retired the same day. Original text kept:

   **A WASM fallback is deferred, not superseded.** The commitment to retain `@downstream/typedb-wasm`
   as a fallback stands until this feature's Phase 03 proves the SQLite adapter against the real
   consumer schemas. Retiring the fallback before the replacement is proven is how a project ends
   up with neither.

## Consequences

### Positive

- The engine becomes replaceable, which is what ADR-001 needed and did not have.
- Every guarantee is enforced by SQLite's own `UNIQUE`, `FOREIGN KEY` and `CHECK` machinery, which
  is older and better tested than anything we would write.
- A Langium grammar gives `.typeqlite` files real editor support as a by-product.

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

Phase 03 demonstrated drop-in for the consumer schemas. It did not, and could not, measure
conformance to **TypeQL as TypeDB specifies it**: nothing here checked TypeQL semantics until
[ADR-005](adr-005-typedb-s-behaviour-specification-is-typeqlite-s-conformance-oracle.md) adopted
TypeDB's own behaviour specification as the oracle. 🔴 **Surveyed 2026-09-10, the honest score is
0 of 791 language scenarios**, because every scenario's schema declares annotations TypeQLite
refuses. From ADR-005's acceptance, any statement that TypeQLite is a drop-in TypeDB replacement
cites a conformance run and its number. Nothing above is rewritten: it was right about the port and
right about the repositories, and it never claimed the language.

## What Phase 00's verification changed

The scope survey this ADR rests on was **wrong the first time**, and the verification step was what
found it. `delete $i;` — deleting a thing — was used in production code where the grammar supported
only `delete $old of $p;`. Confirmed by running it, not by reading it.
Both the grammar and generator were corrected before this ADR was written.

That is worth recording because the "measured surface" claim is load-bearing for the entire feature,
and it survived one round of scrutiny only after failing it.

## References

- [ADR-001](adr-001-typedb-for-graph-persistence.md) — amended by Decision 2
- [ADR-005](adr-005-typedb-s-behaviour-specification-is-typeqlite-s-conformance-oracle.md) — the
  conformance oracle this amendment defers to
