import { CstUtils, type AstNode } from 'langium';
import { AbstractFormatter, Formatting } from 'langium/lsp';
import {
  isAnonRelationPattern,
  isAttributeDef,
  isCardAnnotation,
  isDefineClause,
  isDeleteStage,
  isDeletion,
  isEntityDef,
  isHasProperty,
  isInsertStage,
  isIsaProperty,
  isLinksProperty,
  isMatchStage,
  isOwnsTrait,
  isPipeline,
  isTypeExtensionDef,
  isPlaysTrait,
  isPutStage,
  isRelatesTrait,
  isRelationDef,
  isRolePlayer,
  isRolePlayers,
  isRoleRef,
  isSelectStage,
  isThingPattern,
  isTypeQLiteFile,
  type AnonRelationPattern,
  type AttributeDef,
  type CardAnnotation,
  type DefineClause,
  type DeleteStage,
  type Deletion,
  type EntityDef,
  type HasProperty,
  type InsertStage,
  type IsaProperty,
  type LinksProperty,
  type MatchStage,
  type OwnsTrait,
  type Pipeline,
  type TypeExtensionDef,
  type PlaysTrait,
  type PutStage,
  type RelatesTrait,
  type RelationDef,
  type RolePlayer,
  type RolePlayers,
  type RoleRef,
  type SelectStage,
  type ThingPattern,
  type TypeQLiteFile,
} from './generated/ast.js';

/**
 * TypeQLite formatting.
 *
 * 🔴 **The house style is derived from the production schemas, not invented.** `iam.schema.typeqlite`
 * and `skills.schema.typeqlite` were hand-aligned for a year before anything formatted them, and a
 * formatter that reflowed them into some other shape would produce a diff nobody asked for and
 * would be turned off. So: `define` alone on its line, one trait per line indented, a blank line
 * between block definitions, consecutive one-liners kept tight.
 *
 * 🔴 **Single-pattern stages stay inline; multi-pattern stages break.** Both shapes appear verbatim
 * in `examples/real-queries.typeqlite`, which was itself copied out of the repositories. Encoding the
 * rule on pattern *count* reproduces both deterministically, where `Formatting.fit()` would only
 * preserve whichever the author happened to type.
 */
export class TypeQLiteFormatter extends AbstractFormatter {
  protected format(node: AstNode): void {
    if (isTypeQLiteFile(node)) return this.formatFile(node);
    if (isDefineClause(node)) return this.formatDefineClause(node);
    if (isEntityDef(node) || isRelationDef(node)) return this.formatBlockDef(node);
    if (isAttributeDef(node)) return this.formatAttributeDef(node);
    if (isTypeExtensionDef(node)) return this.formatTypeExtensionDef(node);
    if (isOwnsTrait(node) || isRelatesTrait(node)) return this.formatTrait(node);
    if (isPlaysTrait(node)) return this.formatPlaysTrait(node);
    if (isRoleRef(node)) return this.formatRoleRef(node);
    if (isCardAnnotation(node)) return this.formatCardAnnotation(node);
    if (isPipeline(node)) return this.formatPipeline(node);
    if (isMatchStage(node) || isInsertStage(node) || isPutStage(node)) {
      return this.formatPatternStage(node);
    }
    if (isDeleteStage(node)) return this.formatDeleteStage(node);
    if (isDeletion(node)) return this.formatDeletion(node);
    if (isSelectStage(node)) return this.formatSelectStage(node);
    if (isThingPattern(node)) return this.formatThingPattern(node);
    if (isAnonRelationPattern(node)) return this.formatAnonRelationPattern(node);
    if (isIsaProperty(node)) return this.formatIsaProperty(node);
    if (isHasProperty(node)) return this.formatHasProperty(node);
    if (isLinksProperty(node)) return this.formatLinksProperty(node);
    if (isRolePlayers(node)) return this.formatRolePlayers(node);
    if (isRolePlayer(node)) return this.formatRolePlayer(node);
  }

  /**
   * Apply the vertical separator before `item`, unless a comment leads it.
   *
   * 🔴 **A commented item is left alone deliberately.** Langium falls back to its own hidden-node
   * placement only when a node carries no prepend formatting (`formatter.js`:
   * `if (!prependFormatting && node.hidden)`), so prepending to a definition lands the whitespace
   * *after* its leading comment — which put a blank line between every comment block in
   * `skills.schema.typeqlite` and the definition it documents.
   *
   * Appending to the previous item instead was tried and is worse: it preserves existing spacing
   * but never inserts any, so the formatter silently stops normalising vertical space. That
   * version passed both production schemas — because they already had the blank lines — and failed
   * the mangled-input test, which is the one that can tell the difference.
   *
   * So: normalise where we can see the whole gap, and defer to Langium where a comment owns it.
   */
  private separate(
    f: ReturnType<AbstractFormatter['getNodeFormatter']>,
    item: AstNode,
    blank: boolean,
  ): void {
    if (item.$cstNode && CstUtils.findCommentNode(item.$cstNode, ['SL_COMMENT'])) return;
    f.node(item).prepend(separator(blank));
  }

