import {
  AstUtils,
  GrammarUtils,
  type AstNode,
  type AstNodeLocator,
  type IndexManager,
  type LangiumDocument,
  type LangiumDocuments,
} from 'langium';
import type { LangiumServices } from 'langium/lsp';
import type { Range } from 'vscode-languageserver';
import {
  AttributeDef,
  EntityDef,
  RelationDef,
  TypeExtensionDef,
  isAnonRelationPattern,
  isCapabilityOwns,
  isCapabilitySub,
  isFetchAttribute,
  isHasProperty,
  isIsaProperty,
  isKindLabelPattern,
  isLabelProperty,
  isLinksProperty,
  isOwnsProperty,
  isRedefineSub,
  isRedefineType,
  isRelatesProperty,
  isRelatesTrait,
  isRelationDef,
  isRoleName,
  isRolePlayer,
  isSubProperty,
  isTypeExtensionDef,
  isTypePattern,
  isUndefineFrom,
  isUndefineOwns,
  isUndefineRelates,
  isUndefineSpecialise,
  isUndefineSub,
  isUndefineType,
  type RelatesTrait,
} from './generated/ast.js';

/**
 * What a label position expects to name. `type` is any thing type. A role carries the label of its
 * relation when the surrounding pattern says which relation it is.
 */
export type LabelKind = 'type' | 'entity' | 'relation' | 'attribute' | 'role';

/** A position in a document where TypeQLite names a type or a role with a plain `ID`. */
export interface LabelSite {
  /** The label as written. */
  readonly name: string;
  /** What the position expects to name. */
  readonly kind: LabelKind;
  /** For a role, the relation it belongs to, when the pattern names one. */
  readonly relation?: string;
  /** Where the label is in its document. */
  readonly range: Range;
  /** The document that holds it. */
  readonly document: LangiumDocument;
  /**
   * Whether an unresolved label here is worth a warning. `$t label person` asserts a label rather
   * than using one, and a role whose relation is unknown cannot be checked at all.
   */
  readonly checked: boolean;
}

/** The AST types whose definitions a label of each kind may name. */
const TARGETS: Record<Exclude<LabelKind, 'role'>, readonly string[]> = {
  type: [EntityDef.$type, RelationDef.$type, AttributeDef.$type],
  entity: [EntityDef.$type],
  relation: [RelationDef.$type],
  attribute: [AttributeDef.$type],
};

/** The Langium services, with TypeQLite's label resolver: what the label-aware providers are constructed with. */
export type TypeQLiteLabelServices = LangiumServices & { labels: { Labels: TypeQLiteLabels } };

/**
 * Labels that are plain `ID`s: every position where TypeQLite names a type without a
 * cross-reference (ADR-008 D5). That covers pipelines (`isa`, `has`, `links`, role players, type
 * patterns), a re-open's label, and `undefine` and `redefine` targets.
 *
 * @privateRemarks
 * 🔴 They stay plain `ID`s on purpose. The runtime reads them as strings in hundreds of places, and a
 * query has no schema in scope when it runs. So they are resolved here, in the editor, through the
 * workspace index (ADR-008 D3), and nothing here is a validation check (ADR-008 D2).
 */
export class TypeQLiteLabels {
  private readonly index: IndexManager;
  private readonly documents: LangiumDocuments;
  private readonly locator: AstNodeLocator;

  /**
   * Created with the language's services by {@link TypeQLiteModule}.
   *
   * @param services Langium's services.
   */
  constructor(services: LangiumServices) {
    this.index = services.shared.workspace.IndexManager;
    this.documents = services.shared.workspace.LangiumDocuments;
    this.locator = services.workspace.AstNodeLocator;
  }

  /** Every label site in a document. */
  sitesIn(document: LangiumDocument): LabelSite[] {
    return AstUtils.streamAllContents(document.parseResult.value)
      .flatMap((node) => sitesOf(document, node))
      .toArray();
  }

  /** The label sites one AST node holds. */
  sitesOfNode(document: LangiumDocument, node: AstNode): LabelSite[] {
    return sitesOf(document, node);
  }

  /** The label site under an offset, if there is one. */
  siteAt(document: LangiumDocument, offset: number): LabelSite | undefined {
    const text = document.textDocument;
    return this.sitesIn(document).find(
      (site) => text.offsetAt(site.range.start) <= offset && offset <= text.offsetAt(site.range.end),
    );
  }

