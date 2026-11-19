---
kind: checklist
status: complete
feature: notebook
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the file format, and the ADR

**Branch:** `phase/notebook/00-scope-and-adr`, from `feat/notebook` · **Opened:** 2026-11-19 ·
**Feature:** [Notebook](../../notebook.feature.md)

**Goal.** Answer the feature's six open questions, record them in an ADR, and leave Phase 02 nothing to decide.
This phase writes no code.

## Process

- [x] Cut `feat/notebook` from `main`, and this branch from it

## Measurements

- [x] What already exists, checked on disk (the document's table was written before the engine host): the host,
      `statement.split`, `session.restart`, `HostClient`, the shared classifier
- [x] `node:sqlite` in the desktop Electron's Node: present (measured in the engine-host feature, VS Code 1.146)
- [x] **Spike: the real language server with notebook cells.** Advertising `notebookDocumentSync` and listening is
      enough; a label defined in cell 1 resolves in cell 2 and go-to-definition crosses cells. A second notebook
      resolved the first notebook's label: the scope is the whole workspace index. (Spike files removed; the
      numbers are in ADR-012)
- [~] The cost of a very large answer through the sidecar: **not measured**. Handed to Phase 03

## Decisions

- [x] N1 meaning, N2 file format, N3 kernel, N4 cross-cell services, N5 default store, N6 statements per cell (all
      accepted by the founder, 2026-11-19)

## Outputs

- [x] [ADR-012](../../../../../architecture/adr-012-the-notebook-is-a-markdown-file-run-on-the-engine-host.md) written and accepted
- [x] The feature document updated: status, what exists, open questions answered, Phase Plan, Deferred
- [x] The initiative's status table
- [x] `summary.md`
- [ ] Merged into `feat/notebook`
