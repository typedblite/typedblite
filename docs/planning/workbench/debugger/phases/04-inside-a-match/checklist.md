---
kind: checklist
status: complete
feature: debugger
phase: 04-inside-a-match
---

# Phase 04 — Inside a `match`

**Branch:** `phase/debugger/04-inside-a-match`, from `feat/debugger` · **Opened:** 2026-11-19 ·
**Feature:** [TypeQLite Debugger](../../debugger.feature.md) · **Governed by:**
[ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)

**Goal.** Step into a `match`, one execution step at a time (B6), with rows in and out summed over incoming rows and
the breakdown (B7); nested `or`, `try` and `not` blocks; a function call site or a `fetch` sub-query as a frame;
breakpoints on any line a step consumes.

## Process

- [x] Cut this branch from `feat/debugger` (`f616e3a`)

## Steps

- [x] A stop per step of a stage's `match`, one deeper than the stage, in the order the steps ran
- [x] Nested blocks' steps inside the step that ran them; a function's or a sub-query's stages inside the step or stage
      that called them, each one deeper
- [x] A step is on every line its ranges cover, and a breakpoint on any of them stops there (once per statement, at
      the first stop on the line)
- [x] The call stack: the step, the steps and stages around it, any function (at its call site) or sub-query, and the
      statement
- [x] A function defined in the schema: its frame shown at its call site, and everything inside it shown with no
      source and on no line of the program's file

## Variables at a step

- [x] Rows, paged; Step (its counts, and its incoming rows); Lets and comparisons (each one's rows in, kept and
      dropped); By incoming row (each call's in and out, paged, with what the cap left out)

## Found on the way

- [x] The shared splitter tore a `fetch` sub-query and a multi-pattern write apart. Fixed in `@typedblite/session`: no
      split inside brackets or strings, or before a `;` followed by `$` or `(`
- [~] It also tears a `with fun …` preamble from its pipeline. Not fixed: deferred (see the feature document)

## Proof

- [x] Specs: stops in execution order, breakpoints on a later-running line, step and value counts, the breakdown, a
      `not` block, a schema function, a `fetch` sub-query, `placedIn`; DAP specs for steps and an unplaced frame
- [x] A real-host DAP spec: a breakpoint on a comparison's line stops at the step that holds it, with what it dropped
- [x] Splitter specs
- [x] The gate, from a clean tree

## Outputs

- [x] `summary.md`
- [x] The feature document's Phase Plan row and Deferred entry
- [x] Merged into `feat/debugger`