  /** Whether the workspace defines any type at all. Without one, nothing can be unknown (ADR-008 D6). */
  workspaceHasSchema(): boolean {
    return TARGETS.type.some((type) => !this.index.allElements(type).isEmpty());
  }

  /** The definitions a label names. Empty when nothing in the workspace defines it. */
  resolve(site: Pick<LabelSite, 'name' | 'kind' | 'relation'>): AstNode[] {
    if (site.kind !== 'role') return this.definitionsOf(site.name, TARGETS[site.kind]);
    const relations =
      site.relation !== undefined
        ? this.relationChain(site.relation)
        : this.definitionsOf(undefined, [RelationDef.$type]).filter(isRelationDef);
    return relations
      .flatMap((relation) => this.rolesOf(relation))
      .filter((role) => role.name === site.name);
  }

  /**
   * Every definition a label of this kind could name: what completion offers (ADR-008 D5). A role
   * whose relation is known offers that relation's roles, inherited ones included.
   */
  candidates(kind: LabelKind, relation?: string): AstNode[] {
    if (kind !== 'role') return this.definitionsOf(undefined, TARGETS[kind]);
    const relations =
      relation !== undefined
        ? this.relationChain(relation)
        : this.definitionsOf(undefined, [RelationDef.$type]).filter(isRelationDef);
    return relations.flatMap((each) => this.rolesOf(each));
  }

  /** Every label site in the workspace that names this definition. */
  usesOf(target: AstNode): LabelSite[] {
    const name = (target as { name?: string }).name;
    if (name === undefined) return [];
    return this.documents.all
      .toArray()
      .flatMap((document) => this.sitesIn(document))
      .filter((site) => site.name === name && this.resolve(site).includes(target));
  }

  private definitionsOf(name: string | undefined, types: readonly string[]): AstNode[] {
    return types.flatMap((type) =>
      this.index
        .allElements(type)
        .filter((description) => name === undefined || description.name === name)
        .map((description) => {
          if (description.node) return description.node;
          const document = this.documents.getDocument(description.documentUri);
          return document && this.locator.getAstNode(document.parseResult.value, description.path);
        })
        .nonNullable()
        .toArray(),
    );
  }

  /** A relation, and every relation it is a subtype of: a role may be inherited. */
  private relationChain(name: string, seen = new Set<string>()): RelationDef[] {
    if (seen.has(name)) return [];
    seen.add(name);
    const relations = this.definitionsOf(name, [RelationDef.$type]).filter(isRelationDef);
    return relations.concat(
      relations.flatMap((relation) => {
        const parent = relation.superTypes[0]?.$refText;
        return parent ? this.relationChain(parent, seen) : [];
      }),
    );
  }

  /** A relation's roles: its own `relates`, and those every re-open of it adds. */
  private rolesOf(relation: RelationDef): RelatesTrait[] {
    const reopens = this.definitionsOf(relation.name, [TypeExtensionDef.$type]);
    return [relation, ...reopens]
      .flatMap((node) => AstUtils.streamContents(node).toArray())
      .filter(isRelatesTrait);
  }
}

/**
 * The same label positions, by grammar rule and property: what completion sees while a statement is still being
 * typed, before there is an AST node to ask.
 *
 * @privateRemarks
 *
 * 🔴 Keep it in step with `sitesOf` below; `labels.spec.ts` checks that every entry still names a real rule and property.
 */
export const LABEL_POSITIONS: Readonly<Record<string, LabelKind>> = {
  'IsaProperty.type': 'type',
  'HasProperty.attribute': 'attribute',
  'FetchAttribute.attribute': 'attribute',
  'OwnsProperty.attribute': 'attribute',
  'TypePattern.subject': 'type',
  'KindLabelPattern.label': 'type',
  'AnonRelationPattern.type': 'relation',
  'TypeExtensionDef.type': 'type',
  'TypeExtensionDef.superType': 'type',
  'RoleName.relation': 'relation',
  'RoleName.role': 'role',
  'RolePlayer.role': 'role',
  'RelatesProperty.role': 'role',
  'SubProperty.type': 'type',
  'LabelProperty.label': 'type',
  'RelatesProperty.specialises': 'role',
  'UndefineTarget.attribute': 'attribute',
  'UndefineTarget.superType': 'type',
  'UndefineTarget.role': 'role',
  'Capability.attribute': 'attribute',
  'Capability.superType': 'type',
  'UndefineFrom.type': 'type',
  'UndefineType.type': 'type',
  'RedefineType.type': 'type',
  'RedefineChange.superType': 'type',
};

