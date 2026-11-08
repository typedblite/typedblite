---
kind: standard
status: active
applies-to: the TypeDBLite conformance project and every document that claims TypeQLite compatibility
operationalises: [adr-005]
---

# TypeDBLite Conformance Standard

> **Status:** Active · **Created:** 2026-09-11 · **Accepted:** 2026-09-11, with ADR-005 · **Applies to:** the TypeDBLite conformance
> project (`packages/conformance`) and every document that claims TypeQLite compatibility.
>
> Operationalises [ADR-005](../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md).
> 🔴 **The ADR decides; this standard is how the decision is met.** Where the two disagree, the ADR
> wins and this standard has the bug.
>
> ✅ **Active since 2026-09-11**, the day ADR-005 was accepted.

---

## The rule

🔴 **The conformance suite runs every vendored scenario, accounts for every one of them as pass,
fail, deviation or not-applicable, and is red when any feature's pass count is below its committed
baseline.** Nothing else about the score is asserted, and nothing about it is waived.

## The layout

```
packages/conformance/
  spec/                      # vendored from typedb/typedb-behaviour — MPL-2.0, headers intact
    LICENSE                  # the MPL-2.0 text, verbatim
    PIN                      # commit, date, and the TypeDB server version surveyed against
    query/language/*.feature
  src/                       # the step definitions and runner, bound to TypeDBLiteInterpreter
  baseline.json              # pass count per feature file
  deviations.yaml            # scenarios failed by design, each with its owning record
  not-applicable.yaml        # step patterns outside the engine's contract, each with a reason
```

⚠️ **`spec/` is never edited by hand.** A change to a vendored file is a pin move (below). Anything
we need to change about a scenario is a deviation or a not-applicable declaration, not an edit.

## Running it

```
npx nx run typedblite-conformance:test
```

The run prints one line per feature — `match: 12 pass · 98 fail · 1 deviation · 2 n/a · 113 total`
— and a total line. **The four counts sum to the total, per feature, or the run is broken and says
so** rather than reporting a score.

It needs nothing running. It is part of the routine suite.

## Raising the baseline

When a change makes more scenarios pass:

1. Run the suite; read the per-feature counts.
2. Set each raised feature's entry in `baseline.json` to its **new pass count** — not higher, not
   rounded.
3. Commit the baseline change **in the same commit as the change that earned it**, citing the
   counts in the message.

🔴 **Raise only what the run showed.** A baseline set above the measured count is a red run waiting
for the next person.

## Lowering the baseline

Is a decision, not a fix. It happens in a review, on a branch whose close-out artifact records the
regression as a finding with an outcome, and the commit message says which scenarios regressed and
why that is accepted. **A fix that lowers a baseline as a side effect is the regression it hides.**

## Declaring a deviation

A scenario TypeDBLite fails *by design* goes in `deviations.yaml`:

```yaml
- feature: query/language/match.feature
  scenario: "'isa' matches things of the specified type and all its subtypes"
  reason: the answer table identifies things by @key; TypeDBLite does not project a thing variable — a knowing departure from TypeDB, which answers the concept
  owner: adr-002   # or a defect record id, e.g. d-20260910-an-empty-result-caused-only-by
```

- **`owner` is required** and must resolve: an ADR number that exists in the index, or a defect
  record the gate knows. A deviation with no resolvable owner is counted as a **fail**.
- A deviation that starts *passing* is reported — it means the departure was closed, and the entry
  is removed in the same commit.

## Declaring not-applicable

`not-applicable.yaml` lists **step patterns**, not scenarios — a scenario is not-applicable because
it uses a step the engine has no contract for (a user, a cluster, a driver-side concept object),
never because it is hard:

```yaml
- pattern: "connection has {int} databases"
  reason: TypeDBLite has no connection or database catalogue; one interpreter is one database
```

⚠️ **The list is expected to be short and to shrink.** A scenario moving from fail to
not-applicable is a classification change and is reviewed as one; the sum rule makes the move
visible.

## Moving the pin

1. Record the target commit, its date, and the TypeDB server version it corresponds to in
   `spec/PIN`.
2. Re-vendor `query/language/` from that commit; **diff the scenario names** and list added,
   removed and renamed scenarios in the commit message.
3. Run the suite; re-baseline **downward only where a scenario was removed or changed**, upward
   where the run shows it — each named.
4. Re-check every `deviations.yaml` entry still names a scenario that exists.

## Claiming compatibility

Any document that says TypeDBLite is TypeQL-compatible, a drop-in for TypeDB, or conformant, **cites
a run**: the date, the pin, and the per-feature counts or the total. A claim without a cited run is
prose, and a review may strike it.

## What refuses you

| Condition | Result |
| --------- | ------ |
| A feature's pass count is below `baseline.json` | 🔴 red run |
| The four counts do not sum to the feature's scenario count | 🔴 red run, no score reported |
| A `deviations.yaml` entry with no resolvable `owner` | counted as fail |
| A `deviations.yaml` entry naming a scenario that does not exist | 🔴 red run |
| A vendored file edited by hand | review finding — revert, then deviate or pin |
