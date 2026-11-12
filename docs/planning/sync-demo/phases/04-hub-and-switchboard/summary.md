---
kind: summary
status: complete
feature: sync-demo
phase: 04-hub-and-switchboard
---

# Phase 04 — Summary

**Closed:** 2026-11-12 · **Checklist:** [checklist.md](checklist.md)

## What exists now

`apps/sync-demo` (Nx `sync-demo`) contains:
- a **TypeDBLite hub** in its own process;
- the **switchboard** that cuts and restores each device's link;
- a **control page**;
- **`DemoDevice`**, the platform-neutral device every client will use.

`nx run sync-demo:smoke` runs the whole story's network events headless, in about 8 seconds, and
passes on every step.

## Worth knowing

- A `given` string is a value. Matching a keyed thing by it needs `has task-id == $id`. Writing
  `has task-id $id` matches nothing, and the engine reports that only as an `empty-match` fact. The
  device treats that fact as an error on an update. **This is a usability point for the engine:**
  a `has` binding a variable declared as a value in `given` could be refused, or warned about, at
  plan time (deferred).
- The switchboard no longer needs the original's trick of turning an unreachable hub into a refused
  connection. A 502 is honest now (Phase 03).

## For Phase 05

The browser worker wraps `DemoDevice` around `openWasmSqlite` with an OPFS pool per device name. It
persists the cursor through the page, because a worker has no `localStorage`. Serve the client from
`.build/` through `clientDir`.
