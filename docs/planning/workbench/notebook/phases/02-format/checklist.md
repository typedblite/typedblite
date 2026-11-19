---
kind: checklist
status: complete
feature: notebook
phase: 02-format
---

# Phase 02 — The format

**Branch:** `phase/notebook/02-format`, from `feat/notebook` · **Opened:** 2026-11-19 ·
**Feature:** [Notebook](../../notebook.feature.md)

**Goal.** A notebook serializer and parser over Markdown, byte-exact for an unedited file, with no outputs stored, and
the notebook types registered in the extension.

## Build

- [x] `src/notebook/format.ts`: pure `parseNotebook` and `serializeNotebook` over a model that owns every byte
- [x] `src/notebook/serializer.ts`: VS Code's `NotebookSerializer`, cell metadata for the bytes a cell does not show
- [x] Two notebook types over one serializer: `typeqlite-notebook` (`*.tql.md`, default) and
      `typeqlite-notebook-markdown` (any `*.md`, `priority: option`); both `transientOutputs`
- [x] Activation on both notebook types; the `vscode` fake grows the notebook classes

## Specs

- [x] Which fences are cells: languages, tildes, longer fences, unclosed, nested in another fence, in a quote or a
      list, a backtick in the info string, comments and front matter, blank lines between cells
- [x] **Parse then serialize is the identity** for 19 shapes of file (CRLF, CR, mixed, a BOM, no final newline, an unclosed
      fence, empty, ...), and for **every tracked Markdown file in the repository**
- [x] The code cells are exactly the TypeQLite fences **markdown-it** finds at the top level, over the same files
- [x] Editing: one cell's change changes only its lines; an added cell, a built-from-nothing notebook, new line
      endings; a closing-fence line in a value grows the fence; an unclosed cell is closed when another follows; a
      line ending is restored before the next cell
- [x] The adapter: kinds, language ids, metadata, no outputs written, a cell added in the editor, a kind changed,
      an appended cell
- [x] The manifest: two types, their priorities and selectors, a serializer registered for each
- [x] **e2e against the installed `.vsix` (23 of 23):** a `.tql.md` opens as a notebook with no outputs; editing one cell
      and saving changes only that cell; a `.md` opens as a notebook only through Open With
- [x] Mutations: four in the format (fence growth, closing an unclosed cell, the line-start guard, indented fences)
      and one in the manifest (`*.md` as the default) each fail a spec

## Checks

- [x] `npm run gate -- --quick`

## Outputs

- [x] `summary.md`; ADR-012 N2 made exact; the feature, the initiative, the extension README, `AGENTS.md`
- [ ] Merged into `feat/notebook`
