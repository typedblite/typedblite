---
kind: checklist
status: complete
feature: sync-demo
phase: 03-honest-replication
---

# Phase 03 — Replication that fails honestly

**Branch:** `phase/sync-demo/03-honest-replication`, from `feat/sync-demo` · **Opened:** 2026-11-12 ·
**Governed by:** [ADR-009](../../../../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) D7

**Goal.** The original demo's three replication defects are resolved: fixed, given a timeout, or
shown not to reproduce.

## Defect 1: a 5xx is "nothing to pull"

- [x] Confirmed in `typedblite-replicator.ts`: `if (!response.ok || !response.body) return [];`
- [x] `fetchSince` throws on any non-OK answer (`pull failed: the hub answered 503`) and on a missing
      body. 401/403 still throw `pull refused`
- [x] Found while fixing it: **a stream that ends before the hub's `: caught-up` marker also returned
      as success.** It now throws. The hub always writes the marker when it has nothing more to send
      (`change-stream.ts`), so a stream without one was cut off. Re-reading the records on the next
      sync is harmless, because `applyRemote` is idempotent

## Defect 2: no timeout

- [x] `ReplicationOptions.timeoutMs` (for `replicateOnce`): one `AbortSignal.timeout` covers the pull
      and every push batch, and fails with `no answer from the hub within N ms`.
      `ChangeStreamClient.push` takes the signal. `AbortSignal.timeout` exists in Node 18+ and in
      every browser the binding supports
- [x] `replicateContinuously` already reconnects and reports `onFailed`, so it is unchanged

## Defect 3: a reopened store that skips `define`

- [x] **Not reproduced.** A file store with a `@key`, reopened without `define`, deleted and
      re-inserted the same key 10 times in transactions, with 0 failures, and likewise with
      `define`. The original's failure came from a downstream-app store with its kernel schema, and
      was never reduced to a minimal case. No engine change: the docs already say to `define` on
      every open, and the demo does

## Proof

- [x] `honest-replication.test.ts`, 5 tests: 503 (pull and duplex); a stream cut before the marker; a
      silent hub with `timeoutMs: 300`; a refused push; and a healthy hub with a timeout. Putting back
      `return []` fails the 503 test
- [x] The existing replication suites are unchanged: `replication`, `replication-correctness`,
      `hub-and-spoke` and `change-stream-auth` all pass
- [x] Replication guide: the four ways `replicateOnce` now rejects, `timeoutMs`, and what an
      offline-first app should do with the error

## Close

- [x] Clean gate: 6 projects green (1,294 tests). Conformance at 1742 · 1 · 12 · 1 / 1756.
      `test-wasm`: 579 passed and 1 skipped. `test-browser`: 3 of 3
- [x] `summary.md`, and the Phase Plan row
