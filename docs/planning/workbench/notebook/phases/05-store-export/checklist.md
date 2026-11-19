---
kind: checklist
status: complete
feature: notebook
phase: 05-store-export
---

# Phase 05 — Store choice and export

**Branch:** `phase/notebook/05-store-export`, from `feat/notebook` · **Opened:** 2026-11-19 · **Feature:** [Notebook](../../notebook.feature.md)

**Goal.** A notebook runs in memory until the user chooses a file, in a mode the user picks, shown and never saved; and it exports
to a script and to Markdown (ADR-012 N5; feature goals 5 and 6, invariant 3).

## Build

- [x] `NotebookSessions`: a store choice per notebook (a file and a mode), `useStore`, `commit`, `rollback`, a change event; manual
      mode holds a transaction, restart and a reopened host keep the mode
- [x] `store-commands.ts`: "Choose the Notebook's Store…" (a dialog, or an explicit argument), Commit and Rollback, the status bar,
      the context key that shows Commit and Rollback only while changes are held
- [x] `export.ts` (pure) and two export commands
- [x] The manifest: five commands, their palette and toolbar rules

## Specs

- [x] **The store through the real host, with no VS Code (17):** a file in auto mode keeps what a cell writes; in manual mode another
      reader sees nothing until Commit; the next changes are held again; Rollback discards; closing makes nothing permanent; restart
      drops what was held and holds again; a refused commit is rolled back and the notebook goes on; the host restarted under a
      manual notebook; a path that will not open keeps the old store; the same file; back to memory; the change event
- [x] **Export (13):** the script, the Markdown, the guides' spelling, line endings, a closing-fence line, no outputs
- [x] The manifest: Commit and Rollback only while changes are held; the others for notebooks
- [x] **e2e (29 of 29):** a file store chosen explicitly in manual mode; another connection sees nothing until Commit; the path is
      never in the notebook and the notebook is not dirty; both exports (a mutation making "manual" commit each statement fails it)
- [x] Mutations: manual opens no transaction; Commit does not hold the next one; restart forgets the mode; a bad path closes the old
      session first: each fails a spec

## Checks

- [x] `npm run gate -- --quick`

## Outputs

- [x] `summary.md`; ADR-012 (Phase 05); the changelog; the feature, initiative and extension README
- [ ] Merged into `feat/notebook`
