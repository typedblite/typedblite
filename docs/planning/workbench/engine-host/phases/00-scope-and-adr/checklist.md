---
kind: checklist
status: in-progress
feature: engine-host
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the NestJS and launch decisions, and the ADR

**Branch:** `feat/engine-host` (this phase is docs only, so no phase branch was cut) ·
**Opened:** 2026-11-19 · **Feature:** [Engine host](../../engine-host.feature.md)

**Goal.** Answer the feature's nine open questions, record them in an ADR, and leave Phase 01
nothing to decide. This phase writes no code.

## Process

- [x] Cut `feat/engine-host` from `main`

## Measurements

- [x] Two sessions on one file: SQLite arbitrates (`database is locked` on a second writer, reads
      see committed rows). Raw `node:sqlite`, default journal mode
- [x] `node:sqlite` in a launched Node: present in the remote server's Node 24.22
- [ ] `node:sqlite` in the desktop Electron's Node: **not verified**, so Electron-as-Node is a
      fallback only. Phase 05 checks it
- [ ] The same lock behaviour through `SqliteEngine`: Phase 01

## Decisions

- [x] D1 launch, D2 NestJS, D3 replace the CLI session, D4 names, D5 two sessions, D6 one statement
      per run, D7 debugger left open, D8 MCP tiers, D9 internal operation set (all accepted by the
      founder, 2026-11-19)
- [x] D10 build on `@devx-micro/app-*` (founder, 2026-11-19); the MCP location is deferred to Phase 04

## Outputs

- [x] [ADR-011](../../../../../architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md)
      written and accepted
- [x] The feature document updated: status, Phase Plan, open questions resolved
- [x] The initiative's status table updated
- [ ] `summary.md`
