---
kind: summary
status: complete
feature: debugger
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the DAP mapping, and the ADR: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/debugger/00-scope-and-adr`, merged into `feat/debugger` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Answer the feature's five open questions, record the answers in an ADR, and leave Phase 01 nothing to decide
except the cap's numbers.

## What was built

No code, as planned.

- [ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md),
  accepted as written by the founder on 2026-11-19 (B1–B11). The feature document named ADR-009, which the WASM
  decision had taken.
- The [feature document](../../debugger.feature.md): status, what exists, the four gaps, the mapping table,
  invariant 4, Goal 5, a Definition of Done item, the Phase Intent for 01–05, and three Deferred entries.
- The initiative's status table, whose engine-host and notebook rows were also stale (both merged, #52 and #59).
- The root README's ADR table, which stopped at ADR-010: ADR-011 to ADR-014 added.

## What was measured

- **The plan's "what exists" table was stale.** The classifier invariant 6 waited for is in `@typedblite/session`;
  the engine host exists; Electron's Node has `node:sqlite`.
- **Four gaps the plan missed**, all in `combinations()`:
  1. a `match` runs by kind, not in source order, and one thing step merges every pattern on its variable;
  2. attribute reads, `let`s, comparisons and `is` have no `note()`;
  3. a `match` runs once per incoming row, and a `fetch` sub-query once per parent answer;
  4. a thing's type and attributes are read when asked, so replay would show them as they are after the statement.
- **Comparisons can be counted one at a time without reordering.** `applyValueStatements` evaluates them per
  combination and stops at the first that fails, so a dropped combination is charged to that comparison.
- **`node:sqlite`:** `serialize` and `deserialize` reached Node in April 2026, absent at the 22.16 minimum.
- **DAP libraries** at 1.68.0, MIT. **No upstream debugger** to diff against: TypeDB's own guide is manual.

## What was not measured

- **The size of a recording**, and so the cap's numbers. There is no recorder yet. Phase 01 measures them; B10
  gives provisional numbers (1,000 rows per step, 50 calls per call site, 16 MB per statement).
- `backup()` on Node 22.16 itself. Not needed: copying a store is deferred.

## For Phase 01

🔴 The only phase that touches the interpreter. A `StepHook` interface exported from `@typedblite/runtime/debug`
only. Hook points at stage boundaries, at every existing `note()`, and at the new ones (attribute reads, `let`s,
each comparison, `is`), each step carrying every range it consumes; frames around `callFunction` and `fetch`
sub-queries. A recorder with totals per step, things described when recorded, and the caps. A way in
`@typedblite/session` to run one statement with the recorder. Exit: the differential spec (hook on and off, with
`planJoins` on and off), conformance with the hook on at 1742 of 1756, and the performance suites unchanged with
it off.
