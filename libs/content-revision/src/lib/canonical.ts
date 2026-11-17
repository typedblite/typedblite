/**
 * Canonical encoding of an entity's state, and the identity a change log records it under.
 *
 * Implements [ADR-003](../../../../docs/architecture/adr-003-typedblite-change-log-and-sync-as-a-port.md)
 * Decision 3. Two nodes must produce byte-identical output for the same logical state, because the
 * revision digest is derived from it — a disagreement here manufactures conflicts that look like
 * data corruption rather than like a bug in this file.
 */

/** One attribute of a thing. Values are TEXT in storage, so the encoding does not type them. */
export interface CanonicalAttribute {
  /** The attribute type's label. */
  readonly type: string;
  /** The value, as the text it is stored as. */
  readonly value: string;
}

/** One role a thing plays, naming the *entity id* of the player — never a local `iid`. */
export interface CanonicalRole {
  /** The role's label. */
  readonly role: string;
  /** The entity id of the thing playing it. */
  readonly player: string;
}

/**
 * Everything about a thing that a revision covers: its type, its attributes and the roles it plays. What
 * {@link canonical} encodes and {@link computeRevision} hashes.
 */
export interface EntityState {
  /** The thing's type label. */
  readonly type: string;
  /** Its attributes, in any order: the encoding sorts them. */
  readonly attributes: readonly CanonicalAttribute[];
  /** The roles it plays, in any order: the encoding sorts them. */
  readonly roles: readonly CanonicalRole[];
}

/**
 * 🔴 Length-prefixed, not delimiter-separated.
 *
 * An attribute value is arbitrary user text and may contain any separator we might pick. With
 * `name:value|name:value` a value of `x|title:y` forges a second field, so two different states
 * encode identically and are treated as the same revision — a silent merge of unrelated data. A
 * length prefix makes the structure unforgeable regardless of content.
 */
function field(text: string): string {
  return `${text.length}:${text}`;
}

/** Sort is by encoded field, so ordering cannot depend on locale or on insertion order. */
function sortedAttributes(
  attributes: readonly CanonicalAttribute[],
): readonly string[] {
  return attributes
    .map((a) => `${field(a.type)}${field(a.value)}`)
    .slice()
    .sort();
}

function sortedRoles(roles: readonly CanonicalRole[]): readonly string[] {
  return roles
    .map((r) => `${field(r.role)}${field(r.player)}`)
    .slice()
    .sort();
}

/**
 * The canonical form. Deterministic for a given logical state and independent of the order the
 * caller happened to collect attributes or roles in.
 *
 * An attribute that is absent and one that is present with an empty value encode differently: the
 * first contributes nothing, the second contributes a field of length zero. That distinction is
 * deliberate — they are different states and must not share a revision.
 */
export function canonical(state: EntityState): string {
  const attributes = sortedAttributes(state.attributes);
  const roles = sortedRoles(state.roles);
  return [
    `t${field(state.type)}`,
    `a${attributes.length}:${attributes.join('')}`,
    `r${roles.length}:${roles.join('')}`,
  ].join('');
}
