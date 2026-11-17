import { AstUtils, GrammarUtils, UriUtils, type AstNode, type LangiumDocument } from 'langium';
import {
  AstNodeHoverProvider,
  DefaultDocumentSymbolProvider,
  DefaultNodeKindProvider,
  type LangiumServices,
} from 'langium/lsp';
import {
  CompletionItemKind,
  SymbolKind,
  type DocumentSymbol,
  type Hover,
  type HoverParams,
} from 'vscode-languageserver';
import {
  isAttributeDef,
  isDocAnnotation,
  isEntityDef,
  isFunctionDefinition,
  isRelatesTrait,
  isRelationDef,
  isStructDef,
  isStructField,
  isTypeExtensionDef,
  TypeExtensionDef,
  type RelationDef,
} from './generated/ast.js';
import { docCommentOf } from './typeqlite-doc-comments.js';
import type { TypeQLiteLabels } from './typeqlite-labels.js';

/**
 * Navigation for TypeQLite: what kind of thing each definition is, the outline, and hover.
 *
 * Definition, references, workspace symbols and folding are Langium's own. Since ADR-008 D3 they
 * work across the workspace, from the cross-references and the exported definitions. What is here is
 * what Langium cannot know about TypeQLite. Everything in this file is editor-only (ADR-008 D2):
 * nothing in it is a validation check.
 */

/**
 * A definition's kind, as the outline, workspace symbols and completion show it.
 *
 * @category Language features
 */
export class TypeQLiteNodeKindProvider extends DefaultNodeKindProvider {
  /**
   * The symbol kind of a definition: a class for an entity, an interface for a relation, a property for an
   * attribute, a struct, a field, a function, an enum member for a role and a namespace for a re-open.
   * Anything else is Langium's.
   */
  override getSymbolKind(node: AstNode): SymbolKind {
    if (isEntityDef(node)) return SymbolKind.Class;
    if (isRelationDef(node)) return SymbolKind.Interface;
    if (isAttributeDef(node)) return SymbolKind.Property;
    if (isStructDef(node)) return SymbolKind.Struct;
    if (isStructField(node)) return SymbolKind.Field;
    if (isFunctionDefinition(node)) return SymbolKind.Function;
    if (isRelatesTrait(node)) return SymbolKind.EnumMember;
    if (isTypeExtensionDef(node)) return SymbolKind.Namespace;
    return super.getSymbolKind(node);
  }

  /**
   * The completion item kind of a definition: a class for an entity, an interface for a relation, a property for an
   * attribute, a struct, a function and an enum member for a role. Anything else is Langium's.
   */
  override getCompletionItemKind(node: AstNode): CompletionItemKind {
    if (isEntityDef(node)) return CompletionItemKind.Class;
    if (isRelationDef(node)) return CompletionItemKind.Interface;
    if (isAttributeDef(node)) return CompletionItemKind.Property;
    if (isStructDef(node)) return CompletionItemKind.Struct;
    if (isFunctionDefinition(node)) return CompletionItemKind.Function;
    if (isRelatesTrait(node)) return CompletionItemKind.EnumMember;
    return super.getCompletionItemKind(node);
  }
}

/**
 * The word that introduces a definition: the outline's detail, and hover's heading.
 *
 * @category Language features
 */
export function kindOf(node: AstNode): string | undefined {
  if (isEntityDef(node)) return 'entity';
  if (isRelationDef(node)) return 'relation';
  if (isAttributeDef(node)) return 'attribute';
  if (isStructDef(node)) return 'struct';
  if (isFunctionDefinition(node)) return 'function';
  if (isRelatesTrait(node)) return 'role';
  if (isTypeExtensionDef(node)) return 're-open';
  return undefined;
}

/**
 * The outline. Langium's default lists every node with a `name`. A re-open has none (it names the
 * type it re-opens through `type`), so `employment relates manager;` would vanish from the outline,
 * and the role it adds with it.
 *
 * @category Language features
 */
