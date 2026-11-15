import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../vitest.shared';

/**
 * The runtime's own suite, run on the WASM SQLite binding (`@typedblite/runtime/wasm`) instead of
 * `node:sqlite` — `nx run typedblite-runtime:test-wasm`
 * ([ADR-009](../../docs/architecture/adr-009-typedblite-runs-in-the-browser-on-wasm-sqlite.md)).
 *
 * The interpreter's default opener is the conditional `#default-opener`; pointing it at the WASM
 * opener is the whole swap. No production code or test is edited.
 *
 * Tests that need what only a real file on a real disk gives — another process on the same file, a
 * second connection to inspect it, WAL — are the binding's limits, not defects, and are excluded
 * by name below with the reason (and one test in `schema-lists.test.ts` skips itself under
 * `TYPEDBLITE_SQLITE=wasm`). Everything else must pass.
 */
const WASM_LIMITS = [
  // A second `new DatabaseSync(path)` inspects the file the engine wrote; under memdb it is another database.
  'test/schema-record.test.ts',
  'test/attribute-ownership-check.test.ts',
  'test/role-player-index.test.ts',
  'test/schema-refusals.test.ts',
  // A legacy store forged on a real file through `DatabaseSync`, then reopened by the engine.
  'test/attribute-storage-migration.test.ts',
  'test/legacy-relation-schema.test.ts',
  // Child processes sharing one file, or killed mid-transaction: a browser has no second process on a file.
  'test/durability.test.ts',
  'test/hub-and-spoke.test.ts',
  'test/transaction-crash.test.ts',
  'test/transaction.test.ts',
  'test/write-lock-contention.test.ts',
  // WAL is a property of a real file; memdb and OPFS report another journal mode.
  'test/journal-mode.test.ts',
  // Needs a live Nouveau index of an external documentation store (the on-demand oracle).
  'test/fts-parity.test.ts',
];

const wasmOpener = fileURLToPath(new URL('./test/support/default-opener.wasm.ts', import.meta.url));

export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: {
    alias: [
      { find: '#default-opener', replacement: wasmOpener },
      ...workspaceAliases().filter((alias) => alias.find !== '#default-opener'),
    ],
  },
  test: {
    ...testDefaults('typedblite-runtime-wasm'),
    include: ['test/**/*.test.ts'],
    exclude: WASM_LIMITS,
    setupFiles: ['./test/support/wasm-setup.ts'],
    // Lets a test that is a binding limit inside an otherwise portable file skip by name.
    env: { TYPEDBLITE_SQLITE: 'wasm' },
  },
});
