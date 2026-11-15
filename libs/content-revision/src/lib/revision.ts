// 🔴 **If you change the semantics in this file, every store stops converging with every other.**
// CouchDB's revision-tree behaviour is kept here on purpose (ADR-003), and it was proven against real
// CouchDB 3.4.3 in TypeDBLite Sync Phase 03. That differential suite has since been removed, so
// nothing re-checks CouchDB parity. `revision.spec.ts` and `sha256.spec.ts` pin today's behaviour,
// including that the digest equals what `node:crypto` gave before ADR-009; keep them green.
/**
 * Revision identifiers for the change log.
 *
 * Implements [ADR-003](../../../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)
 * Decision 3: `rev` is `generation-digest`, and the digest is **derived** from the state rather than
 * randomised. That is what makes the same edit, applied to the same parent on two nodes, produce
 * the same revision — so independent identical edits converge instead of manufacturing a conflict
 * for two writers who agreed.
 */
import { canonical, type EntityState } from './canonical.js';
import { sha256Hex } from './sha256.js';

/** `generation-digest`, e.g. `2-9f86d081884c7d659a2feaa0c55ad015`. */
export type Revision = string;

const DIGEST_LENGTH = 32;

export interface RevisionInput {
  /** Absent for a tombstone, which has no state. */
  readonly state?: EntityState;
  readonly parent?: Revision;
  readonly deleted?: boolean;
}

export function generationOf(rev: Revision): number {
  const generation = Number(rev.slice(0, rev.indexOf('-')));
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`Malformed revision, expected <generation>-<digest>: ${rev}`);
  }
  return generation;
}

export function digestOf(rev: Revision): string {
  return rev.slice(rev.indexOf('-') + 1);
}

/**
 * 🔴 The separator is `\0`, and the parts are length-prefixed by `canonical` already.
 *
 * Concatenating with a printable separator would let a crafted attribute value shift the boundary
 * between state and parent, so two different revisions hash alike. `\0` cannot appear in a
 * revision, and the state's own encoding is unforgeable.
 */
export function computeRevision(input: RevisionInput): Revision {
  const generation = input.parent ? generationOf(input.parent) + 1 : 1;
  const body = input.state ? canonical(input.state) : '';
  // One string, hashed once: the same bytes `update(body).update('\0')…` fed `node:crypto`.
  const digest = sha256Hex(`${body}\0${input.parent ?? ''}\0${input.deleted ? '1' : '0'}`)
    .slice(0, DIGEST_LENGTH);
  return `${generation}-${digest}`;
}

/**
 * The winner among an entity's leaves, per ADR-003 Decision 3. Total: live beats tombstone, then
 * highest generation, then greatest digest. A tie at the last step would require equal digests,
 * which by derivation means the same revision rather than two distinct ones.
 *
 * Deliberately consults nothing else — not insertion order, not arrival order, not a clock. Those
 * are exactly what differ between nodes, and a rule reading any of them picks a different winner on
 * each, which is divergence rather than a conflict.
 */
export interface Leaf {
  readonly rev: Revision;
  readonly deleted: boolean;
}

export function winner(leaves: readonly Leaf[]): Leaf | undefined {
  if (leaves.length === 0) return undefined;
  const live = leaves.filter((leaf) => !leaf.deleted);
  const candidates = live.length > 0 ? live : leaves;
  return candidates.reduce((best, leaf) => {
    const bestGeneration = generationOf(best.rev);
    const leafGeneration = generationOf(leaf.rev);
    if (leafGeneration !== bestGeneration) {
      return leafGeneration > bestGeneration ? leaf : best;
    }
    return digestOf(leaf.rev) > digestOf(best.rev) ? leaf : best;
  });
}

/** Every leaf that is not the winner — the equivalent of CouchDB's `_conflicts`. */
export function conflicts(leaves: readonly Leaf[]): readonly Leaf[] {
  const won = winner(leaves);
  return won ? leaves.filter((leaf) => leaf.rev !== won.rev) : [];
}

/**
 * The newest of a set of versioned rows, or `undefined` when there are none — `winner()`'s total
 * order, applied to whatever a caller's own row shape is, rather than each caller mapping to
 * `Leaf` and finding its own row back by hand.
 *
 * 🔴 **Promoted here after two bounded contexts of a downstream application wrote the identical six
 * lines** (code review, 2026-09-13, reuse angle): both
 * were already fully generic over `{ revision: Revision }`, so the second one was a copy with a new
 * name, not a genuinely different operation. Neither domain package depends on the other; both may
 * depend on this one.
 *
 * ⚠️ **Every version is treated as live** (`deleted: false`) — a domain that ever needs to exclude a
 * tombstoned version from "latest" is a different question this function does not yet answer, not
 * a bug in it.
 */
export function latestOf<T extends { readonly revision: Revision }>(
  versions: readonly T[],
): T | undefined {
  const won = winner(versions.map((version) => ({ rev: version.revision, deleted: false })));
  return won === undefined
    ? undefined
    : versions.find((version) => version.revision === won.rev);
}
