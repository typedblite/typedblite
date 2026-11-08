import {
  AstUtils,
  DefaultScopeProvider,
  EMPTY_SCOPE,
  type ReferenceInfo,
  type Scope,
} from 'langium';
import { isRelatesTrait, isRoleRef, isTypeExtensionDef, type RelationDef } from './generated/ast.js';

/**
 * Scoping for role references.
 *
 * 🔴 A role name is only meaningful **inside its relation**. `membership:member` and
 * `skill-composition:owner` both declare roles, and two relations may each relate a role called
 * `member` without collision — so resolving `role` in the global scope would be wrong twice over:
 * it would accept `membership:owner` (a role that exists, but not on that relation) and it would
 * make two identical role names ambiguous.
 *
 * Instead the scope for `RoleRef.role` is exactly the `relates` traits of the relation named
 * alongside it. That turns *"a `plays` names a role its relation actually relates"* from a
 * validator into a resolution rule — Langium reports it, with a position, for free.
 *
 * When the relation itself does not resolve, the role scope is empty rather than global. The
 * unresolved-relation error is the real one; offering role completions from an unknown relation
 * would only add noise on top of it.
 *
 * ⚠️ A role may also be added by a RE-OPEN — `employment relates manager;`, a `TypeExtensionDef`
 * naming the relation with no kind keyword, which the behaviour spec writes (`undefine.feature`).
 * Those `relates` live under the extension, not the `RelationDef`, so the scope gathers both:
 * every extension in the same document whose `type` is the relation's name.
 */
export class TypeQLiteScopeProvider extends DefaultScopeProvider {
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

  /** The contents of every `TypeExtensionDef` re-opening this relation, in the same document. */
  private reopensOf(relation: RelationDef) {
    const root = AstUtils.getDocument(relation).parseResult.value;
    return AstUtils.streamAllContents(root)
      .filter(isTypeExtensionDef)
      .filter((extension) => extension.type === relation.name)
      .flatMap((extension) => AstUtils.streamContents(extension));
  }
}
