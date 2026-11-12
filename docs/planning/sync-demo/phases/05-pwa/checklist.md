---
kind: checklist
status: complete
feature: sync-demo
phase: 05-pwa
---

# Phase 05 — The PWA client and its service worker

**Branch:** `phase/sync-demo/05-pwa`, from `feat/sync-demo` · **Opened:** 2026-11-12

**Goal.** A device in the browser: TypeDBLite in a Web Worker on WASM SQLite and OPFS, syncing
through the switchboard, with a page that shows what the sync is doing, and a shell that starts
offline.

## Build

- [x] `src/client/worker.ts` runs `DemoDevice` (the same class as the smoke run) on
      `openWasmSqlite`, with one SAH pool per device name. It syncs every 1.5 s through
      `/net/<device>/hub`, and a local write syncs at once. **One scheduler:** a tick that arrives
      mid-sync is remembered, and only one timer is ever pending. It publishes its state, and the
      tasks a pull changed, so the page can highlight them
- [x] It imports only `@typedblite/runtime`, which the bundler's `browser` condition resolves to the
      browser entry, `@typedblite/runtime/wasm`, and the demo's own modules. **The esbuild
      configuration has no alias and no plugin**
- [x] `src/client/polyfills.ts`: `Object.groupBy` for Android 14's WebView, imported first (ADR-009
      D6: the application, not the library)
- [x] `src/client/main.ts` and `index.html`:
  - the task list, an add box, checkboxes, and the creating device shown on each task;
  - a status that reads Connecting…, Online · in sync, Syncing… or Offline — working locally;
  - "*n* changes waiting to sync";
  - a highlight on tasks that were pulled in;
  - dark mode.

  The cursor is kept in `localStorage`, because a worker has none. `?device=` names the device and
  `?fresh` wipes its store. `window.typedbliteDemo` is the driver's handle
- [x] `src/client/sw.ts`: a **network-first** shell cache (`/`, the bundles, `sqlite3.wasm`, the
      manifest and the icon). It never caches `/net/` or `/api/`. A navigation with no network gets
      the cached shell
- [x] `build-client.mjs` bundles with esbuild into `.build/` and copies `sqlite3.wasm`, and is part of
      the `build` target. The worker is 2.4 MB unminified, plus 0.86 MB of WASM
- [x] Type-checking runs as three programs: the server (Node), the page (DOM) and the workers
      (WebWorker), with `customConditions: ["browser"]`
- [x] The demo declares its own dev dependencies: `@sqlite.org/sqlite-wasm`, `esbuild` and
      `playwright-core`, at the versions the workspace already has

## Proof

- [x] `test-browser/pwa.test.ts` (target `test-browser`) runs two Chromium profiles, so two OPFS
      stores, through the real server and hub. It proves:
  1. a task added through the page reaches the other device;
  2. completing it by clicking on one device shows it done on the other;
  3. a cut link shows "Offline" and "1 change waiting to sync", then converges when the link is
     restored;
  4. **a reload with the network fully off starts from the service worker, has its data from
     OPFS, takes a write, and converges when the network returns.**

  **4 of 4.** Removing `sw.js` fails the offline reload
- [x] Clean gate: 7 projects green. Conformance at 1742 · 1 · 12 · 1 / 1756

## Close

- [x] `summary.md`, and the Phase Plan row
