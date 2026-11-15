# Runtime load test

Times the engine on realistic schemas and data. It complements the query trace: tests assert on
trace *counts* because counts are deterministic, and this measures *time*, which belongs in a results
file. The latest results and what they showed are in
[docs/development/performance.md](../../../docs/development/performance.md).

```bash
npm exec nx -- run typedblite-runtime:bench                          # every suite
npm exec nx -- run typedblite-runtime:bench -- growth --out r.json   # one suite, results saved
```

Every suite drives `libs/runtime/src` through `bench/tsconfig.json`'s path aliases. It never
loads the built `out/`, so it needs no build and cannot disturb another checkout that loads `out/`.

| Suite | What it does | Default size |
| ----- | ------------ | ------------ |
| `real-stores` | Snapshots of a production application's stores, driven with the queries its repositories issue: the workflow engine's `find()` and `saveStep()`, observability's filtered listing, the document store's `get()`, re-ingest and compaction, and the Skills catalog's relation joins. **Opt-in:** needs `BENCH_STORES` | the stores as they are |
| `growth` | A workflow-engine store built from empty with `scm/ladder.db`'s shape (1 workflow : 7 steps : 20 history entries), measuring writes and reads at checkpoints | 100,000 entities |
| `relations` | The Skills schema generated at multiples of the real catalog (217 skills, 1,482 steps): anchored joins, a full traversal, 2-hop paths | 200, 1,000 and 3,000 skills |
| `concurrency` | Several processes on one store file, as that application runs. Writers run `saveStep()` on disjoint steps; readers run `find()`-style reads | 10 s per configuration |

| Variable | Meaning |
| -------- | ------- |
| `BENCH_STORES` | A directory of store snapshots, for `real-stores` (and the `concurrency` source: `scm__ladder.db`) |
| `BENCH_LABEL` | A label written into the results file (`before`, `after`, a branch name) |
| `BENCH_WORK` | Where working copies go, which is kept afterwards. By default a temporary directory, which is deleted |
| `BENCH_GROWTH_TARGET`, `BENCH_GROWTH_EVERY` | Growth's final size and checkpoint interval, in entities |
| `BENCH_RELATION_SIZES` | Comma-separated skill counts |
| `BENCH_CONCURRENCY_SECONDS` | Seconds per concurrency configuration |

**Snapshot the real stores** with SQLite's online backup, which gives a consistent copy, WAL
included, even while another process writes. Then point `BENCH_STORES` at the copies:

```bash
cd libs/runtime
npx tsx --tsconfig bench/tsconfig.json bench/snapshot.ts <your-stores-dir> /tmp/stores \
  scm/ladder.db observability/observability.db documents/documents.db skills/graph/skills.db
BENCH_STORES=/tmp/stores npm exec nx -- run typedblite-runtime:bench -- real-stores
```

Every suite works on copies, so the snapshots stay as they were taken.

**Compare runs** as Markdown tables. Give two or more files, oldest first. The speed-up column is
first to last, and an operation an older harness did not measure shows as `—`:

```bash
npx tsx --tsconfig bench/tsconfig.json bench/compare.ts before.json after.json
```

Key samples come from a fixed-seed generator, so two runs time the same keys.
