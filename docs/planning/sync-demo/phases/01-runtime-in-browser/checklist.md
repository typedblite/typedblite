---
kind: checklist
status: complete
feature: sync-demo
phase: 01-runtime-in-browser
---

# Phase 01 — The runtime in a browser

**Branch:** `phase/sync-demo/01-runtime-in-browser`, from `feat/sync-demo` · **Opened:** 2026-11-12 ·
**Governed by:** [ADR-009](../../../../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D3–D5

**Goal.** Bundling `@typedblite/runtime` for a browser pulls in nothing from Node. A revision is
byte-identical on every platform.

## Revisions (D5)

- [x] `content-revision/src/lib/sha256.ts`: a synchronous SHA-256 in TypeScript (the spike shim's core,
      with the non-null assertions replaced by typed reads), and `sha256Hex(text)` over UTF-8
- [x] `computeRevision` hashes one string, `${body}\0${parent}\0${deleted}`, which is the same bytes
      the chained `update()` calls fed `node:crypto`. `node:crypto` is gone from the package
- [x] 🔴 `sha256.spec.ts` covers:
  - the FIPS 180-4 vectors;
  - every padding boundary from 0 to 200 bytes;
  - 2,000 strings mixing ASCII, NUL, 2-, 3- and 4-byte UTF-8 and lone surrogates;
  - a 1.2 MB input;
  - raw bytes;
  - **300 chained revisions computed by the pre-ADR-009 `node:crypto` algorithm and by the new
    one, identical.**

  Corrupting one round constant fails 6 of the tests
- [x] The stale "run the parity oracle" header of `revision.ts` now says what guards the algorithm
      today

## The browser entry (D3) and the default opener (D4)

- [x] `src/index.browser.ts` holds everything that runs anywhere. `src/index.ts` re-exports it, and
      adds `change-stream.ts` (the hub, which needs `node:http`) and `node-sqlite.ts`, so the two
      cannot drift apart
- [x] `package.json`: `exports['.'].browser` points to the browser entry, and
      `imports['#default-opener']` gives `node` the `default-opener.node.js` and anything else
      `default-opener.js`. The latter refuses, and names `openWasmSqlite`
- [x] `interpreter.ts` imports `defaultOpener` from `#default-opener`, and no longer imports
      `node-sqlite.ts`. On Node, `new TypeDBLiteInterpreter()` is unchanged
- [x] TypeScript (Node16 resolution, TS 6.0) resolves `#default-opener` from a clean tree by mapping
      `out/` back to `src/`. Vitest would resolve it to `out/`, so `vitest.shared.ts` aliases it to
      the Node source
- [x] `browser-entry.test.ts` bundles the browser entry with esbuild (`platform: 'browser'`, no
      externals). It asserts no `node:` input and no hub or Node binding, that the export surfaces
      match less the Node-only names, the package's export and import maps, and the refusing
      opener. Re-exporting `node-sqlite.ts` from the browser entry fails 3 of its 5 tests

## `Object.groupBy`

- [x] Confirmed to come from Chevrotain, a Langium dependency. Per D6 it is documented, not
      polyfilled. The documentation goes into the runtime README with the WASM export (Phase 02)

## Close

- [x] Gate from a clean tree: 6 projects green (1,289 tests). Conformance at 1742 · 1 · 12 · 1 / 1756
- [x] `summary.md`, the Phase Plan row, and Deferred
