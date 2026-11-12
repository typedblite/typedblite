---
kind: summary
status: complete
feature: editor
phase: 06-code-actions-rename
---

# Phase 06 — Code actions and rename: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/06-code-actions-rename`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Quick fixes where the fix is mechanical and the code identifies it, and a rename that is safe across
the whole workspace.

## What was built

[`typeqlite-edits.ts`](../../../../../libs/language/src/typeqlite-edits.ts):

- **`TypeQLiteRenameProvider`** renames a type or a role from its declaration, a cross-reference, or
  a label. It edits every cross-reference **and** every label use, so `isa person`, `(employee: $p)`,
  re-opens and `undefine` targets are renamed with the schema. It refuses a new name that the
  grammar's own `ID` terminal does not match, or that is a reserved keyword. The terminal's regex is
  read from the grammar, not restated.
- **`TypeQLiteCodeActionProvider`**:
  - `annotation-not-admitted`: remove the annotation (preferred).
  - `annotation-repeated`: "Keep `@card(0..1)`" and "Keep `@card(1..2)`", with neither preferred.
  - `unknown-label` and Langium's `linking-error`: "Change to '…'", for up to three names of the right
    kind within a small edit distance. For a linking error the names come from the failed reference's
    own scope.
  - `duplicate-owns` and `reserved-keyword` get no fix, on purpose: the answer is the writer's.

## Exit evidence

- `edits.spec.ts`: 17 cases, each applying the edit and rebuilding the workspace, then asserting it is
  clean. With Langium's default rename in place of ours, 8 fail.
- e2e, VS Code 1.146.0: **15 passed, 0 failed**, including a rename from a schema applied in the
  editor, which rewrote a query in another file.
- Gate green from a clean tree (1278 tests). Report card **1742 · 1 · 12 · 1 · 1756**, unchanged.

## What did not go as planned

- **The phase's own checklist was wrong about `annotation-repeated`.** It assumed any repeat, which
  would make removing the second one mechanical. The rule only fires when the two disagree, and
  removing either would be choosing for the writer. The fix offers both instead, and the checklist
  records the correction.

## Handoff to Phase 07

- Every editor feature exists. Phase 07 is packaging: a `.vsix` built by an Nx target, the e2e run
  against that artifact rather than the source folder, install instructions, and the `keytar` script
  `vsce` pulls in confirmed unnecessary.
