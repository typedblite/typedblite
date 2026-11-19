import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import {
  AbstractSemanticTokenProvider,
  type LangiumServices,
  type SemanticTokenAcceptor,
} from 'langium/lsp';
import type { TypeQLiteLabels } from './typeqlite-labels.js';
import {
  SemanticTokenTypes,
  SemanticTokenModifiers,
  type CancellationToken,
  type SemanticTokens,
  type SemanticTokensDelta,
  type SemanticTokensDeltaParams,
  type SemanticTokensParams,
  type SemanticTokensRangeParams,
} from 'vscode-languageserver';
import {
  isAttributeDef,
  isEntityDef,
  isHasProperty,
  isOwnsTrait,
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
  private readonly labels: TypeQLiteLabels;

  constructor(services: LangiumServices & { labels: { Labels: TypeQLiteLabels } }) {
    super(services);
    this.labels = services.labels.Labels;
  }

  /**
   * 🔴 One highlighting at a time. Langium keeps the document and token builder being worked on in
   * fields of the provider, and a walk yields between nodes, so two requests in flight (a notebook
   * asks for every cell at once, each a document of its own) write each other's tokens into one
   * response. A cell then came back with another cell's tokens in front of its own, and the editor
   * rejected them as out of range.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  override semanticHighlight(document: LangiumDocument, params: SemanticTokensParams, cancelToken?: CancellationToken): Promise<SemanticTokens> {
    return this.serial(() => super.semanticHighlight(document, params, cancelToken));
  }

  override semanticHighlightRange(document: LangiumDocument, params: SemanticTokensRangeParams, cancelToken?: CancellationToken): Promise<SemanticTokens> {
    return this.serial(() => super.semanticHighlightRange(document, params, cancelToken));
  }

  override semanticHighlightDelta(document: LangiumDocument, params: SemanticTokensDeltaParams, cancelToken?: CancellationToken): Promise<SemanticTokens | SemanticTokensDelta> {
    return this.serial(() => super.semanticHighlightDelta(document, params, cancelToken));
  }

  protected highlightElement(
    node: AstNode,
    acceptor: SemanticTokenAcceptor,
  ): void | undefined | 'prune' {
    this.labelTokens(node, acceptor);

    // ── Declarations ────────────────────────────────────────────────────────
    if (isEntityDef(node) || isRelationDef(node)) {
      acceptor({
        node,
        property: 'name',
        type: SemanticTokenTypes.type,
        modifier: SemanticTokenModifiers.declaration,
      });
      node.superTypes.forEach((superType, index) => {
        if (superType.ref) acceptor({ node, property: 'superTypes', index, type: SemanticTokenTypes.type });
      });
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

    // ── Queries ─────────────────────────────────────────────────────────────
    //
    // Labels (`isa project`, `has name`, a role) are plain `ID`s, coloured by `labelTokens` above.
    // What is left here is variables and literals.
    if (isHasProperty(node)) {
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
   * Labels that are plain `ID`s (ADR-008 D5): `isa project`, `has name`, a role, a re-open's label.
   *
   * 🔴 The same rule as a cross-reference, once the workspace has a schema: a label is coloured only
   * when it resolves, and by what it resolves to. A workspace with no schema cannot tell a known label
   * from a typo, because in TypeDB the schema lives in the database (ADR-008 D6). So there, and only
   * there, a label is coloured by its position, as it was before labels could resolve.
   */
  private labelTokens(node: AstNode, acceptor: SemanticTokenAcceptor): void {
    const document = AstUtils.getDocument(node);
    const sites = this.labels.sitesOfNode(document, node);
    if (sites.length === 0) return;
    const resolving = this.labels.workspaceHasSchema(document.uri);
    for (const site of sites) {
      let type: string;
      if (resolving) {
        const [target] = this.labels.resolve(site);
        if (!target) continue;
        type = isAttributeDef(target)
          ? SemanticTokenTypes.property
          : isRelatesTrait(target)
            ? SemanticTokenTypes.parameter
            : SemanticTokenTypes.type;
      } else {
        type =
          site.kind === 'attribute'
            ? SemanticTokenTypes.property
            : site.kind === 'role'
              ? SemanticTokenTypes.parameter
              : SemanticTokenTypes.type;
      }
      acceptor({ range: site.range, type });
    }
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
