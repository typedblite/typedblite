# TypeQLite Theme Bridge

A helper for the **TypeQLite** extension. You need it only if you use VS Code in a **remote window**:
WSL, SSH, or a dev container.

TypeQLite colours the TypeQLite code blocks in the Markdown preview with your colour theme. In a
remote window, though, TypeQLite runs on the remote machine, and your colour themes stay in the local
VS Code, out of its reach. This extension runs in the local VS Code, reads the active theme's files
there, and hands them to TypeQLite when it asks. It does nothing else and has no settings.

Without it, a remote window's preview shows TypeQLite in the preview's own colours, and the
TypeQLite output channel says why.

## Install

Install it in the **local** VS Code, beside TypeQLite. Build both from the TypeDBLite repository:

```bash
npm exec nx -- run typeqlite-vscode:package
code --install-extension apps/vscode/dist/typeqlite-theme-0.0.1.vsix
```

## License

[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/).
