import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...testDefaults('typeqlite-language'),
    // 🔴 `test/*.spec.ts`, not `src/`. This project keeps its suites beside the grammar rather
    // than next to the source, so the shared include pattern misses them entirely.
    include: ['test/**/*.spec.ts'],
  },
});
