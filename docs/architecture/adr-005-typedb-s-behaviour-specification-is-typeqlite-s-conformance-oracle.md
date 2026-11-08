---
kind: adr
status: accepted
date: 2026-09-11
decision-owners: [founder, downstream-maintainers]
extends: [adr-002, adr-003]
operationalised-by: [typeqlite-conformance-standard]
---

# ADR-005: TypeDB's behaviour specification is TypeQLite's conformance oracle

- **Status:** Accepted — by the founder (Dave Jackson), 2026-09-11, with Phases 00–03 of the conformance
  feature closed and the card at 416 of 1,756
- **Date:** 2026-09-11
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-002](adr-002-typeql-engine-as-a-port.md), whose "drop-in TypeDB replacement"
  this makes a measured claim; [ADR-003](adr-003-typeqlite-change-log-and-sync-as-a-port.md), whose
  CouchDB differential oracle is the same technique aimed at a different question
- **Operationalised by:** the
  [TypeQLite Conformance Standard](../standards/governance/typeqlite-conformance-standard.md), per
  [ADR-054](adr-054-an-adr-that-mandates-behaviour-has-a-companion-standard.md) — the baseline and
  deviation rules below are recurring obligations, and the procedure lives there
- **Relates to:** [ADR-046](adr-046-promptos-conformance-for-every-prompt-artifact.md) and
  [ADR-047](adr-047-promptos-facet-waivers-against-measured-evidence.md), the repository's prior
  measured-conformance rule, whose *waivers against evidence* shape Decision 5 borrows

> ✅ **Accepted 2026-09-11 by the founder**, four phases in — after the oracle had printed 0, 140,
> 164 and 416 of 1,756 (the feature doc, `docs/planning/typeqlite-conformance/`, is on
> `feat/typeqlite-conformance` until that feature merges — a branch-scoped document is named, not linked).
> It was held at Proposed through those phases so the decision was accepted against a measured
> number rather than a drafted one.

---

## Context

Nothing in this repository checks TypeQL semantics. Both existing oracle suites —
`oracle-parity.test.ts` and `couchdb-oracle.test.ts`, established by ADR-003 — compare TypeQLite
against CouchDB's replication conflict model; neither asks what a TypeQL query *answers*. Every
evaluation semantic in the interpreter has therefore been a guess, and on 2026-09-10 a code review
caught those guesses one at a time: sixteen rounds on `defect/typeqlite-select-entity-variable`,
against a gate whose own `MAX_REVIEW_ROUNDS` is 3, before four semantics were settled in minutes by
running the same queries against a live TypeDB 3. The relation-matching rewrite is parked on that
finding, and the PouchDB retirement's engine schema reads relations, so the gap now blocks the
repository's top-priority work.

