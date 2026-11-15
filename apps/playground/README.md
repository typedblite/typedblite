# TypeDBLite playground

Try TypeQLite in a browser, with nothing to install. The engine is TypeDBLite on WASM SQLite, running in a Web
Worker. Each run starts from an empty in-memory database, and nothing leaves the page.

```bash
npm exec nx -- run playground:serve      # then open http://127.0.0.1:4400
```

## Using it

Pick an example or write a program, then press **Run** (or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>).
**Copy link** puts the whole program in the URL after `#code=`, so a link reproduces a run exactly, and no
server holds it.

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
| `src/main.ts`, `src/index.html` | The page. Everything drawn from a program's output goes in through `textContent` |
| `src/examples.ts` | Three examples, each run by a test |
| `build.mjs` | esbuild bundles the page and worker into `.build/`, with `sqlite3.wasm`. Every URL is relative |

It imports only the public packages, `@typedblite/runtime` (the browser entry, chosen by the bundler's `browser`
condition) and `@typedblite/language`.

## Tests

```bash
npm exec nx -- run playground:test           # unit tests, with the coverage floor
npm exec nx -- run playground:test-browser   # the page and worker in a real Chromium
```

The browser test needs Playwright's Chromium (`npx playwright-core install chromium`). It checks that the engine
runs in a worker, that nothing is requested from another origin, that a program's text is shown as text and never
becomes an element (and that breaking this fails the test), that a shared link reproduces a program, and that the
page fits a phone.

## Not done

- **Hosting.** `.build/` is static files and can be served from any path, but nothing publishes it yet.
  Build it with `node build.mjs --minify`: the worker is 2.7 MB unminified.
- **Syntax highlighting.** The editor is a plain text area. The TextMate grammar the VS Code extension uses
  could colour it.
- **A real-browser test of Stop.** The timeout and stop logic is tested with a fake worker, because a query that
  reliably runs long is not a thing a test can make.
