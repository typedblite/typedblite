import { defineConfig } from 'vitest/config';

import { swcDecoratorMetadata, testDefaults, workspaceAliases } from '../../../../vitest.shared';

/**
 * `fts-parity.test.ts`, run **on demand** rather than on every commit — it needs a live
 * `downstream-store` Nouveau index to compare against.
 *
 * 🔴 **`couchdb-oracle.test.ts` and its CouchDB/PouchDB differential-conflict oracle were removed
 * by PouchDB Dependency Removal Phase 00** (2026-09-15) along with every other PouchDB reference in
 * this repository — this config's `include` used to name it too. That suite checked a claim this
 * config's own history called load-bearing: that TypeDBLite's revision-tree conflict model
 * (multi-version winners, an edit beating a concurrent delete) agrees with real CouchDB's. **That
 * coverage is now gone, not superseded** — TypeDB conformance (ADR-055) checks TypeQL query
 * execution, not replication/conflict semantics, so it does not stand in for what this suite
 * checked. Recorded as a real, disclosed loss in that phase's own summary.md, not silently dropped.
 */
export default defineConfig({
  plugins: [swcDecoratorMetadata()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...testDefaults('typedblite-runtime-oracle'),
    include: ['test/fts-parity.test.ts'],
  },
});
