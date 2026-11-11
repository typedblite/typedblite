/**
 * Replication **identity** — which entity two nodes agree they are describing.
 *
 * 🔴 **This is the half of the old `canonical.ts` that did not move.** The canonical *encoding* and
 * the revision generator derived from it are content addressing, and a downstream feature needs them
 * from a `type:domain` library — which may not depend on `type:infrastructure`, so they now live in
 * [`@typedblite/content-revision`](../../content-revision/src/lib/canonical.ts). What stays here
 * is the part that is genuinely about *this engine's* replication: a `local:` id is a TypeDBLite
 * storage fact, not a property of content.
 */
import type { CanonicalAttribute } from '@typedblite/content-revision';

export type {
  CanonicalAttribute,
  CanonicalRole,
  EntityState,
} from '@typedblite/content-revision';
export { canonical } from '@typedblite/content-revision';

/**
 * The identity a change log records an entity under.
 *
 * 🔴 **Never `thing.iid`.** That is `last_insert_rowid()`, so two nodes both call their first
 * entity `1` and replication would merge unrelated things. Identity is the `@key` attribute's
 * value, which is what makes two nodes agree they are describing the same entity — and which the
 * schema already enforces as unique via a partial `UNIQUE INDEX ON has(attribute) WHERE type = <key>`:
 * one key attribute instance, owned once (ADR-006).
 *
 * Keyless things have **no cross-node identity** and are marked `local:` so replication can refuse
 * them rather than silently inventing an equivalence. See `isReplicable`.
 */
export function entityId(
  type: string,
  keyAttribute: CanonicalAttribute | undefined,
  fallbackLocalId: number,
): string {
  if (!keyAttribute) return `local:${type}/${fallbackLocalId}`;
  return `${type}/${keyAttribute.value}`;
}

/** Whether an entity id names something two nodes could agree on. */
export function isReplicable(id: string): boolean {
  return !id.startsWith('local:');
}
