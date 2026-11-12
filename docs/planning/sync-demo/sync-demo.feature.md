---
kind: feature
status: in-progress
decided-by: [adr-009]
title: TypeDBLite Sync Demo
feature: sync-demo
branch: feat/sync-demo
---

# TypeDBLite Sync Demo — Feature Doc

> **Status:** 🚧 In progress · **Written:** 2026-11-12 · **Branch:** `feat/sync-demo`, from
> `main` · **Governed by:** [ADR-009](../../architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md)
>
> Request, 2026-11-12: *a sync demo like the one in `downstream-app`, with every dependency it needs
> included, and without the Windows text-to-speech narration.*
>
> Decided by the founder, 2026-11-12, before this document was written:
> - **A merged showcase.** It lives at `apps/sync-demo`, runs under the
>   [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md),
>   and is merged to `main`. It does not stay on a demo branch.
> - **The WASM binding is promoted.** TypeDBLite on WASM SQLite becomes a supported export of
>   `@typedblite/runtime`, which the demo then uses. The demo never imports the spike.
>
> **A feature, not an initiative.** It has one deliverable, the demo, and the runtime work it needs
> runs in a straight line ahead of it.

## Process

Per the [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md).
`feat/sync-demo` is cut from `main`. Each phase branch, `phase/sync-demo/<NN>-<slug>`, is cut from
`feat/sync-demo` and merges back into it. Each phase's checklist is written when that phase starts.
Questions for the founder are asked in Phase 00.

## Motivation

TypeDBLite's reason to exist is **offline-first**. It keeps a store on every device, every write
lands locally first, and the stores converge through a hub when they can reach it
([ADR-003](../../architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)). The
[replication guide](../../guides/replication-and-search.md) explains this. A demo *shows* it:
- three devices, each holding its own store;
- one device's link is cut while it keeps working, with its changes queued;
- the hub goes down;
- everything converges the moment the network returns.

A demo like that already exists, in `downstream-app` on the branch
`demo/typedblite-offline-sync-2026-11-12`. It cannot be reused here as it stands:
- **It depends on downstream-app.** It needs that project's Docker stack (gateway, PIM API, pim-ui,
  and a hub service), its kernel schema, its token flow, and its PIM repository's record format.
- **It runs TypeDBLite through a spike.** It imports `libs/runtime/spike/wasm-sqlite.ts` from
  *this* repository by a relative path, and aliases `node-sqlite.ts` away in its own esbuild
  configuration.
- **It was never meant to be kept.** Its run-book says *"Demo only… never merged"*.

This feature rebuilds that demo inside this repository. **TypeDBLite is the hub, as well as every
client.** Along the way it turns the browser binding into something anyone can use.

## The original, surveyed 2026-11-12

`downstream-app/demo/offline-sync/`, at `c42c2a7b`. Load-bearing: re-read it before Phase 04.