/** The label sites one AST node holds. */
function sitesOf(document: LangiumDocument, node: AstNode): LabelSite[] {
  const site = (
    property: string,
    name: string | undefined,
    kind: LabelKind,
    options: { relation?: string; checked?: boolean } = {},
  ): LabelSite[] => {
    if (!name || !node.$cstNode) return [];
    const cst = GrammarUtils.findNodeForProperty(node.$cstNode, property);
    if (!cst) return [];
    return [
      {
        name,
        kind,
        relation: options.relation,
        range: cst.range,
        document,
        checked: options.checked ?? (kind !== 'role' || options.relation !== undefined),
      },
    ];
  };

  /** `parentship:parent` names a relation and its role; `person` names a type. */
  const scoped = (property: string, label: string | undefined, checked = true): LabelSite[] => {
    if (!label || !node.$cstNode) return [];
    const cst = GrammarUtils.findNodeForProperty(node.$cstNode, property);
    if (!cst) return [];
    const at = (offset: number, length: number): Range => ({
      start: document.textDocument.positionAt(cst.offset + offset),
      end: document.textDocument.positionAt(cst.offset + offset + length),
    });
    const colon = label.indexOf(':');
    if (colon < 0) return [{ name: label, kind: 'type', range: at(0, label.length), document, checked }];
    const relation = label.slice(0, colon);
    const role = label.slice(colon + 1);
    return [
      { name: relation, kind: 'relation', range: at(0, relation.length), document, checked },
      { name: role, kind: 'role', relation, range: at(colon + 1, role.length), document, checked },
    ];
  };

  if (isIsaProperty(node)) return site('type', node.type, 'type');
  if (isHasProperty(node)) return site('attribute', node.attribute, 'attribute');
  if (isFetchAttribute(node)) return site('attribute', node.attribute, 'attribute');
  if (isOwnsProperty(node)) return site('attribute', node.attribute, 'attribute');
  if (isTypePattern(node)) return site('subject', node.subject, 'type');
  if (isKindLabelPattern(node)) return site('label', node.label, node.kind as LabelKind);
  if (isAnonRelationPattern(node)) return site('type', node.type, 'relation');
  if (isTypeExtensionDef(node)) {
    return [...site('type', node.type, 'type'), ...site('superType', node.superType, 'type')];
  }
  if (isRoleName(node)) {
    return [
      ...site('relation', node.relation, 'relation'),
      ...site('role', node.role, 'role', { relation: node.relation }),
    ];
  }
  if (isRolePlayer(node)) return site('role', node.role, 'role', { relation: relationOf(node) });
  if (isRelatesProperty(node)) {
    const relation = isTypePattern(node.$container) ? node.$container.subject : undefined;
    return [...site('role', node.role, 'role', { relation }), ...scoped('specialises', node.specialises)];
  }
  if (isSubProperty(node)) return scoped('type', node.type);
  if (isLabelProperty(node)) return scoped('label', node.label, false);
  if (isCapabilityOwns(node) || isUndefineOwns(node)) return site('attribute', node.attribute, 'attribute');
  if (isCapabilitySub(node) || isUndefineSub(node) || isRedefineSub(node)) {
    return site('superType', node.superType, 'type');
  }
  if (isUndefineFrom(node) || isUndefineType(node) || isRedefineType(node)) {
    return site('type', node.type, 'type');
  }
  if (isUndefineRelates(node) || isUndefineSpecialise(node)) {
    const from = node.$container;
    return site('role', node.role, 'role', { relation: isUndefineFrom(from) ? from.type : undefined });
  }
  return [];
}

/** The relation a role player belongs to, when its pattern names one. */
function relationOf(player: AstNode): string | undefined {
  const holder = player.$container?.$container;
  if (isIsaProperty(holder) || isAnonRelationPattern(holder)) return holder.type;
  if (isLinksProperty(holder)) {
    const pattern = holder.$container as { properties?: AstNode[] };
    const isa = pattern.properties?.find(isIsaProperty);
    return isa?.type;
  }
  return undefined;
}