ADR-002 commits TypeQLite to being a drop-in TypeDB replacement, and ADR-003's amendment extends
that to CouchDB/PouchDB. **The TypeDB half of that claim has never been measured.** TypeDB publishes
the measurement: [`typedb/typedb-behaviour`](https://github.com/typedb/typedb-behaviour) (MPL-2.0)
is the Cucumber specification that every official driver and the server itself run —
`query/language/` alone is **791 scenarios across 16 feature files**, with a vocabulary of roughly
fifteen step patterns. Surveyed 2026-09-10 at `master` (`7d35851`) against the live server
`typedb/typedb:3.10.4`:

- **Every scenario's Background declares `@card(0..)`, `@independent` and `@unique`**, which
  TypeQLite refuses at `define` — so the honest starting score is **0 of 791**.
- `match $x isa writer;` answers *things*, identified in the answer tables by their `@key` — the
  projection TypeQLite deliberately refuses (`defect/typeqlite-select-refusal`, merged 2026-09-11).

A suite that starts almost entirely red cannot be a gate — it would be waived on day one. A suite
whose score is never read is not an oracle either. The decision is how to bring the specification
in, and what rule makes its number binding.

## Decision

### 1. `typedb-behaviour` is the oracle for TypeQL semantics, and it is vendored at a pinned commit

The feature files are copied into this repository under the TypeQLite conformance project, **with
their MPL-2.0 headers intact and the licence file alongside**, from one recorded commit of
`typedb/typedb-behaviour`. A `PIN` file records the commit, the date, and the TypeDB server version
the survey was made against. The pin moves only by a deliberate commit that re-baselines
(Decision 4).

**Scope at adoption is `query/language/`.** `concept/`, `connection/` and `driver/` specify a
driver API surface TypeQLite has no equivalent of; they may be added later by the same mechanism,
and are not pretended to apply now.

### 2. TypeQLite runs the specification as one more driver would

Step definitions bind the specification's own vocabulary — `typeql schema query`, `get answers of
typeql read query`, `uniquely identify answer concepts`, `… fails with a message containing` — to
`TypeQliteInterpreter` **in memory, with no server**. That is what makes the suite routine: it is
deterministic, it needs nothing running, and a scenario is exactly as expensive as its queries.

⚠️ **The step semantics are TypeDB's, not ours.** Where a step's meaning is unclear the reference is
the server's own implementation (`typedb/typedb` `tests/behaviour/`), not a reading that happens to
make TypeQLite pass.

### 3. 🔴 The suite is a report card, not a gate — and every scenario has one of four outcomes

Every scenario runs, every time. Each ends as exactly one of:

| Outcome | Meaning |
| ------- | ------- |
| **pass** | TypeQLite answered what TypeDB specifies |
| **fail** | It did not, and nothing claims otherwise |
| **deviation** | It did not, **on purpose**, and a record says why (Decision 5) |
| **not-applicable** | A step names capability outside the engine's contract (a user, a cluster, a driver object) |

**The four counts sum to the scenario count**, per feature, and the run prints them. A run that
cannot account for every scenario is a broken run, not a partial score.

### 4. The pass count per feature may never go down

A committed baseline records the pass count per feature file. **The routine run is red when any
feature's pass count is below its baseline** — that is the only assertion the suite makes of itself.
Raising the baseline is a deliberate commit that cites the run. Lowering it is a decision, taken in
a review, never a side effect of a fix.

⚠️ **The baseline is per feature, not a total.** A total hides a regression in `delete` behind
progress in `match`.

### 5. A known deviation is declared, not silently failed

A scenario TypeQLite fails *by design* is listed in a deviations file with the scenario, the reason,
and **the record that owns it** — an ADR decision, or an open defect record. A deviation with no
owner is a **fail**. The select-refusal is the first entry: a knowing departure from TypeDB, decided
on `defect/typeqlite-select-refusal` and recorded on the parking lot as a conformance gap.

### 6. The score is the evidence for the "drop-in" claim

From acceptance, **ADR-002's "drop-in TypeDB replacement" is stated with the number**. Any document
claiming TypeQL compatibility cites a report-card run and its date, as ADR-003's amendment already
requires of CouchDB compatibility. A claim without a cited run is prose.

## Consequences

### Positive

- **Semantics stop being guessed.** The class of defect that cost sixteen review rounds — a
  well-formed query whose evaluation is wrong — is exactly what this corpus specifies, scenario by
  scenario, and it runs in seconds with nothing up.
- **The first number is honest, and it is zero.** That is more useful than a green suite that does
  not contain the question. The first three moves are visible before any harness exists: accept the
  `@card`/`@independent`/`@unique` annotations, answer things, resolve a thing by its key.
- **Progress is countable and regression is refused**, without the suite ever being a gate anyone
  is tempted to waive wholesale.
- **The parked relation-matching branch has its oracle.** It was parked *for* this.
- **Measured at acceptance (added 2026-09-11):** 0 → 140 → 164 → 416 of 1,756 across four phases,
  each chosen from the previous card's failure digest — the grammar, things as answers, and the
  312 schemas TypeDB refuses. Two annotations left the not-enforced list (`@unique`, `@abstract`)
  because the oracle measured them; one defect was found by a review round and placed by the
  digest. The consequence the decision predicted — semantics stop being guessed — held: every
  rule Phase 03 wrote was a scenario's, not a reading of the docs.

### Negative / Constraints

- **The corpus is TypeDB 3.x's.** TypeQLite implements the 3.x language (ADR-002), so that is the
  right target, but every pin move may change scenarios under us; re-baselining is real work.
- **Licence obligation.** MPL-2.0 files are file-scoped copyleft: they stay under MPL with headers
  intact, and modifications to *those files* are MPL. Our step definitions are ours. The vendored
  directory carries the licence and says so.
- **The differential oracle against a live TypeDB is still owed for *our* schemas.** The
  specification covers the language, not `downstream-store` or `skills`. That is a separate, smaller
  piece of work, sequenced after this, and it needs the `downstream-store` stack running.
- **`not-applicable` is a judgement, and judgements drift.** Decision 3's rule that the four counts
  sum to the total is what keeps a scenario from quietly moving from fail to not-applicable; the
  standard says how the classification is declared.

### What was rejected

- **Hand-written semantics tests derived from the TypeDB docs.** The status quo, in effect: the
  relation-semantics suites written on 2026-09-10 were exactly this, and each encoded a guess the
  review then falsified. The specification already exists; writing our own is writing it wrong.
- **The live-TypeDB differential oracle first.** It needs Docker and the `downstream-store` stack up, so
  it cannot be routine; it covers only the schemas we write; and it tests the same assertion as this
  corpus with more machinery. It is still worth having — for our schemas — and is sequenced second.
- **The suite as a gate with waivers.** 791 waivers on day one, and ADR-047's waiver discipline
  exists precisely because a waiver granted in bulk is not evidence of anything.
- **Fetching the specification at test time.** Non-deterministic, network-dependent, and the score
  would change without a commit. The pin is the point.
- **The tests shipped with `@downstream/typedb-wasm`.** They are that package's, not TypeDB's, and
  ADR-002's context records that its source is unobtainable.
- **A single total baseline.** Hides regressions — Decision 4.

## References

- [`typedb/typedb-behaviour`](https://github.com/typedb/typedb-behaviour) — the specification;
  surveyed at `7d35851bffeabd642b7288dea82eb63852f3c191` (2026-09-10)
- [`typedb/typedb` `tests/behaviour/`](https://github.com/typedb/typedb/tree/master/tests/behaviour)
  — the server's own step implementations, the reference for step meaning
- [ADR-002](adr-002-typeql-engine-as-a-port.md) — the drop-in claim this measures
- [ADR-003](adr-003-typeqlite-change-log-and-sync-as-a-port.md) — the CouchDB oracle, and the rule
  that a compatibility claim cites a run
- [ADR-046](adr-046-promptos-conformance-for-every-prompt-artifact.md),
  [ADR-047](adr-047-promptos-facet-waivers-against-measured-evidence.md) — measured conformance and
  waivers against evidence
- [ADR-054](adr-054-an-adr-that-mandates-behaviour-has-a-companion-standard.md) — why the
  procedure is in a standard
- [`next-session-plan.md`](../planning/next-session-plan.md) — the 2026-09-10 session's record of
  what nothing in the repository checked
