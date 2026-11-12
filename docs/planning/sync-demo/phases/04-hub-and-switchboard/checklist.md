---
kind: checklist
status: complete
feature: sync-demo
phase: 04-hub-and-switchboard
---

# Phase 04 — The hub, the switchboard, the control page, and `smoke`

**Branch:** `phase/sync-demo/04-hub-and-switchboard`, from `feat/sync-demo` · **Opened:** 2026-11-12

**Goal.** The server side of `apps/sync-demo`, proven headless before any window exists.

## Build

- [x] `apps/sync-demo`, Nx project `sync-demo`, with targets `build`, `typecheck`, `test`, `smoke` and
      `serve`. Its npm package is the private `typedblite-sync-demo`
- [x] `src/shared/schema.ts`: one keyed type, `task` (`task-id @key`, `title`, `done`, `created-at`,
      `origin`), and `readTasks`
- [x] `src/shared/device.ts`: `DemoDevice`, platform-neutral, importing only `@typedblite/runtime`.
      It defines on every open. User text reaches the engine only as `given` rows. `pending()`
      counts the replicable entities after the push cursor. `syncOnce()` is
      `replicateOnce({ direction: 'duplex', from: cursor, timeoutMs })` and never throws: a failed
      sync is "offline"
- [x] `src/hub/main.ts`: the hub, a child process with a file store, `createChangeStreamHandler`
      behind `Bearer typedblite-sync-demo`, and `/tasks` for the control page. It listens on
      127.0.0.1 only
- [x] `src/server/server.ts`, `startDemoServer`, provides:
  - the switchboard (`/net/<device>/hub/…`). A link that is down destroys the socket, including live
    streams;
  - the hub's process lifecycle, stopped with SIGKILL as a real outage;
  - an unreachable hub answered with 502;
  - the `/api` endpoints;
  - the control page;
  - static client files.
- [x] `static/control.html`: plain HTML. The hub state with stop and start, a cut/restore button per
      device link, and the hub's tasks. Places for Phase 07's caption and Pause are already there

## Found while building

- [x] 🔴 **`match $t isa task, has task-id $id` with a `given $id: string` matches nothing.** A given
      variable is a value, and `has task-id $id` binds an attribute. The engine said so with a fact
      ("`match` bound 0 combinations"), and the update silently did nothing. The device now writes
      `has task-id == $id`, and **treats an `empty-match` fact on an update as an error**
      (invariant 4)

## Proof

- [x] `test/smoke.test.ts`, 8 steps, each asserting that every device and the hub hold the same
      tasks:
  1. three devices converge on three tasks;
  2. write anywhere;
  3. edit elsewhere;
  4. a link is cut: the device keeps writing with 3 changes pending, and misses another device's
     task;
  5. the link comes back and everyone converges;
  6. the hub process is killed: every device fails its sync, none reports itself in sync, and they
     keep writing;
  7. the hub restarts with its store intact and everyone converges;
  8. a device restarts while offline: its store and journal survive, and it converges.

  Stable over three runs, at about 8 seconds each
- [x] By hand: `serve` answers `/control` with 200, a cut link destroys the connection, and a stopped
      hub answers 502. No process is left after shutdown

## Close

- [x] Clean gate: 7 projects green (1,302 tests). Conformance at 1742 · 1 · 12 · 1 / 1756
- [x] `summary.md`, and the Phase Plan row
