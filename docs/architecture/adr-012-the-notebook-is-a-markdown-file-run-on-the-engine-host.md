---
kind: adr
status: accepted
date: 2026-11-19
decision-owners: [Founder, TypeDBLite maintainers]
extends: [adr-008, adr-011]
---

# ADR-012: The TypeQLite notebook is a Markdown file, run on the engine host

- **Status:** Accepted on 2026-11-19. The founder accepted the six recommendations below.
- **Date:** 2026-11-19
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-008](adr-008-the-typeqlite-editor-is-a-langium-language-server-in-this-repository.md) (the
  language server serves notebook cells) and [ADR-011](adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md)
  (the notebook's kernel is an engine-host session).

---

## Context

The feature document was written on 2026-11-17 from the other feature documents, before the engine host existed.
It read the one-line request ("a notebook") as a VS Code notebook for TypeQLite, and left six questions open.

Measured on 2026-11-19, before deciding:

| Fact | Consequence |
| ---- | ----------- |
| The engine host is built: sessions, `statement.split`, `session.restart`, and a `HostClient` in the extension that starts it on first use | The notebook adds no engine path of its own. Its kernel exists |
| A real language server, given `notebookDocumentSync` and `NotebookDocuments.listen(connection)`, builds each cell as a document. A label defined in cell 1 resolves in cell 2, only the truly unresolved one is reported, and go-to-definition crosses cells. Without any hook of our own | Cross-cell services are two small server changes, not a design |
| The schema scope is the **whole workspace index**. A second notebook, defining its own entity, resolved `name` from the first notebook's cell | Notebooks would share a schema with each other and with `.tql` files. Scope must be per notebook |
| The host returns every row of an answer, as one JSON line | A very large answer crosses the sidecar whole. Not measured yet |
| `node:sqlite` is present in VS Code 1.146's Node (ADR-011 D1) | The host runs wherever the extension finds a `node` |

## Decision

**N1. It is a VS Code notebook for TypeQLite:** a file of cells, some Markdown and some TypeQLite, where running a
cell shows its answers beneath it, against one store that lasts from cell to cell. Not a Jupyter kernel and not a
playground feature.

**N2. The file is Markdown.** Each fenced `typeql` block is a code cell, and the text between fences is a Markdown
cell. The notebook type is `typeqlite-notebook`, for `*.tql.md` by default, and for any `*.md` as an opt-in
"Open With" (`priority: option`), so the existing guides open and run with no conversion, GitHub renders them, and
a diff reads as prose. **Outputs are not stored.** The serializer round-trips exact bytes: a code cell keeps its own
opening and closing fence lines, and an unedited notebook is written back unchanged. The fence languages are those
of ADR-010 (`typeql`, `typeqlite`, `tql`). **Made exact in Phase 02:** VS Code gives one `priority` to a notebook type,
and `*.md` cannot be a default, so there are **two types over one serializer**: `typeqlite-notebook` for `*.tql.md`
(the default editor) and `typeqlite-notebook-markdown` for any `*.md` (`priority: option`, "Open With"). Only a
top-level fence with no indentation is a cell: a fence inside another fence, a block quote or a list is text.
Blank lines belong to the cell before them (or to the head of the file), never the one after, so a cell inserted
between two others takes its own spacing. A code cell whose text holds a closing-fence line is written inside a longer
fence, so it reads back whole.

**N3. The kernel is an engine-host session.** One session per open notebook, opened on the first run through the
extension's `HostClient`. Restart is `session.restart`. A cell is run by the host and by nothing else (feature
invariant 1).

**N4. Cells are documents, and the schema scope is the notebook.** The extension syncs cells to the language server
(`notebookDocumentSelector`), the server advertises `notebookDocumentSync` and listens for notebook documents, and the
scope provider restricts a reference's global scope by the **owner** of its document: a cell's owner is its notebook
(the cell URI without its fragment), and every other document shares the workspace's. A cell sees its own
notebook's cells and nothing else, a `.tql` file sees no cell, and two notebooks never share a schema. The Markdown
preview's own workspace (ADR-010) is unaffected.

**N5. The store is in memory by default**, one per notebook. Opening a file is an explicit "Open store…" for that
session, shown in the notebook's status. **The choice is not written into the notebook and not remembered**, so a
shared notebook cannot open someone's path by surprise (feature invariant 3).

**N6. A cell is a source, not one statement.** The host splits it (`statement.split`) and the notebook runs the
statements in order, shows each output in turn, and **stops at the first refusal**. Statements that ran before it
stay committed, as `typedblite --file` behaves, so a cell can be reproduced by pasting it into the REPL (feature
invariant 1). A cell is not wrapped in a transaction.

## Consequences

- A **language change** is part of this feature: a scope-provider change in `libs/language`, and the notebook
  capability in the server. It is made in Phase 04, with the conformance run unchanged (ADR-005).
- The notebook adds a **cell URI scheme** to what the language server sees (`vscode-notebook-cell:`). The server's
  existing document selector (`scheme: 'file'`) is widened for cells only.
