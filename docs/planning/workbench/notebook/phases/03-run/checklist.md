---
kind: checklist
status: complete
feature: notebook
phase: 03-run
---

# Phase 03 — Run

**Branch:** `phase/notebook/03-run`, from `feat/notebook` · **Opened:** 2026-11-19 · **Feature:** [Notebook](../../notebook.feature.md)

**Goal.** A controller that runs cells on the engine host, with outputs for rows, JSON, facts and refusals, restart, and
a bound on what is rendered.

## Measurements

- [x] A very large answer through the sidecar: 50,000 rows in 0.7 s as one 2.3 MiB line. No host `limit` needed (ADR-012)

## Build

- [x] `cell-runner.ts` (pure): split with the host, run statements in order, stop at the first refusal, outputs as data
- [x] `notebook-sessions.ts`: one session per notebook, in memory; reopened if the host lost it; serial per notebook
- [x] `outputs.ts` (pure): tables as escaped Markdown and plain text, the count of rows not shown
- [x] `controller.ts`: a controller for each notebook type; outputs as built-in MIME items; the restart command and toolbar button
- [x] The setting `typedblite.notebook.maxRows`; the `vscode` fake's output classes

## Specs

- [x] The runner: order, headings, facts, documents, columns, the page limit, refusals and their titles, where a refusal is,
      cancellation, an unreachable host, and that the host is asked for nothing but splitting
- [x] The sessions: opened once, one per notebook, reopened and said so, restart, close, one thing at a time
- [x] Outputs: Markdown escaping (a pipe, a dollar, HTML, emphasis, a link, a newline), the count of rows not shown, each block as items
- [x] **Through the real host bundle, with no VS Code (11):** a later cell sees an earlier one's schema and data; several statements in a
      cell; stop at the first refusal with earlier statements committed; the refusal's place; no schema; restart empties the
      store; two notebooks, two stores; `fetch` as JSON; the host restarted under a notebook; a long answer cut with a count
- [x] **e2e (25 of 25):** Run All; outputs; a refusal on its cell and the next cell not started; the notebook not marked changed
      (a mutation dropping `transientOutputs` fails it); restart then a refusal
- [x] Mutations: no stop at a refusal, no reopen, no escaping, no count of rows cut: each fails a spec

## Checks

- [x] `npm run gate -- --quick`

## Outputs

- [x] `summary.md`; ADR-012 (Phase 03 section); the feature and initiative; the extension README
- [ ] Merged into `feat/notebook`
