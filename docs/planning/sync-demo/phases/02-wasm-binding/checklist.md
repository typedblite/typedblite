---
kind: checklist
status: complete
feature: sync-demo
phase: 02-wasm-binding
---

# Phase 02 — The WASM binding, promoted

**Branch:** `phase/sync-demo/02-wasm-binding`, from `feat/sync-demo` · **Opened:** 2026-11-12 ·
**Governed by:** [ADR-009](../../../../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D1, D2, D6

**Goal.** `@typedblite/runtime/wasm` is supported API, tested in Node and in a real Chromium, and the
spike is gone.

## Before starting

- [x] Read the downstream spike analysis (`docs/analysis/typedblite-wasm-engine-spike.md`) and its decision record. It recorded 494 of 515 runtime tests passing on WASM, the 21 failures being binding
      limits (a second connection on a real file, several processes on one file, WAL), and three
      binding mismatches (bare named parameters, `errcode`, and `changes`). The binding already
      handles all three
- [x] The only importer of the spike outside this repository is a downstream application's never-merged demo
      branch (`demo/offline-sync`), which this feature replaces

## Build

- [x] `src/wasm.ts`: the spike binding moved unchanged in behavior, with a supported-API header
      (usage, OPFS, one connection per file). Exported as `./wasm`
- [x] `@sqlite.org/sqlite-wasm`: an optional peer dependency (`^3.50.0`) and an exact dev dependency
      (3.54.1-build1). `playwright-core` 1.62.1 is a dev dependency
- [x] `vitest.wasm.config.ts` starts. It imports `vitest.shared` from the right path, and aliases
      `#default-opener` to the WASM opener in `test/support/`, which does not ship. The binding limits
      are excluded by file, each with its reason. Two files written after the spike (forged legacy
      stores) join the list, and one test in `schema-lists.test.ts` skips itself under
      `TYPEDBLITE_SQLITE=wasm`
- [x] The `test-wasm` target: **574 passed, 1 skipped**
- [x] `test-browser/`: a worker importing only `@typedblite/runtime` (browser condition) and
      `/wasm`, bundled by esbuild, served by `node:http`, and driven in Playwright's Chromium. The
      `test-browser` target depends on the runtime's own build. It proves three things:
  - the store survives closing the whole browser;
  - **the revisions it computed equal Node's for the same writes**;
  - a duplicate key is refused with `[CNT9]` and the same code.

  Removing the SAH pool fails 2 of the 3
- [x] `vitest.oracle.config.ts`'s import path is fixed too. It still needs an external search index
- [x] `libs/runtime/spike/` is removed

## Documentation

- [x] Runtime README, "In the browser": install, init in a worker, the browser condition, OPFS, one
      connection per store, the browser floor (`Object.groupBy`, D6), and serving `sqlite3.wasm`
- [x] Embedding guide: points to the supported binding
- [x] Testing guide: the `test-wasm` and `test-browser` targets, and an honest note on the full-text
      oracle. AGENTS.md: the browser entry rules and the new targets

## Close

- [x] Clean gate: 6 projects green (1,289 tests). Conformance at 1742 · 1 · 12 · 1 / 1756.
      `test-wasm`: 574 passed and 1 skipped. `test-browser`: 3 of 3
- [x] `summary.md`, and the Phase Plan row
