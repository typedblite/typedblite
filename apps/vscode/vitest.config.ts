import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { testDefaults } from '../../vitest.shared';

const defaults = testDefaults('typeqlite-vscode');

export default defineConfig({
  test: {
    ...defaults,
    include: ['test/**/*.test.ts'],
    coverage: {
      ...defaults.coverage,
      // 🔴 Out of the unit floor by name: code that runs only inside a host this runner does not provide, each with where it
      // IS run. Nothing else may be excluded to pass the floor (the launch plan's decision 9). What the notebook decides
      // lives in modules that stay in and are tested here (the format, the runner, the sessions, the outputs, the export).
      exclude: [
        ...defaults.coverage.exclude,
        // VS Code's notebook controller, status bar and commands: they call `vscode.notebooks` and `vscode.window`, which exist
        // only in the extension host. `e2e/suite.ts` runs them in a real VS Code against the installed `.vsix` (Run All, a
        // refusal on its cell, restart, choosing a store, Commit, the exports).
        'src/notebook/controller.ts',
        'src/notebook/store-commands.ts',
        // The language server's notebook capability: it runs in the bundled server, a separate process this runner's coverage
        // cannot see. `test/notebook-server.test.ts` drives that bundle over stdio.
        'src/language-server/notebook-sync.ts',
      ],
    },
  },
  resolve: {
    // 🔴 `vscode` exists only inside VS Code's extension host. Modules that import it are unit-tested
    // against a fake of the parts they call; the real thing is the e2e suite's job (ADR-008 D7).
    alias: { vscode: fileURLToPath(new URL('./test/fakes/vscode.ts', import.meta.url)) },
  },
});
