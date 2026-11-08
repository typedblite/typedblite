import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

import {
  swcDecoratorMetadata,
  testDefaults,
  workspaceAliases,
} from '../../../../vitest.shared';

/**
 * SPIKE — the runtime's own suite, run against the WASM SQLite binding instead of `node:sqlite`.
 *
 * `node-sqlite.ts` is the one file that imports `node:sqlite`, so redirecting it is the whole
 * swap: no production code or test is edited. Run with `npx vitest run -c vitest.wasm.config.ts`.
 *
 * Expect failures that are the binding's honest limits rather than bugs: a real file that survives
 * a restart, and several processes sharing one file. The 21 expected failures are classified in
 * `docs/analysis/typedblite-wasm-engine-spike.md`.
 */
const wasmOpener = fileURLToPath(
  new URL('./spike/wasm-opener.ts', import.meta.url),
);

const useWasmBinding = (): Plugin => ({
  name: 'typedblite-use-wasm-sqlite',
  enforce: 'pre',
  resolveId(source, importer) {
    if (
      importer !== undefined &&
      /\/src\//.test(importer) &&
      /(^|\/)node-sqlite\.js$/.test(source)
    )
      return wasmOpener;
    return null;
  },
});

export default defineConfig({
  plugins: [useWasmBinding(), swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...testDefaults('typedblite-runtime-wasm'),
    include: ['test/**/*.test.ts'],
    exclude: ['test/fts-parity.test.ts'],
    setupFiles: ['./spike/vitest-setup.ts'],
  },
});
