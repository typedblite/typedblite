---
kind: checklist
status: in-progress
feature: debugger
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the DAP mapping, and the ADR

**Branch:** `phase/debugger/00-scope-and-adr`, from `feat/debugger` · **Opened:** 2026-11-19 ·
**Feature:** [TypeQLite Debugger](../../debugger.feature.md)

**Goal.** Answer the feature's five open questions and the four gaps found on reading the interpreter again,
record the answers in an ADR, and leave Phase 01 nothing to decide except the cap's numbers. This phase writes no
code.

## Process

- [x] Cut `feat/debugger` from `main` (`4fa6d8d`), and this branch from it

## Measurements

- [x] What already exists, checked on disk. The document's table was written before the engine host: the stage
      loop, `combinations()` and its `note()` points, `QueryTrace`, `planJoins`, `typeOfThing` and
      `readAttributes`, the host's operations, `HostClient`, and the classifier, now in `@typedblite/session`
- [x] **Gap 1:** a `match` runs by kind, not in source order, and a thing step merges every pattern on its
      variable. `ThingConstraint.range` holds only the first pattern's range
- [x] **Gap 2:** no hook point exists for attribute reads, `let`s, comparisons, or `is`.
      `applyValueStatements` stops at the first failing comparison, so a dropped combination can be charged to it
      without reordering anything
- [x] **Gap 3:** `combinations()` runs once per incoming row; a `fetch` sub-query runs once per parent answer
- [x] **Gap 4:** a thing's type and attributes are read when asked, so replay would show the store after the
      statement, not as it was at the stop
- [x] `node:sqlite` on Node 24.19: `backup`, `serialize` and `deserialize` are present. `serialize` and
      `deserialize` landed in Node in April 2026, so they are absent at the 22.16 minimum
- [~] `backup()` on Node 22.16 itself: **not verified**. Not needed, because B9 defers copying a store
- [x] DAP libraries: `@vscode/debugadapter`, `@vscode/debugprotocol` and `@vscode/debugadapter-testsupport` at
      1.68.0, MIT
- [x] Upstream code to diff against: none. TypeDB has no step debugger; its debugging guide is manual
- [~] The size of a recording, and so the cap's numbers: **not measured**, because there is no recorder yet.
      Handed to Phase 01 (ADR-014 B10 gives provisional numbers)

## Decisions

Recommended in ADR-014, all accepted by the founder as written, 2026-11-19:

- [x] B1 record, then replay, one statement at a time
- [x] B2 the recording is made on the engine host by `session.debug`, refused on any session not at `:memory:`
- [x] B3 the adapter runs inline in the extension host
- [x] B4 the adapter lives in `libs/debugger`, with no dependency on the runtime
- [x] B5 the hook is exported from `@typedblite/runtime/debug` only, as internal
- [x] B6 a `match` step is an execution step, carrying every range it consumes; new hook points for attribute
      reads, `let`s, comparisons and `is`
- [x] B7 steps that repeat per incoming row are shown once, with totals
- [x] B8 a thing is described when it is recorded
- [x] B9 data gets in through `schema` and `seed` files the launch names; no implicit workspace schema; copying a
      store deferred
- [x] B10 the recording is bounded per step, per call site and in bytes; numbers set in Phase 01
- [x] B11 the DAP mapping and the library versions

## Outputs

- [x] [ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)
      written
- [x] ADR-014 accepted as written (founder, 2026-11-19)
- [x] The feature document updated: status, the governing ADR's number, what exists, the four gaps, the open
      questions pointed at ADR-014
- [ ] The feature document updated **after acceptance**: the mapping table, Goals 5 and invariant 4 (B9), the
      Phase Plan intent for phases 01–05 (B6, B7, B8), and the Deferred section (copying a store into memory)
- [x] The initiative's status table
- [ ] The root README's ADR table, **after acceptance**. It stops at ADR-010 today, so ADR-011, 012 and 013 go
      in with it
- [ ] `summary.md`
- [ ] Merged into `feat/debugger`, and the Phase Plan row reads `Complete` with a link to the summary