  /** A `define` block is separated from queries by a blank line; consecutive queries are not. */
  private formatFile(node: TypeQLiteFile): void {
    const f = this.getNodeFormatter(node);
    node.clauses.forEach((clause, index) => {
      if (index === 0) return;
      const previous = node.clauses[index - 1];
      const blank = isDefineClause(clause) || isDefineClause(previous);
      this.separate(f, clause, blank);
    });
  }

  private formatDefineClause(node: DefineClause): void {
    const f = this.getNodeFormatter(node);
    f.keyword('define').append(Formatting.newLines(2));
    node.definitions.forEach((definition, index) => {
      if (index === 0) return;
      const previous = node.definitions[index - 1];
      // A blank line around anything that spans lines, and wherever the KIND of definition
      // changes; consecutive one-liners of the same kind stay tight.
      //
      // 🔴 The kind clause was added after formatting `iam.schema.typeqlite` by hand and reading the
      // result: without it the blank line between the `plays` declarations and the `attribute`
      // declarations disappeared, silently merging two groups the author had separated. Idempotence
      // and AST preservation both still held — which is exactly why the checklist requires a human
      // to read the output once.
      const blank =
        isBlock(definition) || isBlock(previous) || definition.$type !== previous.$type;
      this.separate(f, definition, blank);
    });
  }

  private formatBlockDef(
    node: EntityDef | RelationDef,
  ): void {
    const f = this.getNodeFormatter(node);
    f.property('name').prepend(Formatting.oneSpace());
    f.keyword('sub').surround(Formatting.oneSpace());
    f.keywords(',').prepend(Formatting.noSpace());
    node.traits.forEach((trait) => f.node(trait).prepend(Formatting.indent()));
    f.keyword(';').prepend(Formatting.noSpace());
  }

