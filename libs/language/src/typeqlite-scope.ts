import {
  AstUtils,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type AstNode,
  type AstNodeDescription,
  MapScope,
  type AstNodeLocator,
  type LangiumDocuments,
  type ReferenceInfo,
  type Scope,
  type Stream,
} from 'langium';
import type { LangiumServices } from 'langium/lsp';
import { schemaOwnerOf } from './typeqlite-schema-owner.js';
import {
  isRelatesTrait,
  isRoleRef,
  TypeExtensionDef,
  type RelationDef,
} from './generated/ast.js';

/**
 * Scoping for TypeQLite: role references, and the order in which one workspace's schema is searched.
 *
 * A role reference's scope is exactly the `relates` traits of the relation named alongside it. That makes *"a `plays`
 * names a role its relation actually relates"* a resolution rule, which Langium reports with a position, rather than
 * a validator.
 *
 * When the relation itself does not resolve, the role scope is empty rather than global. The unresolved-relation
 * error is the real one; offering role completions from an unknown relation would only add noise on top of it.
 *
 * @privateRemarks
 * 🔴 A role name is only meaningful **inside its relation**. `membership:member` and
 * `project-task:owner` both declare roles, and two relations may each relate a role called
 * `member` without collision. Resolving `role` in the global scope would be wrong twice over: it
 * would accept `membership:owner` (a role that exists, but not on that relation), and it would make
 * two identical role names ambiguous.
 *
 * ⚠️ A role may also be added by a RE-OPEN, such as `employment relates manager;`, a
 * `TypeExtensionDef` naming the relation with no kind keyword, which the behavior spec writes
 * (`undefine.feature`). Those `relates` live under the extension, not the `RelationDef`. Since
 * ADR-008 D3 they are gathered from the whole workspace, through the index, not only from the
 * relation's own document.
 *
 * @category Language features
 */
export class TypeQLiteScopeProvider extends DefaultScopeProvider {
  private readonly documents: LangiumDocuments;
  private readonly locator: AstNodeLocator;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services.
   */
  constructor(services: LangiumServices) {
    super(services);
    this.documents = services.shared.workspace.LangiumDocuments;
    this.locator = services.workspace.AstNodeLocator;
  }

  /**
   * The scope of a reference. A role's is the `relates` traits of the relation named beside it, those added by
   * re-opens included, and is empty when the relation does not resolve. Any other reference gets Langium's scope,
   * with the current document's definitions before the rest of the workspace's.
   */
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
   * The schema's definitions of a type, with the current document's first. A workspace is one schema, but when two
   * files define one label, the definition beside the reference is the one its author meant.
   *
   * A **notebook is a schema of its own** (ADR-012 N4): a cell sees its notebook's cells and nothing else, and a file
   * sees no cell. See {@link schemaOwnerOf}.
   *
   * @privateRemarks
   * 🔴 The current document's definitions come before the rest of the workspace's. A workspace is
   * one schema (ADR-008 D3), but when two files define one label, the definition beside the
   * reference is the one its author meant. Without this, which one won would depend on the order in
   * which files happened to be indexed.
   */
  protected override getGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
    const uri = AstUtils.getDocument(context.container).uri.toString();
    const own = this.indexManager.allElements(referenceType, new Set([uri]));
    return this.createScope(own, this.schemaScope(referenceType, schemaOwnerOf(uri)));
  }

  /**
   * Every definition of a type in one schema, cached until the workspace changes. The default global scope is the whole
   * index; this is the part of it that belongs to `owner`.
   */
  private schemaScope(referenceType: string, owner: string): Scope {
    return this.globalScopeCache.get(`${owner}|${referenceType}`, () =>
      new MapScope(this.indexManager.allElements(referenceType).filter((description) => schemaOwnerOf(description.documentUri) === owner)),
    );
  }

  /** The contents of every `TypeExtensionDef` re-opening this relation, anywhere in its schema. */
  private reopensOf(relation: RelationDef): Stream<AstNode> {
    const owner = schemaOwnerOf(AstUtils.getDocument(relation).uri);
    return this.indexManager
      .allElements(TypeExtensionDef.$type)
      .filter((description) => description.name === relation.name && schemaOwnerOf(description.documentUri) === owner)
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
