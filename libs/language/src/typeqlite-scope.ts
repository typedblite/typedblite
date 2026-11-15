import {
  AstUtils,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type AstNode,
  type AstNodeDescription,
  type AstNodeLocator,
  type LangiumDocuments,
  type ReferenceInfo,
  type Scope,
  type Stream,
} from 'langium';
import type { LangiumServices } from 'langium/lsp';
import {
  isRelatesTrait,
  isRoleRef,
  TypeExtensionDef,
  type RelationDef,
} from './generated/ast.js';

/**
 * Scoping for TypeQLite: role references, and the order in which one workspace's schema is searched.
 *
 * 🔴 A role name is only meaningful **inside its relation**. `membership:member` and
 * `project-task:owner` both declare roles, and two relations may each relate a role called
 * `member` without collision. Resolving `role` in the global scope would be wrong twice over: it
 * would accept `membership:owner` (a role that exists, but not on that relation), and it would make
 * two identical role names ambiguous.
 *
 * Instead the scope for `RoleRef.role` is exactly the `relates` traits of the relation named
 * alongside it. That turns *"a `plays` names a role its relation actually relates"* from a
 * validator into a resolution rule, which Langium reports, with a position, for free.
 *
 * When the relation itself does not resolve, the role scope is empty rather than global. The
 * unresolved-relation error is the real one; offering role completions from an unknown relation
 * would only add noise on top of it.
 *
 * ⚠️ A role may also be added by a RE-OPEN, such as `employment relates manager;`, a
 * `TypeExtensionDef` naming the relation with no kind keyword, which the behaviour spec writes
 * (`undefine.feature`). Those `relates` live under the extension, not the `RelationDef`. Since
 * ADR-008 D3 they are gathered from the whole workspace, through the index, not only from the
 * relation's own document.
 */
export class TypeQLiteScopeProvider extends DefaultScopeProvider {
  private readonly documents: LangiumDocuments;
  private readonly locator: AstNodeLocator;

  constructor(services: LangiumServices) {
    super(services);
    this.documents = services.shared.workspace.LangiumDocuments;
    this.locator = services.workspace.AstNodeLocator;
  }

  override getScope(context: ReferenceInfo): Scope {
    if (isRoleRef(context.container) && context.property === 'role') {
      const relation = context.container.relation?.ref;
      if (!relation) return EMPTY_SCOPE;
      return this.createScopeForNodes(
        AstUtils.streamContents(relation)
          .concat(this.reopensOf(relation))
          .filter(isRelatesTrait),
      );
    }
    return super.getScope(context);
  }

  /**
   * 🔴 The current document's definitions come before the rest of the workspace's. A workspace is
   * one schema (ADR-008 D3), but when two files define one label, the definition beside the
   * reference is the one its author meant. Without this, which one won would depend on the order in
   * which files happened to be indexed.
   */
  protected override getGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
    const uri = AstUtils.getDocument(context.container).uri.toString();
    const own = this.indexManager.allElements(referenceType, new Set([uri]));
    return this.createScope(own, super.getGlobalScope(referenceType, context));
  }

  /** The contents of every `TypeExtensionDef` re-opening this relation, anywhere in the workspace. */
  private reopensOf(relation: RelationDef): Stream<AstNode> {
    return this.indexManager
      .allElements(TypeExtensionDef.$type)
      .filter((description) => description.name === relation.name)
      .map((description) => this.nodeOf(description))
      .nonNullable()
      .flatMap((extension) => AstUtils.streamContents(extension));
  }

  private nodeOf(description: AstNodeDescription): AstNode | undefined {
    if (description.node) return description.node;
    const document = this.documents.getDocument(description.documentUri);
    return document ? this.locator.getAstNode(document.parseResult.value, description.path) : undefined;
  }
}
