import type { Definition, TypeDefinition } from '@typedblite/language';

/**
 * A `define` definition that declares or re-opens a TYPE — not a schema function or a struct. By
 * `$type`, not the language package's guards: a child process may load an older build of the
 * language package, and only the type names are guaranteed to be there.
 */
export const isTypeDefinition = (definition: Definition): definition is TypeDefinition =>
  definition.$type !== 'FunctionDefinition' && definition.$type !== 'StructDef';
