import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { testDefaults } from '../../vitest.shared';

export default defineConfig({
  test: {
    ...testDefaults('typeqlite-vscode'),
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    // 🔴 `vscode` exists only inside VS Code's extension host. Modules that import it are unit-tested
    // against a fake of the parts they call; the real thing is the e2e suite's job (ADR-008 D7).
    alias: { vscode: fileURLToPath(new URL('./test/fakes/vscode.ts', import.meta.url)) },
  },
});
