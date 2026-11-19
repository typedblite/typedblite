---
kind: checklist
status: in-progress
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

- [ ] A plain interface with begin/end pairs: frame (statement, function, fetch), stage, block (one
      `combinations()` call), step, and value children (each `let` and comparison). Plain data only: no DAP
      (invariant 3)
- [ ] Attached through an `@internal` interpreter method, following `segmentFor`'s precedent; not on
      `TypeDBLiteOptions` (B5)
- [ ] Every hook point is one `undefined` check, and an optional call's arguments are not evaluated when off
      (invariant 2)

## Hook points (`interpreter.ts`, `expressions.ts`)

- [ ] Frames: each statement pipeline, `callFunction`, and `fetch` sub-queries (`rows` and `returned`)
- [ ] Stages: every stage of `runStages`, and `fetch` as a stage after the last
- [ ] `match` steps, each with every range it consumes (B6): `types`, relation early filters, `thing $x`, relation
      bindings, attribute instances, `has` reads, `let`s and comparisons (early and late), `or`, `try`, `is`, `not`
- [ ] Each comparison and `let`, counted inside `applyValueStatements` through an optional observer, without changing
      the evaluation order
- [ ] `QueryTrace` and its `note()` stages unchanged (its tests pass as they are)

## The recorder (`libs/runtime/src/recorder.ts`)

- [ ] Aggregates by key across calls: a block's steps across incoming rows (B7), a function's frame across calls to
      one call site
- [ ] Rows rendered as plain data; things described when recorded (type, iid, attributes), cached per iid and
      cleared around each write stage (B8). Describing never refuses
- [ ] Caps: rows per step, calls per call site (the by-call breakdown), and bytes per recording, each saying what it
      dropped (B10, invariant 5)
- [ ] A refusal is recorded with where it happened: the innermost open frame, stage and step

## The way in

- [ ] `@typedblite/runtime/debug`: a subpath export (package `exports`, `tsconfig.base.json` paths), pinned in
      `public-api.test.ts`, documented as internal and unstable; not in the TypeDoc reference (B5)
- [ ] `Session.debug(source)` in `@typedblite/session`, `@internal`: runs one statement with a recorder and returns
      its result and the recording

## Proof

- [ ] 🔴 The differential spec: hook on and hook off answer the same rows, documents, facts and refusals, in the
      same order, over a corpus of reads, writes, functions, fetch, `or`/`try`/`not` and refusals, with `planJoins`
      on and off
- [ ] 🔴 Conformance with the hook on: 1742 of 1756, the same as with it off, `baseline.json` untouched
- [ ] Recorder specs: aggregation, ranges per step, the caps, descriptions as at the step, a refusal's location
- [ ] The cost when off: the benchmark before and after, within the noise
- [ ] The size of a recording measured, and B10's numbers confirmed or changed
- [ ] The gate, from a clean tree

## Outputs

- [ ] `summary.md`
- [ ] The feature document: Phase Plan row, and anything deferred
- [ ] Merged into `feat/debugger`
