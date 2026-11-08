import {
  categoryOf,
  isMetaAnnotation,
  isOwnsTrait,
  isPlaysTrait,
  isRelatesTrait,
  type Annotation,
  type Trait,
} from '@typedblite/language';

/**
 * The subjects an annotation can sit on, as keys — one shape for the generator that writes
 * `schema_annotation`, the interpreter that loads it, and the rules that read it.
 *
 * 🔴 The record is the schema itself, not a memory of "was this already so": what is written is
 * what the statement said, and a restatement writes the same row. Phase 03's summary records why
 * that distinction matters. It exists because `undefine @card from person owns name` and
 * `redefine … @card(0..1)` must know which annotations a capability carries, and Phase 03
 * recorded only `@key`/`@unique` (as indexes) and `@abstract` (as a set).
 *
 * The separator is ASCII's unit separator (U+001F, shown here as ␟), not the NUL `ownsKey` uses
 * in memory: these keys are written into SQL text by the generator, and SQLite reads that text
 * as a C string — a NUL inside a literal ends the statement (`unrecognized token`, found by the
 * first run). ⚠️ And never the escape `\u0000` in a file written by a tool that decodes JSON
 * escapes: it lands as a literal NUL byte and git sees a binary file. The middle segment names
 * the capability, so a type's own annotations (`person`), its `sub`'s (`person␟sub`), its value
 * type's (`email␟value`), and its traits' (`person␟owns␟name`) cannot collide.
 */
export const SEP = '\u001f';

/**
 * The IN-MEMORY key of `SchemaFacts.owns` — `"person\u0000name"`, NUL-separated, as `interpreter.ts`
 * has keyed it since the ownership check was written. Never written into SQL.
 */
export const ownsKey = (type: string, attribute: string): string => `${type}\u0000${attribute}`;

export const typeSubject = (type: string): string => type;
export const subSubject = (type: string): string => `${type}${SEP}sub`;
export const valueSubject = (attribute: string): string => `${attribute}${SEP}value`;
export const ownsSubject = (owner: string, attribute: string): string => `${owner}${SEP}owns${SEP}${attribute}`;
export const relatesSubject = (relation: string, role: string): string => `${relation}${SEP}relates${SEP}${role}`;
export const playsSubject = (player: string, role: string): string => `${player}${SEP}plays${SEP}${role}`;

/** `employment:employee` — how a played role is named, in the record and in the text. */
export const roleRef = (relation: string, role: string): string => `${relation}:${role}`;

/** The subject key of a trait on `owner`, and the trait's own name for messages. */
export function traitSubject(owner: string, trait: Trait): { subject: string; name: string } {
  if (isOwnsTrait(trait)) {
    const attribute = trait.attribute.$refText;
    return { subject: ownsSubject(owner, attribute), name: `${owner} owns ${attribute}` };
  }
  if (isRelatesTrait(trait)) {
    return { subject: relatesSubject(owner, trait.name), name: `${owner} relates ${trait.name}` };
  }
  if (isPlaysTrait(trait)) {
    const role = roleRef(trait.role.relation.$refText, trait.role.role.$refText);
    return { subject: playsSubject(owner, role), name: `${owner} plays ${role}` };
  }
  throw new Error(`TypeDBLite: unhandled trait kind '${String((trait as { $type?: string }).$type)}'`);
}

/**
 * The record's category: the annotation's, except `@meta`, which is a map keyed by its key — two
 * `@meta` with different keys are two rows, and `undefine @meta("key") from …` names one.
 */
export const recordCategory = (annotation: Annotation): string =>
  isMetaAnnotation(annotation) ? `meta:${annotation.key}` : categoryOf(annotation);

/** The annotation as written — what a restatement must equal, and what a redefine changes. */
export const recordText = (annotation: Annotation): string =>
  (annotation.$cstNode?.text ?? '').replace(/\s+/g, ' ').trim();

