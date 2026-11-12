---
kind: checklist
status: complete
feature: editor
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the upstream diff, and the ADR

**Branch:** `phase/editor/00-scope-and-adr`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md)

**Goal.** Answer every question the feature document's Phase 00 intent lists, record the
architectural answers in an ADR, and leave Phase 01 nothing to decide. This phase writes no code.

## Process

- [x] Adopt the Multi-Phase Lifecycle Standard in this repository:
      [`docs/standards/governance/multi-phase-lifecycle-standard.md`](../../../../standards/governance/multi-phase-lifecycle-standard.md)
- [x] Cut `feat/editor` from `main`, and this branch from `feat/editor`

## Measurements

- [x] Upstream `langium-vscode` read at tag `v4.3.0`. This repository pins `langium@4.3.1` and
      `langium-cli@4.3.0`, and there is no `v4.3.1` tag. The row-by-row diff is in the ADR
- [x] What Langium exports to the global index by default. Only the root's direct children are
      exported (`DefaultScopeComputation.collectExportedSymbols`), and TypeQLite's are clauses, which
      have no name. **Nothing is exported today**
- [x] Every pipeline position that names a type, and how much runtime code reads those properties as
      strings: about 390 lines across 12+ files of `libs/runtime/src` (13.7k lines)
- [x] The `vscode-languageserver` versions installed. `@typedblite/language` pins `~9.0.1`, and
      `langium@4.3.1` depends on `~10.0.1`, so two copies are installed
- [x] What an e2e harness can run on this machine. `code-server` 4.135.0 is installed, and Playwright
      browsers are cached. An Electron VS Code is missing `libatk-bridge-2.0` and `libsecret-1`, and
      this repository has no CI

## Decisions

- [x] Package location, Nx project and extension identity
- [x] Query-side labels: no grammar change
- [x] Unknown-label severity
- [x] LSP library versions
- [x] The unit of "a schema": the whole workspace (founder, ADR-008 D3)
- [x] File associations: `.typeqlite` and `.tql` (founder, ADR-008 D4)
- [x] The e2e harness: `@vscode/test-electron` (founder, ADR-008 D7)

## Outputs

- [x] ADR-008 written and accepted
- [x] The feature document updated to the decisions: Phase Plan, Phase Intent, Definition of Done
- [x] `summary.md`
- [x] Merged into `feat/editor`, and the Phase Plan row reads `Complete` with a link to the summary
