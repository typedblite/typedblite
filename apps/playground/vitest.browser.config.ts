import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

/** `nx run playground:test-browser` — the page and its worker in a real Chromium. */
export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: { ...testDefaults('playground-browser'), include: ['test-browser/**/*.test.ts'], fileParallelism: false },
});
