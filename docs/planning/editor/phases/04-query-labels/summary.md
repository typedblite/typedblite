---
kind: summary
status: complete
feature: editor
phase: 04-query-labels
---

# Phase 04 — Query-side labels: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/04-query-labels`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

A type label that is a plain `ID` resolves against the workspace schema with no grammar change
(ADR-008 D5), and gets definition, references, hover, resolved highlighting and an unknown-label
warning that the runtime never sees (D2, D6).

## What was built

- [`TypeQLiteLabels`](../../../../../libs/language/src/typeqlite-labels.ts) is one table of every
  label position. It covers `isa`, `has`, `owns`, type-pattern subjects, `entity person;`, anonymous
  relations, role players, `relates`, `sub` and `label` (including `relation:role`), re-opens, and
  `undefine`/`redefine` targets. Each position records what kind of definition it expects. A role's
  relation is taken from its pattern (`$e isa employment (employee: $p)`) and resolved through the
  supertype chain, so an inherited role is not unknown.
- [`typeqlite-label-providers.ts`](../../../../../libs/language/src/typeqlite-label-providers.ts):
  - Definition and references consult labels after Langium's cross-references. References now
    returns a type's cross-references **and** its label uses, whichever side the request starts
    from.
  - `TypeQLiteDocumentValidator` adds `typedblite.unknown-label` at warning severity, only when the
    workspace defines at least one type.
  - `TypeQLiteDocumentBuilder` relinks any document holding labels when anything changes. Without
    it, a warning stayed stale after the defining file appeared.
- Hover falls back to a label's resolution, and semantic tokens colour labels through the same table.

The grammar is unchanged, and so is the runtime.

## Exit evidence

- `labels.spec.ts`: 17 cases. These cover each label kind, an inherited role, definition, references
  from both sides, hover, the warning with and without a schema, the warning for a role, the warning
  clearing, `validateSync` never reporting it, and tokens with and without a schema. With the document
  builder unregistered, the clearing case fails.
- e2e, VS Code 1.146.0: **12 passed, 0 failed**.
- Gate green from a clean tree (1221 tests). Report card **1742 · 1 · 12 · 1 · 1756**, unchanged.

## Decisions made in the phase

- **Semantic tokens follow D6.** In a workspace with a schema, a label is coloured only when it
  resolves, and by what it resolves to (attribute → property, role → parameter, other types → type).
  In a workspace with none, labels keep the position-based colouring they had before. A 🔴 comment
  in the old provider said resolution "genuinely does not exist here", and that comment is replaced.
- **`$t label person` is never warned about.** It asserts a label rather than using one. Nor is a
  role whose relation the pattern does not name (`links (employee: $x)` with no `isa`), because there
  is nothing to check it against.

## Known cost

`TypeQLiteDocumentBuilder` relinks every label-bearing document on every change anywhere in the
workspace. For a workspace of tens of files that is nothing. For thousands it would be noticeable. The
narrower rule (relink only when a changed document's exports changed) is in **Deferred**.

## Handoff to Phase 05

- Completion can use the same table. A label position knows the kind it expects, so after `isa` it
  offers types, after `has` attributes, and after `employment (`, or in `employment:`, that relation's
  roles. `TypeQLiteLabels.resolve` with no name filter is most of it.
- Langium's default completion offers cross-reference targets for `owns`, `sub` and `plays`. Phase 02
  made those cover the workspace, so they need a test, not code.
