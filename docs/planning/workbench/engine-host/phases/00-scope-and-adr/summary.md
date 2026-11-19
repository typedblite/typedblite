---
kind: summary
status: complete
feature: engine-host
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the NestJS and launch decisions, and the ADR: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/engine-host/00-scope-and-adr`, merged into
`feat/engine-host` · **Checklist:** [checklist.md](checklist.md)

## Goal

Answer the feature's nine open questions, record them in an ADR, and leave Phase 01 nothing to
decide.

## What was built

No code, as planned.

- [ADR-011](../../../../../architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md),
  accepted. D1 to D9 answer the nine questions. D10 (added after review) builds the host on
  `@devx-micro/app-*`.
- The feature document and the initiative's status table, updated to match.

## What was measured

- Two `node:sqlite` connections on one file: a second writer gets `database is locked` while a
  transaction is open, and readers see committed rows only. So SQLite can arbitrate two sessions.
- `node:sqlite` works in the Node 24.22 that the VS Code remote server ships here.
- All seven `@devx-micro/app-*` packages are on the local registry at 0.2.1. None is on npmjs.org.

## What was not verified, and where it went

- `node:sqlite` in the **desktop Electron's Node**. Electron-as-Node is a fallback only until
  Phase 05 checks it.
- The lock behaviour **through `SqliteEngine`**, which may set its own pragmas. Phase 01 checks it.

## Left open

- Where MCP lives (the host, or a new `app-mcp` in devx-micro). Decided at Phase 04.
- Publishing the devx-micro packages to npmjs.org, which a public `npm ci` of this repository needs.
  Both are on the feature's Deferred list.

## For Phase 01

The app skeleton in `apps/engine-host`, the session aggregate and its handlers, and the classifier
moved out of the CLI, with the CLI's specs unchanged. Install NestJS and the devx-micro packages,
then check the lockfile for `localhost` entries.
