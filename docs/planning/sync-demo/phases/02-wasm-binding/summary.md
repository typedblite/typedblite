---
kind: summary
status: complete
feature: sync-demo
phase: 02-wasm-binding
---

# Phase 02 — Summary

**Closed:** 2026-11-12 · **Checklist:** [checklist.md](checklist.md)

## What changed

- **`@typedblite/runtime/wasm` is supported API.** It provides `initWasmSqlite`, `openWasmSqlite`,
  `wipeOpfsPool` and `poolInfo`, with `@sqlite.org/sqlite-wasm` as an optional peer dependency.
- **The runtime suite runs on WASM SQLite** as an Nx target (`test-wasm`). The binding's limits are
  excluded by name, each with its reason.
- **A real Chromium proves the browser story** (`test-browser`): OPFS persistence across a full
  browser restart, `[CNT9]` refusals, and, the strongest evidence for ADR-009 D5, **revisions
  computed in the browser equal Node's**.
- **The spike is gone.** Its browser harness is replaced by `test-browser/`.

## For later phases

- The demo's worker can copy `test-browser/worker.ts`'s shape: `initWasmSqlite({ moduleOptions:
  { locateFile }, sahPool })`, then `new TypeDBLiteInterpreter(path, undefined, { openDatabase:
  openWasmSqlite })`, then `define` on every open.
- Serving: `sqlite3.wasm` from `node_modules/@sqlite.org/sqlite-wasm/dist/`, as `application/wasm`.
- Playwright's Chromium 1234 and its headless shell are in `~/.cache/ms-playwright`. On a cold
  machine, `npx playwright-core install chromium` fetches them. Phase 08 documents it.
