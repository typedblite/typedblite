---
kind: summary
status: complete
feature: debugger
phase: 05-breakpoints-that-matter
---

# Phase 05 — Breakpoints that answer "where did my rows go?": Summary

**Closed:** 2026-11-19 · **Branch:** `phase/debugger/05-breakpoints-that-matter`, merged into `feat/debugger` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

The breakpoints the feature exists for: on row counts, where the rows run out, and where TypeQLite refused; and
moving back through what was recorded.

## What was built

- **`conditions.ts`:** `rowsIn`, `rowsOut` and `rows` compared with a number, joined with `&&` (tighter) and `||`.
  Read by a regular expression per comparison, never evaluated as code; a condition that cannot be read says how to
  write one.
- **Conditional breakpoints** stop at each stage or step on their line whose summed counts meet them. A statement's
  own stop has no counts, so a conditional breakpoint always waits for its statement, then holds if a stage or step is
  on its line.
- **Exception breakpoints**, offered at initialize:
  - *On refusal* (on by default). The stop is the deepest stop around the record that was open when the statement was
    refused (`Recording.refusal.at`, walked up through the records' parents), so a division by zero in a `let` stops
    at that `let`'s step, and exception info carries the `DiagnosticCode` (`typedblite.value-out-of-range`). A refusal
    found before anything ran has no record, and stops at the statement. Off, a refusal ends the program at once
    with exit code 1.
  - *When a step empties* (off by default). A stage or step that received rows and passed none on stops, unless a step
    inside it did the same: the stop is where the rows ran out, not the stage around it. Nothing after it fires, since
    rows that never arrive cannot run out. A refused statement's unfinished records are skipped: they passed nothing
    on because they never finished.
- **Step back and reverse continue** (`supportsStepBack`): back one stop, or to the last earlier stop where a breakpoint
  holds, or to the start. Moving forward again over statements already run walks their recordings; nothing runs twice.
  What is shown is what was true then (B8).
- **The adapter** holds the exception filters a client sets before the launch, as it holds breakpoints.

## Exit evidence

- `libs/debugger`: 75 specs (20 new). Conditions; a conditional breakpoint passing over line 1's steps (3 → 3) to stop
  at line 2's comparison (3 → 0); an unreadable condition; the emptying step, and nothing without the filter; a refusal
  at its `let`, with its code; the refusal filter off; step back, reverse continue, and forward again with one
  `session.debug` call in all. DAP: the capabilities; the emptying step set before the launch, with exception info; a
  conditional breakpoint, then step back and reverse continue.
- 🔴 **The real host** (`apps/vscode/test/debug-adapter.test.ts`): a `match` whose rows disappear at its third pattern,
  `$n > 1000` on its own line, stops there under *When a step empties*: `$n > 1000 · 2 → 0 row(s)`, line 4. The
  Definition of Done's e2e half is Phase 06's.
- The gate, from a clean tree: all 14 steps passed.

## For Phase 06

The editor: `apps/vscode` contributes the `typeqlite` debug type, launch snippets and breakpoints in TypeQLite files;
the adapter runs inline (B3) over the extension's `HostClient`; the e2e drives a session through
`vscode.debug.startDebugging` against the packaged `.vsix`.
