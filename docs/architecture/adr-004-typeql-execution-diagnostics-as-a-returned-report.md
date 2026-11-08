# ADR-004: TypeQL Execution Diagnostics Are a Returned Report, Not an Emitted Event

- **Status:** Accepted
- **Date:** 2026-08-31
- **Decision owners:** the downstream application maintainers
- **Extends:** [ADR-002](adr-002-typeql-engine-as-a-port.md) — the engine gains a diagnostic
  channel; the port boundary it established is unchanged
- **Feature:** [TypeQLite Language Tooling](../planning/typeqlite-language-tooling/typeqlite-language-tooling.feature.md)
- **Evidence:** [execution-diagnostics.md](../planning/typeqlite-language-tooling/phases/00-scope-and-adr/execution-diagnostics.md),
  [upstream-diff.md](../planning/typeqlite-language-tooling/phases/00-scope-and-adr/upstream-diff.md)

> ✅ **Accepted by the founder, 2026-08-31.** Drafted by Phase 00 alongside its analysis and held
> at Proposed until a person accepted it, as ADR-003 was.
>
> 🔴 **The prior-art search this Skill requires could not run, and is reported rather than skipped.**
> This repository's documents are outside `downstream-store`'s corpus — verified again here: no
> `downstream-store` script exists in this repo's `package.json`, and the string `downstream-app` appears
> nowhere in `downstream-monorepo`'s `downstream-store` sources. A disk substitute was run instead
> (`docs/architecture/*.md` for *diagnostic* and *DomainEvent*), and the only hit is
> `platform-capability-porting.md`, which is not an ADR and states no competing decision.
> **"downstream-store returned nothing" is not an answer here — it was never asked.** Standing
> parking-lot item; ADR-017, ADR-002 and ADR-003 were all written under the same gap.

---

## Context

TypeQL execution has no observability. `interpreter.ts` (now in typedblite sibling repo: `packages/runtime/src/`)
exposes `define()` for DDL, `execute()` for writes and `query()` for reads, and every failure leaves
through one of six `throw new Error` sites carrying **a string and no source position**. A statement
that succeeds but does the wrong thing — a `define` that re-applied as a no-op, a `match` whose
candidate set was empty — says nothing at all.

This mattered less when TypeQLite was a parser. It matters now: since
[ADR-003](adr-003-typeqlite-change-log-and-sync-as-a-port.md) the engine holds real IAM and Skills
data, replicates it, and searches it.

**A source-mapped debugger was the first answer, and was cut.** It was scoped as three phases —
traced generation, source maps, a DAP adapter — and rejected on 2026-08-31 before any branch
existed. Two findings killed it, both recorded in the feature doc's *Deferred* section:
`interpreter.ts` executes a pipeline eagerly and nothing in it is written to suspend and resume; and
`sqlite-generator.ts` emits SQL from plain template strings, so source maps were never an addition
to that generator but a **rewrite of load-bearing, oracle-tested code** carrying this ADR's parent's
guarantees.

What survives is the question the debugger existed to answer — *what did this statement actually
do* — asked without the reshape.

## Decision

**1. Diagnostics are returned, not emitted.** `define()`, `execute()` and `query()` each return an
execution report carrying LSP-shaped `Diagnostic`s. The runtime takes **no** dependency on
`libs/core/events/domain`.

**2. The application layer decides what reaches an event.** The handler that already publishes a
`DomainEvent` attaches the diagnostics to its payload. `DomainEvent<TType, TPayload>` is already
generic over its payload and does not change.

**3. Errors that throw today keep throwing.** A diagnostic is attached to the thrown error; it never
replaces it. 🔴 Converting a `throw` into a diagnostic downgrades a failure to a warning, and
[ADR-001](adr-001-typedb-for-iam-persistence.md)'s duplicate-registration guarantee and ADR-002's
constraint layers are both enforced by failures propagating. **A change that ends with fewer throws
than it started with has broken something**, and the suite asserts the count.

**4. A diagnostic carries a range and a message; it echoes source only where no range exists.**
Event payloads replicate. A diagnostic on an `insert` that quoted its statement would carry
attribute **values** across the change stream and into logs. The one case with no derivable range is
a constraint violation raised inside SQLite — which is also the case whose values are most likely to
be sensitive — so there it names the statement rather than reproducing it.

**5. Execution facts are capped, with an explicit truncation marker.** "What this write touched" is
unbounded on a large write.

**6. The diagnostic type is the LSP shape Langium already uses.** Not a new one. Per the feature's
reference-implementation rule, upstream's shape is the specification.

### Alternatives rejected

- **The engine publishes `DomainEvent`s itself.** Fewer moving parts, and no caller has to opt in.
  Rejected because it reverses a boundary the runtime was built to hold —
  `change-stream.ts` (typedblite sibling repo: `packages/runtime/src/`) records that it
  avoided even the *name* `EventSource` to stay clear of the events domain — and because it would
  make every repository an event publisher, which is the application layer's job.
- **A `DiagnosticSink` port.** Keeps the boundary and adds push semantics. Rejected as a third
  mechanism beside the change stream and the event bus, for a payload with one consumer that is
  already synchronously holding the result.

## Consequences

### Positive

- **The observability question is answered without touching the execution path.** The measured cost
  is one intermediate type gaining provenance: `constraintsOf()` converts AST `Pattern`s into
  `ThingConstraint`, dropping the AST link, and every range-less throw inherits that loss. Three of
  `checkKnown`'s five call sites still hold the AST node and simply do not pass it.
- **The widening is additive, proven by compiling rather than by reading.** A scratch probe widened
  all three signatures; the two consumers outside the library —
  [`typedb-database.ts`](../../libs/core/persistence/infrastructure/src/lib/typedblite-database.ts) and
  `session.ts` (typedblite sibling repo: `apps/cli/src/`) — compiled untouched, and
  `nx run-many -t lint test build` was green for all 36 projects with the probe in place.
- **The engine stays portable.** A consumer with no event bus loses nothing.

### Negative / Constraints

- **Two throw sites need a range threaded to them**, and one can never have a genuine one.
  `checkKnown` takes primitives; `insertRoles` takes plain `{ role, player }` structures; and
  `translateConstraintError` originates inside SQLite, which has never seen the TypeQL.
- **A returned report is ignorable.** Nothing forces a caller to read it — the same shape as the
  `@card` problem this engine already guards against by throwing. This is why Decision 3 exists:
  anything that must not be ignored stays a `throw`.
- **Parse failures need a second range path.** A lexer or parser error has no AST; its position
  comes from Chevrotain's own offsets, not from a `CstNode`.
- **The diagnostic path must not re-enter `execute()`.** Projection writes rows directly, because
  applying a change is not a change; a diagnostic that ran a query to enrich its message would make
  two nodes ping-pong. It must be **assembled, never written**.

## References

- [ADR-002 — The TypeQL engine as a port](adr-002-typeql-engine-as-a-port.md)
- [ADR-003 — A change log belongs to the engine, and sync is a port](adr-003-typeqlite-change-log-and-sync-as-a-port.md)
- [TypeQLite Language Tooling feature doc](../planning/typeqlite-language-tooling/typeqlite-language-tooling.feature.md)
- [Multi-Phase Lifecycle Standard](../standards/governance/multi-phase-lifecycle-standard.md)
- [Langium](https://github.com/eclipse-langium/langium) at `v4.3.0` — the reference implementation
