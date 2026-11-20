# TypeQLite for VS Code

Language support for **TypeQLite**, the TypeQL 3.x dialect that [TypeDBLite](https://github.com/typedblite/typedblite)
speaks. The editor runs the same grammar and the same rules as the engine, so what it reports is what
the engine would say.

Files: `.typeqlite` and `.tql`.

## What it does

- **Diagnostics as you type.** Parse errors, and every rule the engine enforces at parse time:
  annotations a position does not admit, two `owns` of one attribute that disagree, reserved
  keywords, and more.
- **One workspace is one schema.** A type defined in any `.typeqlite` or `.tql` file in the workspace
  resolves from every other. That covers `sub`, `owns`, `plays`, and the roles a re-open adds.
- **Labels in queries resolve too.** `$p isa person`, `has name`, `(employee: $x)`, and `$p.name` in a
  `fetch` all point at their definition.
- **Navigation.** Go to definition, find references (schema references and query labels together),
  an outline, workspace symbols (Ctrl+T), and folding.
- **Hover.** A definition's source, its `#!` doc comment and `@doc("…")` text, and the files that
  re-open it.
- **Completion.** Types after `isa`, attributes after `has`, `owns` and `$p.`, and a relation's roles,
  inherited ones included, as role players and after `relation:`.
- **Rename.** A type or a role, from its definition, a reference, or a query label. Every schema
  reference and every query label is renamed with it.
- **Quick fixes.** Remove an annotation the position does not admit; keep either of two annotations
  that disagree; change an unknown label or an unresolved reference to the nearest defined name.
- **Formatting and semantic highlighting.** A label is colored by what it resolves to. Keywords are
  colored by kind (`define`, `entity`, `string` and `@key` each look different), with the same
  scopes as TypeDB's TypeQL extension, so your theme colors TypeQLite as it colors TypeQL.
- **TypeQLite in the Markdown editor.** Code fenced as `typeql`, `typeqlite` or `tql` is highlighted
  while you write the Markdown, not only in its preview.
- **TypeQLite in the Markdown preview.** Code blocks fenced as `typeql`, `typeqlite` or `tql` are
  highlighted as the editor would highlight them, in your color theme, and again when it changes. The
  blocks on one page are read together, so a schema in one block resolves the labels in the next.

## Unknown labels, and why they are only warnings

In TypeDB the schema lives in the database, not beside the query. So:

- In a workspace that defines **no** types, a query's labels are never reported as unknown. They are
  colored by position.
- In a workspace that defines **some**, a label it does not define is a warning
  (`typedblite.unknown-label`), never an error, because the database may still know it.

The engine never sees this warning. It is produced by the editor alone.

## Limits

- **One workspace is one schema.** If two independent schemas in one workspace define the same label,
  a reference resolves to the definition in its own file first, and otherwise to whichever is found
  first.
- **Running statements has no UI here yet.** The extension carries the engine host and starts it for features built
  on it (see [The engine host](#the-engine-host)); the graph explorer, debugger and notebook are those features.
- **The Markdown preview reads your theme's files**, because VS Code offers no other way to get a
  theme's token colors. In a remote window (WSL, SSH, a container) the themes stay in your local
  VS Code, out of this extension's reach. Install the **TypeQLite Theme Bridge** there too (below),
  or the preview shows TypeQLite in its own colors. A theme whose colors are in a `.tmTheme` file gets the preview's own
  colors instead. On GitHub, TypeQLite code blocks are plain: GitHub has no TypeQL grammar, and allows
  no colors of a page's own.

## Notebooks

A **TypeQLite notebook** is a Markdown file: each fenced `typeql` block is a code cell, and the text between them is
a Markdown cell ([ADR-012](../../docs/architecture/adr-012-the-notebook-is-a-markdown-file-run-on-the-engine-host.md)).

- **`*.tql.md`** opens as a notebook. **Any other `.md` file** stays a Markdown file, and opens as a notebook only
  when you choose **Open With… → TypeQLite Notebook (any Markdown file)**, so the guides open and read as notebooks
  without being renamed.
- **Opening and saving changes nothing.** The file is written back byte for byte unless you edit a cell, and an edit
  changes only that cell's lines, so a notebook diffs like prose. **Outputs are never saved**, and running a cell does
  not mark the notebook changed.
- A fence is a cell only at the top level of the document. A `typeql` fence inside another fenced block, a block
  quote or a list item is text.
- A cell whose text contains a line of three backticks is written inside a longer fence, so it reads back whole.

### Language features in cells

Diagnostics, completion, hover, go to definition, rename and quick fixes work in a notebook's code cells as they do in a
`.tql` file, **across the cells of one notebook**: a schema defined in one cell resolves in the next. **A notebook is a
schema of its own.** A cell sees its own notebook's cells and nothing else, so two notebooks may define the same label,
and a notebook and the workspace's `.tql` files do not see each other.

### Choosing a store

A notebook runs in **memory** until you choose a file: **"Choose the Notebook's Store…"** (the status bar's store item, or the
notebook toolbar's **…** menu). Open an existing store file or create one, and then say **when a write becomes permanent**:

- **Hold changes until I commit** (listed first, the safer one): nothing is permanent until you choose Commit. Commit and
  Rollback appear on the toolbar while a notebook holds changes, and the next changes are held in turn. A commit the engine
  refuses is rolled back, with its reason. Closing the notebook without committing makes nothing permanent.
- **Commit each statement**: every successful statement is permanent at once.

The status bar shows which file and which mode. **The choice is never saved in the notebook and never remembered**, so a
notebook someone sends you runs in your memory, not on a path from their machine, and saving a notebook never touches a
store. Switching asks first, because it ends the current session.

### Exporting

"Export the Notebook as a TypeQLite Script…" writes the code cells, one blank line apart, as a `.tql` file. "Export the
Notebook as Markdown…" writes the prose and every code cell as a fenced `typeql` block. Both are of the notebook as it is in the
editor, edits included, and neither has outputs.

### Running cells

Run a cell, or use VS Code's own **Run All**, **Run Above** and **Run Below**. Each notebook has **one store, in
memory**, kept from cell to cell: a schema defined in one cell is there for the next. The cells are run by the
[engine host](#the-engine-host), which splits a cell into statements and runs them in order.

- **Answers** are a table for rows, JSON for a `fetch`, and the engine's own execution facts ("Wrote 1 thing(s)…").
  A table shows the first **1,000** rows (`typedblite.notebook.maxRows`) and says how many it did not show.
- **A refusal is the engine's own message**, on the cell that was refused, with its line and column. It ends the run: later
  cells are not started, and the statements of the cell that ran before it **stay committed**.
- **Restart** (the notebook toolbar, or "TypeQLite: Restart the Notebook's Store") closes the store and opens a fresh,
  empty one. If the engine host itself was restarted, the next cell says so and starts a new, empty store.
- Nothing is saved: outputs are not written to the file, and running a cell does not mark the notebook changed.

## Debugging

Run a `.tql` or `.typeqlite` file under the debugger, and watch where its rows go
([ADR-014](../../docs/architecture/adr-014-the-debugger-replays-a-recording-of-each-statement-from-the-engine-host.md)).
Press **F5** in a TypeQLite file with no `launch.json`, or add a **TypeQLite** configuration:

```jsonc
{
  "type": "typeqlite",
  "request": "launch",
  "name": "Debug TypeQLite",
  "program": "${workspaceFolder}/queries.tql",
  "cwd": "${workspaceFolder}",
  "schema": ["schema.tql"], // define statements, run first
  "seed": ["seed.tql"],     // data, run next
  "stopOnEntry": true
}
```

- **Nothing you keep is ever opened.** Every session runs in a fresh **in-memory** store: the `schema` files, then the
  `seed` files, then the program, statement by statement. Its writes, commits included, vanish when the session ends.
- **Each statement is recorded as it runs**, then stepped through: the call stack is the statement, its stage, the
  step of its `match`, and any function or `fetch` sub-query inside. **Step into** a `match` to go one step at a time
  **in the order the engine runs them, which is not always the order of the lines**: a step's every line is
  highlighted, and a breakpoint on any of them stops there.
- **Variables** at a stage or step: its **Rows** (paged; open a row for its bindings, a thing for its attributes as they
  were at that point), its counts, each `let` and comparison with how many rows it **dropped**, and the rows each
  incoming row gave.
- **Breakpoints:** on a line; with a **condition** on the counts (`rowsOut == 0`, `rowsIn > 0 && rowsOut == 0`); and two
  exception breakpoints: **On refusal** (on by default; stops where TypeQLite refused, with its code) and **When a step
  empties** (stops where the rows ran out). A breakpoint on a line inside a statement is checked when that statement
  runs.
- **Step back** and **Reverse Continue** move through what was recorded; nothing runs twice. **Run Without Debugging**
  runs the file and prints its answers.
- Answers and facts are printed to the Debug Console. A refusal ends the program after you continue from it, as
  `typedblite --file` does.

Not yet: evaluating expressions in the Debug Console, changing a value, and debugging against a store on disk.

## The engine host

The extension ships the TypeDBLite **engine host**, a separate process that runs TypeQLite statements in sessions
([ADR-011](../../docs/architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md)). It
is a bundle inside the `.vsix` (`out/host/sidecar.cjs`), and the extension **never imports it**: it runs it with a
`node` and sends it operations over the sidecar (JSON lines on stdio).

- **It starts on the first request**, not when a `.tql` file opens, so using the editor costs nothing. The notebook and
  the debugger use the same host process, each with sessions of its own.
- **It needs Node 22.16 or newer**, which has `node:sqlite`. The extension uses the `node` on PATH, or the path in
  the **`typedblite.host.node`** setting (a machine setting: a repository cannot choose what runs). It asks that
  `node` before using it, and says what is wrong if it is missing, too old, or has no `node:sqlite`.
- **Other extensions and features use it** through the command `typedblite.host.request`
  (`executeCommand('typedblite.host.request', 'session.open', { schema })`, which answers the host's envelope), or
  through the extension's exported API (`host.call(operation, input)`, which answers the data and throws a
  `HostRequestError` carrying the host's `code`).
- **Its sessions live in its process.** If the process dies, the next request starts a new one, and a session id from
  before answers `SESSION_NOT_FOUND`: reopen it. Changing `typedblite.host.node` ends the running host.

The operations are the host's: see [its README](../engine-host/README.md).

## Install

Build and package from the repository root:

```bash
npm install
npm exec nx -- run typeqlite-vscode:package
code --install-extension apps/vscode/dist/typeqlite-0.0.1.vsix
```

`package` also builds `apps/vscode/dist/typeqlite-theme-0.0.1.vsix`, the **TypeQLite Theme Bridge**.
You need it only in remote windows, and it belongs in the **local** VS Code: run the `code` command
of your local VS Code, not the one in the remote terminal. See
[its README](theme-bridge/README.md).

## Develop

- **F5, "Run TypeQLite Editor"**, opens a second VS Code window with the extension loaded from
  source.
- **"Attach to TypeQLite Language Server"** attaches a debugger to its server, which listens on port
  6009.
- `npm exec nx -- run typeqlite-vscode:test` runs the manifest check, drives the bundled server
  over stdio, and tests the Markdown preview's theme rules and painting.
- `npm exec nx -- run typeqlite-vscode:e2e` packages the extension, installs the `.vsix` into a
  downloaded VS Code, and runs the editor cases there. It needs a display; on a headless machine, use
  `xvfb-run`.

The architecture is ADR-008 in this repository, and ADR-010 for the Markdown preview:
`docs/architecture/`.

## License

[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/). The packaged extension includes the
license text.
