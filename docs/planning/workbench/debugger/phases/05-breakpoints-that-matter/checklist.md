---
kind: checklist
status: complete
feature: debugger
phase: 05-breakpoints-that-matter
---

# Phase 05 — Breakpoints that answer "where did my rows go?"

**Branch:** `phase/debugger/05-breakpoints-that-matter`, from `feat/debugger` · **Opened:** 2026-11-19 ·
**Feature:** [TypeQLite Debugger](../../debugger.feature.md) · **Governed by:**
[ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)

**Goal.** Conditional breakpoints on `rowsIn` and `rowsOut`; exception breakpoints for a step that empties and for a
refusal, carrying its code; step back and reverse continue across every statement recorded (B1, B11).

## Process

- [x] Cut this branch from `feat/debugger` (`c9de54a`)

## Conditional breakpoints

- [x] A condition language read by a small parser, never `eval`: `rowsIn`, `rowsOut` and `rows` (`rowsOut`), compared
      with a number, joined with `&&` and `||`
- [x] A conditional breakpoint stops at each stage or step on its line whose counts meet it; it waits for its
      statement; a condition that cannot be read never holds, and says how to write one

## Exception breakpoints

- [x] Two filters, offered at initialize: *On refusal* (on by default) and *When a step empties* (off)
- [x] On refusal: stops at the deepest stop around the record that was open when the statement was refused; its
      `DiagnosticCode` in exception info. Off: a refusal ends the program at once, with exit code 1
- [x] When a step empties: stops at the stage or step that received rows and passed none on, inside which no step did
      the same; not in a refused statement's unfinished records
- [x] Filters set before the launch apply to it

## Stepping back

- [x] Step back: the previous stop. Reverse continue: the last earlier stop where a breakpoint holds, or the start
- [x] Forward again over what has run reads the recording; nothing runs twice

## Proof

- [x] Condition specs; program specs for each kind; DAP specs (capabilities, an emptying step set before the launch
      with exception info, a conditional breakpoint then step back and reverse continue)
- [x] 🔴 The Definition of Done's adapter half, through the real host: a query whose rows disappear at the third
      pattern of its `match` stops there under "when a step empties"
- [x] The gate, from a clean tree

## Outputs

- [x] `summary.md`
- [x] The feature document's Phase Plan row
- [x] Merged into `feat/debugger`
