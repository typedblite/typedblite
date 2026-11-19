---
kind: summary
status: complete
feature: debugger
phase: 03-stages-and-rows
---

# Phase 03 — Stages and rows: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/debugger/03-stages-and-rows`, merged into `feat/debugger` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Stops at stage boundaries from the recording, the rows and scope at each, and line breakpoints.

## What was built

- **`records.ts`:** a recording indexed by id with each record's parent; a statement's ranges placed in its file
  (`inFile`); a stop per stage of each pipeline (`stopsOf`).
- **`values.ts`:** the Variables view as a pure tree. A thing reads `person 0x1e…` and opens to its type, iid and
  attributes as they were at the stage (several values of one attribute type numbered); an attribute `name "Ann"`; a
  value as written; an empty variable says a `try` did not match. A row reads `{ $p: …, $n: … }`. A row set reads
  `3 row(s)`, is paged, and ends with a line for the rows not recorded, saying why (the per-step cap, or the size
  limit).
- **`DebugProgram`:** stage stops spliced in when a statement runs; `frames()` (the stage, then its statement);
  `scopes()` (Rows, Stage, Scope at a stage; Statement at a statement); breakpoints: `setBreakpoints`, `start()` for a
  launch that does not stop on entry, every move stopping at a breakpoint it passes, and `breakpointChanged` when a
  waiting breakpoint is settled.
- **The adapter:** `setBreakPoints` (held until the launch has located the program, then answered with `breakpoint`
  events), stack frames from `frames()`, scopes and paged variables from the tree.

## Decided here

- **A line breakpoint stops once in a statement, at its first stop on that line.** A statement and its first stage
  nearly always start on the same line, so without this a breakpoint on `match` would stop before the statement runs
  and again at its first stage. It stops before; step in reaches the stage.
- **A stage is breakable on its first line only.** A breakpoint inside a `match`'s body is the next phase's: it stops
  at the step that consumes that line (B6). Until then it is settled as not holding, and says so.
- **Breakpoints other than on a statement's first line are known only when the statement runs**, because a stage's
  position is in its recording. They wait unverified, and the client is told when they settle.

## Exit evidence

- `libs/debugger`: 43 specs, 18 new in this phase (values, records, stages, scopes, breakpoints) and 3 new DAP specs
  (stack and paged rows after step in; breakpoints set before the launch, answered after it, and a stage's line
  stopping continue; a breakpoint in another file).
- `apps/vscode/test/debug-adapter.test.ts`: a breakpoint on a `select` on its own line stops there through the real
  host, and the stage's row reads `{ $t: title "Dune" }`.
- **Found by a spec:** a settled breakpoint kept the "Checked when its statement runs" message it waited with, so the
  change was never reported. `check()` now builds a breakpoint's state afresh.
- **Found running the extension's specs:** they load `@typedblite/debugger` from its built `out/`, so a stale build
  answered for the new adapter. Nx's `test` target builds first, so the gate is not affected; run the build before
  running those specs by hand.
- The gate, from a clean tree.

## For Phase 04

Inside a `match`: a stop per step (depth 2), in execution order, at every line it consumes (B6); rows in and out summed
over incoming rows with the breakdown (B7); nested `or`, `try` and `not` blocks; a function call site or a `fetch`
sub-query as a frame of its own; breakpoints on any line a step consumes.
