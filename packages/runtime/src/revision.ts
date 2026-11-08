/**
 * 🔴 **Moved to [`@typedblite/content-revision`](../../content-revision/src/lib/revision.ts).**
 *
 * ADR-020 D3's `generation-digest` is content addressing, and a downstream feature's `DocumentVersion`
 * needs it from a `type:domain` library — which the boundary rules forbid depending on this
 * `type:infrastructure` one. Re-exported here so every existing consumer of this engine's barrel is
 * unaffected, and so nobody writes a second implementation.
 *
 * ⚠️ **The parity-oracle warning moved with the file.** If you change those semantics, re-run
 * `nx run typedblite-runtime:test-oracle` — it is not in the routine suite.
 */
export {
  computeRevision,
  conflicts,
  digestOf,
  generationOf,
  winner,
  type Leaf,
  type Revision,
  type RevisionInput,
} from '@typedblite/content-revision';
