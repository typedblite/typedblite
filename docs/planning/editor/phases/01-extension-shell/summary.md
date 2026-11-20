---
kind: summary
status: complete
feature: editor
phase: 01-extension-shell
---

# Phase 01 — Extension shell: Summary

**Closed:** 2026-11-12 · **Branch:** `phase/editor/01-extension-shell`, merged into `feat/editor` ·
**Checklist:** [checklist.md](checklist.md)

## Goal

Stand up the extension and prove, in a real VS Code, that what the language library already does
reaches the editor: diagnostics, formatting and semantic tokens.

## What was built

| Piece | Where |
| ----- | ----- |
| Client: IPC, a debug server on `--inspect=6009`, and `deactivate()` | [`apps/vscode/src/extension.ts`](../../../../../apps/vscode/src/extension.ts) |
| Server: `createTypeQLiteServices` over `NodeFileSystem`, transport from argv | [`apps/vscode/src/language-server/main.ts`](../../../../../apps/vscode/src/language-server/main.ts) |
| Bundling: two CommonJS entries, `node20` target | [`apps/vscode/esbuild.mjs`](../../../../../apps/vscode/esbuild.mjs) |
| Manifest: `typedblite.typeqlite`, `.typeqlite` and `.tql` | [`apps/vscode/package.json`](../../../../../apps/vscode/package.json) |
| Nx targets: `sync-grammar`, `build`, `typecheck`, `test`, `e2e` | [`apps/vscode/project.json`](../../../../../apps/vscode/project.json) |
| Manifest test, and a stdio test of the bundled server | [`apps/vscode/test/`](../../../../../apps/vscode/test/) |
| e2e: a runner, and the cases run in the extension host | [`apps/vscode/e2e/`](../../../../../apps/vscode/e2e/) |
| F5 and attach configurations | [`.vscode/launch.json`](../../../../../.vscode/launch.json) |

The language library is unchanged apart from its `vscode-languageserver` version.

## Exit evidence

- `nx run typeqlite-vscode:e2e`, in VS Code 1.146.0: **4 passed, 0 failed**. The four cases are
  activation (with `.tql` mapped to `typeqlite`), a `typedblite.duplicate-owns` error at line 2, column
  31, Format Document followed by an idempotent second format, and a resolved `owns` colored
  `property` beside an unresolved one left uncolored.
- `nx run-many -t typecheck test --skip-nx-cache`: green across 6 projects (1181 tests, 12 of them new).
- Report card: **1742 pass · 1 fail · 12 deviation · 1 n/a · 1756**, the same before and after.

## What did not go as planned

- **The gate was red on `main` before anything changed.** One test file had not kept up with
  `AnnotationSubject`, and `typecheck` raced the builds whose declarations it reads. Both are fixed
  here, in their own commit, because the phase cannot exit on a gate that fails without it.
- 🔴 **Phase 00's library measurement was wrong.** `libatk-bridge-2.0` is installed. The search
  pattern (`libatk-bridge\.so`) could not match its real name, `libatk-bridge-2.0.so.0`. `libsecret` is
  absent, and VS Code runs without it. ADR-008 D7 and the Phase 00 summary are corrected in place, with
  a note saying so. **No install is needed on this host.**
- **The e2e failed first on the environment, not on the code.** Run from a VS Code terminal, the
  runner inherits `ELECTRON_RUN_AS_NODE`, so the downloaded VS Code started as plain Node. The runner
  now strips that variable and every `VSCODE_*` variable before launching.
- **The extension id comes from `name`, not from the Nx project.** The first e2e found
  `typedblite.typeqlite-vscode`. The package is now named `typeqlite`, and a manifest test pins
  `publisher.name` to ADR-008 D1.
- **Upstream's `vscode-languageserver` major had also to reach the runtime**, which uses its
  `Diagnostic` type for ADR-004's reports. ADR-008 D8 row 9 now says both libraries.

## Handoff to Phase 02

- The stdio test in `test/server.test.ts` is the fast way to prove a capability reaches a client.
  Phase 02's cross-file cases fit it: open two documents, and assert that one resolves into the other.
  The e2e is the slower, real-editor confirmation.
- 🔴 Phase 02 is the first phase in which ADR-008 D2 can actually break. Run the report card before and
  after, not only at the end.
- `@vscode/vsce` pulls in `keytar`, whose install script npm leaves unapproved. `vsce package` does not
  need it, and Phase 07 should confirm that rather than approve the script.
- The downloaded VS Code lives in `apps/vscode/.vscode-test/` (about 1.1 GB, gitignored), and is
  reused across runs.