export class TypeQLiteDocumentSymbolProvider extends DefaultDocumentSymbolProvider {
  /** The outline entries for a node. A re-open, which has no name of its own, is listed under the label it re-opens. */
  protected override getSymbol(document: LangiumDocument, node: AstNode): DocumentSymbol[] {
    if (isTypeExtensionDef(node) && node.$cstNode) {
      const label = GrammarUtils.findNodeForProperty(node.$cstNode, 'type');
      if (label) {
        return [
          {
            ...this.createSymbol(document, node, node.$cstNode, label, node.type),
            detail: kindOf(node),
          },
        ];
      }
    }
    return super.getSymbol(document, node).map((symbol) => ({
      ...symbol,
      detail: symbol.detail ?? kindOf(node),
    }));
  }
}

/**
 * Hover over a definition, or anything that refers to one: its source, its documentation, and where
 * else the workspace re-opens it.
 *
 * The documentation is TypeDB's two kinds: a `#!` doc comment above the definition, read by the same
 * rule the runtime stores it with (`docCommentOf`), and an `@doc("…")` annotation.
 *
 * @category Language features
 */
export class TypeQLiteHoverProvider extends AstNodeHoverProvider {
  private readonly services: LangiumServices;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services.
   */
  constructor(services: LangiumServices) {
    super(services);
    this.services = services;
  }

  /**
   * A label that is a plain `ID` (`isa person`) is not a reference Langium can follow, so when Langium
   * finds nothing the hover is for whatever the label resolves to (ADR-008 D5).
   */
  override async getHoverContent(
    document: LangiumDocument,
    params: HoverParams,
  ): Promise<Hover | undefined> {
    const found = await super.getHoverContent(document, params);
    if (found) return found;
    const labels = (this.services as { labels?: { Labels: TypeQLiteLabels } }).labels?.Labels;
    const site = labels?.siteAt(document, document.textDocument.offsetAt(params.position));
    if (!labels || !site) return undefined;
    const contents = labels
      .resolve(site)
      .map((target) => this.getAstNodeHoverContent(target))
      .filter((content): content is string => content !== undefined);
    if (contents.length === 0) return undefined;
    return { contents: { kind: 'markdown', value: contents.join('\n\n---\n\n') }, range: site.range };
  }

  /**
   * The hover text for a definition: its role label for a role, its source, its `#!` doc comment and `@doc`
   * annotations, and where else the workspace re-opens it. `undefined` for a node that is not a definition.
   */
  protected override getAstNodeHoverContent(node: AstNode): string | undefined {
    const kind = kindOf(node);
    if (kind === undefined || !node.$cstNode) return undefined;
    const parts: string[] = [];
    if (isRelatesTrait(node)) {
      const relation = AstUtils.getContainerOfType(node, isRelationDef);
      const label = relation ? `${relation.name}:${node.name}` : node.name;
      parts.push(`**role** \`${label}\``);
    }
    parts.push(['```typeqlite', node.$cstNode.text.trim(), '```'].join('\n'));
    const documentation = [docCommentOf(node), ...docAnnotationsOf(node)].filter(
      (text): text is string => text !== undefined && text.length > 0,
    );
    parts.push(...documentation);
    if (isEntityDef(node) || isRelationDef(node) || isAttributeDef(node)) {
      const reopens = this.reopensOf(node);
      if (reopens.length > 0) parts.push(`Re-opened in ${reopens.join(', ')}`);
    }
    return parts.join('\n\n');
  }

  /** `file.typeqlite:3` for every re-open of this label in the workspace. */
  private reopensOf(node: { name: string } | RelationDef): string[] {
    const { IndexManager, LangiumDocuments } = this.services.shared.workspace;
    const locator = this.services.workspace.AstNodeLocator;
    return IndexManager.allElements(TypeExtensionDef.$type)
      .filter((description) => description.name === node.name)
      .map((description) => {
        const document = LangiumDocuments.getDocument(description.documentUri);
        const reopen = document && locator.getAstNode(document.parseResult.value, description.path);
        const line = reopen?.$cstNode ? reopen.$cstNode.range.start.line + 1 : undefined;
        const file = UriUtils.basename(description.documentUri);
        return line === undefined ? `\`${file}\`` : `\`${file}:${line}\``;
      })
      .toArray();
  }
}

function docAnnotationsOf(node: AstNode): string[] {
  const annotations = (node as { annotations?: AstNode[] }).annotations ?? [];
  return annotations.filter(isDocAnnotation).map((annotation) => annotation.text);
}
