---
kind: summary
status: complete
feature: notebook
phase: 05-store-export
---

# Phase 05 — Store choice and export: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/notebook/05-store-export` · **Checklist:** [checklist.md](checklist.md)

## Goal

Let a notebook run on a file the user chose, in a mode the user picked, and export it.

## What was built

- **A store chosen, never assumed** (invariant 3): in memory until the user picks "Choose the Notebook's Store…" (open a file, create
  one, or back to memory), and a **mode** the user must pick, the safer first: **hold changes until I commit** (a transaction is held
  open; Commit and Rollback appear on the toolbar only then) or **commit each statement**. The status bar shows the file and the mode.
- **Never saved, never remembered:** the choice is not written into the notebook and not kept between sessions, so a shared notebook
  runs in the reader's memory. Saving a notebook never touches a store.
- **Export:** a `.tql` script of the code cells, and Markdown with every code cell as a fenced `typeql` block, of the notebook as the
  editor holds it, neither with outputs.

## What was proven

- **Through the real host, no VS Code (17 cases):** in manual mode another connection to the file sees nothing, not even the schema,
  until Commit; Commit holds the next transaction; Rollback discards; closing a notebook makes nothing permanent; a refused commit is
  rolled back and says why; the host restarted under a manual notebook opens the file in the same mode.
- **e2e, 29 of 29:** the above in the real VS Code, the path absent from the notebook file, the notebook not dirty, both exports.
- 13 export specs; four mutations on the store and one on the e2e each fail a spec.

## Found while building

- **My first `useStore` closed the old session before opening the new one,** so a mistyped path left the notebook with its store choice
  but none of its state. A spec ("a file that will not open ... keeps the store it had") caught it. The new session is now opened first,
  except for the same file, whose old manual session may hold the write lock.
- **The kernel's description ("In-memory store") was static,** which would have been wrong once a file was chosen. It now says what is
  always true, and the status bar says which store.

## What was not done

- **A warning on closing a notebook that holds uncommitted changes.** VS Code has no hook to stop a notebook closing, so they are
  rolled back; the status bar and the README say so.
- **Remembering a store per notebook,** by design (ADR-012 N5).
- **Remote windows and non-Linux hosts:** the file dialog and the paths were only run on Linux.

## For Phase 06

Packaging and the guide: the e2e is in place (29 cases), so what remains is the five-minute tour (or a guide) as a runnable notebook whose
answers a spec checks, and the docs: `AGENTS.md`, the README, the project overview, and closing the feature's Definition of done.
