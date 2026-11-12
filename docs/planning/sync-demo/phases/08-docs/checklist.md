---
kind: checklist
status: complete
feature: sync-demo
phase: 08-docs
---

# Phase 08 — Setup scripts, the README, and the docs

**Branch:** `phase/sync-demo/08-docs`, from `feat/sync-demo` · **Opened:** 2026-11-12

**Goal.** Someone with a fresh clone can set up, run and present the demo, and the repository's own
documents know it exists.

## The demo's README

- [x] `apps/sync-demo/README.md` covers:
  - what it shows, with a Mermaid diagram;
  - what is real and what is built for the demo;
  - the schema;
  - setup (npm, Playwright's Chromium, the build, and the Android setup and KVM);
  - running the story, its flags and Pause;
  - running by hand, with the control API from `curl`;
  - the nine steps;
  - the tests;
  - troubleshooting, and the layout.
- [x] Found while writing it: the desktop shell's default profile was relative to the working
      directory, so `npx electron …` from the repository root would create an untracked `.data/`
      there. It is now anchored beside the build

## The repository's documents

- [x] Root README: a packages-table row, a "see it working" paragraph in Replication, and `sync-demo`
      in the Nx project list
- [x] `docs/README.md`, `CONTRIBUTING.md` (the project table), `AGENTS.md` (the project list, the
      dependency graph, and the public-API-only rule), the architecture guide (graph and packages
      table), the testing guide (the suite), the replication guide (a pointer), and the project
      overview memory (the app and ADR-009)
- [x] The feature document: every Definition of Done item ticked, each with its evidence; the
      Android caveat stated; a stale link to the removed spike corrected in place; status complete

## Proof

- [x] Every Mermaid block in the repository (6) parses with Mermaid's own parser. Every relative link
      and anchor resolves
- [x] Final verification from a clean tree:
  - the gate: 7 projects, 1,302 tests;
  - conformance at 1742 · 1 · 12 · 1 / 1756;
  - `typedblite-runtime:test-wasm`: 579 passed and 1 skipped;
  - `typedblite-runtime:test-browser`: 3 of 3;
  - `sync-demo:test-browser`: 7 of 7, including the whole story.

## Close

- [x] `summary.md`, and the Phase Plan row
