---
kind: adr
status: accepted
date: 2026-11-12
decision-owners: [TypeDBLite maintainers]
extends: [adr-005]
---

# ADR-007: A scenario TypeDB itself fails is a deviation, and the oracle decides which

- **Status:** Accepted by the founder (Dave Jackson) on 2026-11-12, with the oracle run and the twelve
  deviations it owns on PR #6.
- **Date:** 2026-11-12
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-005](adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md).
  ADR-005 makes the vendored spec the standard and names a live-server oracle as later work. This ADR is
  that oracle's first use.

> ✅ **Accepted 2026-11-12 by the founder.** It was proposed with its evidence: a full oracle run against
> `typedb/typedb:3.10.4`, and each of the twelve scenarios re-run there before acceptance.
> `update` L959 is not decided here (see below).

---

## Context

On 2026-11-12 the card stood at 1,742 of 1,756 passing. The pin is `typedb-behaviour@7d35851`, surveyed
against TypeDB 3.10.4. Twelve of the 13 failures have no TypeDBLite fix that would be correct.
**TypeDB 3.10.4 fails them too.**

Before this ADR, "TypeDB fails it too" was an argument from reading the spec and TypeDB's source. Now
it is measured. `libs/conformance/src/oracle.ts` runs the same `World`, steps and scenarios against a
live `typedb/typedb:3.10.4` over its HTTP API (`typedb-oracle.ts`). It then prints where the two
engines disagree. The full run on 2026-11-12 found:

- 1,447 scenarios pass on both;
- 49 pass on TypeDB and failed here; all are now fixed, except `update:959` (below);
- 12 fail on TypeDB, listed here.

A further 245 failed on TypeDB but passed here. Almost all of those are things the harness cannot do
over HTTP, such as given rows, or value spellings the adapter does not normalise. They are not evidence
about either engine.

| Scenario | Where TypeDB 3.10.4 fails | Why |
| --- | --- | --- |
| `insert` L2219, L2272, L2337, L2432 | parse, at `rule …` / `undefine employment owns ref` | TypeDB-2 syntax (`rule`, define-shaped undefine); TypeDB 3 has no rules. Tagged `@ignore` upstream |
| `insert` L2515 | commit, `@card(0..1)` violated | the same rules scenario; its data cannot commit on TypeDB 3. `@ignore` |
| `delete` L221 | L233, type inference | TypeQL-2 syntax throughout (`$n0 "Alice"`, `type person`). `@ignore` |
| `match` L210 | L231, templating an iid for a TYPE | "types cannot be specified by IID" (upstream comment). `@ignore` |
| `match` L1484 | L1516, `transaction is open: false` | TypeDB keeps a transaction open after a failed read: probed on every kind, 2026-11-12. `@ignore` |
| `metadata` L189 | L198, `get_doc` does not parse | "TODO: settle on the syntax" (upstream). `@ignore` |
| `negation` L303 | L354, `verify answer set is equivalent for query` | the two queries name different variables (`$f3`/`$f2`). TypeDB's own step is a no-op (`if true { … return; }`, `tests/behaviour/steps/query/typeql.rs`), which is the only reason TypeDB's CI passes it |
| `put` L366, L407 | parse, at `Then answer size is: 1` | an unterminated doc string in the spec: the next step's text is inside the query |

The harness has its own reading of a few steps, such as transaction state and answer-set equality. Each
entry above was checked against TypeDB's step code or a direct HTTP probe, not only against the shared
`World`.

## Decision

### 1. A scenario the oracle shows TypeDB failing is declared a deviation owned by this ADR

It goes in `deviations.yaml` with `owner: adr-007` and a `reason` that names where TypeDB fails. It is
not treated as an engine gap. The standard's rule still holds: a deviation is declared only once it is
the reason the scenario fails. Here that means TypeDBLite fails at, or after, the step where TypeDB
does, for the same cause.

### 2. The oracle is re-run whenever the pin moves

Each `adr-007` entry is re-verified then. An entry whose scenario TypeDB now passes is removed, and the
scenario becomes an ordinary gap.

### 3. Where TypeDB and its own spec disagree, the spec wins

The spec is the standard (ADR-005). Where TypeDB 3.10.4 answers against it, TypeDBLite follows the spec
and passes. Two such cases:

- `match` L5298: TypeDB answers every loop for `$l links (member: $l)`.
- `redefine` L412: TypeDB cannot parse `redefine relation … label …`.

Neither is a deviation, because TypeDBLite passes both.

## Not decided here

`update` L959 is the one failure TypeDB passes. TypeDB enforces an `owns` without `@card` as
`@card(0..1)` at commit. TypeDBLite does not, and a downstream application depends on that:

- its document store's schema declares `owns doc-facet, owns doc-tag;` with no `@card`, and 1,041 and
  389 documents hold more than one value;
- its defect tracker does the same for four attributes.

Enforcing the default would make those stores refuse writes to the things they already have. That
trade is the founder's: fix the downstream schemas, or declare the default unenforced in an ADR of its
own.

## Consequences

- The card reaches 1,742 pass, 1 fail, 12 deviation, 1 not-applicable.
- "TypeDB fails it too" stops being prose. It is a command anyone with Docker can re-run:
  `docker run -p 8000:8000 typedb/typedb:3.10.4`, then `npx tsx src/oracle.ts` in `libs/conformance`.
- TypeDB 3.10.4 panics and exits on some spec queries (`executor/instruction/checker.rs:1168`). The
  oracle waits for a restarted server (`--restart always`), and the scenario that crashed it fails on
  the TypeDB side only.
