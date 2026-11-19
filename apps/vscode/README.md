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
- **Formatting and semantic highlighting.** A label is coloured by what it resolves to. Keywords are
  coloured by kind (`define`, `entity`, `string` and `@key` each look different), with the same
  scopes as TypeDB's TypeQL extension, so your theme colours TypeQLite as it colours TypeQL.
- **TypeQLite in the Markdown editor.** Code fenced as `typeql`, `typeqlite` or `tql` is highlighted
  while you write the Markdown, not only in its preview.
- **TypeQLite in the Markdown preview.** Code blocks fenced as `typeql`, `typeqlite` or `tql` are
  highlighted as the editor would highlight them, in your colour theme, and again when it changes. The
  blocks on one page are read together, so a schema in one block resolves the labels in the next.

## Unknown labels, and why they are only warnings

In TypeDB the schema lives in the database, not beside the query. So:

- In a workspace that defines **no** types, a query's labels are never reported as unknown. They are
  coloured by position.
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
  theme's token colours. In a remote window (WSL, SSH, a container) the themes stay in your local
  VS Code, out of this extension's reach. Install the **TypeQLite Theme Bridge** there too (below),
  or the preview shows TypeQLite in its own colours. A theme whose colours are in a `.tmTheme` file gets the preview's own
  colours instead. On GitHub, TypeQLite code blocks are plain: GitHub has no TypeQL grammar, and allows
  no colours of a page's own.

## The engine host

The extension ships the TypeDBLite **engine host**, a separate process that runs TypeQLite statements in sessions
([ADR-011](../../docs/architecture/adr-011-the-workbench-runs-typeqlite-in-a-separate-engine-host-process.md)). It
is a bundle inside the `.vsix` (`out/host/sidecar.cjs`), and the extension **never imports it**: it runs it with a
`node` and sends it operations over the sidecar (JSON lines on stdio).

- **It starts on the first request**, not when a `.tql` file opens, so using the editor costs nothing.
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
licence text.
