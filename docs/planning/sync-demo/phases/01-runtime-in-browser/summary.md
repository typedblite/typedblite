---
kind: summary
status: complete
feature: sync-demo
phase: 01-runtime-in-browser
---

# Phase 01 — Summary

**Closed:** 2026-11-12 · **Checklist:** [checklist.md](checklist.md)

## What changed

- **`@typedblite/content-revision` has no Node dependency.** It hashes with its own synchronous
  SHA-256, proven identical to `node:crypto` by a differential that includes 300 chained revisions
  computed both ways.
- **`@typedblite/runtime` has a `browser` entry point.** It includes everything but the
  `node:sqlite` binding and the SSE hub, and is proven Node-free by an esbuild browser bundle on
  every test run.
- **The interpreter's default opener is the conditional `#default-opener`.** On Node it is
  `node:sqlite`, as before. Elsewhere it refuses, and names the opener to pass.

## Evidence

- `sha256.spec.ts`: 7 tests. A one-constant mutation fails 6 of them.
- `browser-entry.test.ts`: 5 tests. Re-exporting the Node binding fails 3.
- Clean gate: 1,289 tests across 6 projects. Conformance unchanged at 1742 of 1756.

## For later phases

- The browser bundle is about 1.9 MB unminified. Much of it is `vscode-languageserver`, which
  `diagnostics.ts` imports for one enum (deferred).
- Phase 02 must alias `#default-opener` to the WASM opener in `vitest.wasm.config.ts`. It replaces
  the old `node-sqlite.js` redirection, which no longer catches anything, because `interpreter.ts`
  no longer imports that file.
