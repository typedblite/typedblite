import type { AstNode } from 'langium';
import {
  AbstractSemanticTokenProvider,
  type SemanticTokenAcceptor,
} from 'langium/lsp';
import { SemanticTokenTypes, SemanticTokenModifiers } from 'vscode-languageserver';
import {
  isAttributeDef,
  isEntityDef,
  isHasProperty,
  isIsaProperty,
  isOwnsTrait,
  isTypeExtensionDef,
  isRelatesTrait,
  isRelationDef,
  isRolePlayer,
  isRoleRef,
  isStringLiteral,
  isBooleanLiteral,
  isDateLiteral,
  isDatetimeLiteral,
  isDatetimeTzLiteral,
  isDecimalLiteral,
  isDoubleLiteral,
  isIntLiteral,
  isThingPattern,
  isDeletion,
  isSelectStage,
  isAnonRelationPattern,
} from './generated/ast.js';

/**
 * Resolved highlighting for TypeQLite.
 *
 * 🔴 **The point is what is NOT emitted.** A TextMate grammar is a regex over text: it colours
 * `adr` and `adrr` identically, because it has no idea one names a type and the other names
 * nothing. The scope provider already knows. This turns that knowledge into the thing a reader
 * actually looks at.
 *
 * So a cross-reference is highlighted **only when it resolved**. An unresolved one is left to fall
 * back to the TextMate default, which is visibly different — and is what the tests assert on. This
 * is deliberately not an error marker: the validator already reports unresolved references as
 * diagnostics, and a second, quieter channel saying the same thing would be a second source of
 * truth about what TypeQLite means.
 */
export class TypeQLiteSemanticTokenProvider extends AbstractSemanticTokenProvider {
  protected highlightElement(
    node: AstNode,
    acceptor: SemanticTokenAcceptor,
  ): void | undefined | 'prune' {
    // ── Declarations ────────────────────────────────────────────────────────
    if (isEntityDef(node) || isRelationDef(node)) {
      acceptor({
        node,
        property: 'name',
        type: SemanticTokenTypes.type,
        modifier: SemanticTokenModifiers.declaration,
      });
      this.reference(node, 'superType', SemanticTokenTypes.type, acceptor);
      return;
    }
    if (isAttributeDef(node)) {
      acceptor({
        node,
        property: 'name',
        type: SemanticTokenTypes.property,
        modifier: SemanticTokenModifiers.declaration,
      });
      if (node.valueType) {
        acceptor({ node, property: 'valueType', type: SemanticTokenTypes.type });
      }
      return;
    }
    if (isRelatesTrait(node)) {
      acceptor({
        node,
        property: 'name',
        type: SemanticTokenTypes.parameter,
        modifier: SemanticTokenModifiers.declaration,
      });
      return;
    }

    // ── References ──────────────────────────────────────────────────────────
    if (isOwnsTrait(node)) {
      this.reference(node, 'attribute', SemanticTokenTypes.property, acceptor);
      return;
    }
    if (isRoleRef(node)) {
      this.reference(node, 'relation', SemanticTokenTypes.type, acceptor);
      this.reference(node, 'role', SemanticTokenTypes.parameter, acceptor);
      return;
    }
    if (isTypeExtensionDef(node)) {
      acceptor({ node, property: 'type', type: SemanticTokenTypes.type });
      return;
    }

    // ── Queries ─────────────────────────────────────────────────────────────
    //
    // 🔴 These are NOT cross-references in the grammar — `isa skill` is a plain `ID`, because a
    // query is parsed without its schema in scope. So they are classified by position, and the
    // "did it resolve" distinction genuinely does not exist here. Saying so is better than
    // implying a check that is not happening; `checkKnown` in the interpreter is where an unknown
    // type in a query is actually caught, at execution time.
    if (isIsaProperty(node) || isAnonRelationPattern(node)) {
      acceptor({ node, property: 'type', type: SemanticTokenTypes.type });
      return;
    }
    if (isHasProperty(node)) {
      acceptor({ node, property: 'attribute', type: SemanticTokenTypes.property });
      if (node.valueVariable) {
        acceptor({ node, property: 'valueVariable', type: SemanticTokenTypes.variable });
      }
      return;
    }
    if (isThingPattern(node)) {
      acceptor({ node, property: 'variable', type: SemanticTokenTypes.variable });
      return;
    }
    if (isRolePlayer(node)) {
      acceptor({ node, property: 'role', type: SemanticTokenTypes.parameter });
      acceptor({ node, property: 'player', type: SemanticTokenTypes.variable });
      return;
    }
    if (isDeletion(node)) {
      acceptor({ node, property: 'target', type: SemanticTokenTypes.variable });
      if (node.owner) acceptor({ node, property: 'owner', type: SemanticTokenTypes.variable });
      return;
    }
    if (isSelectStage(node)) {
      node.variables.forEach((_, index) =>
        acceptor({ node, property: 'variables', index, type: SemanticTokenTypes.variable }),
      );
      return;
    }
    if (isStringLiteral(node)) {
      acceptor({ node, property: 'value', type: SemanticTokenTypes.string });
      return;
    }
    if (isIntLiteral(node)) {
      acceptor({ node, property: 'value', type: SemanticTokenTypes.number });
      return;
    }
    if (isDatetimeTzLiteral(node) || isDatetimeLiteral(node) || isDateLiteral(node) || isDoubleLiteral(node) || isDecimalLiteral(node)) {
      acceptor({ node, property: 'value', type: SemanticTokenTypes.number });
      return;
    }
    if (isBooleanLiteral(node)) {
      acceptor({ node, property: 'value', type: SemanticTokenTypes.keyword });
      return;
    }
    return;
  }

  /**
   * Emit a token for a cross-reference **only if it resolved**.
   *
   * 🔴 `ref` is `undefined` when linking failed. Emitting anyway is the bug this whole phase
   * exists to prevent — it would colour a typo as a type and put the editor back where the
   * TextMate grammar left it.
   */
  private reference<N extends AstNode>(
    node: N,
    property: keyof N & string,
    type: string,
    acceptor: SemanticTokenAcceptor,
  ): void {
    const value = node[property] as { ref?: unknown } | undefined;
    if (!value?.ref) return;
    acceptor({ node, property: property as never, type });
  }
}
