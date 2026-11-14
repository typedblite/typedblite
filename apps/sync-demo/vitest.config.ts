import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

const defaults = testDefaults('sync-demo');

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...defaults,
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    coverage: {
      ...defaults.coverage,
      // 🔴 Out of the unit floor by name: code that runs only inside a host this runner does not
      // provide, each with where it IS run. Nothing else may be excluded to pass the floor (the
      // launch plan's decision 9). The server, the shared device and the schema stay in, tested here.
      exclude: [
        ...defaults.coverage.exclude,
        // A browser page, its Web Worker (WASM SQLite on OPFS) and its service worker:
        // `test-browser/pwa.test.ts`, in two Chromium profiles. ⚠️ `test-browser` is not run in CI.
        'src/client/main.ts',
        'src/client/worker.ts',
        'src/client/sw.ts',
        'src/client/polyfills.ts',
        // Electron's main process: `test-browser/electron.test.ts`. ⚠️ Not run in CI.
        'src/electron/**',
        // The Playwright demo driver: `test-browser/story.test.ts` runs the whole story headless.
        // ⚠️ Not run in CI.
        'src/driver/**',
        // The hub's process entry: forked by `smoke.test.ts` and `server.test.ts` (both in CI), as a
        // separate process this runner's coverage cannot see.
        'src/hub/main.ts',
        // The `serve` target's entry: it starts `server.ts`, which is tested, and waits.
        'src/server/main.ts',
      ],
    },
  },
});
