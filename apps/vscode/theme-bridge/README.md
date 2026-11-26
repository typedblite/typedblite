# TypeQLite Theme Bridge

A helper for the **TypeDBLite** extension. You need it only if you use VS Code in a **remote window**:
WSL, SSH, or a dev container.

The TypeDBLite extension colors the TypeQLite code blocks in the Markdown preview with your color theme. In a
remote window, though, the TypeDBLite extension runs on the remote machine, and your color themes stay in the local
VS Code, out of its reach. This extension runs in the local VS Code, reads the active theme's files
there, and hands them to the TypeDBLite extension when it asks. It does nothing else and has no settings.

Without it, a remote window's preview shows TypeQLite in the preview's own colors, and the
TypeQLite output channel says why.

## Install

Install it in the **local** VS Code, beside the TypeDBLite extension. It is published on
[Open VSX](https://open-vsx.org/extension/typedblite/typeqlite-theme). To build both from the TypeDBLite repository instead:

```bash
npm exec nx -- run typeqlite-vscode:package
code --install-extension apps/vscode/dist/typeqlite-theme-0.3.2.vsix
```

## License

[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/).
