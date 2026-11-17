import {
  isBooleanLiteral,
  isDateLiteral,
  isDatetimeLiteral,
  isDatetimeTzLiteral,
  isDurationLiteral,
  isDecimalLiteral,
  isDoubleLiteral,
  isIntLiteral,
  isStringLiteral,
  type Annotation,
  type Literal,
} from './generated/ast.js';

/**
 * Where each annotation may sit — TypeDB 3's table, as `define.feature` states it row by row
 * (`can set annotation @X to Y` / `cannot set annotation @X to Y`, L1290–L1990 at the pin).
 *
 * 🔴 This is the whole of one rule, in one place, read by one check. Before Phase 03 of the
 * conformance feature the validator had a single row of it — `@key` on a `relates` — as a rule of
 * its own, and every other misplacement was accepted, applied, and reported as *"parsed and not
 * enforced"*: 280 of the specification's scenarios stopped on exactly that.
 *
 * The subjects are syntactic: the AST says whether an annotation follows the type's name, its
 * `sub`, its `value`, or a trait. A re-open (`player @abstract;`) does not say which kind of type
 * it names, so it admits the union of the three kinds; the interpreter, which knows the applied
 * schema, refuses `@independent` on a re-opened entity.
 *
 * `@cascade` is TypeDB's own *"temporarily turned off"* — kept on relation types, where it
 * belonged, and nowhere else. `@distinct` belongs to lists — `owns name[]`, `relates parent[]` —
 * and to nothing else; a list admits everything its unordered form does, and that (L1728, L1495).
 */
export type AnnotationSubject =
  | 'entity type'
  | 'relation type'
  | 'attribute type'
  | 'type'
  | 'sub'
  | 'value type'
  | 'owns'
  | 'owns list'
  | 'relates'
  | 'relates list'
  | 'plays';

/** The kind of an annotation: its keyword without the `@`, which is also its node type's name without `Annotation`, lower-cased. */
export type AnnotationCategory =
  | 'key'
  | 'unique'
  | 'card'
  | 'independent'
  | 'abstract'
  | 'distinct'
  | 'cascade'
  | 'regex'
  | 'values'
  | 'range'
  | 'doc'
  | 'meta';

const METADATA: readonly AnnotationCategory[] = ['doc', 'meta'];

/** For each place an annotation can sit, the categories it admits there. The whole of the placement rule. */
export const ADMITTED: Readonly<Record<AnnotationSubject, ReadonlySet<AnnotationCategory>>> = {
  'entity type': new Set(['abstract', ...METADATA]),
  'relation type': new Set(['abstract', 'cascade', ...METADATA]),
  'attribute type': new Set(['abstract', 'independent', ...METADATA]),
  type: new Set(['abstract', 'independent', 'cascade', ...METADATA]),
  sub: new Set(METADATA),
  'value type': new Set(['regex', 'range', 'values']),
  owns: new Set(['card', 'unique', 'key', 'regex', 'range', 'values', ...METADATA]),
  'owns list': new Set(['distinct', 'card', 'unique', 'key', 'regex', 'range', 'values', ...METADATA]),
  relates: new Set(['abstract', 'card', ...METADATA]),
  'relates list': new Set(['abstract', 'distinct', 'card', ...METADATA]),
  plays: new Set(['card', ...METADATA]),
};

/** `CardAnnotation` → `card`: the category is the node's own type name. */
export const categoryOf = (node: Annotation): AnnotationCategory =>
  node.$type.replace(/Annotation$/, '').toLowerCase() as AnnotationCategory;

/** `CardAnnotation` → `@card`, for messages. */
export const keywordOf = (node: Annotation): string => `@${categoryOf(node)}`;

/** The subjects that admit a category — named in the refusal, so it says where the annotation goes. */
export const subjectsAdmitting = (category: AnnotationCategory): AnnotationSubject[] =>
  (Object.keys(ADMITTED) as AnnotationSubject[]).filter(
    (subject) => subject !== 'type' && ADMITTED[subject].has(category),
  );

/** The value types TypeDB 3 has. `long` is TypeDB 2's name for `integer`, kept for older callers. */
export const VALUE_TYPES: ReadonlySet<string> = new Set([
  'string', 'integer', 'long', 'double', 'decimal', 'boolean', 'datetime-tz', 'datetime', 'date',
  'duration',
]);

/**
 * ISO 8601 duration, as TypeDB writes one — `P1Y2M3DT4H5M6.789S`. A string literal is a duration
 * only if it reads as one; `@values("year")` on a duration attribute is refused
 * (`define.feature` L1622).
 */
const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

/**
 * Whether a literal can constrain a value type — `@values(0.1)` cannot constrain an `integer`,
 * `@regex("A")` nothing but a `string`, `@range("A".."B")` nothing but a `string`. The table is
 * the spec's own *wrong value type* outlines, L1622 and L1843: an integer literal fits `integer`,
 * `double` and `decimal` (no row refuses it there); a string fits `string`, and `duration` when it
 * reads as one.
 */
export function literalFits(literal: Literal, valueType: string): boolean {
  if (isStringLiteral(literal)) {
    return valueType === 'string' || (valueType === 'duration' && ISO_DURATION.test(literal.value));
  }
  if (isIntLiteral(literal)) return ['integer', 'long', 'double', 'decimal'].includes(valueType);
  // A double is a double: `1.5` on a decimal attribute is refused as a double VALUE is (QA, B3);
  // the spec writes a decimal with its `dec` suffix, always (reduce.feature L154).
  if (isDoubleLiteral(literal)) return valueType === 'double';
  if (isDecimalLiteral(literal)) return valueType === 'decimal';
  if (isBooleanLiteral(literal)) return valueType === 'boolean';
  // A date fits a datetime too: `has birth-date 2000-01-01` on a `datetime` attribute is the
  // spec's own Background (reduce.feature L420, fetch.feature L76) — midnight, on TypeDB.
  if (isDateLiteral(literal)) return valueType === 'date' || valueType === 'datetime';
  if (isDatetimeLiteral(literal)) return valueType === 'datetime';
  if (isDatetimeTzLiteral(literal)) return valueType === 'datetime-tz';
  if (isDurationLiteral(literal)) return valueType === 'duration';
  return false;
}

/** What a literal is, for a message: `a string`, `an integer`, … */
export function literalKind(literal: Literal): string {
  if (isStringLiteral(literal)) return 'a string';
  if (isIntLiteral(literal)) return 'an integer';
  if (isDoubleLiteral(literal)) return 'a double';
  if (isDecimalLiteral(literal)) return 'a decimal';
  if (isBooleanLiteral(literal)) return 'a boolean';
  if (isDateLiteral(literal)) return 'a date';
  if (isDatetimeLiteral(literal)) return 'a datetime';
  if (isDatetimeTzLiteral(literal)) return 'a datetime-tz';
  if (isDurationLiteral(literal)) return 'a duration';
  return 'a literal';
}
