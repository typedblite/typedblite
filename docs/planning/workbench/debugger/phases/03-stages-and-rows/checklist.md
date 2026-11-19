---
kind: checklist
status: complete
feature: debugger
phase: 03-stages-and-rows
---

# Phase 03 — Stages and rows

**Branch:** `phase/debugger/03-stages-and-rows`, from `feat/debugger` · **Opened:** 2026-11-19 ·
**Feature:** [TypeQLite Debugger](../../debugger.feature.md) · **Governed by:**
[ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)

**Goal.** Stops at stage boundaries, from the recording. The Rows variables, paged, with each thing as it was at the
stage (B8). The Scope variables. Line breakpoints on statements and stages.

## Process

- [x] Cut this branch from `feat/debugger` (`ff29213`)

## Stages

- [x] A statement's recording becomes a stop per stage of each of its pipelines (depth 1), spliced in after the
      statement's own stop when it runs
- [x] The call stack at a stage: the stage (`match · 1 → 3 row(s)`, at the stage's own line), then its statement
- [x] Ranges the engine reports for a statement are placed in the file through `statement.locate`'s positions

## Variables

- [x] Rows: the rows a stage passed on, paged through DAP's indexed variables; a row opens to its bindings, a thing to
      its type, iid and attributes from `Recording.things`; the rows the cap left out on a line of their own
- [x] Stage: rows in, rows out, whether it writes
- [x] Scope: each variable's kind, value type, and whether it may be empty
- [x] A statement's own frame: its status and text

## Line breakpoints

- [x] On a statement's first line: verified at once
- [x] On another line of a statement: unverified ("Checked when its statement runs") until that statement runs, then
      settled and reported with a `breakpoint` event
- [x] On a line in no statement, or in another file: never verified, saying why
- [x] Set before the launch has located the program: answered once it has
- [x] Continue, over, in and out each stop at a breakpoint they pass; the first stop of a launch is checked too
- [x] A line breakpoint stops once in a statement, at its first stop on that line

## Proof

- [x] Specs: values, records, stages, scopes, breakpoints (pure and over DAP)
- [x] A real-host DAP spec: a breakpoint on a stage's line, and that stage's rows
- [x] The gate, from a clean tree

## Outputs

- [x] `summary.md`
- [x] The feature document's Phase Plan row
- [x] Merged into `feat/debugger`
