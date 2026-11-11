# typedblite-conformance

TypeDB's own behaviour specification, vendored and run against TypeDBLite as a report card.

This package is the TypeDBLite Conformance Standard (ADR-005). It answers the question: *which TypeDB behaviours does TypeDBLite implement correctly, and which does it knowingly deviate from?*

## What this package provides

- **Vendored spec** (`spec/query/language/*.feature`) — Cucumber `.feature` files from [typedb/typedb-behaviour](https://github.com/typedb/typedb-behaviour), vendored at a pinned commit. These files are **never edited by hand**.
- **Runner** (`src/runner.ts`) — executes every Cucumber scenario against the TypeDBLite runtime.
- **Report card** (`src/report.ts`) — summarises pass/fail counts per feature file and compares against `baseline.json`.
- **CLI** (`src/cli.ts`) — prints the report card and exits 1 on a regression.
- **Deviation declarations** (`deviations.yaml`) — intentional failures, each with an owner.
- **Not-applicable declarations** (`not-applicable.yaml`) — scenarios that do not apply to TypeDBLite's model.
- **Baseline** (`baseline.json`) — the last-known pass count per feature file; the floor below which a run fails.

## Vendored spec

| Field | Value |
|---|---|
| Source | `typedb/typedb-behaviour` |
| Commit | `7d35851` (2026-09-10) |
| Paths | `query/language/*.feature`, `LICENSE` |
| Surveyed against | TypeDB 3.10.4 |
| Licence | MPL-2.0 — file headers intact |

The pinned commit is in `spec/PIN`. Do not update the vendored files without also updating `PIN` and re-running the full report card.

## Running

```bash
# Run all scenarios and check for regressions against baseline.json
nx run typedblite-conformance:test

# Print the full report card to stdout (exits 1 on regression, 0 otherwise)
nx run typedblite-conformance:report
```

The test suite exits non-zero if any scenario is below its baseline. The report CLI also prints:
- Improvements whose baseline has not been raised (`⬆ above baseline — raise it`)
- Deviations that now pass and must be removed (`✅ deviation now passing`)

## Baseline

`baseline.json` records the last-known pass count per feature file:

```json
{
  "define": 415,
  "undefine": 131,
  "redefine": 155,
  ...
}
```

**When scenarios improve:** the report prints `⬆ above baseline`. Raise `baseline.json` in the same commit that introduced the improvement.

**When scenarios regress:** the report exits 1 and prints `🔴 below baseline`. Fix the regression or declare a deviation.

## Declaring a deviation

A deviation is an intentional failure — TypeDBLite behaves differently from TypeDB by design.

Add an entry to `deviations.yaml`:

```yaml
- feature: define
  scenario: "Scenario name from the .feature file"
  owner: adr-005          # ADR number or defect record id — required
```

Rules:
- Every entry **must have an owner** — an ADR number or a defect id. No owner means it is a plain failure.
- Declare a deviation only once the scenario's Background steps pass and the deviation is the actual reason it fails. Declaring it against a scenario that fails three steps earlier records the wrong reason.
- When the scenario starts passing, the report prints `✅ deviation now passing`. Remove the entry in the same commit.

## Not-applicable declarations

`not-applicable.yaml` lists scenarios that do not apply to TypeDBLite at all (e.g. scenarios that test a TypeDB feature TypeDBLite explicitly does not model). These are excluded from the report card, not counted as failures.

## Feature file coverage (baseline)

| Feature | Passing |
|---|---|
| define | 415 |
| redefine | 155 |
| undefine | 131 |
| expression | 117 |
| reduce | 63 |
| insert | 42 |
| match | 56 |
| delete | 15 |
| fetch | 40 |
| pipelines | 9 |
| modifiers | 24 |
| update | 30 |
| variables | 11 |
| disjunction | 7 |
| given | 18 |
| metadata | 107 |
| negation | 14 |
| optional | 10 |
| put | 7 |

## Tests

```bash
nx run typedblite-conformance:test
```

The test suite (`test/conformance.test.ts`) calls `runConformance()` and asserts no regressions. Additional unit tests cover the harness, spec loading, and owner validation.
