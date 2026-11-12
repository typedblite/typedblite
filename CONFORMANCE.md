# TypeDBLite Conformance Status

How closely TypeDBLite matches TypeDB, measured against TypeDB's own behaviour specification. This page
gives the latest numbers, what each non-passing scenario is and why, and how to reproduce or update the
count.

> **Cited run:** 2026-11-12, at `main` `fa3e075`, against the spec pin
> `typedb/typedb-behaviour@7d35851` (`query/language/*.feature`, surveyed against TypeDB 3.10.4).
> The [TypeDBLite Conformance Standard](docs/standards/governance/typedblite-conformance-standard.md)
> requires any compatibility claim to cite a run. Cite this one, or a later one.

## Summary

| Outcome | Scenarios | Share |
| --- | ---: | ---: |
| **Pass** | **1,742** | 99.2% |
| Deviation (declared, owned) | 12 | 0.7% |
| Fail | 1 | 0.06% |
| Not applicable | 1 | 0.06% |
| **Total** | **1,756** | |

- **Every scenario a live TypeDB 3.10.4 passes, TypeDBLite passes, except one** (`update` L959, see
  [The one failure](#the-one-failure)).
- The 12 deviations are scenarios **TypeDB 3.10.4 fails too**. That was measured by running the same
  steps against a real TypeDB server, not argued. They are owned by
  [ADR-007](docs/architecture/adr-007-a-scenario-typedb-itself-fails-is-a-deviation.md) (accepted
  2026-11-12).
- No scenario stops in a Background step, and no step is left undefined.

## By feature

| Feature | Pass | Fail | Deviation | N/A | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| define | 475 | 0 | 0 | 0 | 475 |
| delete | 49 | 0 | 1 | 0 | 50 |
| disjunction | 9 | 0 | 0 | 0 | 9 |
| expression | 130 | 0 | 0 | 0 | 130 |
| fetch | 66 | 0 | 0 | 0 | 66 |
| given | 22 | 0 | 0 | 0 | 22 |
| insert | 136 | 0 | 5 | 0 | 141 |
| match | 130 | 0 | 2 | 0 | 132 |
| metadata | 122 | 0 | 1 | 0 | 123 |
| modifiers | 34 | 0 | 0 | 0 | 34 |
| negation | 15 | 0 | 1 | 1 | 17 |
| optional | 10 | 0 | 0 | 0 | 10 |
| pipelines | 12 | 0 | 0 | 0 | 12 |
| put | 15 | 0 | 2 | 0 | 17 |
| redefine | 197 | 0 | 0 | 0 | 197 |
| reduce | 65 | 0 | 0 | 0 | 65 |
| undefine | 176 | 0 | 0 | 0 | 176 |
| update | 67 | 1 | 0 | 0 | 68 |
| variables | 12 | 0 | 0 | 0 | 12 |
| **Total** | **1,742** | **1** | **12** | **1** | **1,756** |

Twelve of the nineteen feature files pass in full. The pass counts are the committed floor in
[`libs/conformance/baseline.json`](libs/conformance/baseline.json). The routine test run fails if any
feature drops below its floor.

## What the four outcomes mean

Every scenario ends as exactly one of these, and per feature they always add up to the total
([ADR-005](docs/architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md) D3):

- **Pass:** every step ran and none failed. The harness refuses passes that check nothing. A scenario
  that fails because the query did not parse, or because TypeDBLite does not implement it, is not the
  failure the scenario asked for, and it does not count as a pass.
- **Fail:** a step failed, and nothing records it as intended.
- **Deviation:** it fails on purpose, and an ADR or defect record listed in
  [`deviations.yaml`](libs/conformance/deviations.yaml) says why. A deviation whose owner cannot be
  found counts as a fail.
- **Not applicable:** a step uses something outside the engine's contract, or the scenario has no steps.

## The one failure

**`update.feature` L959: "Has for attribute subtypes can be updated without affecting sub and
supertypes"**, at L1094: `transaction commits; fails with a message containing: "card"`.

TypeDB treats an `owns` with no `@card` as `@card(0..1)` and enforces it when the transaction commits. In
this scenario, `surname` and its subtype `old-surname` together leave a person with two `surname`
values, so TypeDB refuses the commit. TypeDBLite does not enforce the default, so the commit goes
through.

**This is a product decision that is still open, not an oversight.** downstream-app depends on the current
behaviour:

| Store | Ownership declared without `@card` | Owners holding more than one value |
| --- | --- | ---: |
| document-store | `document owns doc-facet` | 1,041 |
| document-store | `document owns doc-tag` | 389 |
| defects | `defect owns defect-subject-scope` | 64 |
| defects | `defect owns defect-exclude-path` | 7 |
| defects | `defect owns defect-red-test-path` | 2 |
| defects | `defect owns defect-changed-recording` | 1 |

These counts come from a read-only scan of downstream-app's `.mvp` stores on 2026-11-12. If TypeDBLite
enforced TypeDB's default, those stores would refuse writes to things that already hold several values.
There are two ways forward:

1. **Conform:** add `@card(0..)` to those ownerships in the downstream-app schemas, then enforce the
   default. The scenario then passes.
2. **Deviate:** record in an ADR that TypeDBLite does not enforce the default `@card(0..1)`, and declare
   the scenario as a deviation owned by it.

## Deviations: scenarios TypeDB itself fails

Each entry was run against `typedb/typedb:3.10.4` with the differential oracle (below), and the TypeDB
side fails too. TypeDBLite fails at the same step or a later one, for the same cause. Nine are tagged
`@ignore` in the upstream spec.

| Scenario | Where TypeDB 3.10.4 fails | Cause |
| --- | --- | --- |
| `insert` L2219: inferred concepts are not materialised | parse, L2222 | TypeDB-2 `rule` syntax; TypeDB 3 has no rules. `@ignore` |
| `insert` L2272: an inferred ownership is not persisted | parse, L2275 | `rule` syntax. `@ignore` |
| `insert` L2337: an inferred attribute gets materialised | parse, L2343 | `rule` syntax. `@ignore` |
| `insert` L2432: an inferred relation gets materialised | parse, L2435 | TypeDB-2 define-shaped `undefine employment owns ref`. `@ignore` |
| `insert` L2515: a chain of inferred concepts is materialised | commit, L2580 (`@card(0..1)` violated) | the rules chain; its data cannot commit on TypeDB 3. `@ignore` |
| `delete` L221: variable types can be used in deletes | type inference, L233 | TypeQL-2 syntax throughout (`$n0 "Alice"`, `type person`). `@ignore` |
| `match` L210: transitive `sub` assertions | L231, templating an iid for a type | "types cannot be specified by IID" (upstream comment). `@ignore` |
| `match` L1484: relation and role pairings | L1516, `transaction is open: false` | TypeDB keeps every kind of transaction open after a failed read (probed directly). `@ignore` |
| `metadata` L189: doc comments on top-level items | parse, L198 (`get_doc`) | "TODO: settle on the syntax" (upstream). `@ignore` |
| `negation` L303: filtering a chain of relations | L354, `verify answer set is equivalent for query` | the two queries name different variables (`$f3` and `$f2`). TypeDB's own version of this step does nothing (`if true { … return; }`), which is the only reason TypeDB's CI passes it |
| `put` L366: put when a subtype already owns | parse, L385 | a doc string in the spec is never closed, so `Then answer size is: 1` ends up inside the query |
| `put` L407: put when a subtype is already owned | parse, L427 | the same unclosed doc string |

When the pin moves, the oracle is run again. Any entry TypeDB then passes is removed, and its scenario
becomes an ordinary gap (ADR-007 D2).

## Not applicable

`negation.feature` L656, "Nested negations", has no steps upstream, only a `# TODO`. A scenario that runs
nothing cannot pass, so it is counted as not applicable.

## Where TypeDB disagrees with its own spec

The spec is the standard (ADR-005), so where TypeDB 3.10.4 answers against it, TypeDBLite follows the
spec and passes. This section records what the oracle found about the server itself:

- **`match` L5298:** for `$l isa loop, links (member: $l)`, TypeDB answers every loop that has a member,
  not just the loop that plays a role in itself. TypeDBLite answers what the spec specifies.
- **`redefine` L412:** TypeDB cannot parse `redefine relation … label …`. TypeDBLite renames, as the spec
  specifies.
- **Server crashes:** TypeDB 3.10.4 panics and exits on some spec queries (`executor/instruction/checker.rs:1168`,
  "Check variables without an extractor must have been recorded in the row"). It happened four times in
  one full run.

## How the numbers are produced

### The report card

```bash
npx nx run typedblite-conformance:test      # routine; red if any feature drops below its floor
npx nx run typedblite-conformance:report    # prints the card and a digest of failures
```

Both targets build their dependencies first. If you need to leave the built `out/` folders alone (see
[Caveats](#caveats)), run from source:

```bash
cd libs/conformance
npx tsx --tsconfig ../../tsconfig.base.json src/cli.ts
```

A full run takes about 8 seconds. Each scenario gets its own in-memory engine, and the harness
(`World`) plays the role of the connection layer: databases, transactions and their kinds. A write or
schema transaction is the engine's real transaction. Commit runs the engine's checks, and closing the
transaction rolls it back.

### The differential oracle

```bash
docker run -d --name typedb-oracle --restart always -p 8000:8000 typedb/typedb:3.10.4
cd libs/conformance
npx tsx --tsconfig ../../tsconfig.base.json src/oracle.ts [feature[:line,…] …]
```

[`src/oracle.ts`](libs/conformance/src/oracle.ts) runs the same steps on TypeDBLite and on a live TypeDB
(through [`src/typedb-oracle.ts`](libs/conformance/src/typedb-oracle.ts), over TypeDB's HTTP API) and
sorts every scenario into one of four groups. Its first full run, on 2026-11-12:

| Group | Scenarios | Meaning |
| --- | ---: | --- |
| Pass on both | 1,447 | agreement |
| TypeDB passes, TypeDBLite failed | 49 | real gaps; all closed since, except `update` L959 |
| Both fail | 15 | the 12 deviations, plus 3 later fixed in TypeDBLite (`match` L5298 and L5327 by following the spec, and `redefine` L412) |
| TypeDB fails, TypeDBLite passes | 245 | mostly the harness's own limits over HTTP (see below); not evidence about either engine |

What the oracle can't do:
- It can't send given rows over the HTTP API, so `given.feature` is checked on TypeDBLite only.
- It doesn't convert TypeDB's value formats into TypeDBLite's, so some value comparisons fail on the
  TypeDB side only.
- Its rulings on transaction state come from the shared `World`, not from TypeDB. Where that mattered
  (`match` L1484), TypeDB was probed directly.

Run the container with `--restart always` so that a server crash fails only the scenario that caused it.

## Readings taken from TypeDB's own source

Where a step's meaning was unclear, the harness copies TypeDB's own step definitions
(`typedb/typedb`, `tests/behaviour/steps/query/typeql.rs`) rather than guessing:

- **`<answer.x.iid>` templates:** these are substituted with the answer's iid, as TypeDB's
  `apply_query_template` does. `each answer satisfies` requires exactly one answer per row.
- **iid cells in given rows:** a cell such as `iid:entity:0:1` is `iid:<kind>:<type id, hex>:<object id, hex>`.
  TypeDB numbers types per kind in definition order, and objects per type in creation order.
  TypeDBLite resolves that numbering with `thingNumbered`.
  - ⚠️ TypeDB never reuses an object id. TypeDBLite's numbering shifts after a delete, and no scenario
    numbers a thing after one.
- **`answer size is`** counts rows without removing duplicates, as TypeDB's step does.
- **`verify answer set is equivalent for query`** compares whole rows. TypeDB's step is turned off; if
  it were on, it would compare whole rows too.

## Recent behaviour changes

The push from 1,676 to 1,742 (PR #6) changed behaviour that callers can notice. Projects that load the
built runtime, such as downstream-app, see these changes after their next rebuild:

- **Deleting a thing keeps relations that still have other players.** Before, every relation the thing
  played in was deleted. Now a relation is deleted only once it has no player left, as on TypeDB.
- **A relation emptied inside a transaction is removed at commit**, so the transaction's own answers can
  still name it.
- **`plays` is enforced once the store records roles**, even after the last `plays` is undefined. The
  check is skipped only for a store that records no roles at all. Every real downstream-app store that
  has roles also records its `plays`.
- **Writes are type-checked as TypeDB checks them:**
  - `delete has $e of $p` requires every type the match lets `$p` be to own every type `$e` can be.
  - `delete links` and `update … links` refuse any relation type that has specialised the role away.
  - Refusals use TypeDB's own messages ("Left type … across constraint …", "Type-inference was unable
    to find compatible types …").
- **The grammar now accepts these TypeDB forms:**
  - `$x iid 0x…` and `iid($x)`
  - `$x value integer`
  - `has $a 9`
  - `has age (10 + 5)`
  - `entity person;` as a pattern
  - `sub` after the traits
  - `(…) isa $r`
- **`delete has name $n of $p` no longer parses**, as on TypeDB.

## History

| Date | Card | Milestone |
| --- | --- | --- |
| 2026-09-11 | 0 → 140 → 164 → 416 | spec vendored; first four phases ([ADR-005](docs/architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md) accepted) |
| 2026-11-11 | 1,306 → 1,439 | attributes stored once per type and value ([ADR-006](docs/architecture/adr-006-an-attribute-is-stored-once-per-type-and-value.md)) |
| 2026-11-12 | 1,676 | lists, role specialisation, scoped keys, real transactions, functions and metadata (PR #5) |
| 2026-11-12 | **1,742**, 1 fail, 12 deviations | every gap TypeDB passes closed but one; differential oracle; [ADR-007](docs/architecture/adr-007-a-scenario-typedb-itself-fails-is-a-deviation.md) (PR #6) |

## Caveats

- **The built `out/` folders lag behind the source.** downstream-app loads `libs/*/out` through symlinks,
  so this checkout's runtime and language packages were not rebuilt during this work. Whatever its
  `out/` holds when it starts is the engine it runs. Nine runtime tests start child processes that load
  `out/`. They pass against source with `TSX_TSCONFIG_PATH=tsconfig.base.json`, and under `nx test`,
  which builds first.
- **One TypeDB version.** Every claim on this page is about TypeDB 3.10.4 and spec pin `7d35851`. Moving
  the pin means repeating the
  [standard's procedure](docs/standards/governance/typedblite-conformance-standard.md#moving-the-pin):
  re-vendor, diff the scenario names, re-run the card, and re-run the oracle on every deviation.
- **The spec covers the language, not your schema.** A passing card shows TypeDBLite does what TypeDB's
  specification says. It doesn't show that every query a particular application sends behaves the same
  as on TypeDB. The oracle can be pointed at any scenario; it doesn't yet replay application traffic.

## Keeping this page current

- When a change makes scenarios pass, raise those features' floors in `baseline.json` in the same commit.
  The routine test refuses an improvement whose floor was not raised.
- A deviation that starts passing is reported by the run. Remove its entry in the same commit.
- Refresh this page from a new cited run whenever the card changes. Put the date, the commit and the
  pin in the box at the top.

## References

- [ADR-005](docs/architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md):
  TypeDB's behaviour specification is TypeDBLite's conformance oracle
- [ADR-006](docs/architecture/adr-006-an-attribute-is-stored-once-per-type-and-value.md): an attribute
  is stored once per type and value
- [ADR-007](docs/architecture/adr-007-a-scenario-typedb-itself-fails-is-a-deviation.md): a scenario
  TypeDB itself fails is a deviation, and the oracle decides which
- [TypeDBLite Conformance Standard](docs/standards/governance/typedblite-conformance-standard.md)
- [`libs/conformance/README.md`](libs/conformance/README.md): the package itself
- [`libs/conformance/deviations.yaml`](libs/conformance/deviations.yaml) and
  [`libs/conformance/baseline.json`](libs/conformance/baseline.json)
