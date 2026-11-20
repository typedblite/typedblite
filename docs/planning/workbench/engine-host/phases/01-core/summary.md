---
kind: summary
status: complete
feature: engine-host
phase: 01-core
---

# Phase 01 — The core: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/engine-host/01-core` · **Checklist:** [checklist.md](checklist.md)

## Goal

The session aggregate, its commands and queries, and the shared classifier, proven with no transport.

## What was built

- **`@typedblite/session`** (`libs/session`), a new **published**, NestJS-free package: `Session`,
  `classifyStatement`, `splitStatements`. The founder chose a new package over a runtime export or a private
  core, because the CLI is published (ADR-011 D3, amended).
- **`apps/engine-host`** (private): `EngineHostModule`, the `SessionRegistry`, seven commands and five queries
  with handlers, and `HostError` (a `code` and an `exitCode`). No transport and no binary yet.
- **The CLI** runs through `Session`; `session.ts` is now a thin adapter, and its specs are unchanged.
- Five published packages: `nx.json`, `tools/publishable.mjs`, the tour, `typedoc.json`, the docs.

## Decisions made while building

- **A manual transaction is the interpreter's own** (`BEGIN IMMEDIATE`, savepoints per statement). Auto mode is
  the engine's default. `mode` is `manual` while a transaction is open.
- **`restart` keeps a file.** The feature document said "drops the store". A `:memory:` store comes back
  empty; a file comes back as last committed, because the data is the file. A wipe, if wanted, is a new option.
- **A closed session stays listed**, so a run on it is refused as `closed` and not reported as an unknown id.
- **Handlers are all `async`**: an unknown id is a rejection, never a synchronous throw. A spec found this.

## What was found

- **A session opened before another's `define` does not see that schema** until it restarts. The interpreter
  loads a file's schema at open. Pinned by a spec, recorded in ADR-011, and left to the engine.
- **Lock behavior through the engine** matches the Phase 00 measurement: the second writer waits for
  `busyTimeoutMs` and is refused as `locked`; its reads see committed rows.
- **A defect moved unchanged, and left for its own change:** the classifier only recognizes a leading
  `define`, so `undefine` and `redefine` take the read path and are refused with a parse error, in the CLI as
  they always were. The interpreter's `define()` accepts `undefine b;` and `undefine owns n from a;` (checked),
  so a user cannot run them from the CLI, the REPL or the host. `redefine entity a;` is refused by `define()`
  itself, so the form that works is unchecked. Fixing it changes the CLI's behavior (invariant 3), so it is a
  decision, not part of the move.

## What was not done

- The WASM, browser, e2e and clean-room gate steps were not run. The clean room packs a fifth package now.
- `package-lock.json`: all 17 `localhost` URLs, integrity checked against registry.npmjs.org, rewritten. Two
  of them (`@fontsource`) were already in `main`.
- The packages are not on npmjs.org (`@typedblite/session` joins the list the maintainer must publish).

## For Phase 02

Compose the operations on `@devx-micro/app-*`: descriptors with input schemas, `defineApp`, the CLI, REPL and
sidecar entry points, the refused unknown flag, and the parity spec. `session.run` over the CLI takes a
location directly (open, run, close in one call).
