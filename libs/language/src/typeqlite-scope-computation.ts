import {
  Cancellation,
  DefaultScopeComputation,
  interruptAndCheck,
  type AstNodeDescription,
  type LangiumDocument,
} from 'langium';
import { isDefineClause, isTypeExtensionDef, type TypeQLiteFile } from './generated/ast.js';

/**
 * What a TypeQLite document contributes to the workspace's one schema (ADR-008 D3).
 *
 * Every named definition in a `define` clause is exported under its label. A re-open
 * (`employment relates manager;`) is exported too, under the label it re-opens, so that the role
 * scope can find its traits wherever it is written. No cross-reference targets a `TypeExtensionDef`,
 * so exporting one cannot make a reference resolve to it.
 *
 * @privateRemarks
 * 🔴 Langium's default exports only the root's direct children, and a TypeQLite root's children are
 * clauses, which have no name. So until this existed nothing was exported, and nothing resolved
 * across files. It was worse inside one file: a definition is a local symbol of its own `define`
 * clause, so a second clause could not see the first.
 *
 * ⚠️ This is editor-only by construction (ADR-008 D2). The runtime parses and runs `validateSync`; it
 * never builds a document, so scope computation never runs for it.
 *
 * @category Language features
 */
export class TypeQLiteScopeComputation extends DefaultScopeComputation {
  /**
   * Exports every named definition of each `define` clause under its label, and each re-open under the label it
   * re-opens, so that references resolve across clauses and across files.
   */
  override async collectExportedSymbols(
    document: LangiumDocument,
    cancelToken = Cancellation.CancellationToken.None,
  ): Promise<AstNodeDescription[]> {
    const exported: AstNodeDescription[] = [];
    const root = document.parseResult.value as TypeQLiteFile;
    for (const clause of root.clauses) {
      if (!isDefineClause(clause)) continue;
      for (const definition of clause.definitions) {
        await interruptAndCheck(cancelToken);
        const label = isTypeExtensionDef(definition)
          ? definition.type
          : this.nameProvider.getName(definition);
        if (label) exported.push(this.descriptions.createDescription(definition, label, document));
      }
    }
    return exported;
  }
}
