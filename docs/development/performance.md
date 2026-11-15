# Performance

What the engine costs on generated data of realistic size, what the load test found, and what is still open.
The numbers come from the load test, `nx run typedblite-runtime:bench`
([libs/runtime/bench](../../libs/runtime/bench/README.md)). The raw results are in
[performance-results/](performance-results/).

- [How it was measured](#how-it-was-measured)
- [What it found](#what-it-found)
- [Results, before and after](#results-before-and-after)
- [Still open](#still-open)
- [Running it again](#running-it-again)

## How it was measured

Every suite generates its own data from the project tracker in `test-fixtures/schemas/`, so anyone can
run it. There are three:

- **Growth.** A sprint-board store (`sprint.schema.typeqlite`) built from empty to 100,000 entities: per
  sprint, 1 sprint, 7 tickets and 20 ticket events. It measures a write and the common reads every 20,000
  entities. A cost that rises while its answer does not is a scan.
- **Relations at scale.** The project tracker (`tracker.schema.typeqlite`) at 200, 1,000 and 3,000
  projects, up to 21,000 tasks and 44,000 writes. Each project has 7 tasks, a dependency chain between
  consecutive tasks, and one task in ten holds a sub-project.
- **Contention.** One to four writer processes, with and without readers, on one generated sprint-board store.

Everything ran from source on one machine: an Intel Core Ultra 9 275HX (24 cores), WSL2, Node 24.19.0.
Absolute numbers are this machine's, and this machine is noisy (see [contention](#contention)). The ratios
and the growth curves are the findings.

**Where the first six findings came from.** They were found on 2026-11-12 on snapshots of the stores of a
production application built on the engine, and fixed. Those stores are not published, so their timings are
not either. The same shapes were generated for growth and relations, and those measurements are what this
page compares, before and after. Each finding has a regression test that holds it, and none depends on
that data. The seventh finding was made on the generated data.

## What it found

Seven problems in the engine, all fixed, and an eighth that belongs to the consumer. What the fixes left
behind is under [Still open](#still-open).

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
answers are routine: an application reads each optional attribute with a query of its own, and most
rows lack most of them. So ordinary reads paid for a full read of the type: a 16-query read took 46 ms
on a real store.

**Fixed:** the fact asks `LIMIT 1` whether anything matches, and SQL `COUNT(*)` for the number it
states. The messages are unchanged. Guarded by `empty-answer-cost.test.ts`.

### 5. One broad `has` value made a selective match slow

`$s isa project, has project-id "x", has revision "r1"` built one `t.iid IN (owners of the value)`
subquery per literal, and SQLite materialises each. When one value is owned by thousands of things
and another by one, the broad one set the cost: 5.0 ms against 0.017 ms for the same answer
computed from the selective subquery, with the other checked per candidate by `EXISTS`.

**Fixed:** with two or more literals, `candidateQuery` counts each value's owners, stopping at 256,
and drives from the fewest. Every other literal becomes an `EXISTS` probe through the
`attribute(type, value)` and `has(owner, attribute)` indexes. SQLite cannot make that choice itself
without `ANALYZE` statistics. `ORDER BY t.iid` keeps the row order, whichever literal drives.
Guarded by `literal-selectivity.test.ts`, which asserts which value drives.

### 6. A two-hop path enumerated everything when its middle had no type

`(dependent: $a, prerequisite: $b) isa task-dependency; (dependent: $b, prerequisite: $c) isa
task-dependency; $c has task-id $y;` with `$a` pinned answered one row in 1.3 s on a 21,000-task
graph. Adding `$b isa task` answered it in about 1 ms. `$b` has no constraint of its own, so it
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

### 7. An empty answer read every relation of a type to explain itself

Found on the generated data. A project's sub-projects, a query that joins through two relations, took
0.8 ms when the project had one and 6 ms at 1,000 projects, 21 ms at 3,000, when it had none. The same
shape showed in the 2026-11-12 runs: 17 ms at 1,000 projects. Fix 4 made the empty-answer explanation cheap
for a type's *things*, but for a *relation* it still asked "could any relation of this type satisfy this?"
by reading all of them and keeping only whether there were any. `relationHolds` asks the same question.

**Fixed:** `relationBindings` stops at the first row (`LIMIT 1`) when only existence is asked, unless a
role variable or an unbound type variable could reject a row after it is read. The empty answer now costs
what a matching one does, 0.7 to 0.9 ms at every size. The query trace counts `relationRows`, and
`empty-answer-cost.test.ts` asserts the empty answer reads at most four rows more than the matching one
(364 against 7 without the fix).

### 8. The document store was mostly change log (consumer)

818 MB of one real document store's 967 MB was `change_log`: 195,000 full-state revisions of 2,670
documents. `changeLog.compact()` and `vacuum()` took it to 81 MB in 3 seconds. That application exposes
compaction as a command and never schedules it. The engine has no retention policy of its own, so
any consumer that rewrites large values will grow the same way.

## Results, before and after

Four runs of the same harness on the same generated data and the same machine. Times are milliseconds at
the median:

- **original**: the engine before any fix (`2041031`'s harness on `711b535`'s engine, 2026-11-12).
- **fixes 1–4** (`55b783a`) and **fixes 1–6** (`2041031`), the same day. Fixes 1–4 predate the
  `a key and a broad value` measurement, so that row shows `—`.
- **now**: 2026-11-15, all seven fixes (`101f972`), on this repository's generated data.

The raw files are in [performance-results/](performance-results/). The 2026-11-12 files are renamed to this
page's vocabulary: the data they measured was generated with the same shapes and sizes, and only the names
differed. Their measurements of the private stores, and their contention table (which ran on one of them), are
removed. Compare any two with `bench/compare.ts`.

**The headlines,** original → now:

| | Original | Now |
| - | -------: | --: |
| Bulk load, ms per entity, at 20k → 100k entities | 2.3 → 13.1 (rising) | 0.38 → 0.37 (flat) |
| Updating one ticket (delete, insert, event) at 100k entities | 34.7 ms | 4.5 ms |
| Generating 3,000 projects (21,000 tasks, 44,000 writes) | 300 s | 35 s |
| A key and a broad value, at 21,000 tasks (finding 5) | 7.44 ms, rising with size | 0.20 ms, flat |
| Two-hop path with an untyped middle, at 21,000 tasks (finding 6) | 1,341 ms | 0.60 ms |
| A project's sub-projects when it has none, at 1,000 projects (finding 7) | 17.2 ms | 0.80 ms |
| An absent optional attribute, at 100k entities | 20.6 ms | 4.2 ms |

Every read and write measured got faster or stayed level. `tasks via project-task` shows 1.15 to 1.18 ms
now against 0.77 to 0.82 in the fixes 1–6 run, but that is the machine, not the engine: the fixes 1–6
engine source run again today on today's data gave 0.81, 1.23 and 1.20 ms in three runs, and today's gave
0.78, 1.21 and 1.20. The query is bimodal between runs. Two costs still grow with the store, and both are
under [Still open](#still-open): the absent-optional read (a count over the type) and `every dependency edge`
(a full traversal, which grows with its answer).

### relations

| Operation | Rows | original p50 | fixes 1–4 p50 | fixes-1-6 p50 | now p50 | original → now |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200: tasks via project-task | 7 | 1.54 | 0.77 | 0.81 | 1.15 | 1.3× |
| 200: task dependencies (2 relations) | 6 | 2.18 | 0.99 | 1.05 | 0.91 | 2.4× |
| 200: subproject children (2 relations) | 0 | 4.63 | 1.99 | 2.08 | 0.82 | 5.6× |
| 200: log fields (multi-valued) | 14 | 1.33 | 0.66 | 0.70 | 0.63 | 2.1× |
| 200: a key and a broad value | 1 | 0.74 | — | 0.23 | 0.21 | 3.5× |
| 200: every dependency edge | 1200 | 190 | 56.0 | 58.5 | 56.0 | 3.4× |
| 200: 2-hop, untyped middle | 1 | 84.2 | 25.3 | 0.58 | 0.50 | 167.1× |
| 200: 2-hop, typed middle | 1 | 1.11 | 0.73 | 0.75 | 0.65 | 1.7× |
| 1000: tasks via project-task | 7 | 1.59 | 0.78 | 0.82 | 1.18 | 1.3× |
| 1000: task dependencies (2 relations) | 6 | 2.19 | 1.01 | 1.02 | 0.94 | 2.3× |
| 1000: subproject children (2 relations) | 0 | 17.2 | 6.35 | 6.54 | 0.80 | 21.4× |
| 1000: log fields (multi-valued) | 14 | 1.32 | 0.65 | 0.71 | 0.61 | 2.1× |
| 1000: a key and a broad value | 1 | 2.52 | — | 0.24 | 0.21 | 12.1× |
| 1000: every dependency edge | 6000 | 923 | 291 | 292 | 278 | 3.3× |
| 1000: 2-hop, untyped middle | 1 | 443 | 123 | 0.49 | 0.44 | 1014.7× |
| 1000: 2-hop, typed middle | 1 | 1.04 | 0.68 | 0.68 | 0.55 | 1.9× |
| 3000: tasks via project-task | 7 | 1.57 | 0.78 | 0.77 | 1.17 | 1.3× |
| 3000: task dependencies (2 relations) | 6 | 2.17 | 0.98 | 1.02 | 0.90 | 2.4× |
| 3000: subproject children (2 relations) | 1 | 1.67 | 0.77 | 0.81 | 0.70 | 2.4× |
| 3000: log fields (multi-valued) | 14 | 1.34 | 0.65 | 0.70 | 0.60 | 2.2× |
| 3000: a key and a broad value | 1 | 7.44 | — | 0.23 | 0.20 | 36.3× |
| 3000: every dependency edge | 18000 | 2848 | 849 | 851 | 828 | 3.4× |
| 3000: 2-hop, untyped middle | 1 | 1341 | 383 | 0.50 | 0.60 | 2235.4× |
| 3000: 2-hop, typed middle | 1 | 1.18 | 0.70 | 0.63 | 0.67 | 1.8× |

### growth

Columns read original → fixes 1–4 → fixes 1–6 → now.

| entities | loadPerEntity | keyed | column | emptyOptional | listAll | ticketUpdate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20160 | 2.34 → 0.45 → 0.43 → 0.38 | 0.37 → 0.26 → 0.35 → 0.44 | 2.34 → 0.79 → 0.57 → 0.66 | 3.43 → 1.11 → 1.00 → 1.14 | 20.0 → 9.06 → 8.44 → 8.48 | 11.2 → 4.37 → 3.94 → 4.44 |
| 40320 | 4.95 → 0.45 → 0.44 → 0.38 | 1.50 → 0.23 → 0.26 → 0.21 | 1.46 → 0.55 → 0.56 → 0.53 | 7.29 → 1.77 → 1.79 → 1.67 | 42.8 → 17.8 → 17.2 → 17.7 | 19.0 → 4.73 → 5.02 → 4.64 |
| 60480 | 7.55 → 0.44 → 0.44 → 0.37 | 0.40 → 0.22 → 0.24 → 0.21 | 1.39 → 0.65 → 0.56 → 0.53 | 13.1 → 2.46 → 2.51 → 2.43 | 62.2 → 25.7 → 28.3 → 26.1 | 23.8 → 4.44 → 5.07 → 5.14 |
| 80640 | 10.8 → 0.43 → 0.43 → 0.37 | 1.85 → 0.30 → 0.35 → 0.19 | 1.34 → 0.57 → 0.57 → 0.60 | 14.1 → 3.66 → 3.59 → 3.23 | 81.0 → 35.1 → 34.4 → 33.2 | 27.8 → 3.75 → 3.59 → 3.95 |
| 100800 | 13.1 → 0.44 → 0.43 → 0.37 | 0.35 → 0.23 → 0.23 → 0.18 | 1.30 → 0.59 → 0.59 → 0.51 | 20.6 → 4.45 → 4.50 → 4.20 | 105 → 43.0 → 48.2 → 43.4 | 34.7 → 3.93 → 5.20 → 4.49 |

### relations-generation

Same columns.

| projects | tasks | writes | seconds | msPerWrite |
| --- | ---: | ---: | ---: | ---: |
| 200 | 1400 → 1400 → 1400 → 1400 | 2939 → 2939 → 2939 → 2939 | 5.76 → 2.66 → 2.81 → 2.46 | 1.96 → 0.91 → 0.96 → 0.84 |
| 1000 | 7000 → 7000 → 7000 → 7000 | 14699 → 14699 → 14699 → 14699 | 47.0 → 12.9 → 13.1 → 11.7 | 3.20 → 0.88 → 0.89 → 0.80 |
| 3000 | 21000 → 21000 → 21000 → 21000 | 44099 → 44099 → 44099 → 44099 | 300 → 39.3 → 39.2 → 35.4 | 6.81 → 0.89 → 0.89 → 0.80 |

### contention

One generated sprint-board store, 10 seconds per configuration, each writer updating its own tickets so every
failure is the engine's. This is the noisiest measurement on this machine, so these are ranges over five runs
(two full runs and three of this suite alone), not a single figure:

| Writers + readers | Updates per second | Writer wait, 99th percentile | Reads per second |
| --- | ---: | ---: | ---: |
| 1 + 0 | 165 – 183 | 12 – 13 ms | 0 |
| 2 + 0 | 152 – 170 | 114 – 1,237 ms | 0 |
| 4 + 0 | 93 – 140 | 945 – 1,449 ms | 0 |
| 2 + 2 | 70 – 151 | 140 – 773 ms | about 2,500 |
| 4 + 4 | 57 – 114 | 944 – 2,539 ms | about 4,300 – 4,600 |

Writer errors were 0 in both full runs. Readers' 99th percentile stayed between 2.2 and 2.9 ms. Before fix 1,
two writer processes on one real store lost 606 writes in 10 seconds to `database is locked`.

## Still open

- **The planner has no cost model.** Fixes 5 and 6 are targeted: the bounded count chooses between
  literals, and nested seeds follow relation paths. Thing variables are still enumerated in the
  order they are written, and a variable no relation or literal reaches is enumerated whole.
  `every dependency edge` is a full traversal and stays linear in the edges.
- **The empty-answer count still visits the type.** `COUNT(*)` reads no rows into memory, but it is
  still linear in the type's size: 1.1 ms at 20,000 entities and 4.2 ms at 100,000. Making the fact lazy, or bounding the count, would change what
  the fact says, which is a decision of its own.
- **Read paths still run one SQL statement per row per binding.** The cache made each statement
  cheap. Fetching a binding's values for every owner in one statement would remove the per-row
  round trip.
- **One writer at a time.** SQLite allows one writer, so write throughput does not grow with
  processes. What the fixes change is how long each write holds the lock. The wait is not fair:
  with four writers the 99th-percentile wait for the lock is 0.9 to 1.4 s, and up to 2.5 s with four
  readers alongside. That is under the 5 s `busy_timeout`, but not far under it.
- **No change-log retention policy** (8 above).

## Running it again

```bash
npm exec nx -- run typedblite-runtime:bench -- --out after.json
cd libs/runtime && npx tsx --tsconfig bench/tsconfig.json bench/compare.ts before.json after.json
```

The [bench README](../../libs/runtime/bench/README.md) covers the suites, sizes and variables. The load
test generates its own data, so it needs nothing else. To compare two commits fairly, run the older one from its own
`git worktree`: the concurrency suite spawns fresh processes, which would otherwise load whatever
the working tree holds at that moment.
