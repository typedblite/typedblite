---
kind: checklist
status: complete
feature: sync-demo
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the survey of the original, ADR-009

**Branch:** `phase/sync-demo/00-scope-and-adr`, from `feat/sync-demo` · **Opened:** 2026-11-12 ·
**Feature:** [TypeDBLite Sync Demo](../../sync-demo.feature.md)

**Goal.** Settle every question the later phases depend on, and record the architecture in ADR-009.

## Survey

- [x] Re-read the original (a downstream application's `demo/offline-sync/` at `c42c2a7b`): its run-book, worker,
      server and driver. The feature doc's survey table stands
- [x] Versions installed and proven on this machine by the original: Electron 38.2.0, Capacitor
      7.4.3, playwright-core 1.62.1 (Chromium revision 1234, present in `~/.cache/ms-playwright`),
      and `@sqlite.org/sqlite-wasm` 3.54.1-build1
- [x] The latest releases (npm, 2026-11-12): Electron 45.3.1, Capacitor 8.6.2, playwright-core 1.65.0,
      and sqlite-wasm 3.54.1-build1. Licenses: sqlite-wasm and playwright-core are Apache-2.0;
      Electron and Capacitor are MIT. All are compatible with MPL-2.0
- [x] Android toolchain on this machine: SDK platforms 34 and 35, the API 34 google_apis x86_64
      image, an existing AVD, and JDK 21 at `~/Android/jdk/jdk-21.0.13+9`. 🔴 **The user is not in the
      `kvm` group** (`/dev/kvm` is `root:kvm`, mode 660), so the emulator cannot boot without
      `sudo chmod 666 /dev/kvm`. This session can build and package the Android app, but cannot run
      it
- [x] npm 11.17 gates install scripts through `allowScripts` in the root `package.json`. Electron's
      script, which downloads its binary, must be approved there
- [x] The runtime compiles with `moduleResolution: Node16`, which resolves the `imports` field with
      conditions. A conditional `#default-opener` is therefore available to `interpreter.ts`

## Decisions (the open questions, under the founder's delegation of 2026-11-12)

- [x] **Browser floor:** documented, not polyfilled by the library. A library that patches globals
      surprises its host. The demo ships the `Object.groupBy` polyfill, because Android 14's WebView
      (Chromium 113) needs it
- [x] **Where the hub runs:** a child process of the demo server, so "the hub goes down" kills a real
      process, as `docker stop` did
- [x] **Versions:** the ones proven on this machine, which are all older than two weeks: Electron 38.2.0,
      Capacitor 7.4.3, playwright-core 1.62.1, sqlite-wasm 3.54.1-build1. A move to Electron 45 or
      Capacitor 8 is a separate change, with its own run on the emulator
      ⚠️ **Corrected in Phase 06.** `npm audit` showed critical and high advisories on these:
      Capacitor Android below 7.6.9 can load remote content at the app origin, its CLI pulls in a
      vulnerable `tar`, and Electron 38 has dozens of advisories fixed only from 39 to 42.11.16. The
      demo now pins **Capacitor 7.6.10** and **Electron 42.11.18**, the patched releases in the
      lowest majors, each more than two weeks old. "Proven on this machine" was the wrong criterion
      on its own
- [x] **Android in the default run:** on when `adb devices` lists a device, otherwise skipped with a
      message. `--no-android` forces it off

## Output

- [x] [ADR-009](../../../../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md), accepted under the
      founder's decision to promote the binding
- [x] `summary.md`, and the Phase Plan row
