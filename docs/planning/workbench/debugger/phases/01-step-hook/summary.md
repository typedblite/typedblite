---
kind: summary
status: complete
feature: debugger
phase: 01-step-hook
---

# Phase 01 — The step hook, the recorder, and proof that it is harmless: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/debugger/01-step-hook`, merged into `feat/debugger` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

🔴 The only phase that touches the interpreter. A step hook, a recorder that turns its reports into a bounded
plain-JSON recording, and a way for a session to run one statement with it, proven to change no answer and to cost
nothing when off before anything uses it.

## What was built

- **`libs/runtime/src/step-hook.ts`:** the `StepHook` interface. Begin/end pairs for frames (statement, function,
  `fetch` sub-query), stages (and `fetch` as a stage after the last), blocks (one `combinations()` call), steps, and
  values (each `let` and comparison). Plain data; no DAP (invariant 3).
- **Hook points** in `interpreter.ts`: every stage of `runStages`; each statement pipeline, `callFunction` and both
  `fetch` sub-query paths as frames; and in `combinations()` (now a thin wrapper over `combine()`), a step for
  `types`, each relation filter pushed down, each thing variable, each relation binding, each attribute instance,
  each `has` read, the `let`s and comparisons that can run early and those that run late, `or`, `try`, each `is`
  and each `not`. `put` and the nested blocks say why they ran (`put`, `branch`, `try`, `not`). Each step carries
  every range it consumes: a thing step takes every top-level pattern headed by its variable and every literal on
  it, with any range inside another dropped (B6).
- **`expressions.ts`:** an optional `ValueStatementObserver` for `applyValueStatements`, told of each comparison as
  it is evaluated and each `let` with its rows in and out. A combination is charged to the first comparison it
  fails, because that is where evaluation stops; nothing is reordered.
- **`libs/runtime/src/recorder.ts`:** `StepRecorder`. Records are found by a key that is stable from call to call,
  so a block's steps are summed over its incoming rows with a breakdown by call (B7), and a function's frame over
  every call from one call site. A step first seen in a later call is placed after the step it followed there.
  Things are described when a row naming them is kept, **once per state**, in `Recording.things`, under a `ref`
  that changes after each write stage (B8). Caps per step, per call site, and in bytes, each saying what it
  dropped (B10). A refusal is placed at the innermost record open when it was thrown. Every report is guarded: a
  fault is counted, never thrown into the interpreter.
- **The way in (B5):** `@typedblite/runtime/debug` (package `exports`, `tsconfig.base.json` paths), pinned in
  `public-api.test.ts`, documented as internal and unstable, and not in the TypeDoc reference. The interpreter's
  `setStepHook` is `@internal`, following `segmentFor`'s precedent; `TypeDBLiteOptions` is unchanged.
  `Session.debug(source, limits?)` in `@typedblite/session`, also `@internal`, runs one statement as `run` does
  and returns `{ result, recording }`.
- **`TYPEDBLITE_STEP_HOOK=record`**, beside `TYPEDBLITE_TRACE` and `TYPEDBLITE_PLAN_JOINS`: every interpreter
  records every statement and throws the recording away (`SelfCheckingRecorder`), printing once on stderr if the
  recorder could not place a report. This is how a whole suite runs with the hook on.
- Describing a thing suspends the `QueryTrace`, so a trace counts the same with the hook on as off.
- The join-planning corpus moved to `test/fixtures/join-corpus.ts`, shared by its own differential test and the hook's.

## Exit evidence

- 🔴 **Differential spec** (`step-hook-differential.test.ts`): a corpus of 38 statements (every stage, every step
  kind, nested blocks, a function, `fetch` with a sub-query, `insert`/`put`/`delete`/`update`, three refusals)
  and the join corpus over eight random stores, each answered identically with a recorder attached and without,
  with `planJoins` on and off. Zero recorder faults. A non-vacuity check asserts the corpus reports all 11 step
  kinds, 5 block kinds, 12 stage kinds and 3 frame kinds. `QueryTrace` identical with the hook on.
- 🔴 **Conformance with the hook on:** `TYPEDBLITE_STEP_HOOK=record` gives a report byte-identical to the run
  without it: **1742 pass · 1 fail · 12 deviation · 1 n/a of 1756**. 2,781 statements were recorded (counted with
  a temporary probe in the built `out/`, then removed). `baseline.json` untouched.
- **The runtime's whole suite with the hook on:** 753 of 753 tests pass, with no fault printed.
- **Recorder specs** (`recorder.test.ts`, 17): execution order and every range, values counted with the dropped row
  charged, totals and breakdown over incoming rows, stage rows and scope, a thing described before and after its
  write, a function call site and `fetch` sub-queries as frames, nested blocks, a define, refusals at a step, inside
  a function, and before anything ran, all three caps, detaching, and faults counted and never thrown.
- **`Session.debug` specs** (5), in `libs/session`.
- **The gate**, from a clean tree: all 14 steps passed, the coverage floor and the VS Code e2e included.

## Measured

- **Cost with the hook off** (invariant 2), `bench` growth to 20,000 entities and relations at 200 and 1,000
  projects, from `src`: main's `interpreter.ts` and `expressions.ts` against this branch's, the branch run twice.
  The two branch runs differ from each other by more than either differs from main (the 1,000-project full edge
  scan: 272 ms on main, 319 ms and 283 ms on the branch; growth's reads were faster on the branch). Within this
  machine's noise. Each hook point is one `undefined` check, and an optional call evaluates no argument when off.
- **Cost and size with the hook on**, on the 1,000-project tracker (7,000 tasks): the full dependency-edge join
  (6,000 rows) 253 ms off and 271 ms recorded, 2.1 MB; every task then its log fields (14,000 rows) 214 and 259 ms,
  1.2 MB; every project (1,000 rows) 8 and 17 ms, 0.9 MB; an anchored join of 7 rows, 21 KB. Describing each thing
  once per state halved the sizes (the edge join was 5.1 MB before). The try-it notebook and the five-minute tour,
  run statement by statement through `Session.debug`: the largest recording 6.4 KB.
- **B10's numbers stand:** 1,000 rows per step, 50 calls per call site, 16 MB. The largest realistic recording is
  an eighth of the ceiling. Streaming a recording in parts is not needed (stays Deferred).

## For Phase 02

The engine host gains `session.debug` (B2): `Session.debug` behind an operation, refused on any session not at
`:memory:`, and not an MCP tool. **Found in this phase:** `splitStatements` strips comment lines and trims, so it
cannot say where a statement sits in its file, and recorded ranges are relative to the statement. Phase 02 adds a
positioned split to `@typedblite/session` that shares the splitting loop (invariant 6), behind a host operation,
since the extension does not import the session package. Then `libs/debugger`: launch, `schema` and `seed` files,
statement-level stepping, output, Run Without Debugging.
