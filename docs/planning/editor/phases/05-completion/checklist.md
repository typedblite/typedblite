---
kind: checklist
status: complete
feature: editor
phase: 05-completion
---

# Phase 05 — Completion

**Branch:** `phase/editor/05-completion`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md) · **Governed by:**
[ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
D3, D5

> ⚠️ **Written at the phase's close, not its start**, against the Multi-Phase Lifecycle Standard. The
> phase was worked from Phase 04's handoff, and the slip was noticed only at the exit gate. The items
> below are what was actually done and checked, not a plan written after the fact to look like one.

**Goal.** Completion offers the workspace's definitions of the kind each label position expects.

## Found at the start

- [x] Langium's default completion already offers cross-reference targets across the workspace
      (`owns |` offers attributes from another file), and keywords. At every plain-`ID` label
      position (`isa |`, `has |`, a role player, `plays employment:|`) it offers nothing
- [x] Completion sees grammar rules (`RedefineChange.superType`), not the AST types `sitesOf` sees
      (`RedefineSub`), so the label table needs a second key
- [x] `$p.age` in a `fetch` (`FetchAttribute.attribute`) is an attribute label, and Phase 04's table
      missed it

## Build

- [x] `LABEL_POSITIONS` (rule.property → kind), beside `sitesOf`, and `FetchAttribute` added to both
- [x] `TypeQLiteLabels.candidates(kind, relation?)`: a role whose relation is known offers that
      relation's roles, inherited ones included
- [x] `TypeQLiteCompletionProvider`: at a label position, offer candidates, with their kind and the
      kind word as detail, sorted ahead of keywords. A role's relation is read from the text before the
      cursor (`relationBefore`), because an unfinished statement may not parse

## Proof

- [x] `test/completion.spec.ts`, 40 cases: each label kind, inherited roles, `plays relation:`, fetch,
      item kinds, Langium's cross-file `owns` and keywords still working, `relationBefore` on six
      inputs, and every `LABEL_POSITIONS` entry naming a real rule and property. With the provider
      unregistered, the 7 label-position cases fail
- [x] e2e: completion after `isa`, after `has`, and at a role player. 13 of 13 passed
- [x] Gate green from a clean tree (1261 tests). Report card unchanged at 1742 of 1756

## Close

- [x] `summary.md`, and the Phase Plan row
