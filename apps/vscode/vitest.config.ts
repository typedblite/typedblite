import { defineConfig } from 'vitest/config';

import { testDefaults } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...testDefaults('typeqlite-vscode'),
    include: ['test/**/*.test.ts'],
  },
});
