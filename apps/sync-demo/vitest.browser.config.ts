import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

/** `nx run sync-demo:test-browser` — the client in a real Chromium. */
export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: { ...testDefaults('sync-demo-browser'), include: ['test-browser/**/*.test.ts'], fileParallelism: false },
});
