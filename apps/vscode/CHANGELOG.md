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
- Formatting, and semantic highlighting that colours a label by what it resolves to and keywords by kind.
- TypeQLite code blocks coloured in your theme, in the Markdown preview and the Markdown editor. In a remote
  window, the preview needs the optional TypeQLite Theme Bridge, installed in your local VS Code.
