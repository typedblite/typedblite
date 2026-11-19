---
kind: checklist
status: complete
feature: engine-host
phase: 03-http
---

# Phase 03 — HTTP

**Branch:** `phase/engine-host/03-http`, from `feat/engine-host` · **Opened:** 2026-11-19 ·
**Feature:** [Engine host](../../engine-host.feature.md)

**Goal.** HTTP as the fourth transport: generic dispatch over the operation list, loopback only, and in the
parity spec.

## Build

- [x] `@devx-micro/app-http` and `@nestjs/platform-express` installed; 55 npm lockfile URLs verified against
      registry.npmjs.org and rewritten, the devx-micro one rewritten as before
- [x] `src/http.ts`: `GET /help`, `POST /ops/:operation` through `unwrap`; no route per operation
- [x] Loopback only: a listener on `127.0.0.1`, a peer check, and a `Host` check
- [x] `defineApp`'s `http` definition: a bare `typedblite-host` serves, `TYPEDBLITE_HOST_PORT`, default 3470

## Specs

- [x] The bound address is `127.0.0.1` (and the spec fails when the adapter is removed)
- [x] The `Host` check refuses a rebinding name (and fails when the check is removed); a table of peers and hosts
- [x] The operation flow, an engine refusal as a 200, faults as 400 and 404 with a code, a non-object body
- [x] **Parity:** HTTP joins the CLI, sidecar and REPL in the same flow
- [x] A process: no arguments serves and stops on SIGTERM; `--help` starts nothing; `--repel` still exits 2

## Checks

- [x] `npm run gate -- --quick`
- [ ] WASM, browser, e2e and clean-room steps: not run

## Outputs

- [x] `summary.md`; the feature and initiative status; the README, `AGENTS.md`
- [ ] Merged into `feat/engine-host`
