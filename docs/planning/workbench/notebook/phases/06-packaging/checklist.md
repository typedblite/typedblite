---
kind: checklist
status: complete
feature: notebook
phase: 06-packaging
---

# Phase 06 — Packaging, the guide, and the docs

**Branch:** `phase/notebook/06-packaging`, from `feat/notebook` · **Opened:** 2026-11-19 · **Feature:** [Notebook](../../notebook.feature.md)

**Goal.** A guide that runs as a notebook, the package checked, and the feature's docs and Definition of done closed.

## Build

- [x] `docs/guides/reading-list.tql.md`: the TypeQLite half of the five-minute tour as a notebook, linked from the tour and the docs index
- [x] The e2e copies the repository's own guide into its workspace, so the case cannot drift from it
- [x] The extension's changelog, the root changelog, `AGENTS.md`, the READMEs, the project overview, ADR-012

## Specs

- [x] **The guide through the real host, with no VS Code (4):** nine cells; its statements are the tour's own; every cell answers and
      the last is the deliberate refusal; the answers equal the tour's outputs; the empty-match fact and the constraint violation are the
      ones the tour branches on (a mutation in the guide, and one in the tour, each fail it)
- [x] **e2e (30 of 30):** the guide opens as a notebook, Run All runs eight cells to success, the last is refused with the engine's
      message, and the list shows the tour's answer
- [x] The package: 1.3 MB packed, the host bundle and both notebook types inside, no test, source or map

## Checks

- [x] `npm run gate`, in full (website, clean-room and tour included)
- [x] The conformance suite is unchanged (the runtime and the conformance suite have no diff against `main`)

## Outputs

- [x] `summary.md`; the feature's Definition of done ticked; the initiative
- [ ] Merged into `feat/notebook`
