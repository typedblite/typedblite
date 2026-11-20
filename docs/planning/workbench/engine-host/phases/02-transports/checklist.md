---
kind: checklist
status: complete
feature: engine-host
phase: 02-transports
---

# Phase 02 — CLI, REPL and sidecar, on `@devx-micro/app-*`

**Branch:** `phase/engine-host/02-transports`, from `feat/engine-host` · **Opened:** 2026-11-19 ·
**Feature:** [Engine host](../../engine-host.feature.md)

**Goal.** The host is a process: its twelve operations declared once, reachable over the CLI, the REPL and the
sidecar, with a spec that a transport cannot drift from the core.

## Build

- [x] `@devx-micro/app-main`, `app-runtime` and `app-sidecar` installed (the lockfile's six devx-micro URLs point
      at their future npmjs.org address: see the summary)
- [x] `src/operations.ts`: twelve descriptors, each with `validate` and an `inputSchema`
- [x] `src/host-tool.ts` and `src/main.ts`: `defineApp`, the `typedblite-host` binary
- [x] `session.run` takes a `location` (open, run, close) as well as a session, for the one-shot CLI
- [x] Build output ignored: a `.gitignore` for `apps/engine-host` and `libs/session`, and the output Phase 01
      committed by mistake removed from the index

## Specs

- [x] Every operation declares an input schema that agrees with its `validate` (`assertInputSchemaAgreesWithValidate`)
- [x] **Parity:** the same flow through the CLI, the sidecar and the REPL gives the same data, status and error codes
- [x] A mutation (the REPL running a different statement) fails the parity spec
- [x] An unrecognized mode flag exits 2 and names the flag, in the built process; `-x` the same; no arguments
      starts nothing
- [x] One operation as a process: exit codes 0, 2 and 5, and a typo'd operation is an error envelope
- [x] The sidecar through `SidecarClient`, the client the editor will use: a session across requests, in order

## Checks

- [x] `npm run gate -- --quick`
- [ ] WASM, browser, e2e and clean-room steps: not run

## Outputs

- [x] `summary.md`; the feature and initiative status
- [ ] Merged into `feat/engine-host`
