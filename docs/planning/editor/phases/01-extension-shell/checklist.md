---
kind: checklist
status: complete
feature: editor
phase: 01-extension-shell
---

# Phase 01 — Extension shell

**Branch:** `phase/editor/01-extension-shell`, from `feat/editor` · **Opened:** 2026-11-12 ·
**Feature:** [TypeQLite Editor](../../editor.feature.md) · **Governed by:**
[ADR-008](../../../../architecture/adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md)

**Goal.** Stand up the extension: a client, a server that runs the real `createTypeQLiteServices`, a
bundle, and a harness proving in a real VS Code that what the language library already does reaches
the editor. That covers diagnostics, formatting and semantic tokens.

## The gate was red before the phase started

On `main` at `20649bc`, `nx run-many -t typecheck` failed in two places:

- [x] `typeqlite-language:typecheck`: `annotation-admissibility.spec.ts` had no rows for the
      `owns list` and `relates list` subjects added to `AnnotationSubject`. The rows are added, and
      24 more admissibility cases now run
- [x] `typedblite-conformance:typecheck`: a race. `typecheck` read the runtime's built `.d.ts` without
      depending on its build. `nx.json` now gives `typecheck` a `^build` dependency, and the language
      library's `typecheck` runs `langium-generate` first, as AGENTS.md already claimed it did
- [x] Baseline after both: every suite green, and the report card at
      **1742 pass · 1 fail (`update:959`) · 12 deviation · 1 n/a · 1756**

## Dependencies (ADR-008 D8, row 9)

- [x] `@typedblite/language` and `@typedblite/runtime`: `vscode-languageserver ~9.0.1` → `~10.0.1`.
      One copy is installed now, not two
- [x] Gate green and the report card unchanged after the bump

## The extension (ADR-008 D1, D8)

- [x] `apps/vscode/` as Nx project `typeqlite-vscode`, extension `typedblite.typeqlite`, private. The npm
      name is `typeqlite`, because VS Code builds the id from `publisher.name`, and a test pins it
- [x] `src/extension.ts`: the client over IPC, with the debug server on `--inspect`, and
      `deactivate()` stopping the client (upstream rows 5–7)
- [x] `src/language-server/main.ts`: `createTypeQLiteServices` over `NodeFileSystem` (row 8)
- [x] `esbuild.mjs`: two CommonJS entries, `vscode` external, sourcemaps unless minified (row 4)
- [x] `language-configuration.json`: `#` comments, brackets, auto-closing quotes (row 2), and a
      `wordPattern` that keeps `project-id` and `$x` whole on a double-click
- [x] The TextMate grammar copied from `libs/language/syntaxes/` by `sync-grammar`, and gitignored (row 3)
- [x] `.vscodeignore`, and `vsce.dependencies: false` (row 10)
- [x] 🔴 The manifest's extensions, language id, activation event and grammar scope are checked against
      `langium-config.json` and the generated grammar by `test/manifest.test.ts` (ADR-008 D4)
- [x] `.vscode/launch.json` gains "Run TypeQLite Editor" and "Attach to TypeQLite Language Server", which
      the client's `--inspect=6009` was useless without

## Proof

- [x] Unit (`test/server.test.ts`): the bundled server, driven over stdio, advertises formatting and
      semantic tokens; publishes `typedblite.duplicate-owns` at the right position; formats; and gives
      a resolved `owns` a `property` token while an unresolved one gets none
- [x] e2e through `@vscode/test-electron`, in VS Code 1.146.0: activation (with `.tql` mapped), the
      validator diagnostic, Format Document (and idempotence), and semantic tokens. **4 passed, 0
      failed.** ~~This needs `libatk-bridge2.0-0` and `libsecret-1-0` on this machine~~: it does not.
      See the summary
- [x] Gate green across 6 projects, and the report card unchanged at 1742 of 1756

## Close

- [x] `summary.md`
- [x] Merged into `feat/editor`, and the Phase Plan row reads `Complete` with a link to the summary
