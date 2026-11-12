---
kind: summary
status: complete
feature: sync-demo
phase: 03-honest-replication
---

# Phase 03 — Summary

**Closed:** 2026-11-12 · **Checklist:** [checklist.md](checklist.md)

## What changed

- **A hub's error answer is a failed sync** (ADR-009 D7). The pull throws on any non-OK status, on a
  missing body, and on a stream that ends before the hub's caught-up marker. That last case was
  found while fixing the first.
- **`replicateOnce({ timeoutMs })`** fails a sync the hub never answers.
- **The reopened-store defect does not reproduce** on a minimal store, so the engine is unchanged.
  The guidance to `define` on every open stands.

## Evidence

`honest-replication.test.ts`: 5 tests, and the 503 test fails without the fix. All existing
replication suites pass, as do the clean gate, `test-wasm` and `test-browser`, and conformance is
unchanged.

## For later phases

The demo client uses `replicateOnce({ direction: 'duplex', from: cursor, timeoutMs })` every
1.5 s. Any rejection means "offline": keep the cursor, show the pending count, and try again. The
switchboard no longer has to turn an unreachable hub into a refused connection, as the original
had to. A 502 from the proxy is now enough.