- **Output is bounded in the notebook** (feature invariant 6). Whether the host needs a `limit` input on
  `session.run`, so a huge answer does not cross the sidecar whole, is decided in Phase 03 after measuring it. A
  consumer that needs something the host lacks adds it to the host through a small change there (initiative rule).
- A notebook runs at most one statement at a time, because the host's sidecar answers one request at a time.

## Made exact in Phase 03 (running cells)

- **The sidecar needs no `limit`.** Measured: 50,000 rows came through it in 0.7 s as one 2.3 MiB line (5,000 in 0.35 s),
  so a 200,000-row answer is about 3 s and 9 MiB. The whole answer still crosses the sidecar; the notebook bounds what
  it **renders** (`typedblite.notebook.maxRows`, default 1,000) and counts the rest ("N more rows are not shown").
  A host `limit` is deferred until answers reach millions of rows.
- **Outputs use built-in MIME types, so there is no renderer of our own:** a table is `text/markdown` with a
  `text/plain` fallback, a `fetch` is `application/json`, facts are standard output, a refusal is an error output. A
  value is escaped so nothing in an answer can alter a table or become markup (a `$` would otherwise read as math).
- **A refusal is shown on its cell as an error output** with the engine's own message and its line and column in the cell
  (the host's range for the statement, added to where the statement starts in the cell), and **ends the run**: the cells
  after it are not started. VS Code's own Run All, Run Above and Run Below call one handler, so none needed code.
- **The host's session is not assumed to last.** If the host process was restarted under a notebook, the next statement
  opens a new, empty store and says so in the cell, instead of failing every cell.
- **Restart** is a command (`typedblite.notebook.restart`, on the notebook toolbar) over `session.restart`.

## Made exact in Phase 04 (language services across cells)

- **The schema owner is one rule, `schemaOwnerOf`**, in `@typedblite/language`: a `vscode-notebook-cell:` URI's owner is the URI
  without its fragment (its notebook), and every other document's is the workspace. Every place that reads the index
  filters by it: the scope provider's global scope and a relation's re-opens, the labels service (resolve, candidates, "does
  this schema define anything", the uses of a definition), and the hover's list of re-opens. Completion, rename, the
  nearest-label quick fix and the unknown-label check follow from those.
- **The server advertises notebooks through a subclass of Langium's server**, passed to `createTypeQLiteServices` as a second
  argument (a new optional parameter), and listens for notebook documents. The client's document selector gains the cell scheme.
- **A cell's language comes from its synced `languageId`**, not its URI: a real cell's path ends `.tql.md`, an extension no
  language claims. The library's harness has no synced documents, so its notebooks are named `.tql`; the bundled-server spec
  uses real `.tql.md` cells and `languageId`.
- **The public API grew, and changed a little:** `schemaOwnerOf` and friends are exported, and `workspaceHasSchema`,
  `resolve` and `candidates` take an optional context (workspace by default). The changelog records it.

## Made exact in Phase 05 (store and export)

- **The store is chosen through a dialog, and an explicit argument for a script.** "Choose the Notebook's Store…" offers: open
  an existing file, create one, or go back to memory. A file also needs a **mode**, picked by the user, with the safer
  one first: **hold changes until I commit** (a transaction is held open; Commit and Rollback appear on the toolbar only
  while a notebook holds its changes) or **commit each statement**. There is no default mode applied without the user
  choosing one.
- **It is shown, and never saved or remembered.** The status bar says which file and when a write is permanent. The choice is
  not written into the notebook (a spec and the e2e check the path is not in the file) and not kept between sessions, so a
  shared notebook runs in the reader's memory. Saving a notebook never touches a store.
- **Switching ends the session** and what it held in memory or in an uncommitted transaction is lost, so the user is asked
  first. A path that will not open costs the notebook nothing: the new session is opened before the old one is closed, except for
  the same file, whose old session may hold its write lock.
- **A commit the engine refuses is rolled back** and says why; the notebook goes on holding changes. Closing a notebook with
  uncommitted changes makes none of them permanent. A host restarted under a notebook opens the file again in the same mode.
- **Export** is of the notebook as the editor holds it, edits included: a **script** of the code cells, one blank line apart, and
  **Markdown** with every code cell as a fenced `typeql` block (the guides' spelling), neither with outputs.

## Made exact in Phase 06 (the guide, and packaging)

- **A guide is a notebook.** `docs/guides/reading-list.tql.md` is the TypeQLite half of the five-minute tour, using the tour's own
  statements, and a spec runs it on the real engine host and checks its answers against the tour's. The tour's shell and Node
  halves are not a notebook's, and `given` statements (values supplied by a program) have no notebook form, so they became literals.
  The guide's last cell is refused on purpose, so Run All ends there.
- **The package carries everything the notebook needs:** the `.vsix` is 1.3 MB, with the host bundle, both notebook types and no
  test, source or map; the e2e runs against it.

## Not decided here

How a table and a refusal render (Phase 03), the export formats (Phase 05), and whether a Markdown cell's own
TypeQLite fences are highlighted in the notebook as in the preview (ADR-010 already does it for the preview).
