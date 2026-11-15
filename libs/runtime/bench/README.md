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
| `growth` | A sprint-board store (`sprint.schema.typeqlite`) built from empty, 1 sprint : 7 tickets : 20 ticket events, measuring writes and reads at checkpoints | 100,000 entities |
| `relations` | The project tracker (`tracker.schema.typeqlite`) generated at several sizes: anchored joins, a full traversal, 2-hop paths | 200, 1,000 and 3,000 projects |
| `concurrency` | Several processes on one generated sprint-board store. Writers update disjoint tickets; readers read a sprint with its tickets | 10 s per configuration |

| Variable | Meaning |
| -------- | ------- |
| `BENCH_LABEL` | A label written into the results file (`before`, `after`, a branch name) |
| `BENCH_WORK` | Where working copies go, which is kept afterwards. By default a temporary directory, which is deleted |
| `BENCH_GROWTH_TARGET`, `BENCH_GROWTH_EVERY` | Growth's final size and checkpoint interval, in entities |
| `BENCH_RELATION_SIZES` | Comma-separated project counts |
| `BENCH_CONCURRENCY_SECONDS` | Seconds per concurrency configuration |

Every suite generates its own data, so the load test needs nothing but this repository.

**Compare runs** as Markdown tables. Give two or more files, oldest first. The speed-up column is
first to last, and an operation an older harness did not measure shows as `—`:

```bash
npx tsx --tsconfig bench/tsconfig.json bench/compare.ts before.json after.json
```

Key samples come from a fixed-seed generator, so two runs time the same keys.
