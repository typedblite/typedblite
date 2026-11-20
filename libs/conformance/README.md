# typedblite-conformance

TypeDB's own behavior specification, vendored and run against TypeDBLite as a report card.

This package is the TypeDBLite Conformance Standard (ADR-005). It answers the question: *which TypeDB behaviors does TypeDBLite implement correctly, and which does it knowingly deviate from?*

## What this package provides

- **Vendored spec** (`spec/query/language/*.feature`) — Cucumber `.feature` files from [typedb/typedb-behaviour](https://github.com/typedb/typedb-behaviour), vendored at a pinned commit. These files are **never edited by hand**.
- **Runner** (`src/runner.ts`) — executes every Cucumber scenario against the TypeDBLite runtime.
- **Report card** (`src/report.ts`) — summarizes pass/fail counts per feature file and compares against `baseline.json`.
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
| License | MPL-2.0 — file headers intact |

The pinned commit is in `spec/PIN`. Do not update the vendored files without also updating `PIN` and re-running the full report card.

## Running

```bash
# Run all scenarios and check for regressions against baseline.json
npm exec nx -- run typedblite-conformance:test

# Print the full report card to stdout (exits 1 on regression, 0 otherwise)
npm exec nx -- run typedblite-conformance:report
```

### The differential oracle (ADR-007)

```bash
docker run -d --name typedb-oracle --restart always -p 8000:8000 typedb/typedb:3.10.4
npx tsx --tsconfig ../../tsconfig.base.json src/oracle.ts [feature[:line,…] …]
```

Runs the same steps against a live TypeDB (`TYPEDB_URL`, default `http://localhost:8000`) and prints
where it and TypeDBLite disagree. A scenario TypeDB itself fails is a deviation owned by ADR-007, not
an engine gap. It needs a server, so it is never part of the routine suite. Given rows cannot be passed
over HTTP, and TypeDB 3.10.4 panics on a few spec queries; `--restart always` lets the run continue.

### Comparing speed against TypeDB

```bash
npm exec nx -- run typedblite-conformance:oracle-bench -- --growth=100,400,1000 --relations=200,1000 --out=results.md
```

Runs the load test's `growth` and `relations` workloads (`libs/runtime/bench`) on TypeDBLite and on the same
live TypeDB, with the same statements and fixture schemas, and checks that both return the same number of
answers. It needs the server from the section above. TypeDBLite runs in process and TypeDB over HTTP, which
costs about 2 ms a call whatever the query is, so a raw comparison measures the embedding. The tool takes
the network out three ways (one open read transaction on TypeDB, count-only reads so no rows are
transferred, and each engine's floor subtracted: the header of
[`src/oracle-bench.ts`](src/oracle-bench.ts) explains each), and a cost under 0.15 ms is shown as `~0`, because
it cannot be told from the floor. Writes are not adjusted and are not comparable. Treat one run as one run:
this machine's results vary by up to 2x, and TypeDB runs in Docker. No results are kept in the repository.

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
| define | 475 |
| redefine | 197 |
| undefine | 176 |
| expression | 130 |
| reduce | 65 |
| insert | 136 |
| match | 130 |
| delete | 49 |
| fetch | 66 |
| pipelines | 12 |
| modifiers | 34 |
| update | 67 |
| variables | 12 |
| disjunction | 9 |
| given | 22 |
| metadata | 122 |
| negation | 15 |
| optional | 10 |
| put | 15 |

## Tests

```bash
npm exec nx -- run typedblite-conformance:test
```

The test suite (`test/conformance.test.ts`) calls `runConformance()` and asserts no regressions. Additional unit tests cover the harness, spec loading, and owner validation.
