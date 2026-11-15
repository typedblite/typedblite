import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...testDefaults('typedblite-runtime'),
    include: ['test/**/*.test.ts'],
    // 🔴 **`fts-parity.test.ts` is not in the routine run** — see `vitest.oracle.config.ts`. It
    // needs a live Nouveau index of an external documentation store; re-runnable on demand:
    // `nx run typedblite-runtime:test-oracle`.
    exclude: ['test/fts-parity.test.ts'],
  },
});
