/**
 * A concept's iid as TypeQL writes it — `0x…` hex — for `$x iid 0x…` and `iid($x)` (match.feature
 * L948, expression.feature L1351).
 *
 * 🔴 **TypeDBLite's own numbering, in TypeDB's shape.** A TypeDB iid is its storage key — a prefix byte
 * for the kind, the type's id, the object's id — and nothing outside the server can compute one. What
 * the spec asks of an iid is that it round-trips: `iid($x)` answers the text `$x iid …` finds `$x` by,
 * and an iid no concept has finds nothing. So a thing's iid is a kind byte and its `thing.iid` (eight
 * bytes), and an attribute's — which has no row id since ADR-006, being its type and value — is a
 * kind byte and the UTF-8 of `type NUL value`, which a label can never contain and UTF-8 never
 * produces. Any other hex decodes to nothing and matches nothing, as TypeDB's
 * `0x1e00000000001234567890` (L734) must.
 */

const ENTITY = '1e';
const RELATION = '1f';
const ATTRIBUTE = '20';

export type DecodedIid =
  | { readonly kind: 'thing'; readonly relation: boolean; readonly id: number }
  | { readonly kind: 'attribute'; readonly type: string; readonly value: string };

const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

export const thingIid = (relation: boolean, id: number): string =>
  `0x${relation ? RELATION : ENTITY}${id.toString(16).padStart(16, '0')}`;

export const attributeIid = (type: string, value: string): string => `0x${ATTRIBUTE}${hexOf(type)}00${hexOf(value)}`;

export const decodeIid = (text: string): DecodedIid | undefined => {
  const hex = text.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) return undefined;
  const prefix = hex.slice(0, 2);
  const body = hex.slice(2);
  if (prefix === ENTITY || prefix === RELATION) {
    if (body.length !== 16) return undefined;
    const id = Number.parseInt(body, 16);
    return Number.isSafeInteger(id) ? { kind: 'thing', relation: prefix === RELATION, id } : undefined;
  }
  if (prefix === ATTRIBUTE) {
    const bytes = Buffer.from(body, 'hex');
    const nul = bytes.indexOf(0);
    if (nul <= 0) return undefined;
    return { kind: 'attribute', type: bytes.subarray(0, nul).toString('utf8'), value: bytes.subarray(nul + 1).toString('utf8') };
  }
  return undefined;
};
