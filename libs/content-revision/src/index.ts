/**
 * Canonical state encoding and content-derived `generation-digest` revision identifiers (ADR-003 D3).
 *
 * A thing's revision is derived from its content, so two nodes that write the same state arrive at the same revision
 * without talking to each other. `canonical` fixes what "the same state" means, as a byte string, and `computeRevision`
 * hashes it with the revision before it. The runtime's change log is built on these; they have no dependency of their
 * own and run anywhere JavaScript does.
 *
 * @categoryDescription Canonical form
 * The state a revision covers, and its encoding as text that does not depend on the order things were written in.
 *
 * @categoryDescription Revisions
 * Deriving a revision identifier, reading one, and choosing between revisions that disagree.
 *
 * @module @typedblite/content-revision
 */
export * from './lib/canonical.js';
export * from './lib/revision.js';
