# Changelog

All notable changes to the TypeQLite extension. The extension is versioned separately from the TypeDBLite npm
packages. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

The first release. Nothing has been published to a marketplace yet.

### Added
- Diagnostics as you type: parse errors, and every rule the TypeDBLite engine enforces at parse time.
- One workspace is one schema: a type defined in any `.typeqlite` or `.tql` file resolves from every other,
  and labels in queries resolve to their definitions.
- Go to definition, find references, an outline, workspace symbols, folding and hover.
- Completion, rename, and quick fixes.
- The TypeDBLite mark as the icon of `.typeqlite` and `.tql` files, in light and dark forms. VS Code uses it
  when your file icon theme has no icon of its own for TypeQLite.
- Formatting, and semantic highlighting that colors a label by what it resolves to and keywords by kind.
- **The TypeQLite debugger.** F5 on a `.tql` or `.typeqlite` file runs it in a fresh in-memory store, after any
  schema and seed files the launch names. Step through statements, stages, and a `match`'s steps in the order the engine
  runs them; see each step's rows, counts and dropped rows; break on a line, on a row-count condition, where TypeQLite
  refused, or where a step's rows ran out; step back through what was recorded. No store on disk is ever opened.
- **TypeQLite notebooks.** A Markdown file whose `typeql` fences are code cells: `*.tql.md` opens as a notebook, and any `.md`
  file by "Open With". Run a cell, Run All, Run Above and Below, and Restart: the cells run on the TypeDBLite engine, in one
  store kept from cell to cell, and answer with a table, JSON, the engine's execution facts, or its own refusal on the cell. The
  language features work across a notebook's cells, and each notebook is a schema of its own. A notebook runs in memory until
  you choose a store file and when its writes become permanent (hold changes until you commit, or commit each statement); the
  choice is never saved in the notebook. Export as a `.tql` script or as Markdown. Saving never writes outputs, and an unedited
  notebook is written back byte for byte.
- **The engine host**, bundled and started as a process on first use, with a `node` it checks first (`typedblite.host.node`):
  needs Node 22.16 or newer. Other extensions reach it through the command `typedblite.host.request`.
- TypeQLite code blocks colored in your theme, in the Markdown preview and the Markdown editor. In a remote
  window, the preview needs the optional TypeQLite Theme Bridge, installed in your local VS Code.
