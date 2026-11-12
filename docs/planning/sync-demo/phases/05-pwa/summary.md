---
kind: summary
status: complete
feature: sync-demo
phase: 05-pwa
---

# Phase 05 — Summary

**Closed:** 2026-11-12 · **Checklist:** [checklist.md](checklist.md)

## What exists now

**The PWA device.** TypeDBLite runs in a Web Worker on WASM SQLite with an OPFS store, syncing
through the switchboard. The page shows the sync's state and the offline journal, and a
network-first service worker starts the app with no network. It is built from the public packages,
with no bundler tricks.

## Evidence

`nx run sync-demo:test-browser`: 4 of 4 in a real Chromium, including the original's step 8 (a
reload with no network, then convergence). Removing the service worker fails that test.

## For Phase 06

- Electron and Android load the same page from the demo server: `?device=electron` and
  `?device=android`. Each needs its own storage (an Electron profile, the app's WebView) so that its
  OPFS store is its own.
- The page is served from `http://localhost:<port>`, which is a secure context, so OPFS and the
  service worker work in Electron, and in Android through `adb reverse`.
