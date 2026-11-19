---
kind: checklist
status: complete
feature: engine-host
phase: 01-core
---

# Phase 01 — The core

**Branch:** `phase/engine-host/01-core`, from `feat/engine-host` · **Opened:** 2026-11-19 ·
**Feature:** [Engine host](../../engine-host.feature.md)

**Goal.** The session aggregate, its commands and queries, and the classifier moved out of the CLI, proven
by specs that call the buses with no transport. The CLI moves onto the shared core with its specs unchanged.

## Process

- [x] Cut this branch from `feat/engine-host`
- [x] Ask the founder where the shared core lives (it cannot be in the private host: the CLI is published)

## Build

- [x] `libs/session` (`@typedblite/session`): `classifyStatement`, `splitStatements`, `Session` (run, begin,
      commit, rollback, restart, close, schema)
- [x] `apps/engine-host`: NestJS, the `SessionRegistry`, 7 commands, 5 queries and their handlers
- [x] `apps/cli` on `@typedblite/session`; `apps/cli/test` has no change
- [x] Five published packages: `nx.json`, `tools/publishable.mjs`, the tour, the API reference config

## Specs

- [x] Open, define, write, read, commit, roll back, restart, close, with no transport
- [x] A closed session refuses; two sessions keep separate stores; a file survives a host restart
- [x] A write in manual mode is gone after rollback and present after commit
- [x] Facts and refusals come back as data, with the engine's own message
- [x] Two sessions on one file: a second writer is refused as `locked` (through the interpreter, closing the
      Phase 00 measurement)
- [x] Mutation checks: a rollback that commits, and a lock that is not named, each fail a spec

## Checks

- [x] `npm run gate -- --quick`: build, typecheck, package contents, API, tests with the coverage floor
- [ ] WASM, browser, e2e and clean-room steps: **not run** (nothing they cover changed, but the clean room now
      packs a fifth package)
- [x] The runtime has no new dependency and no changed export; the conformance run is untouched

## Outputs

- [x] ADR-011 D3 amended
- [x] `summary.md`
- [ ] Merged into `feat/engine-host`
