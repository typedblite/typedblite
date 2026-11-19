---
kind: checklist
status: complete
feature: engine-host
phase: 05-client
---

# Phase 05 — The client in `apps/vscode`

**Branch:** `phase/engine-host/05-client`, from `feat/engine-host` · **Opened:** 2026-11-19 ·
**Feature:** [Engine host](../../engine-host.feature.md)

**Goal.** The extension starts the host over the sidecar and exposes its operations to the features built on it. No
UI. Packaged, and reached by an e2e against the installed `.vsix`.

## Measurements

- [x] `node:sqlite` in the desktop Electron's Node: **present** in VS Code 1.146 (Electron 43, Node 24.22) run as plain Node.
      Absent on builds with Node 20, which `engines.vscode ^1.91` still covers, so no fallback to it (see the summary)
- [x] The size of the host bundle: 3.4 MB minified, with no HTTP server and no MCP SDK

## Build

- [x] `engine-host:bundle` (`esbuild.mjs`): `dist/sidecar.cjs`, from a `src/sidecar.ts` that is `defineApp` with the sidecar only
- [x] `@Inject` on every handler's constructor: esbuild does not emit the metadata Nest reads
- [x] `typeqlite-vscode:sync-host` copies the bundle to `out/host/`; `build` and `package` depend on it
- [x] `src/host/probe-node.ts`: the `node` is asked for its version and `node:sqlite` before it is used
- [x] `src/host/host-client.ts`: lazy start, one host for concurrent requests, a dead host is forgotten, `request` and `call`
- [x] The command `typedblite.host.request` (hidden from the palette), the exported `host` API, the setting
      `typedblite.host.node` (a machine setting), the host stopped on deactivate and when the setting changes

## Specs

- [x] `probe-node`: the version rule, every way a `node` can be wrong, and the real probe on this process's `node`
- [x] `host-client`: lazy start, the `node` chosen, the messages, one start for concurrent requests, a retry after installing `node`, a dead host, stop
- [x] The bundle itself, run as a process: every operation that needs an injected dependency (and a removed `@Inject` fails it)
- [x] The manifest: the command, the setting's scope, the bundle's path, and **the extension never imports the host, the runtime or the session package**
- [x] **e2e against the packaged `.vsix`:** the host starts, a session works through the command and through the exported API, and a fault is the host's code
      (a wrong bundle path fails it)

## Checks

- [x] `npm run gate`, in full
- [x] `typeqlite-vscode:e2e`: 20 of 20

## Outputs

- [x] `summary.md`; ADR-011 D1; the feature's Definition of done; the extension README; `AGENTS.md`; the project overview
- [ ] Merged into `feat/engine-host`