  private formatAttributeDef(node: AttributeDef): void {
    const f = this.getNodeFormatter(node);
    f.property('name').prepend(Formatting.oneSpace());
    f.keyword(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
    f.keyword('value').append(Formatting.oneSpace());
    f.keyword(';').prepend(Formatting.noSpace());
  }

  private formatTypeExtensionDef(node: TypeExtensionDef): void {
    const f = this.getNodeFormatter(node);
    f.keyword(';').prepend(Formatting.noSpace());
  }

  private formatTrait(
    node: OwnsTrait | RelatesTrait,
  ): void {
    const f = this.getNodeFormatter(node);
    const named = isOwnsTrait(node) ? 'attribute' : 'name';
    f.property(named as never).prepend(Formatting.oneSpace());
    node.annotations.forEach((annotation) =>
      f.node(annotation).prepend(Formatting.oneSpace()),
    );
  }

  private formatPlaysTrait(node: PlaysTrait): void {
    this.getNodeFormatter(node).property('role').prepend(Formatting.oneSpace());
  }

  /** `membership:member` — never spaced, or it reads as two names. */
  private formatRoleRef(node: RoleRef): void {
    this.getNodeFormatter(node).keyword(':').surround(Formatting.noSpace());
  }

  private formatCardAnnotation(node: CardAnnotation): void {
    const f = this.getNodeFormatter(node);
    f.keyword('(').prepend(Formatting.noSpace()).append(Formatting.noSpace());
    f.keyword('..').surround(Formatting.noSpace());
    f.keyword(')').prepend(Formatting.noSpace());
  }

  /** Each stage begins a line; the stage itself decides how its patterns sit. */
  private formatPipeline(node: Pipeline): void {
    const f = this.getNodeFormatter(node);
    const stages = [...node.stages, node.fetch, node.returnStage].filter(
      (stage): stage is NonNullable<typeof stage> => stage !== undefined,
    );
    stages.forEach((stage, index) => {
      if (index === 0) return;
      f.node(stage).prepend(Formatting.newLine());
    });
  }

  private formatPatternStage(
    node:
      | MatchStage
      | InsertStage
      | PutStage,
  ): void {
    this.layoutItems(node, node.patterns);
  }

  private formatDeleteStage(node: DeleteStage): void {
    this.layoutItems(node, node.deletions);
  }

  private formatDeletion(node: Deletion): void {
    const f = this.getNodeFormatter(node);
    f.keyword('of').surround(Formatting.oneSpace());
    f.keyword(';').prepend(Formatting.noSpace());
  }

  private formatSelectStage(node: SelectStage): void {
    const f = this.getNodeFormatter(node);
    node.variables.forEach((_, index) =>
      f.property('variables', index).prepend(Formatting.oneSpace()),
    );
    f.keywords(',').prepend(Formatting.noSpace());
    f.keyword(';').prepend(Formatting.noSpace());
  }

  private formatThingPattern(node: ThingPattern): void {
    const f = this.getNodeFormatter(node);
    node.properties.forEach((property, index) => {
      if (index === 0) f.node(property).prepend(Formatting.oneSpace());
    });
    f.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
    f.keyword(';').prepend(Formatting.noSpace());
  }

  private formatAnonRelationPattern(
    node: AnonRelationPattern,
  ): void {
    const f = this.getNodeFormatter(node);
    f.keyword('isa').surround(Formatting.oneSpace());
    f.keyword(';').prepend(Formatting.noSpace());
  }

  private formatIsaProperty(node: IsaProperty): void {
    const f = this.getNodeFormatter(node);
    f.property('type').prepend(Formatting.oneSpace());
    if (node.players) f.node(node.players).prepend(Formatting.oneSpace());
    // `$n isa name "John"` — an attribute instance's value, spaced as `has name "John"` is.
    if (node.value) f.node(node.value).prepend(Formatting.oneSpace());
  }

  private formatHasProperty(node: HasProperty): void {
    const f = this.getNodeFormatter(node);
    f.property('attribute').prepend(Formatting.oneSpace());
    if (node.value) f.node(node.value).prepend(Formatting.oneSpace());
    if (node.valueVariable) f.property('valueVariable').prepend(Formatting.oneSpace());
  }

  private formatLinksProperty(node: LinksProperty): void {
    this.getNodeFormatter(node).node(node.players).prepend(Formatting.oneSpace());
  }

  private formatRolePlayers(node: RolePlayers): void {
    const f = this.getNodeFormatter(node);
    f.keyword('(').append(Formatting.noSpace());
    f.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
    f.keyword(')').prepend(Formatting.noSpace());
  }

  private formatRolePlayer(node: RolePlayer): void {
    this.getNodeFormatter(node)
      .keyword(':')
      .prepend(Formatting.noSpace())
      .append(Formatting.oneSpace());
  }

  /**
   * One item stays on the keyword's line; several break one-per-line, indented. Both shapes are
   * verbatim from `examples/real-queries.typeqlite`.
   */
  private layoutItems(node: AstNode, items: readonly AstNode[]): void {
    const f = this.getNodeFormatter(node);
    if (items.length === 1) {
      f.node(items[0]).prepend(Formatting.oneSpace());
      return;
    }
    items.forEach((item) => f.node(item).prepend(Formatting.indent()));
  }
}

const isBlock = (node: AstNode): boolean => isEntityDef(node) || isRelationDef(node);

/**
 * The vertical separator between two top-level items — at least one line, at least two where the
 * shape changes.
 *
 * 🔴 `allowMore` is not a nicety, and both halves of it were found by formatting the production
 * schemas and diffing:
 *
 * - **Authored grouping survives.** `skills.schema.typeqlite` separates two runs of `attribute`
 *   declarations with a blank line. Forcing exactly one newline between same-kind definitions
 *   deleted it, merging two groups the author had deliberately kept apart.
 * - **A comment does not gain a blank line.** Langium applies a prepended formatting to a
 *   definition's *leading comment*, so forcing exactly two newlines before a commented definition
 *   inserted a second blank line above every comment block in the file.
 *
 * Neither showed up in idempotence or AST preservation. Both are invisible to a property suite and
 * obvious to a reader, which is the whole argument for the by-eye check.
 *
 * 🔴 **And it is applied by APPENDING to the previous item, never by prepending to the next one.**
 * Langium falls back to its own hidden-node placement only when a node has no prepend formatting
 * (`formatter.js`: `if (!prependFormatting && node.hidden)`), so a prepend on a definition lands
 * *after* its leading comment — which inserted a blank line between every comment block in
 * `skills.schema.typeqlite` and the definition it documents. Appending to the previous definition
 * targets the gap before the comment, which is the gap that was meant.
 */
const separator = (blank: boolean) =>
  blank
    ? Formatting.newLines(2, { allowMore: true })
    : Formatting.newLines(1, { allowMore: true });
