---
kind: checklist
status: complete
feature: debugger
phase: 01-step-hook
---

# Phase 01 — The step hook, the recorder, and proof that it is harmless

**Branch:** `phase/debugger/01-step-hook`, from `feat/debugger` · **Opened:** 2026-11-19 ·
**Feature:** [TypeQLite Debugger](../../debugger.feature.md) · **Governed by:**
[ADR-014](../../../../../architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)

**Goal.** 🔴 The only phase that touches the interpreter. Add a step hook that reports frames, stages and `match`
steps; a recorder that turns those reports into a bounded, plain-JSON recording; and a way for a session to run one
statement with it. Prove that the hook changes no answer (invariant 1) and costs nothing when off (invariant 2)
before anything uses it.

## Process

- [x] Cut this branch from `feat/debugger` (`5001041`)

## The hook (`libs/runtime/src/step-hook.ts`)

- [x] A plain interface with begin/end pairs: frame (statement, function, fetch), stage, block (one
      `combinations()` call), step, and value children (each `let` and comparison). Plain data only: no DAP
      (invariant 3)
- [x] Attached through an `@internal` interpreter method, following `segmentFor`'s precedent; not on
      `TypeDBLiteOptions` (B5)
- [x] Every hook point is one `undefined` check, and an optional call's arguments are not evaluated when off
      (invariant 2)

## Hook points (`interpreter.ts`, `expressions.ts`)

- [x] Frames: each statement pipeline, `callFunction`, and `fetch` sub-queries (`rows` and `returned`)
- [x] Stages: every stage of `runStages`, and `fetch` as a stage after the last
- [x] `match` steps, each with every range it consumes (B6): `types`, relation early filters, `thing $x`, relation
      bindings, attribute instances, `has` reads, `let`s and comparisons (early and late), `or`, `try`, `is`, `not`
- [x] Each comparison and `let`, counted inside `applyValueStatements` through an optional observer, without changing
      the evaluation order
- [x] `QueryTrace` and its `note()` stages unchanged (its tests pass as they are)

## The recorder (`libs/runtime/src/recorder.ts`)

- [x] Aggregates by key across calls: a block's steps across incoming rows (B7), a function's frame across calls to
      one call site
- [x] Rows rendered as plain data; things described when recorded (type, iid, attributes), cached per iid and
      cleared around each write stage (B8). Describing never refuses
- [x] Caps: rows per step, calls per call site (the by-call breakdown), and bytes per recording, each saying what it
      dropped (B10, invariant 5)
- [x] A refusal is recorded with where it happened: the innermost open frame, stage and step

## The way in

- [x] `@typedblite/runtime/debug`: a subpath export (package `exports`, `tsconfig.base.json` paths), pinned in
      `public-api.test.ts`, documented as internal and unstable; not in the TypeDoc reference (B5)
- [x] `Session.debug(source)` in `@typedblite/session`, `@internal`: runs one statement with a recorder and returns
      its result and the recording

## Proof

- [x] 🔴 The differential spec: hook on and hook off answer the same rows, documents, facts and refusals, in the
      same order, over a corpus of reads, writes, functions, fetch, `or`/`try`/`not` and refusals, with `planJoins`
      on and off
- [x] 🔴 Conformance with the hook on: 1742 of 1756, the same as with it off, `baseline.json` untouched
- [x] Recorder specs: aggregation, ranges per step, the caps, descriptions as at the step, a refusal's location
- [x] The cost when off: the benchmark before and after, within the noise
- [x] The size of a recording measured, and B10's numbers confirmed (and each thing now described once per state)
- [x] The gate, from a clean tree

## Outputs

- [x] `summary.md`
- [x] The feature document: Phase Plan row, and anything deferred
- [x] Merged into `feat/debugger`
