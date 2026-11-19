---
kind: summary
status: complete
feature: debugger
phase: 04-inside-a-match
---

# Phase 04 — Inside a `match`: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/debugger/04-inside-a-match`, merged into `feat/debugger` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Step through a `match` one execution step at a time, with every line a step consumes breakable, and every kind of
nested frame placed in the call stack.

## What was built

- **`stopsOf`** walks the whole recording in pre-order: each stage; each step of its `match`, in the order they ran;
  inside a step, its blocks' steps (an `or`'s branches, a `try`, a `not`) and the stages of the functions it called;
  inside a stage, its sub-queries. Each level is one deeper, so over, in and out work at every level.
- **Lines (B6):** a step is on every line its ranges cover. A breakpoint on a later line that runs first stops first:
  in `match $p has age $a; $a > 20; $p isa person;` written over three lines, `$p`'s step consumes the first and third
  and runs before the comparison on the second.
- **The call stack:** the step, the steps and stages around it, any function (shown at its call site, `names() · 3
  call(s)`) or sub-query (`fetch · 3 call(s)`), and the statement. A frame's name carries its rows in and out.
- **`placedIn`:** a function defined in the schema reports ranges in the text that defined it, not the program's.
  Its frame is shown at its call site, and everything inside it with no source and on no line, so nothing lands on a
  wrong line and no breakpoint stops in it. A function the statement defines itself is placed as any record is.
- **Variables at a step:** Rows (paged), Step (rows in and out summed over every incoming row, and how many incoming
  rows), Lets and comparisons (`$a < 40 · 3 → 2 kept, 1 dropped here`), By incoming row (each call's `in → out`,
  paged; B7).
- **`@typedblite/session`'s splitter** no longer splits inside brackets or strings, skips an end-of-line comment, and
  does not end a statement before a `;` followed by `$` or `(` (no statement begins with either). Found by this
  phase's specs: it tore a `fetch` sub-query (`[ match …; fetch { … }; ]`) and a multi-pattern write
  (`insert $a …; $b …;`) apart, for the CLI's `--file`, the notebook and the debugger alike.

## Exit evidence

- `libs/debugger`: 55 specs (12 new): stepping in execution order, breakpoints on a later-running line, scopes at a
  step, a `not` block's steps three deep and out of it, a schema function's unplaced frames, a sub-query as a frame,
  `placedIn`, and two DAP specs (steps over DAP; an unplaced frame `subtle`, with no source).
- `apps/vscode/test/debug-adapter.test.ts`, the real host: a breakpoint on a comparison's own line stops at the step
  that holds it, `$n > 100 · 2 → 1 row(s)`, whose Lets and comparisons read `2 → 1 kept, 1 dropped here`.
- `@typedblite/session`: three splitter specs (a sub-query and a block kept whole; a multi-pattern write; a `;` in a
  string and in an end-of-line comment); its existing specs unchanged.
- The gate, from a clean tree: all 14 steps passed, the five-minute tour, the notebook guides and the clean-room install included, with the splitter changed.

## Deferred

- **A `with fun …` preamble is still torn from its pipeline** by the splitter: a statement that begins with `with`
  ends at its first `;`. Fixing it means teaching the splitter where a preamble ends (after its `return`), which is a
  grammar decision for the session package, not this feature. Until then, a function to debug is defined in a schema
  file, which works (its frames are shown at the call site).

## For Phase 05

Conditional breakpoints on `rowsIn` and `rowsOut`; exception breakpoints for a step that empties and for a refusal,
carrying its code; step back and reverse continue across every statement recorded (B1).
