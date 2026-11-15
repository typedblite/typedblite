# Performance

What the engine costs on real schemas and data, what the load test found, and what is still open.
The numbers come from the load test, `nx run typedblite-runtime:bench`
([libs/runtime/bench](../../libs/runtime/bench/README.md)). The raw results are in
[performance-results/](performance-results/).

- [How it was measured](#how-it-was-measured)
- [What it found](#what-it-found)
- [Results, before and after](#results-before-and-after)
- [Still open](#still-open)
- [Running it again](#running-it-again)

## How it was measured

**Real stores.** Snapshots of the stores of a production application built on the engine,
taken on 2026-11-12. Each was driven with the query shapes its repository issues, copied from that
repository's source:

| Store | Things | `has` rows | What it exercises |
| ----- | -----: | ---------: | ----------------- |
| `scm/ladder.db`, the workflow engine | 46,690 | 275,669 | `find()` is 16 queries; `saveStep()` is a delete, an insert and a history insert, 3 commits |
| `observability.db` | 22,938 | 77,156 | A filtered listing: one base match, then one query per optional attribute |
| `document-store.db` | 2,390 | 21,611 | Large text values and full-text search; 967 MB, most of it change log |
| `skills/graph/skills.db` | 4,099 | 14,325 | The only store with relations at volume (4,800 role players) |

**Growth.** A workflow-engine store built from empty to 100,000 entities with `ladder.db`'s shape,
measured every 20,000. A cost that rises while its answer does not is a scan.

**Relations at scale.** The Skills schema generated at 1×, 5× and 14× the real catalog.

**Contention.** One to four writer processes, with and without readers, on one copy of `ladder.db`.
That application runs two processes on the same stores.

Everything ran from source on one machine: an Intel Core Ultra 9 275HX (24 cores), WSL2, Node
24.19.0. Absolute numbers are this machine's. The ratios and the growth curves are the findings.

## What it found

Six problems in the engine, all fixed on the branch that added this page, and a seventh that belongs
to the consumer. What the fixes left behind is under [Still open](#still-open).

### 1. A second writing process failed instead of waiting

`execute()` opened its transaction with a plain, deferred `BEGIN`. A write pipeline reads before it
writes, so the transaction held a read snapshot and then had to upgrade it. When another process
had committed in between, SQLite refused the upgrade with `SQLITE_BUSY` at once, and `busy_timeout`
does not apply to an upgrade. Two processes sharing one store lost about 30% of their writes to
`database is locked`.

**Fixed:** `BEGIN IMMEDIATE`, as `beginTransaction()` already used, takes the write lock first.
`changeLog.compact()` had the same `BEGIN` and got the same fix. Guarded by
`write-lock-contention.test.ts`: four real processes start at one instant.

### 2. Every write scanned the full-text index

`entity_fts.entity_id` is `UNINDEXED`, as an FTS5 column must be unless it is tokenised. So
`FullTextIndex.remove()`, which runs before every index update including a new entity's, executed
`DELETE … WHERE entity_id = ?` as a scan of the whole index. It was 51% of an insert's CPU, and it
grew with the store: 1.8 ms per write at 15,000 entities, 19 ms at 150,000. It also capped bulk
loading: 100 inserts in one transaction cost the same per insert as 100 commits.

**Fixed:** `entity_fts_key` maps each entity to its FTS rowid, so a write reads and deletes by rowid.
A store gains the table on open and its keys on its first write. An older engine writing the same
file is tolerated, because each write checks that the newest index row is keyed and rebuilds the
keys once when it is not (the comment above `entity_fts_key` in `full-text.ts` explains why that
check suffices). Guarded by `full-text-key.test.ts`, which checks every statement a write prepares
against `EXPLAIN QUERY PLAN`.

### 3. Statements were prepared once per row

The engine prepares SQL inline at about 250 call sites, and some of them run per row:
`readAttributes` prepares once per owner per `has $x` binding. Listing 7,000 observations with six
bindings prepared 42,000 statements, and preparing cost more than running them.

**Fixed:** `cachingStatements` (`statement-cache.ts`) memoises `prepare()` by SQL text, as an LRU
of 512, beneath the tracing proxy. Guarded by `statement-cache.test.ts`.

### 4. An empty answer read the whole type to explain itself

When a query answers nothing, the `noCandidates` fact states two counts. Both were taken by running
`candidates()` again and taking `.length`, which read every instance of the type into memory. Empty
answers are routine: that application reads each optional attribute with a query of its own, and most
rows lack most of them. So ordinary reads paid for a full read of the type, and it is why the
workflow engine's `find()` took 46 ms.

**Fixed:** the fact asks `LIMIT 1` whether anything matches, and SQL `COUNT(*)` for the number it
states. The messages are unchanged. Guarded by `empty-answer-cost.test.ts`.

### 5. One broad `has` value made a selective match slow

`$s isa skill, has skill-id "x", has revision "r1"` built one `t.iid IN (owners of the value)`
subquery per literal, and SQLite materialises each. When one value is owned by thousands of things
and another by one, the broad one set the cost: 5.0 ms against 0.017 ms for the same answer
computed from the selective subquery, with the other checked per candidate by `EXISTS`.

**Fixed:** with two or more literals, `candidateQuery` counts each value's owners, stopping at 256,
and drives from the fewest. Every other literal becomes an `EXISTS` probe through the
`attribute(type, value)` and `has(owner, attribute)` indexes. SQLite cannot make that choice itself
without `ANALYZE` statistics. `ORDER BY t.iid` keeps the row order, whichever literal drives.
Guarded by `literal-selectivity.test.ts`, which asserts which value drives.

### 6. A two-hop path enumerated everything when its middle had no type

`(dependent: $a, prerequisite: $b) isa step-dependency; (dependent: $b, prerequisite: $c) isa
step-dependency; $c has step-id $y;` with `$a` pinned answered one row in 1.3 s on a 21,000-step
graph. Adding `$b isa skill-step` answered it in about 1 ms. `$b` has no constraint of its own, so it
was bound only when the relations bound, after `$c`. And `relationSeed` needed every other player
of a relation bound, so `$c` got no seed and was enumerated whole: 21,000 candidates and 42,000
statements.

**Fixed:** `relationSeed` nests the seed of an unbound player that is itself seedable through another
relation, up to three relations deep. The nested seed is a necessary condition, so it only narrows,
and rows and their order are unchanged. A relation that reaches the variable from a bound player
directly is still preferred: nesting only adds a seed where there was none. The untyped path now
costs what the typed one does. Guarded
by `untyped-role-player-seed.test.ts` (trace counts), and by four untyped-chain reads in the
planned-against-unplanned differential suite.

### 7. The document store was mostly change log (consumer)

818 MB of the document store's 967 MB was `change_log`: 195,000 full-state revisions of 2,670
documents. `changeLog.compact()` and `vacuum()` took it to 81 MB in 3 seconds. That application exposes
compaction as a command and never schedules it. The engine has no retention policy of its own, so
any consumer that rewrites large values will grow the same way.

## Results, before and after

Three runs of the same harness (`65e68b6`), with the same snapshots, sizes and sampled keys, on the
same machine, each from its own worktree. Times are milliseconds at the median:

- **original**: the engine before any fix. `libs/runtime/src` was exactly `218b2ca`'s, the bench
  commit, in a worktree of `65e68b6`; the results file records the worktree's commit.
- **fixes-1-4**: fixes 1 to 4 (`55b783a`, the same engine as `0f63c6c` after a rebase that
  changed only `project.json`). It was recorded by the harness before `a key and a broad value` was
  added, so that row shows `—`. The file records its label as `after`.
- **fixes-1-6**: all six fixes (`65e68b6`).

The raw files are in [performance-results/](performance-results/). `2026-11-12-before.json` is the
first baseline, taken on the original engine with the harness as first committed. The rerun
reproduces it closely: 13.4 and 13.1 ms per entity at 100,000 entities, and the same lock errors.

**The headlines,** original → all six fixes:

| | Original | Fixes 1–6 |
| - | -------: | --------: |
| Bulk load, ms per entity, at 20k → 100k entities | 2.3 → 13.1 (rising) | 0.43 → 0.43 (flat) |
| `saveStep()` at 100k entities | 34.7 ms | 5.2 ms |
| Skills catalog at 14×, generated | 300 s | 39 s |
| Two writer processes: writes lost to `database is locked`, in 10 s | 606 | 0 |
| `saveStep()` throughput, one process / four processes | 55 / 52 per s | 160 / 143 per s |
| Workflow engine `find()`, 16 queries | 46.7 ms | 19.4 ms |
| Observability listing, 7,000 rows | 1,106 ms | 385 ms |
| A key and a broad value, at 21,000 steps (finding 5) | 7.44 ms, rising with size | 0.23 ms, flat |
| Two-hop path with an untyped middle, at 21,000 steps (finding 6) | 1,341 ms | 0.50 ms |

Every read and write measured got faster or stayed level. The exception is `ladder: open`, a single
sample each run (8.3 and 10.0 ms), which is noise. `compact()`, `vacuum()` and full-text search did
not change, and were not expected to. Two costs still grow with the store, and both are listed
under [Still open](#still-open): the empty-optional read (counting the type, now 4.6× cheaper) and
`every dependency edge` (a full traversal, which grows with its answer).

### real-stores

| Operation | Rows | original p50 | fixes-1-4 p50 | fixes-1-6 p50 | original → fixes-1-6 (p50) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ladder: open |  | 8.29 | 8.34 | 10.0 | 0.8× |
| ladder: workflow by key | 1 | 0.51 | 0.50 | 0.43 | 1.2× |
| ladder: step column (present) | 7 | 0.88 | 0.60 | 0.60 | 1.5× |
| ladder: history column (mostly absent) | 0 | 9.05 | 2.21 | 2.19 | 4.1× |
| ladder: find() — 16 queries | 113 | 46.7 | 19.7 | 19.4 | 2.4× |
| ladder: list every workflow id | 1601 | 46.3 | 19.5 | 20.4 | 2.3× |
| ladder: saveStep() — 3 commits |  | 17.2 | 5.98 | 5.66 | 3.0× |
| ladder: 100 inserts in one transaction |  | 375 | 55.8 | 50.3 | 7.5× |
| obs: getObservation(id) — 5 queries | 1 | 10.9 | 4.82 | 4.69 | 2.3× |
| obs: list(operation) — 5 queries, ~170 rows | 172 | 16.8 | 6.59 | 6.24 | 2.7× |
| obs: list(kind) — 5 queries, ~7,000 rows | 7032 | 1106 | 398 | 385 | 2.9× |
| obs: event by key | 1 | 0.33 | 0.20 | 0.20 | 1.7× |
| obs: append payload + index — 2 commits |  | 14.8 | 3.70 | 3.60 | 4.1× |
| docs: get(id) — 3 queries | 5 | 2.18 | 0.85 | 1.03 | 2.1× |
| docs: list every document | 2390 | 212 | 77.8 | 84.3 | 2.5× |
| docs: full-text search, limit 150 | 140 | 1.06 | 1.07 | 1.09 | 1.0× |
| docs: re-ingest (remove + add) — 2 commits |  | 15.7 | 4.82 | 5.31 | 3.0× |
| docs: compact() the change log |  | 2686 | 2707 | 2670 | 1.0× |
| docs: vacuum() |  | 279 | 267 | 248 | 1.1× |
| skills: steps via skill-composition | 6 | 1.41 | 0.81 | 0.82 | 1.7× |
| skills: sub-workflow children | 0 | 4.57 | 2.07 | 2.20 | 2.1× |
| skills: step dependencies | 1 | 2.21 | 0.96 | 0.99 | 2.2× |
| skills: every dependency edge | 167 | 73.7 | 15.4 | 16.5 | 4.5× |

### relations

| Operation | Rows | original p50 | fixes-1-4 p50 | fixes-1-6 p50 | original → fixes-1-6 (p50) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200: steps via skill-composition | 7 | 1.54 | 0.77 | 0.81 | 1.9× |
| 200: step dependencies (2 relations) | 6 | 2.18 | 0.99 | 1.05 | 2.1× |
| 200: sub-workflow children (2 relations) | 0 | 4.63 | 1.99 | 2.08 | 2.2× |
| 200: output fields (multi-valued) | 14 | 1.33 | 0.66 | 0.70 | 1.9× |
| 200: a key and a broad value | 1 | 0.74 | — | 0.23 | 3.2× |
| 200: every dependency edge | 1200 | 190 | 56.0 | 58.5 | 3.3× |
| 200: 2-hop, untyped middle | 1 | 84.2 | 25.3 | 0.58 | 144.6× |
| 200: 2-hop, typed middle | 1 | 1.11 | 0.73 | 0.75 | 1.5× |
| 1000: steps via skill-composition | 7 | 1.59 | 0.78 | 0.82 | 1.9× |
| 1000: step dependencies (2 relations) | 6 | 2.19 | 1.01 | 1.02 | 2.1× |
| 1000: sub-workflow children (2 relations) | 0 | 17.2 | 6.35 | 6.54 | 2.6× |
| 1000: output fields (multi-valued) | 14 | 1.32 | 0.65 | 0.71 | 1.9× |
| 1000: a key and a broad value | 1 | 2.52 | — | 0.24 | 10.4× |
| 1000: every dependency edge | 6000 | 923 | 291 | 292 | 3.2× |
| 1000: 2-hop, untyped middle | 1 | 443 | 123 | 0.49 | 897.7× |
| 1000: 2-hop, typed middle | 1 | 1.04 | 0.68 | 0.68 | 1.5× |
| 3000: steps via skill-composition | 7 | 1.57 | 0.78 | 0.77 | 2.0× |
| 3000: step dependencies (2 relations) | 6 | 2.17 | 0.98 | 1.02 | 2.1× |
| 3000: sub-workflow children (2 relations) | 1 | 1.67 | 0.77 | 0.81 | 2.1× |
| 3000: output fields (multi-valued) | 14 | 1.34 | 0.65 | 0.70 | 1.9× |
| 3000: a key and a broad value | 1 | 7.44 | — | 0.23 | 32.2× |
| 3000: every dependency edge | 18000 | 2848 | 849 | 851 | 3.3× |
| 3000: 2-hop, untyped middle | 1 | 1341 | 383 | 0.50 | 2687.8× |
| 3000: 2-hop, typed middle | 1 | 1.18 | 0.70 | 0.63 | 1.9× |

### growth

| entities | loadPerEntity | keyed | column | emptyOptional | listAll | saveStep |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20160 | 2.34 → 0.45 → 0.43 | 0.37 → 0.26 → 0.35 | 2.34 → 0.79 → 0.57 | 3.43 → 1.11 → 1.00 | 20.0 → 9.06 → 8.44 | 11.2 → 4.37 → 3.94 |
| 40320 | 4.95 → 0.45 → 0.44 | 1.50 → 0.23 → 0.26 | 1.46 → 0.55 → 0.56 | 7.29 → 1.77 → 1.79 | 42.8 → 17.8 → 17.2 | 19.0 → 4.73 → 5.02 |
| 60480 | 7.55 → 0.44 → 0.44 | 0.40 → 0.22 → 0.24 | 1.39 → 0.65 → 0.56 | 13.1 → 2.46 → 2.51 | 62.2 → 25.7 → 28.3 | 23.8 → 4.44 → 5.07 |
| 80640 | 10.8 → 0.43 → 0.43 | 1.85 → 0.30 → 0.35 | 1.34 → 0.57 → 0.57 | 14.1 → 3.66 → 3.59 | 81.0 → 35.1 → 34.4 | 27.8 → 3.75 → 3.59 |
| 100800 | 13.1 → 0.44 → 0.43 | 0.35 → 0.23 → 0.23 | 1.30 → 0.59 → 0.59 | 20.6 → 4.45 → 4.50 | 105 → 43.0 → 48.2 | 34.7 → 3.93 → 5.20 |

### relations-generation

| skills | steps | writes | seconds | msPerWrite |
| --- | ---: | ---: | ---: | ---: |
| 200 | 1400 → 1400 → 1400 | 2939 → 2939 → 2939 | 5.76 → 2.66 → 2.81 | 1.96 → 0.91 → 0.96 |
| 1000 | 7000 → 7000 → 7000 | 14699 → 14699 → 14699 | 47.0 → 12.9 → 13.1 | 3.20 → 0.88 → 0.89 |
| 3000 | 21000 → 21000 → 21000 | 44099 → 44099 → 44099 | 300 → 39.3 → 39.2 | 6.81 → 0.89 → 0.89 |

### concurrency

| configuration | saveStepsPerSecond | writerP50 | writerP99 | writerErrors | readsPerSecond | readerP99 | readerErrors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1W+0R | 55.3 → 158 → 160 | 17.2 → 5.69 → 5.61 | 27.4 → 14.2 → 13.5 | 0 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 |
| 2W+0R | 54 → 149 → 151 | 17.7 → 6.01 → 6.30 | 1564 → 545 → 1045 | 606 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 |
| 4W+0R | 51.6 → 138 → 143 | 19.8 → 6.74 → 6.85 | 1961 → 1761 → 1825 | 658 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 | 0 → 0 → 0 |
| 2W+2R | 45.9 → 133 → 141 | 20.9 → 6.74 → 6.58 | 956 → 198 → 238 | 383 → 0 → 0 | 1151 → 2022 → 2243 | 6.91 → 2.35 → 2.29 | 0 → 0 → 0 |
| 4W+4R | 38.7 → 105 → 108 | 46.5 → 13.0 → 20.4 | 5905 → 1204 → 2458 | 782 → 0 → 0 | 1925 → 3792 → 3655 | 8.89 → 3.07 → 3.44 | 0 → 0 → 0 |

## Still open

- **The planner has no cost model.** Fixes 5 and 6 are targeted: the bounded count chooses between
  literals, and nested seeds follow relation paths. Thing variables are still enumerated in the
  order they are written, and a variable no relation or literal reaches is enumerated whole.
  `every dependency edge` is a full traversal and stays linear in the edges.
- **The empty-answer count still visits the type.** `COUNT(*)` reads no rows into memory, but it is
  still linear in the type's size. Making the fact lazy, or bounding the count, would change what
  the fact says, which is a decision of its own.
- **Read paths still run one SQL statement per row per binding.** The cache made each statement
  cheap. Fetching a binding's values for every owner in one statement would remove the per-row
  round trip.
- **One writer at a time.** SQLite allows one writer, so write throughput does not grow with
  processes. What the fixes change is how long each write holds the lock. The wait is not fair:
  with four writers the p99 `saveStep()` still waits 1.8 s for the lock, and 2.5 s with four
  readers alongside. That is under the 5 s `busy_timeout`, but not far under it.
- **No change-log retention policy** (7 above).

## Running it again

```bash
npm exec nx -- run typedblite-runtime:bench -- --out after.json
cd libs/runtime && npx tsx --tsconfig bench/tsconfig.json bench/compare.ts before.json after.json
```

The [bench README](../../libs/runtime/bench/README.md) covers the suites, sizes, and how to
snapshot live stores safely. To compare two commits fairly, run the older one from its own
`git worktree`: the concurrency suite spawns fresh processes, which would otherwise load whatever
the working tree holds at that moment.
