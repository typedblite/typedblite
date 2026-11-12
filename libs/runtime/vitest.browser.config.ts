import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

/** `nx run typedblite-runtime:test-browser` — the engine in a real Chromium (ADR-009). See `test-browser/opfs.test.ts`. */
export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...testDefaults('typedblite-runtime-browser'),
    include: ['test-browser/**/*.test.ts'],
    fileParallelism: false,
  },
});
