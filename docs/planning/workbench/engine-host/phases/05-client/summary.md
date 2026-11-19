---
kind: summary
status: complete
feature: engine-host
phase: 05-client
---

# Phase 05 — The client in `apps/vscode`: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/engine-host/05-client` · **Checklist:** [checklist.md](checklist.md)

## Goal

The extension starts the host over the sidecar and exposes its operations. No UI.

## What was built

- **The host as a bundle in the `.vsix`.** `engine-host:bundle` makes `dist/sidecar.cjs` (3.4 MB minified) from a
  `sidecar.ts` that is `defineApp` with the sidecar transport only, so the editor carries no HTTP server and no MCP
  SDK. `typeqlite-vscode:sync-host` copies it to `out/host/`. The extension **runs** it and never imports it.
- **`HostClient`.** Starts the host on the first request, over `SidecarClient`; starts one host for requests that
  arrive together; forgets a host that died, so the next request starts a fresh one; `request` answers the envelope,
  `call` answers the data and throws a `HostRequestError` carrying the host's code.
- **A `node` that is asked first.** The extension uses the setting `typedblite.host.node` (a machine setting, so a
  repository cannot choose what runs) or the `node` on PATH, and probes it for version and `node:sqlite`. A missing,
  old or sqlite-less `node` gets a message that says which, and what to do. A failed probe is not remembered.
- **How features reach it:** the command `typedblite.host.request` (hidden from the palette), and the `host` object
  the extension exports. Changing the setting ends the running host.

## What was proven

- **e2e against the installed `.vsix`:** the host starts from inside the package, a session opens, writes and reads
  through the command and through the exported API, and a fault comes back as the host's own code. Pointing the
  client at a wrong bundle path fails it. The whole suite is 20 of 20.
- The bundle, run as a process, answers every operation that needs an injected dependency; removing one `@Inject`
  fails it.
- The extension imports none of the host, the runtime or the session package (a spec reads its sources).

## Found while building

- **esbuild does not emit decorator metadata.** The first bundle failed with `Cannot read properties of undefined
  (reading 'open')`: every handler's registry was `undefined`. Nothing else in the suite sees it, because the tests
  compile with swc and the build with tsc, both of which emit it. Every handler now names its token with `@Inject`,
  and the bundle spec is the one that would catch a regression.
- **Electron's Node, measured:** VS Code 1.146 (Electron 43, Node 24.22) run as plain Node has `node:sqlite`. That
  settles Phase 00's open item for current VS Code. It is **not** used as a fallback: `engines.vscode ^1.91` covers
  builds with Node 20, which have none, and `SidecarClient` has no `env` option, so it cannot set
  `ELECTRON_RUN_AS_NODE` for its child. Setting it on the extension host's own environment would change every later
  child it spawns. A fallback needs an `env` option in devx-micro's client; deferred.

## What was not done

- **A fallback to Electron's Node** (above), so a user with no suitable `node` on PATH must install one.
- **A UI.** Nothing here shows a result. The graph explorer, debugger and notebook are the consumers.
- **Restoring sessions after the host dies.** They are gone, and a consumer reopens on `SESSION_NOT_FOUND`.
- **Windows and macOS.** The probe and the spawn use no shell, so they should work, but only Linux was run here.
- The lockfile's devx-micro entries (Phase 02's note).

## The feature

This closes the engine host: six phases, all merged into `feat/engine-host`, which has not been merged into
`main`. Its Definition of done is ticked. The consumers can start, in any order: the **notebook** or the **graph
explorer** first, as the initiative recommends. Each begins by re-reading the host's protocol as built.
