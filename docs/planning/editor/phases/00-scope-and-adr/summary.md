---
kind: summary
status: complete
feature: editor
phase: 00-scope-and-adr
---

# Phase 00 — Scope, the upstream diff, and the ADR: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/00-scope-and-adr`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Answer every question in the feature document's Phase 00 intent, record the answers in an ADR, and
leave Phase 01 nothing to decide.

## What was built

No code, as planned.

- [ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md),
  accepted.
- The [Multi-Phase Lifecycle Standard](../../../../standards/governance/multi-phase-lifecycle-standard.md),
  adapted from downstream-app and adopted here. This repository had no process standard, and the
  feature document was restating one inline.
- The [feature document](../../editor.feature.md), updated to match the ADR.
- ADR-007 and ADR-008 added to the project overview's ADR table. ADR-007 had been missing since it
  was accepted.

## What the measurements changed

Four findings, each of which moved a decision.

1. **The runtime never links and never runs `DocumentValidator`.** It runs `ValidationRegistry`
   checks through `validateSync`. That gives the boundary a mechanical form: an editor-only
   diagnostic belongs in a `DocumentValidator` subclass, and a registered check is a runtime rule
   (ADR-008 D2).
2. **Nothing is in Langium's global index.** The default exports only the root's direct children,
   which in TypeQLite are clauses with no name. Phase 02 is therefore real work, not configuration.
3. **The runtime reads pipeline labels as strings in about 390 lines across 12+ files.** That ruled
   out turning them into cross-references (ADR-008 D5).
4. **Two `vscode-languageserver` majors are installed** (9 for the language library, 10 for Langium).
   Phase 01 aligns them to 10, which matches upstream.

## Founder decisions — 2026-11-12

| Question | Decision | Recorded |
| -------- | -------- | -------- |
| Which files form one schema | The whole workspace. A project file is deferred | ADR-008 D3 |
| Which file extensions to claim | `.typeqlite` and `.tql`, as `langium-config.json` already says | ADR-008 D4 |
| Which e2e harness | `@vscode/test-electron` | ADR-008 D7 |

Each was taken as recommended. The rest of ADR-008 records measurements, not choices.

## Exit evidence

- Upstream `langium-vscode` and `examples/domainmodel` were read at `v4.3.0`, and every row is
  dispositioned in ADR-008 D8.
- Each item on the checklist is ticked.
- No code changed, so build, test and conformance are untouched by this phase.

## Handoff to Phase 01

- 🔴 **Before the e2e can run on this machine:**
  `sudo apt install libatk-bridge2.0-0 libsecret-1-0`. An Electron VS Code cannot start without
  these (ADR-008 D7).
- Move `@typedblite/language` to `vscode-languageserver ~10.0.1` first, and prove the language suite
  and the conformance run unchanged before any extension code exists (ADR-008 D8, row 9).
- The manifest's file extensions must come from `langium-config.json` (ADR-008 D4). Either generate
  them, or have a test that fails when they differ.
- Upstream's `examples/domainmodel` is the nearer template for the manifest. `langium-vscode` is the
  template for the client, the server and the bundling.
