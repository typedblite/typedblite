# TypeDBLite playground

Try TypeQLite in a browser, with nothing to install. The engine is TypeDBLite on WASM SQLite, running in a Web
Worker. Each run starts from an empty in-memory database, and nothing leaves the page.

```bash
npm run playground                       # then open http://127.0.0.1:4400
```

## Using it

Pick an example or write a program, then press **Run** (or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>).
**Copy link** puts the whole program in the URL after `#code=`, so a link reproduces a run exactly, and no
server holds it.

The editor is [Monaco](https://microsoft.github.io/monaco-editor/), with the **real TypeQLite language server**
behind it over LSP, in a worker. It is the server the VS Code extension runs, so you get what the extension gives:
errors underlined as you type, completion (<kbd>Ctrl</kbd> + <kbd>Space</kbd>), hover, go to definition
(<kbd>F12</kbd>) and references, rename (<kbd>F2</kbd>), quick fixes, an outline, folding, formatting
(<kbd>Shift</kbd> + <kbd>Alt</kbd> + <kbd>F</kbd>), and names coloured by what they resolve to.

A program is a list of statements. The page splits it with the language library's own parser, so a `define`
block with many definitions is one statement. **A statement that follows a write or a query ends with `end;`.**
In TypeQL 3, a `match` after an `insert` is the next stage of the same pipeline, not a new query, and the page
says so in its footer.

- A program with a syntax error anywhere runs nothing, and the error names its line.
- A statement that fails stops the run there. The error names its line, with a **Go to line** button.
- A write also shows what it inserted, and the engine's own notes: what was written, and why an answer was empty.
- At most 1,000 rows of an answer are drawn; the rest are counted.
- A run that takes longer than 10 seconds is ended, by terminating its worker, and the next run starts a fresh one.

## How it is built

| File | What it is |
| --- | --- |
| `src/run.ts` | `runProgram(source, open)`: split, classify (schema, write or read, from the AST), run, describe as plain data. Runs on `node:sqlite` in the unit tests and on WASM in the page |
| `src/worker.ts` | The engine in a worker: `initWasmSqlite`, then a fresh `:memory:` interpreter per run |
| `src/runner-client.ts` | Runs programs in the worker one at a time, and ends one that does not finish |
| `src/share.ts` | A program in a URL hash |
| `src/editor.ts` | The Monaco editor, and Monaco's own LSP client pointed at the language worker |
| `src/language-server.ts` | `serve(connection)`: `startLanguageServer` over `createTypeQLiteServices`, the extension's server |
| `src/language-worker.ts` | That server in a worker, over `vscode-languageserver/browser` |
| `src/highlighting.ts` | The base colouring a tokenizer can do from text (keywords, strings, comments), built from the language package's `KEYWORD_SCOPES`, and the light and dark themes |
| `src/main.ts`, `src/app.html`, `src/app.css`, `src/index.html` | The page. `app.html` is the markup and `app.css` the styles (scoped to `.pg`, colours from `--pg-*` custom properties): `index.html` is the standalone page around them, and the website's `/playground/` is a Starlight page around the same two files. `scheme.ts` follows the host page's `data-theme`. Everything drawn from a program's output goes in through `textContent` |
| `src/examples.ts` | Three examples, each run by a test |
| `build.mjs` | esbuild bundles the page and worker into `.build/`, with `sqlite3.wasm`. Every URL is relative |

It imports only the public packages, `@typedblite/runtime` (the browser entry, chosen by the bundler's `browser`
condition) and `@typedblite/language`.

**Why Monaco's own LSP client.** Monaco 0.57 ships one (`lsp.MonacoLspClient`, with `createTransportToWorker`),
which wires completion, hover, definition, references, rename, code actions, symbols, folding, formatting, semantic
tokens and diagnostics to a server. It speaks to `vscode-languageserver/browser` as it is. The alternative,
`monaco-languageclient`, replaces Monaco with the `monaco-vscode-api` stack, which is a much bigger dependency tree
for nothing this page needs. Two build details follow from how Monaco is packaged: its `exports` map rewrites
`monaco-editor/<x>.js` to `esm/vs/<x>.js`, so the core API is `monaco-editor/editor/editor.api.js`, and its LSP
client lives outside `esm/vs`, where no public subpath reaches it, so `build.mjs` aliases it and
`tsconfig.client.json` maps its types.

## Tests

```bash
npm exec nx -- run playground:test           # unit tests, with the coverage floor
npm exec nx -- run playground:test-browser   # the page and worker in a real Chromium
```

The browser test needs Playwright's Chromium (`npx playwright-core install chromium`). It checks that the engine
runs in a worker, that nothing is requested from another origin, that a program's text is shown as text and never
becomes an element (and that breaking this fails the test), that a shared link reproduces a program, and that the
page fits a phone. It also drives the editor: the language server is spoken to over LSP (the page's messages to its
worker are recorded and checked), names are coloured by what the server resolved them to, errors are underlined and
clear when fixed, and completion, hover and formatting work. Each of those fails if the language client is switched
off. `test/language-server.test.ts` runs the server alone over the real protocol in Node.

## Not done

- **Hosting.** `.build/` is static files and can be served from any path. The website (`apps/website`) hosts the playground at `/playground/`, in its own layout, and has not been published yet.
  Build it with `node build.mjs --minify`: a first visit is about 2.1 MB gzipped (Monaco is 1.1 MB of it, the
  run worker 0.3 MB, the SQLite engine 0.4 MB, the language server 0.2 MB).
- **A real-browser test of Stop.** The timeout and stop logic is tested with a fake worker, because a query that
  reliably runs long is not a thing a test can make.
