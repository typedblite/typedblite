import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

const defaults = testDefaults('playground');

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...defaults,
    include: ['test/**/*.test.ts'],
    coverage: {
      ...defaults.coverage,
      // 🔴 Out of the unit floor by name, each for a reason no unit test can meet, and each says where
      // it IS run. Nothing else may be excluded to pass the floor (the launch plan's decision 9).
      exclude: [
        ...defaults.coverage.exclude,
        // The page and its worker run only in a browser: `test-browser/playground.test.ts`, in Chromium.
        'src/main.ts',
        'src/editor.ts',
        'src/worker.ts',
        'src/language-worker.ts',
        'src/polyfills.ts',
        // The browser notebook's page, its cell editors and its kernel's worker: DOM, Monaco and a Worker. Run in Chromium by
        // `test-browser/notebook.test.ts`. Its kernel (`kernel-core.ts`) and client (`kernel-client.ts`) are unit tested.
        'src/notebook/notebook.ts',
        'src/notebook/notebook-page.ts',
        'src/notebook/cell-editor.ts',
        'src/notebook/kernel-worker.ts',
        // The `serve` target's entry: it starts the static server, which is tested.
        'src/dev/serve.ts',
      ],
    },
  },
});
