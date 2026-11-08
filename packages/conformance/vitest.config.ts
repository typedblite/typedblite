import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...testDefaults('typedblite-conformance'),
    include: ['test/**/*.test.ts'],
    // 935 scenarios, each with its own in-memory interpreter. Well under this on a warm machine,
    // but the first run after a langium-generate is not warm.
    testTimeout: 120_000,
  },
});
