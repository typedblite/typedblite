---
kind: summary
status: complete
feature: editor
phase: 05-completion
---

# Phase 05 — Completion: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/05-completion`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Completion offers the workspace's definitions of the kind each position expects.

## What was built

- [`TypeQLiteCompletionProvider`](../../../../../libs/language/src/typeqlite-completion.ts). At a
  label position, it offers types after `isa`, attributes after `has`/`owns`/`$p.`, relations before a
  player list, and a relation's roles (inherited ones included) as players and after `relation:`.
  Everywhere else, Langium's own completion runs, unchanged: keywords, and cross-references, which
  cover the workspace since Phase 02.
- `LABEL_POSITIONS` in [`typeqlite-labels.ts`](../../../../../libs/language/src/typeqlite-labels.ts),
  keyed by grammar rule, with a spec that fails if a key stops naming a real rule and property.
- `FetchAttribute` (`$p.age`) is now a label site. That means it also gets definition, hover,
  references, tokens and the unknown-label warning, which Phase 04 missed.

## Exit evidence

- `completion.spec.ts`: 40 cases. With the provider unregistered, 7 fail.
- e2e, VS Code 1.146.0: **13 passed, 0 failed**.
- Gate green from a clean tree (1261 tests). Report card **1742 · 1 · 12 · 1 · 1756**, unchanged.

## What did not go as planned

- **The checklist was written at the close**, not the start. Its header says so.
- **The Phase 03 references e2e broke twice**, each time correctly: a new fixture used `nav-name`,
  and references found it. Asserting an exact file list in a shared fixture workspace was the bug.
  The case now asserts the files it must find, and that every hit really is `nav-name`.
- **A role's relation is read from text**, not the AST: `relationBefore`. While a statement is being
  typed it usually does not parse, so there is no node to ask. Its six inputs are pinned by a spec.

## Handoff to Phase 06

- Langium's rename already works for cross-references across files, through its references. Labels
  are not references, so a rename must also edit every `TypeQLiteLabels.usesOf` site, or a rename
  from the schema would leave every query naming the old label.
- Quick fixes key on the validator's stable codes, through `codeActionProvider`. The server already
  advertises it, because Langium registers a default.
