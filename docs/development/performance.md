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

**Real stores.** Snapshots of downstream-app's `.mvp` stores, the engine's one production consumer,
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
downstream-app runs two processes on the same stores.

Everything ran from source on one machine: an Intel Core Ultra 9 275HX (24 cores), WSL2, Node
24.19.0. Absolute numbers are this machine's. The ratios and the growth curves are the findings.

## What it found

Six problems, and a seventh that belongs to the consumer. Fixes 1 to 4 are on the branch that added
this page. 5 and 6 are [still open](#still-open).

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
answers are routine: downstream-app reads each optional attribute with a query of its own, and most
rows lack most of them. So ordinary reads paid for a full read of the type, and it is why the
workflow engine's `find()` took 46 ms.

**Fixed:** the fact asks `LIMIT 1` whether anything matches, and SQL `COUNT(*)` for the number it
states. The messages are unchanged. Guarded by `empty-answer-cost.test.ts`.

### 5. One broad `has` value made a selective match slow

`$s isa skill, has skill-id "x", has revision "r1"` builds one `t.iid IN (owners of the value)`
subquery per literal, and SQLite materialises each. When one value is owned by thousands of things
and another by one, the broad one sets the cost: 5.0 ms against 0.017 ms for the same answer
computed from the selective subquery, with the other checked per candidate by `EXISTS`. **Open.**

### 6. A two-hop path enumerated everything when its middle had no type

`(dependent: $a, prerequisite: $b) isa step-dependency; (dependent: $b, prerequisite: $c) isa
step-dependency;` with `$a` pinned answered one row in 1.3 s on a 21,000-step graph. Adding
`$b isa skill-step` answered it in about 1 ms. The planner seeds a role player from a relation only
when the player has its own `isa`; an untyped `$b` is never seeded, so `$c` is enumerated whole.
**Open.** Until it is fixed, give every variable in a relation path a type.

### 7. The document store was mostly change log (consumer)

818 MB of the document store's 967 MB was `change_log`: 195,000 full-state revisions of 2,670
documents. `changeLog.compact()` and `vacuum()` took it to 81 MB in 3 seconds. downstream-app exposes
compaction as a command and never schedules it. The engine has no retention policy of its own, so
any consumer that rewrites large values will grow the same way.

## Results, before and after

Both runs used the same snapshots, sizes and sampled keys, on the same machine, each from its own
worktree. *Before* is the bench commit on its own (`d3103d4`, now `218b2ca`); *after* adds fixes 1 to
4 (`55b783a`, the same source tree as `0f63c6c` after a rebase that changed only `project.json`).
Times are milliseconds. Raw files: [before](performance-results/2026-11-12-before.json),
[after](performance-results/2026-11-12-after.json).

**The headlines:**

| | Before | After |
| - | -----: | ----: |
| Bulk load, ms per entity, at 20k → 100k entities | 2.4 → 13.4 (rising) | 0.45 → 0.44 (flat) |
| `saveStep()` at 100k entities | 36.9 ms | 3.9 ms |
| Skills catalog at 14×, generated | 302 s | 39 s |
| Two writer processes: writes lost to `database is locked` | 389 in 10 s | 0 |
| `saveStep()` throughput, one process / four processes | 53 / 53 per s | 158 / 138 per s |
| Workflow engine `find()`, 16 queries | 46.2 ms | 19.7 ms |
| Observability listing, 7,000 rows | 1,132 ms | 398 ms |

Every read and write measured got faster or stayed level. Two costs still grow with the store, and
both are listed under [Still open](#still-open). The empty-optional read is 4× cheaper but still linear,
because it counts the type. The untyped 2-hop path is 3.5× cheaper but still enumerates (finding 6).
`compact()`, `vacuum()` and full-text search did not change, and were not expected to.

### real-stores

| Operation | Rows | Before p50 | After p50 | Before p95 | After p95 | Speed-up (p50) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ladder: open |  | 8.92 | 8.34 | 8.92 | 8.34 | 1.1× |
| ladder: workflow by key | 1 | 0.47 | 0.50 | 1.02 | 1.06 | 0.9× |
| ladder: step column (present) | 7 | 0.80 | 0.60 | 1.30 | 1.16 | 1.3× |
| ladder: history column (mostly absent) | 0 | 9.13 | 2.21 | 12.3 | 2.90 | 4.1× |
| ladder: find() — 16 queries | 113 | 46.2 | 19.7 | 54.5 | 22.9 | 2.3× |
| ladder: list every workflow id | 1601 | 44.0 | 19.5 | 45.5 | 21.9 | 2.3× |
| ladder: saveStep() — 3 commits |  | 17.6 | 5.98 | 24.5 | 12.7 | 2.9× |
| ladder: 100 inserts in one transaction |  | 410 | 55.8 | 417 | 56.1 | 7.4× |
| obs: getObservation(id) — 5 queries | 1 | 10.7 | 4.82 | 13.0 | 6.12 | 2.2× |
| obs: list(operation) — 5 queries, ~170 rows | 172 | 17.0 | 6.59 | 17.7 | 8.40 | 2.6× |
| obs: list(kind) — 5 queries, ~7,000 rows | 7032 | 1132 | 398 | 1174 | 405 | 2.8× |
| obs: event by key | 1 | 0.33 | 0.20 | 0.41 | 0.39 | 1.6× |
| obs: append payload + index — 2 commits |  | 14.2 | 3.70 | 19.6 | 7.67 | 3.8× |
| docs: get(id) — 3 queries | 5 | 2.20 | 0.85 | 3.52 | 1.17 | 2.6× |
| docs: list every document | 2390 | 204 | 77.8 | 250 | 79.2 | 2.6× |
| docs: full-text search, limit 150 | 140 | 1.03 | 1.07 | 1.53 | 1.60 | 1.0× |
| docs: re-ingest (remove + add) — 2 commits |  | 14.4 | 4.82 | 27.9 | 13.7 | 3.0× |
| docs: compact() the change log |  | 2612 | 2707 | 2612 | 2707 | 1.0× |
| docs: vacuum() |  | 266 | 267 | 266 | 267 | 1.0× |
| skills: steps via skill-composition | 6 | 1.40 | 0.81 | 2.39 | 1.25 | 1.7× |
| skills: sub-workflow children | 0 | 4.60 | 2.07 | 7.07 | 3.05 | 2.2× |
| skills: step dependencies | 1 | 2.31 | 0.96 | 6.02 | 2.34 | 2.4× |
| skills: every dependency edge | 167 | 73.9 | 15.4 | 74.6 | 16.3 | 4.8× |

### relations

| Operation | Rows | Before p50 | After p50 | Before p95 | After p95 | Speed-up (p50) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200: steps via skill-composition | 7 | 1.56 | 0.77 | 2.01 | 0.95 | 2.0× |
| 200: step dependencies (2 relations) | 6 | 2.25 | 0.99 | 3.30 | 1.26 | 2.3× |
| 200: sub-workflow children (2 relations) | 0 | 4.60 | 1.99 | 5.56 | 2.89 | 2.3× |
| 200: output fields (multi-valued) | 14 | 1.33 | 0.66 | 1.63 | 0.96 | 2.0× |
| 200: every dependency edge | 1200 | 185 | 56.0 | 185 | 56.0 | 3.3× |
| 200: 2-hop, untyped middle | 1 | 80.5 | 25.3 | 112 | 28.1 | 3.2× |
| 200: 2-hop, typed middle | 1 | 1.06 | 0.73 | 1.46 | 1.08 | 1.4× |
| 1000: steps via skill-composition | 7 | 1.55 | 0.78 | 1.79 | 1.33 | 2.0× |
| 1000: step dependencies (2 relations) | 6 | 2.14 | 1.01 | 2.40 | 1.42 | 2.1× |
| 1000: sub-workflow children (2 relations) | 0 | 17.4 | 6.35 | 20.7 | 7.47 | 2.7× |
| 1000: output fields (multi-valued) | 14 | 1.35 | 0.65 | 1.65 | 0.79 | 2.1× |
| 1000: every dependency edge | 6000 | 905 | 291 | 905 | 291 | 3.1× |
| 1000: 2-hop, untyped middle | 1 | 439 | 123 | 530 | 126 | 3.6× |
| 1000: 2-hop, typed middle | 1 | 1.17 | 0.68 | 33.5 | 1.31 | 1.7× |
| 3000: steps via skill-composition | 7 | 1.57 | 0.78 | 1.87 | 1.03 | 2.0× |
| 3000: step dependencies (2 relations) | 6 | 2.18 | 0.98 | 3.09 | 1.24 | 2.2× |
| 3000: sub-workflow children (2 relations) | 1 | 1.65 | 0.77 | 4.66 | 1.77 | 2.1× |
| 3000: output fields (multi-valued) | 14 | 1.31 | 0.65 | 1.80 | 0.89 | 2.0× |
| 3000: every dependency edge | 18000 | 2769 | 849 | 2769 | 849 | 3.3× |
| 3000: 2-hop, untyped middle | 1 | 1321 | 383 | 1409 | 531 | 3.5× |
| 3000: 2-hop, typed middle | 1 | 1.05 | 0.70 | 1.42 | 1.35 | 1.5× |

### growth

| entities | loadPerEntity before → after | keyed before → after | column before → after | emptyOptional before → after | listAll before → after | saveStep before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20160 | 2.38 → 0.45 | 0.36 → 0.26 | 2.58 → 0.79 | 3.58 → 1.11 | 20.7 → 9.06 | 13.6 → 4.37 |
| 40320 | 4.95 → 0.45 | 0.38 → 0.23 | 1.27 → 0.55 | 7.81 → 1.77 | 40.3 → 17.8 | 17.7 → 4.73 |
| 60480 | 7.85 → 0.44 | 0.36 → 0.22 | 1.39 → 0.65 | 10.8 → 2.46 | 61.7 → 25.7 | 27.3 → 4.44 |
| 80640 | 10.7 → 0.43 | 0.38 → 0.30 | 1.37 → 0.57 | 15.2 → 3.66 | 80.2 → 35.1 | 29.3 → 3.75 |
| 100800 | 13.4 → 0.44 | 0.37 → 0.23 | 1.42 → 0.59 | 19.3 → 4.45 | 103 → 43.0 | 36.9 → 3.93 |

### relations-generation

| skills | steps before → after | writes before → after | seconds before → after | msPerWrite before → after |
| --- | ---: | ---: | ---: | ---: |
| 200 | 1400 → 1400 | 2939 → 2939 | 5.85 → 2.66 | 1.99 → 0.91 |
| 1000 | 7000 → 7000 | 14699 → 14699 | 47.8 → 12.9 | 3.25 → 0.88 |
| 3000 | 21000 → 21000 | 44099 → 44099 | 302 → 39.3 | 6.86 → 0.89 |

### concurrency

| configuration | saveStepsPerSecond before → after | writerP50 before → after | writerP99 before → after | writerErrors before → after | readsPerSecond before → after | readerP99 before → after | readerErrors before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1W+0R | 53 → 158 | 18.0 → 5.69 | 27.2 → 14.2 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| 2W+0R | 52.2 → 149 | 18.5 → 6.01 | 1751 → 545 | 389 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| 4W+0R | 52.5 → 138 | 18.9 → 6.74 | 3392 → 1761 | 1035 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| 2W+2R | 45 → 133 | 21.7 → 6.74 | 1362 → 198 | 442 → 0 | 1097 → 2022 | 7.23 → 2.35 | 0 → 0 |
| 4W+4R | 41.6 → 105 | 25.0 → 13.0 | 4598 → 1204 | 778 → 0 | 2060 → 3792 | 8.03 → 3.07 | 0 → 0 |

## Still open

- **5 and 6 above**, both in the planner.
- **The empty-answer count still visits the type.** `COUNT(*)` reads no rows into memory, but it is
  still linear in the type's size. Making the fact lazy, or bounding the count, would change what
  the fact says, which is a decision of its own.
- **Read paths still run one SQL statement per row per binding.** The cache made each statement
  cheap. Fetching a binding's values for every owner in one statement would remove the per-row
  round trip.
- **One writer at a time.** SQLite allows one writer, so write throughput does not grow with
  processes. What the fixes change is how long each write holds the lock. The wait is not fair:
  with four writers the p99 `saveStep()` still waits 1.8 s for the lock, under the 5 s
  `busy_timeout` but not far under it.
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
