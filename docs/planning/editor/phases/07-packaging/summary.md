---
kind: summary
status: complete
feature: editor
phase: 07-packaging
---

# Phase 07 — Packaging: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/07-packaging`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

A `.vsix` built by an Nx target, the e2e run against that installed artifact, and documentation that
names the editor.

## What was built

- `nx run typeqlite-vscode:package` builds minified bundles and packages
  `apps/vscode/dist/typeqlite-0.0.1.vsix`: 8 files, 260 KB, with no sources, maps or `node_modules`.
- `nx run typeqlite-vscode:e2e` now depends on `package`. It installs the `.vsix` with the downloaded
  VS Code's own CLI into a fresh extensions folder, and runs every case against the installed copy.
  The suite asserts that the copy it is testing is that one. Run directly with no argument, it still
  tests the source folder, for quick iteration.
- [`apps/vscode/README.md`](../../../../../apps/vscode/README.md) covers what the editor does, why
  unknown labels are only warnings, its limits, and how to install and develop it.
- The root `README.md` lists the extension and how to install it. `AGENTS.md` covers the e2e, the
  multi-document test harness, and the rule that the label tables follow the grammar.

## Exit evidence

- e2e against the installed `.vsix`, VS Code 1.146.0: **16 passed, 0 failed**.
- Gate green from a clean tree (1278 tests). Report card **1742 · 1 · 12 · 1 · 1756**, unchanged.

## What did not go as planned

- **Under WSL, VS Code's `bin/code` stops to ask whether to continue**, so the first install hung on a
  question and failed. `DONT_PROMPT_WSL_INSTALL=1` answers it, set for the install step only.
- **One Definition of Done item had never been asserted where it said.** The resolved-versus-unknown
  semantic token for a *query label* was proven in the language specs only, never in the extension
  host. The 16th e2e case closes that gap.
- `keytar` needed nothing. `vsce` pulls it in for marketplace credentials, and packaging never loads
  it, so its unapproved install script can stay unapproved.

## The feature is complete

Every phase is closed and every Definition of Done item is met. The feature document records the
evidence for each. What was deliberately left out is in its **Deferred** section.
