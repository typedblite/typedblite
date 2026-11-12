---
kind: summary
status: complete
feature: sync-demo
phase: 00-scope-and-adr
---

# Phase 00 — Summary

**Closed:** 2026-11-12 · **Checklist:** [checklist.md](checklist.md)

## What was decided

[ADR-009](../../../../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) is accepted:
- WASM SQLite is a supported binding, exported as `@typedblite/runtime/wasm`;
- `@sqlite.org/sqlite-wasm` is an optional peer dependency;
- the runtime has a `browser` entry point that leaves out the Node-only binding and hub;
- the default opener is a conditional `#default-opener` import;
- revisions are hashed by one synchronous SHA-256 in TypeScript;
- the browser floor is documented rather than polyfilled;
- a hub's non-OK answer is an error.

The feature's open questions were answered under the founder's delegation:

| Question | Answer |
| -------- | ------ |
| Browser floor | Documented (Chromium 117+). The demo polyfills `Object.groupBy` for Android 14's WebView |
| Where the hub runs | A child process of the demo server, so it can really go down |
| Versions | Proven on this machine: Electron 38.2.0, Capacitor 7.4.3, playwright-core 1.62.1, sqlite-wasm 3.54.1-build1. Apache-2.0 or MIT. ⚠️ Corrected in Phase 06, for security advisories, to **Electron 42.11.18** and **Capacitor 7.6.10** |
| Android | On when `adb devices` lists a device, else skipped with a message |

## What later phases must know

- 🔴 **This session cannot boot the Android emulator.** The user is not in the `kvm` group. The
  Android app can be built and packaged; running it needs `sudo chmod 666 /dev/kvm`. The Definition
  of Done already makes Android conditional on an emulator.
- Electron's install script must be approved in the root `allowScripts`, or its binary is never
  downloaded.
- The `Object.groupBy` call comes from Chevrotain, not from TypeDBLite's own code.
