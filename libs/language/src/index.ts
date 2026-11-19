/**
 * TypeQLite's grammar, generated AST, synchronous validation and language services. Start with
 * {@link createTypeQLiteServices}.
 *
 * The package is what the engine parses and checks every statement with, and what the editor's language server is
 * built from. Parse, then validate:
 *
 * ```ts
 * import { EmptyFileSystem } from 'langium';
 * import { createTypeQLiteServices, validateSync, type TypeQLiteFile } from '@typedblite/language';
 *
 * const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);
 * const result = TypeQLite.parser.LangiumParser.parse<TypeQLiteFile>(`
 *   define
 *     entity person, owns name;
 *     attribute name, value string;
 * `);
 * const diagnostics = validateSync(TypeQLite, result.value); // every rule, synchronously
 * ```
 *
 * `result.value` is the syntax tree: most of what this page lists is its node types and the `is…` guards that tell them
 * apart, which are generated from the grammar. The rest is the services around it. To learn the language itself, read
 * [The TypeQLite language](../../../docs/guides/typeqlite-language.md).
 *
 * @categoryDescription Setup
 * Composing the services. `createTypeQLiteServices` returns them wired together; the generated module and the grammar
 * are what it composes them from.
 *
 * @categoryDescription Syntax tree
 * The node types the parser produces, one for each rule of the grammar, with a type guard for each. Generated from
 * the grammar, so each is described by its shape and not by what the construct means.
 *
 * @categoryDescription Validation
 * The checks that run on a parsed statement, synchronously, and the stable codes that name them. The engine's
 * diagnostic codes are built on these.
 *
 * @categoryDescription Language features
 * What an editor asks of the language: completion, hover, outline, go to definition, references, rename and quick
 * fixes, with the scoping and labelling they rely on. The VS Code extension runs these in a language server.
 *
 * @categoryDescription Annotations
 * Which annotations are admitted where, and what values they take.
 *
 * @categoryDescription Highlighting
 * The TextMate grammar for editors and highlighters that colour code with one, generated from the grammar's keywords.
 *
 * @module @typedblite/language
 */
export * from './typeqlite-module.js';
export * from './typeqlite-validator.js';
export * from './typeqlite-validate-sync.js';
export * from './typeqlite-validation-codes.js';
export * from './typeqlite-schema-owner.js';
export * from './typeqlite-scope.js';
export * from './typeqlite-scope-computation.js';
export * from './typeqlite-doc-comments.js';
export * from './typeqlite-navigation.js';
export * from './typeqlite-labels.js';
export * from './typeqlite-label-providers.js';
export * from './typeqlite-completion.js';
export * from './typeqlite-edits.js';
export * from './generated/ast.js';
export * from './generated/grammar.js';
export * from './generated/module.js';
export * from './typeqlite-annotations.js';
export * from './typeqlite-definitions.js';
export * from './typeqlite-textmate.js';