| Part | What it does | Here |
| ---- | ------------ | ---- |
| `client/worker.ts` | TypeDBLite on WASM SQLite with OPFS storage, in a Web Worker. It writes tasks, counts changes not yet pushed (from the push cursor), and syncs with `replicateOnce({ direction: 'duplex', from: cursor })` every 1.5 s, with an 8 s timeout | **Kept**, rewritten against the public WASM export and a small task schema of its own |
| `client/main.ts`, `index.html` | The task list, add and complete, a "*n* changes waiting to sync" badge, an online/offline state, and a highlight on tasks pulled in | **Kept** |
| `client/sw.ts` | A network-first service worker, so a reload works offline | **Kept** |
| `client/polyfills.ts` | `Object.groupBy`, which Chevrotain (Langium's parser library) calls and which needs Chromium 117. Android 14's WebView is Chromium 113 | **Kept**, as part of the supported binding or documented as a requirement (Phase 00) |
| `server.ts` | esbuild the client, serve it, and run the **switchboard**: `/net/<device>/hub/…` proxies to the hub, and cutting a link destroys that device's sockets | **Kept**. The hub moves in-process or to a child process, and the gateway and token proxy go |
| `control.html` | The hub's tasks, and a button per device to cut or restore its link | **Kept**, reading the hub's TypeDBLite store directly instead of the PIM API |
| `electron/main.ts` | A desktop shell with its own profile, so its own OPFS | **Kept** |
| Capacitor `android/` project, `android/*.sh`, `*.py` | The Android app, plus SDK setup, an emulator start script, and toolbar hiding | **Kept**, with the SDK setup scripted, not hand-installed |
| `scripts/demo.ts` | A Playwright driver that opens every window and runs a nine-step story. It has `--auto`, `--open`, `--fresh`, `--no-android`, `--record`, and Pause and Play | **Kept**, **without narration**. Captions are shown on screen, and a recording has no sound track |
| `scripts/tts.ts`, `tts/synthesize.ps1`, `.build/tts/*.wav` | Windows SAPI narration | 🔴 **Left out**, at the founder's request |
| `scripts/reset.ts` | Fresh Docker volumes, device grants, and an optional seed | **Replaced** by deleting the hub's store file and the clients' stores |
| `scripts/repro-*`, `*-check.ts` | One-off investigations from that night | **Left out.** What they found is in the table below |
| Docker stack, gateway tokens, PIM API, pim-ui, kernel schema | downstream-app itself | 🔴 **Not needed.** TypeDBLite's own hub replaces all of it |

The defects found while building the original matter here:

| # | Defect | Status in this repository, verified 2026-11-12 | Here |
| - | ------ | ---------------------------------------------- | ---- |
| 1 | `TypeDBLiteReplicator.fetchSince` treats any non-OK answer except 401/403 as "nothing to pull", so a spoke whose hub answers 5xx reports itself in sync | 🔴 **Still present**: `typedblite-replicator.ts` returns `[]` when `!response.ok` | **Fixed in Phase 03.** The "hub goes down" step depends on it |
| 2 | No timeout on a sync against a hub that drops packets | downstream-app's `sync.now`. The replicator has none either | Phase 03 decides whether the replicator takes a timeout or a signal |
| 3 | A reopened store that skips `define` fails at the first write that reuses a key (`[CNT9]`) | A usability gap in the engine: it does not refuse or warn | The demo defines on every open. Phase 03 decides whether the engine should warn |
| 4 | The runtime needs `Object.groupBy` (Chromium 117+) | Through Chevrotain, a dependency of Langium | Phase 01 |
| 5 | A cache-first service worker served stale code | The demo's own | Network-first from the start |

## What already exists — verified on disk 2026-11-12

| Thing | State |
| ----- | ----- |
| WASM binding | [`libs/runtime/spike/wasm-sqlite.ts`](../../../libs/runtime/spike/wasm-sqlite.ts) (243 lines): `initWasmSqlite({ sahPool, moduleOptions })` and `openWasmSqlite`, using SQLite's in-memory `memdb`, or OPFS through the SAH-pool VFS (worker-only, with no `SharedArrayBuffer` and so no COOP/COEP). It also has `wipeOpfsPool` and `poolInfo`. **Unsupported**: it is not exported, and has no tests of its own |
| `@sqlite.org/sqlite-wasm` | **Not a dependency of this repository.** The spike has only ever resolved it from downstream-app's `node_modules` (3.54.1-build1 there) |
| Browser test harness | `libs/runtime/spike/browser/`: about 2,300 lines of console, crash, failure, idempotency, tab and WAL runners, with a `node-crypto-shim.ts` |
| WASM test config | [`vitest.wasm.config.ts`](../../../libs/runtime/vitest.wasm.config.ts) runs the runtime suite with `node-sqlite.ts` redirected to the WASM opener. 🔴 **It does not start**: it imports `vitest.shared` from `../../../../`, outside the repository. It cites `docs/analysis/typedblite-wasm-engine-spike.md`, which is not in this repository |
| Node-only imports | [`node-sqlite.ts`](../../../libs/runtime/src/node-sqlite.ts) (`node:sqlite`), [`change-stream.ts`](../../../libs/runtime/src/change-stream.ts) (`node:http`), and [`content-revision/src/lib/revision.ts`](../../../libs/content-revision/src/lib/revision.ts) (`node:crypto`). 🔴 **The runtime's `index.ts` re-exports the first two, and `interpreter.ts` imports `openNodeSqlite` as its default opener**, so a browser bundle of `@typedblite/runtime` pulls in all three |
| `process` | The interpreter already guards `typeof process === 'undefined'` for its environment switches |
| Replication client | [`change-stream-client.ts`](../../../libs/runtime/src/change-stream-client.ts) is hand-rolled over `fetch`, and imports nothing from `node:`. It should run in a browser as it is (Phase 01 proves it) |
| Hub | `serveChangeStream(log, options)` listens on `127.0.0.1` only. `createChangeStreamHandler` can be mounted in the demo's own server |
| esbuild | Already a dev dependency (the VS Code extension uses it) |
| Playwright | **Not a dependency here.** downstream-app used `playwright-core` 1.62.1 with a Chromium from `~/.cache/ms-playwright` |

## 🔴 The invariants every phase is bound by

**1. The Node path is unchanged.** Promoting the WASM binding adds a way to run the engine. It
does not change how the engine runs on Node. The runtime suite stays green, and **the conformance
run stays at 1742 of 1756** (ADR-005), at every phase close.

**2. A revision is byte-identical everywhere.** If `content-revision` stops depending on
`node:crypto`, every revision computed in a browser must equal the one computed on Node, or stores
on different platforms stop converging (ADR-003 D3). That is proven by a differential test over many
states, not argued. The CouchDB parity oracle no longer exists, so nothing else would notice
([Testing](../../development/testing.md#the-full-text-parity-oracle)).

**3. The demo uses only public API.** It imports nothing from `src/`, `spike/` or a relative path
into a library. Anything it needs that is not exported is a change to the library, made in a library
phase, with its own tests.

**4. Fail loudly, the demo included.** A hub that cannot be reached shows as offline. It never shows
as "in sync" (defect 1). A refused write shows its diagnostic code in the client.

**5. Nothing leaves the machine.** The hub, the switchboard and every client talk over `localhost`,
or the emulator's reversed port. The demo needs no account, no cloud service and no Docker.

## Goals

1. **`@typedblite/runtime` runs in a browser, as supported API.** It has a browser-safe entry point,
   and a WASM export (`initWasmSqlite`, `openWasmSqlite`, OPFS persistence) with
   `@sqlite.org/sqlite-wasm` as an optional peer dependency. It is tested in Node and in a real
   Chromium.
2. **Replication is honest about failure.** A hub answering 5xx, or not answering, is an error.
3. **`apps/sync-demo`**, an Nx project, containing:
   - a TypeDBLite hub;
   - the switchboard server;
   - a control page;
   - a PWA client;
   - an Electron shell;
   - a Capacitor Android app.
4. **The story**, driven by Playwright, with the original's nine steps, on-screen captions, Pause and
   Play, and `--auto`, `--open`, `--fresh`, `--no-android` and `--record` (silent).
5. **One command per platform to set up**, from a cold machine: npm dependencies, a Playwright
   Chromium, Electron, and the Android SDK, emulator image and JDK.

## Definition of done

- [ ] `@typedblite/runtime`'s browser entry, bundled by esbuild for the browser platform, contains no
      `node:` import.
- [ ] The WASM export has a test suite running in Node (memdb) and in Chromium (OPFS), including a
      store that survives a page reload.
- [ ] The runtime suite passes against the WASM binding, except for the documented limits of the
      binding: a real file that survives a restart, and several processes sharing one file. Each
      exception is listed with its reason.
- [ ] 🔴 Revisions computed in a browser equal those computed on Node, over a differential corpus.
- [ ] 🔴 Conformance is unchanged at 1742 of 1756, and the Node runtime suite is green.
- [ ] A spoke whose hub answers 5xx, or does not answer within its timeout, reports an error. Proven
      by a runtime test.
- [ ] `nx run sync-demo:smoke` runs three headless spokes and a hub through the story's network
      events (cut, write, restore, hub down, hub up), and asserts convergence each time.
- [ ] `nx run sync-demo:demo -- --auto --fresh` runs the whole story with the PWA and Electron, and
      with Android when an emulator is available. Every step's convergence check passes.
- [ ] The demo's README covers setup from a cold machine, running, the story, and troubleshooting.
      The root README and the replication guide link to it.
- [ ] `AGENTS.md`, the project overview memory, and `CONTRIBUTING.md`'s project table name the new
      project.
- [ ] Build, typecheck and test are green from a clean tree.

## Out of scope

- **Narration.** The Windows SAPI text-to-speech is left out, at the founder's request. Captions
  carry the story.
- **downstream-app's PIM**: its schema, its API, its token flow and its UI. The demo has its own task
  schema and talks only to its own hub.
- **Authentication between spoke and hub**, beyond showing the replicator's `headers` hook with a
  static demo token. Per-record authorisation is ADR-003's open question, not this feature's.
- **Production hosting** of the hub or the clients.
- **iOS.** Capacitor supports it, but it needs macOS to build.
- **Moving the spike's browser harness wholesale.** Only what the promoted binding's tests need is
  kept. The rest is removed or left, as Phase 02 decides.

## Open questions for Phase 00

These are for the founder.

1. **Browser floor:** ship an `Object.groupBy` polyfill with the binding, or document Chromium 117+
   (and so Android 14+ with an updated WebView) as a requirement?
2. **Where the hub runs:** in the demo server's own process (one command), or as a child process
   (so "the hub goes down" can kill a real process, as `docker stop` did)?
3. **Dependency versions:** `@sqlite.org/sqlite-wasm`, `playwright-core`, `electron` and the
   Capacitor packages. The original pinned Electron 38.2.0 and Capacitor ^7.4.3. Phase 00 confirms
   the current versions, and the licence of each.
4. **Android in the default run:** on by default when an emulator is reachable (as the original
   was), or opt-in?

## How this gets proven

**The library first, the demo second.** Phases 01 to 03 change libraries, and are proven by library
tests and by conformance. Only then does the demo build on them, so a demo failure cannot hide a
library defect.

**Headless before windowed.** `smoke` runs the story's network events with headless spokes, in
seconds, on any machine. The windowed story is the demonstration, not the test.

**Every step of the story checks convergence.** A step does not pass because time went by. It passes
because every store holds the same tasks, which is what the original's driver checked too.

## Phase Plan

| # | Phase | Status | Summary |
| - | ----- | ------ | ------- |
| 00 | [Scope, the survey of the original, ADR-009, versions and licences](phases/00-scope-and-adr/summary.md) | Complete | [summary](phases/00-scope-and-adr/summary.md) |
| 01 | [The runtime in a browser: a browser-safe entry, synchronous SHA-256, `Object.groupBy`](phases/01-runtime-in-browser/summary.md) | Complete | [summary](phases/01-runtime-in-browser/summary.md) |
| 02 | [The WASM binding, promoted: the export, the peer dependency, tests in Node and Chromium](phases/02-wasm-binding/summary.md) | Complete | [summary](phases/02-wasm-binding/summary.md) |
| 03 | [Replication that fails honestly: 5xx and timeouts, and a warning on a reopened store](phases/03-honest-replication/summary.md) | Complete | [summary](phases/03-honest-replication/summary.md) |
| 04 | [The hub, the switchboard, the control page, and `smoke`](phases/04-hub-and-switchboard/summary.md) | Complete | [summary](phases/04-hub-and-switchboard/summary.md) |
| 05 | The PWA client and its service worker | Not started | |
| 06 | Electron and Android | Not started | |
| 07 | The story: the Playwright driver, captions, Pause and Play, silent recording | Not started | |
| 08 | Setup scripts, the README, and the docs | Not started | |

## Phase Intent

This is a forward plan. Each phase's checklist is written when that phase starts.

**00 — Scope and ADR-009.** Re-survey the original. Answer the open questions. Write ADR-009:
TypeDBLite on WASM SQLite is a supported binding, with a browser entry point and synchronous
hashing. It amends ADR-002 D9, which retired an earlier WASM adapter.

**01 — The runtime in a browser.** Give `@typedblite/runtime` a browser entry point, through
conditional exports, that leaves out `node:sqlite` and `node:http`. Make the default opener an
injected dependency, so `interpreter.ts` stops importing it statically. Give `content-revision` a
synchronous SHA-256 that needs no `node:crypto`, proven byte-identical (invariant 2). 🔴 This phase
touches the engine and the revision algorithm: conformance and the differential run at its close.

**02 — The WASM binding, promoted.** Move it from the spike to `src/`, behind a `./wasm` export, with
`@sqlite.org/sqlite-wasm` as an optional peer dependency. Fix `vitest.wasm.config.ts`, and make it a
target. Add a Chromium test of OPFS persistence through Playwright.

**03 — Honest replication.** Fix defect 1. Decide on and implement a timeout or `AbortSignal` for a
sync (defect 2). Decide whether opening a store without re-applying its schema should warn
(defect 3).

**04 — The hub, the switchboard and `smoke`.** Build `apps/sync-demo`'s server:
- the hub (its store, `createChangeStreamHandler`, and the static demo token);
- the per-device switchboard;
- the control page;
- static serving of the client build.

`smoke` drives headless spokes through every network event.

**05 — The PWA.** The worker (the engine on OPFS, the sync loop, the pending count), the page, and a
network-first service worker.

**06 — Electron and Android.** The Electron shell with its own profile. The Capacitor project, the
SDK, emulator and JDK setup scripts, and `adb reverse` for the switchboard port.

**07 — The story.** The Playwright driver: the nine steps, convergence checks, captions, Pause and
Play, the flags, and a silent recording.

**08 — Docs.** The demo's README, links from the root README and the replication guide, and
`AGENTS.md` and the project overview.

## Deferred

Anything a phase defers is recorded here, not only in a commit message.

- **A lighter browser bundle.** Phase 01. `diagnostics.ts` imports `DiagnosticSeverity` from
  `vscode-languageserver`, which pulls about a megabyte of protocol code into a browser bundle.
  Importing it from `vscode-languageserver-types` would avoid that, at the cost of a direct
  dependency. To be picked up when a browser user asks about bundle size.
- **Refuse `has <attr> $v` where `$v` is a `given` value.** Phase 04. It matches nothing, and is
  reported only as an `empty-match` fact. A refusal or a warning at plan time would have saved a
  debugging round. This is engine and grammar work, decided caller-first.

## Key Documents

- [ADR-003](../../architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md): the change log
  and sync
- [ADR-002](../../architecture/adr-002-typeql-engine-as-a-port.md) D9: the earlier WASM adapter,
  retired, which ADR-009 revisits
- [Replication and search](../../guides/replication-and-search.md)
- [Multi-Phase Lifecycle Standard](../../standards/governance/multi-phase-lifecycle-standard.md)
- The original: `downstream-app` branch `demo/typedblite-offline-sync-2026-11-12`, folder
  `demo/offline-sync/` (outside this repository)
