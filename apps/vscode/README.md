# TypeQLite for VS Code

Language support for **TypeQLite**, the TypeQL 3.x dialect that [TypeDBLite](https://github.com/dave-jackson-dev/typedblite)
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
- **Formatting and semantic highlighting.** A label is coloured by what it resolves to.
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
- Running queries against a database is not part of this extension.
- **The Markdown preview reads your theme's files**, because VS Code offers no other way to get a
  theme's token colours. In a remote window (WSL, SSH, a container) the themes stay in your local
  VS Code, out of this extension's reach. Install the **TypeQLite Theme Bridge** there too (below),
  or the preview shows TypeQLite in its own colours. A theme whose colours are in a `.tmTheme` file gets the preview's own
  colours instead. On GitHub, TypeQLite code blocks are plain: GitHub has no TypeQL grammar, and allows
  no colours of a page's own.

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
