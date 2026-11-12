---
kind: checklist
status: complete
feature: editor
phase: 07-packaging
---

# Phase 07 — Packaging

**Branch:** `phase/editor/07-packaging`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md) · **Governed by:**
[ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)
D7, D8

**Goal.** A `.vsix` built by an Nx target. The e2e installs **that artifact** and runs against it,
not the source folder. Install instructions, and the repository's own documentation, name the
editor.

## Build

- [x] `nx run typeqlite-vscode:package`: a minified build, then `vsce package` into
      `apps/vscode/dist/`, non-interactively (`--no-dependencies --skip-license`, a `repository` field
      for the README's links, and `mkdir -p dist`, which `vsce` does not do)
- [x] The e2e installs the `.vsix` with the downloaded VS Code's own CLI, into a fresh extensions
      folder, and runs the cases against the installed copy. Under WSL, VS Code's `bin/code` stops to
      ask a question, and `DONT_PROMPT_WSL_INSTALL` answers it. The suite asserts the extension's path
      is the installed one
- [x] Confirm `keytar` (pulled in by `vsce`, its install script left unapproved) is not needed to
      package. It is not: `vsce package` ran without it
- [x] `apps/vscode/README.md`: what the editor does, how to build, install and debug it, and its limits
- [x] Root `README.md` and `AGENTS.md` name the editor and its targets

## Proof

- [x] The `.vsix` contains the two bundles, the grammar, the language configuration, the manifest and
      the README, and no sources, maps or `node_modules`: 8 files, 260 KB
- [x] e2e against the installed `.vsix`: 16 of 16. The 16th is new: a query label's semantic token
      in the extension host, which the Definition of Done asked for and no phase had asserted there
- [x] Gate green from a clean tree, and the report card unchanged

## Close

- [x] `summary.md`, the Phase Plan row, and the feature document's Definition of Done and status
