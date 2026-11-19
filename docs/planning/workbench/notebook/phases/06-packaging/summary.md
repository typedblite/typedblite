---
kind: summary
status: complete
feature: notebook
phase: 06-packaging
---

# Phase 06 — Packaging, the guide, and the docs: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/notebook/06-packaging` · **Checklist:** [checklist.md](checklist.md)

## Goal

A guide that runs as a notebook, the package checked, and the feature closed.

## What was built

- **`docs/guides/reading-list.tql.md`**, a guide that is a notebook: the TypeQLite half of the five-minute tour (a schema, inserts,
  queries, an update, and two refusals), in nine cells. It uses the tour's own statements, is linked from the tour and the docs
  index, and ends on a deliberate refusal.
- **The docs:** the extension's and the root changelog, `AGENTS.md` (the notebook's modules and how they are tested), the READMEs, the
  project overview and ADR-012 now describe the notebook.

## What was proven

- **The guide runs, and its answers are the tour's.** A spec reads the tour, checks the notebook's statements are the tour's own, runs
  every cell through the real engine host, and compares the rows with the tour's outputs. The two refusals are the ones the tour branches
  on (`typedblite.empty-match` and `typedblite.constraint-violated`). A change to a guide statement, and a change to a tour statement,
  each fail it.
- **e2e, 30 of 30:** the same guide, copied from the repository, run by Run All in the real VS Code against the installed `.vsix`.
- **The package:** 1.3 MB packed, with the host bundle (3.4 MB unpacked), both notebook types and 7 commands, and no test, source or map.

## Found while building

- **The tour cannot be a notebook whole.** Two thirds of it is shell and Node, and its program passes values with `given`, which a
  notebook has no way to supply. The notebook is the TypeQLite half with literal values, tied to the tour by a spec rather than copied.
- My first spec compared against the tour's whole output blocks, which also hold the lines for the other commands in the block; the
  spec now compares the lines it means.

## The feature

This closes the notebook: Phases 00 and 02 to 06 merged into `feat/notebook` (Phase 01 moved to the engine host). Its Definition of done is
ticked. **`feat/notebook` has not been merged into `main`.**

## What was not done

- **Windows and macOS:** only Linux was run.
- **A warning on closing a notebook with uncommitted changes** (no VS Code hook), and **interrupting a statement** (the engine is synchronous).
- **Notebooks on the website or in the playground,** and other languages in a cell: out of scope, as the feature said.
