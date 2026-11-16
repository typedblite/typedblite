import type { Definition, TypeDefinition } from '@typedblite/language';

/**
 * A `define` definition that declares or re-opens a TYPE — not a schema function or a struct. By
 * `$type`, not the language package's guards: a child process may load an older build of the
 * language package, and only the type names are guaranteed to be there.
 */
export const isTypeDefinition = (definition: Definition): definition is TypeDefinition =>
  definition.$type !== 'FunctionDefinition' && definition.$type !== 'StructDef';

/** What the grammar calls a type's `sub` and `value` clauses differs by kind, so these two read them alike. */
type Clauses = {
  superType?: string | { $refText: string };
  superTypes?: Array<{ $refText: string }>;
  valueType?: string;
  valueTypes?: string[];
};

/**
 * The parent a type definition names with `sub`, as text. A definition's is a cross-reference and a
 * re-open's is a plain name. An entity or a relation collects its clauses in a list (the grammar lets them
 * sit among the traits), and the validator refuses a second one, so the first is the one.
 */
export function declaredParentOf(definition: TypeDefinition): string | undefined {
  const { superType, superTypes } = definition as Clauses;
  const parent = superTypes ? superTypes[0] : superType;
  return typeof parent === 'string' ? parent : parent?.$refText;
}

/** The value type a type definition names with `value`, if it does. */
export function declaredValueTypeOf(definition: TypeDefinition): string | undefined {
  const { valueType, valueTypes } = definition as Clauses;
  return valueTypes ? valueTypes[0] : valueType;
}
