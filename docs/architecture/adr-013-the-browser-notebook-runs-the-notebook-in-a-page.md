---
kind: adr
status: accepted
date: 2026-11-19
decision-owners: [Founder, TypeDBLite maintainers]
extends: [adr-009, adr-012]
---

# ADR-013: The browser notebook runs the notebook in a page, on WASM SQLite

- **Status:** Accepted on 2026-11-19. The founder chose a browser notebook whose content is the TypeQLite half of the
  five-minute tour.
- **Date:** 2026-11-19
- **Decision owners:** Founder; TypeDBLite maintainers
- **Extends:** [ADR-009](adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md) (the engine runs in a browser on WASM
  SQLite) and [ADR-012](adr-012-the-notebook-is-a-markdown-file-run-on-the-engine-host.md) (the notebook's file format,
  runner and outputs).

---

## Context

A reader of the site could run TypeQLite in the playground: three examples, or a program of their own, in one editor,
but not a guided walk through the language. The five-minute tour had become
a notebook (ADR-012) that needs VS Code and Node. The founder wanted a "try it in the browser" page: the tour's TypeQLite
half, run in the page, with no installation and no server. Cloudflare cannot host a code-server, and this does not need
one: everything the notebook needs runs in a browser already.

## Decision

**B1. The page is the notebook, not a new thing.** The document is `docs/guides/try-it.tql.md`, a `.tql.md` notebook, so
it also opens in VS Code. The page reads it at build time (`try-data.json`), and shows its prose as Markdown and its
code blocks as cells. Nothing is edited in or saved to the document.

**B2. The notebook's pure logic is one library, `@typedblite/notebook`** (private). The file format, the cell runner, the
output model, the session bookkeeping and the export moved out of the extension into it, with their tests, so the
extension and the page run a cell by the same code. The extension keeps only what needs VS Code.

**B3. The kernel is a session in a worker, behind the host's operation names.** `@typedblite/session` takes an `openDatabase`
option (the runtime already did), and the page's kernel (`apps/playground/src/notebook/kernel-core.ts`) is a thin adapter
that answers the host's operations (`statement.split`, `session.open`, `session.run`, `session.restart`, `session.close`)
over a `Session` on `openWasmSqlite`. The shared runner cannot tell it from the engine host. It opens only `:memory:`: a
file has no meaning in a page.

**B4. Each cell is a Monaco editor, and the real language server runs in a worker.** Cells are documents of one notebook
under `vscode-notebook-cell:` URIs, so a label defined in a cell above resolves below, as in VS Code (ADR-012 N4).

**B5. What a statement answers is drawn as text.** Every output is set with `textContent`, so a value such as `<img onerror>`
is shown, never run.

**B6. The site's page is the same fragment.** `apps/playground/src/notebook.html` is the markup; the standalone `try.html`
and the website's `/try/` (a Starlight page) wrap it. Its scripts, workers and `.wasm` are the playground's build output,
served at `/playground/`.

## Consequences

- The tour's printed answers and this page's are held to what runs: `try-it-journey.test.ts` plays the document on the
  browser kernel in Node, and `test-browser/notebook.test.ts` plays it through the page in Chromium on WASM.
- Writing the page found a bug in the language server that VS Code shared: the semantic-token provider kept one document
  and builder in fields while a walk yielded, so a notebook's cells, asked for at once, got one another's tokens
  (`TypeQLiteSemanticTokenProvider` now answers one request at a time).
- The page has no store to choose, no Commit mode and no export; they need a file or a VS Code. It says it runs in memory.
- A change to the document's links must also be added to `LINKS` in `apps/playground/build.mjs`, which fails the build
  for a link the site does not have.
