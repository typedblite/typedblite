---
kind: summary
status: complete
feature: notebook
phase: 02-format
---

# Phase 02 — The format: Summary

**Closed:** 2026-11-19 · **Branch:** `phase/notebook/02-format` · **Checklist:** [checklist.md](checklist.md)

## Goal

A serializer and parser over Markdown, byte-exact for an unedited file, with no outputs stored, and the notebook
registered in the extension.

## What was built

- **`format.ts`**, pure: a Markdown file is cells. A top-level, unindented fence with a TypeQLite language is a code
  cell; the text between fences is a Markdown cell. **Every byte belongs to one field** (a cell's text, its fence lines,
  its trailing line ending, the blank lines after it, the file's head), so parse then serialize is the identity.
- **`serializer.ts`**: VS Code's notebook model over it. What a cell does not show travels in its metadata. A cell added
  in the editor gets the guides' spelling, and its spacing is set so it is set off by a blank line.
- **Two notebook types over one serializer**: `typeqlite-notebook` for `*.tql.md` (the default editor) and
  `typeqlite-notebook-markdown` for any `*.md`, as an option only. VS Code gives one priority per type, and `*.md`
  cannot be a default without taking over every Markdown file.

## What was proven

- **Every tracked Markdown file in the repository round-trips byte for byte** (133 tracked files), and **its code cells are
  exactly the TypeQLite fences markdown-it finds at the top level**, the engine the preview uses. The notebook and
  the preview agree about the guides.
- 19 shapes of file round-trip, including CRLF, CR, mixed endings, a byte order mark, an unclosed fence and no final newline.
- Outputs are never written, however many a cell holds, and the types are `transientOutputs`.
- **e2e against the installed `.vsix`, 23 of 23:** a `.tql.md` opens as a notebook, an edit saves only that cell, and a
  `.md` is a notebook only through Open With (a mutation making it the default fails this).
- Five mutations each failed a spec.

## Found while building

- **Blank lines belong to the cell before them.** My first design gave a blank line after a code cell to the *next*
  Markdown cell, so inserting a cell between two put the blank line on the wrong side of it. One spec failed. Now a
  cell's trailing blank lines are its own (or the file's head), and an inserted cell takes its own spacing.
- **A value that holds three backticks on a line would end its cell early** the next time the file is read. The
  serializer now writes it inside a longer fence, and an unclosed cell is closed when another cell follows it.
- **The five-minute tour has one `typeql` fence**, the rest shell and TypeScript. Making it a runnable notebook, as
  the feature's Definition of done asks, is Phase 06's conversion, not this format's.
- `TextDecoder` drops a byte order mark by default, which would have removed it on save; the adapter keeps it.

## What was not done

- **Running a cell**, outputs, a controller: Phase 03.
- **Non-UTF-8 files**: decoding replaces invalid bytes, so such a file would not round-trip. Markdown files are UTF-8.
- **A fence indented by one to three spaces** is text, not a cell, though CommonMark calls it a fence. Cells with
  indentation would need the indentation stripped from their lines and restored, and no guide has one.
- The full gate (WASM, browser, clean-room): nothing it covers changed.

## For Phase 03

The controller: one engine-host session per open notebook (through the extension's `HostClient`), a cell run by
`statement.split` and `session.run` statement by statement, stopping at the first refusal, with outputs for rows,
JSON (`fetch`), facts and refusals, and the output bound (measure a large answer first, and decide whether the host
needs a `limit` input). Both notebook types need the controller.
