import { isFunctionDefinition, isStructDef, type AttributeDef, type Definition, type EntityDef, type RelationDef, type TypeExtensionDef } from './generated/ast.js';

/**
 * A `define` definition that declares or re-opens a TYPE — not a schema function or a struct.
 *
 * @category Syntax tree
 */
export type TypeDefinition = EntityDef | RelationDef | AttributeDef | TypeExtensionDef;

/**
 * Whether a definition is a type's: what every schema rule about types reads.
 *
 * @category Syntax tree
 */
export const isTypeDefinition = (definition: Definition): definition is TypeDefinition =>
  !isFunctionDefinition(definition) && !isStructDef(definition);
