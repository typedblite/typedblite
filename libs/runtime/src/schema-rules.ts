import {
  isAbstractAnnotation,
  isAttributeDef,
  isDefineClause,
  isEntityDef,
  isIndependentAnnotation,
  isKeyAnnotation,
  isOwnsTrait,
  isPlaysTrait,
  isRangeAnnotation,
  isRegexAnnotation,
  isRelatesTrait,
  isRelationDef,
  isTypeExtensionDef,
  isUniqueAnnotation,
  isValuesAnnotation,
  keywordOf,
  literalFits,
  literalKind,
  type Annotation,
  type AttributeDef,
  type Definition,
  type Literal,
  type OwnsTrait,
  type PlaysTrait,
  type RelatesTrait,
  type TypeExtensionDef,
  type TypeQLiteFile,
} from '@typedblite/language';
import type { Range } from 'vscode-languageserver';
import { DiagnosticCode, rangeOf, type DiagnosticCodeValue } from './diagnostics.js';
import { ownsSubject, relatesSubject } from './schema-subjects.js';

/**
 * What `define` has applied, as the schema rules need to read it.
 *
 * 🔴 **Facts, not a query.** Every map here is held in memory beside the database and rebuilt from
 * the additive `schema_*` tables on open — the ownership check learned that a lookup inside a
 * write's transaction makes writers contend (`interpreter.ts`, `SchemaModel.parents`). Labels
 * are unique across kinds on TypeDB, so one `parents` map carries a thing type's parent and an
 * attribute type's alike.
 */
export interface SchemaFacts {
  /** Entity and relation types. */
  readonly types: ReadonlySet<string>;
  readonly relations: ReadonlySet<string>;
  readonly attributes: ReadonlySet<string>;
  /** Which type owns which attribute, as `ownsKey(type, attribute)` from `schema-subjects.ts`. */
  readonly owns: ReadonlySet<string>;
  /** Each type's direct supertype — thing types and attribute types in one map. */
  readonly parents: ReadonlyMap<string, string>;
  /** Each attribute type's DECLARED value type; a subtype with none inherits (see `valueTypeOf`). */
  readonly valueTypes: ReadonlyMap<string, string>;
  /** Each relation's DECLARED roles; inherited ones are the parent's (see `roleDeclaredBy`). */
  readonly roles: ReadonlyMap<string, ReadonlySet<string>>;
  /** Ownerships already `@key`, as `"owner\u0000attribute"` — a restated `@key` is not new. */
  readonly keyOwnerships: ReadonlySet<string>;
  /** Every annotation per subject (`schema-subjects.ts` keys) — category → text as written. */
  readonly annotations: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Which types play which roles, as `playsSubject(type, "relation:role")`. */
  readonly plays: ReadonlySet<string>;
  /** The ordered capabilities, `owns name[]` and `relates parent[]`, as their subjects. */
  readonly ordered: ReadonlySet<string>;
}

/** One key for `keyOwnerships`, the shape `SchemaModel.owns` already uses. */
export const ownershipKey = (owner: string, attribute: string): string => `${owner}\u0000${attribute}`;

/**
 * What the data says, for the rules that look at it — TypeDB refuses a schema change the
 * existing instances do not conform to. Answered by the interpreter with one query each, outside
 * any write transaction.
 */
export interface DataFacts {
  /** Direct instances of a thing type, or values of an attribute type. */
  readonly instancesOf: (type: string) => number;
  /** A value of the attribute type held by more than one owner, if any. */
  readonly repeatedValueOf: (attribute: string) => string | undefined;
  /** Instances of the owner type (subtypes included) that do not hold exactly one value of the attribute. */
  readonly ownersWithoutExactlyOne: (owner: string, attribute: string) => number;
}

/** How a rule refuses: with a code, a message, and the definition it points at. Never returns. */
export type Refuse = (code: DiagnosticCodeValue, message: string, range: Range | undefined) => never;

type Kind = 'entity' | 'relation' | 'attribute';

/**
 * The schema rules TypeDB applies at `define` and TypeDBLite did not — Phase 03 of the conformance
 * feature, chosen because 312 of the specification's scenarios stopped at *"expected the query to
 * fail, and it succeeded"*.
 *
 * ⚠️ **Checked against the applied schema PLUS what this statement declares**, before any DDL
 * runs, the way `checkSupertypesExist` is: a parent defined later in the same statement is fine,
 * as it is on TypeDB. Each rule reads the proposed schema and refuses through `refuse`, which
 * attaches the diagnostic the interpreter's report carries.
 *
 * 🔴 Rules that need only the AST — which subject an annotation sits on, two of one category —
 * live in the language package's validator, so an editor sees them. Only what needs the applied
 * schema is here.
 */
export function checkSchemaRules(
  file: TypeQLiteFile,
  applied: SchemaFacts,
  data: DataFacts,
  refuse: Refuse,
): void {
  const proposed = propose(file, applied);
  // 🔴 The facts as they stand BEFORE each definition — the applied schema plus the definitions
  // above this one in the statement. A rule that reads only `applied` misses a contradiction
  // between two definitions of one statement (`attribute name value string; name value integer;`
  // applied with integer winning — review, round 1), and a cycle is refused at the definition
  // that closes it rather than at whichever member of the loop comes first.
  const soFar = { parents: new Map(applied.parents), valueTypes: new Map(applied.valueTypes) };
  for (const clause of file.clauses) {
    if (!isDefineClause(clause)) continue;
    for (const definition of clause.definitions) {
      const name = nameOf(definition);
      const before: SchemaFacts = { ...proposed, parents: soFar.parents, valueTypes: soFar.valueTypes };
      checkKindUnchanged(definition, name, applied, refuse);
      checkSupertypeUnchanged(definition, name, before, refuse);
      checkSupertypeKind(definition, name, proposed, refuse);
      checkNoCycle(definition, name, before, refuse);
      checkAnnotationsForKind(definition, name, proposed, data, refuse);
      const declaredParent = isTypeExtensionDef(definition) ? definition.superType : definition.superType?.$refText;
      if (isAttributeDef(definition) || (isTypeExtensionDef(definition) && proposed.attributes.has(name))) {
        checkAttributeValueType(definition, name, declaredParent, before, proposed, refuse);
      }
      if (declaredParent !== undefined) soFar.parents.set(name, declaredParent);
      if (definition.valueType !== undefined) soFar.valueTypes.set(name, definition.valueType);
      if (isAttributeDef(definition)) continue;
      if (isTypeExtensionDef(definition)) {
        if (!proposed.attributes.has(name) && definition.valueType !== undefined) {
          refuse(
            DiagnosticCode.valueTypeOnThing,
            `'${name}' is ${proposed.relations.has(name) ? 'a relation' : 'an entity'} type and has no ` +
              `value type: '${name} value ${definition.valueType}' cannot be defined.`,
            rangeOf(definition),
          );
        }
      }
      for (const trait of definition.traits) {
        if (isOwnsTrait(trait)) checkOwns(trait, name, proposed, data, refuse);
        if (isPlaysTrait(trait)) checkPlays(trait, name, proposed, refuse);
        if (isRelatesTrait(trait)) checkRelates(trait, name, proposed, refuse, applied);
      }
    }
  }
}

const nameOf = (definition: Definition): string =>
  isTypeExtensionDef(definition) ? definition.type : definition.name;

/** The applied facts with this statement's declarations laid over them. */
function propose(file: TypeQLiteFile, applied: SchemaFacts): SchemaFacts {
  const types = new Set(applied.types);
  const relations = new Set(applied.relations);
  const attributes = new Set(applied.attributes);
  const parents = new Map(applied.parents);
  const valueTypes = new Map(applied.valueTypes);
  const roles = new Map([...applied.roles].map(([relation, set]) => [relation, new Set(set)]));
  const declareRole = (relation: string, role: string): void => {
    const set = roles.get(relation) ?? new Set<string>();
    set.add(role);
    roles.set(relation, set);
  };
  for (const clause of file.clauses) {
    if (!isDefineClause(clause)) continue;
    for (const definition of clause.definitions) {
      const name = nameOf(definition);
      if (isEntityDef(definition) || isRelationDef(definition)) {
        types.add(name);
        if (isRelationDef(definition)) relations.add(name);
        if (definition.superType) parents.set(name, definition.superType.$refText);
      }
      if (isAttributeDef(definition)) {
        attributes.add(name);
        if (definition.superType) parents.set(name, definition.superType.$refText);
        if (definition.valueType) valueTypes.set(name, definition.valueType);
      }
      if (isTypeExtensionDef(definition)) {
        if (definition.superType) parents.set(name, definition.superType);
        if (definition.valueType) valueTypes.set(name, definition.valueType);
      }
      if (!isAttributeDef(definition)) {
        for (const trait of definition.traits) {
          if (isRelatesTrait(trait)) declareRole(name, trait.name);
        }
      }
    }
  }
  // `keyOwnerships` is the APPLIED set on purpose: the rule that reads it asks whether this
  // statement adds a key, which the statement's own annotations cannot answer.
  return {
    types, relations, attributes, parents, valueTypes, roles,
    owns: applied.owns,
    keyOwnerships: applied.keyOwnerships,
    annotations: applied.annotations,
    plays: applied.plays,
    ordered: applied.ordered,
  };
}

const kindOf = (name: string, facts: SchemaFacts): Kind | undefined =>
  facts.relations.has(name)
    ? 'relation'
    : facts.types.has(name)
      ? 'entity'
      : facts.attributes.has(name)
        ? 'attribute'
        : undefined;

/** The supertype chain above a type, nearest first — cycle-guarded, because one may be malformed. */
function ancestorsOf(type: string, facts: SchemaFacts): string[] {
  const chain: string[] = [];
  let current = facts.parents.get(type);
  while (current !== undefined && !chain.includes(current) && current !== type) {
    chain.push(current);
    current = facts.parents.get(current);
  }
  return chain;
}

/**
 * An attribute's effective value type: its own, or the nearest ancestor's. `undefined` for an
 * abstract attribute with none anywhere above it.
 */
export function valueTypeOf(attribute: string, facts: SchemaFacts): string | undefined {
  for (const type of [attribute, ...ancestorsOf(attribute, facts)]) {
    const own = facts.valueTypes.get(type);
    if (own !== undefined) return own;
  }
  return undefined;
}

/** Which relation in the hierarchy DECLARES a role — the one it is played and specialised as. */
function roleDeclaredBy(relation: string, role: string, facts: SchemaFacts): string | undefined {
  for (const type of [relation, ...ancestorsOf(relation, facts)]) {
    if (facts.roles.get(type)?.has(role)) return type;
  }
  return undefined;
}

// ── the rules ──────────────────────────────────────────────────────────────

/**
 * `entity name;` when `name` is an attribute; `attribute employment value string;` when
 * `employment` is a relation — a label keeps its kind (`define.feature` L2610, L2619, L2626).
 * A re-open has no kind keyword and cannot contradict one.
 */
function checkKindUnchanged(definition: Definition, name: string, applied: SchemaFacts, refuse: Refuse): void {
  if (isTypeExtensionDef(definition)) return;
  const before = kindOf(name, applied);
  const now: Kind = isEntityDef(definition) ? 'entity' : isRelationDef(definition) ? 'relation' : 'attribute';
  if (before === undefined || before === now) return;
  refuse(
    DiagnosticCode.kindChanged,
    `'${name}' is already defined as ${article(before)} ${before} type and cannot become ` +
      `${article(now)} ${now} type. A label keeps its kind; undefine it first.`,
    rangeOf(definition),
  );
}

/**
 * A type with a parent keeps it through `define` — `entity pigeon sub animal;` when `pigeon sub
 * bird` is applied is refused whether or not `pigeon` has instances (`define.feature` L3197,
 * L3263, L3337). Assigning a FIRST parent is fine: `person sub parent;` on a parentless `person`
 * is how the spec re-opens types. `facts` is the chain before this definition, so `entity c sub
 * a; c sub b;` in one statement is the switch it is.
 */
function checkSupertypeUnchanged(definition: Definition, name: string, facts: SchemaFacts, refuse: Refuse): void {
  const declared = isTypeExtensionDef(definition) ? definition.superType : definition.superType?.$refText;
  const before = facts.parents.get(name);
  if (declared === undefined || before === undefined || declared === before) return;
  refuse(
    DiagnosticCode.supertypeChanged,
    `'${name}' already has supertype '${before}' and cannot be switched to '${declared}' through ` +
      `define. Use redefine to change a supertype.`,
    rangeOf(definition),
  );
}

/**
 * A parent is of the child's kind: `entity contractor sub employment` — an entity under a
 * relation — is refused, as is a re-opened `person sub employment`. `checkSupertypesExist` settles
 * that the parent exists; this settles what it is. Without it the `isa` closure answered entities
 * for a relation type (review, round 1).
 */
function checkSupertypeKind(definition: Definition, name: string, proposed: SchemaFacts, refuse: Refuse): void {
  const declared = isTypeExtensionDef(definition) ? definition.superType : definition.superType?.$refText;
  if (declared === undefined) return;
  const childKind = isEntityDef(definition)
    ? 'entity'
    : isRelationDef(definition)
      ? 'relation'
      : isAttributeDef(definition)
        ? 'attribute'
        : kindOf(name, proposed);
  const parentKind = kindOf(declared, proposed);
  if (childKind === undefined || parentKind === undefined || childKind === parentKind) return;
  refuse(
    DiagnosticCode.supertypeKind,
    `'${name} sub ${declared}': ${article(childKind)} ${childKind} type cannot have ${article(parentKind)} ` +
      `${parentKind} type as its supertype. A parent is of its child's kind.`,
    rangeOf(definition),
  );
}

/**
 * `entity person sub green-giant;` closing `giant sub person, green-giant sub giant` — refused at
 * that definition (L3474; `dog sub dog` at L3467). `facts.parents` is the chain before this
 * definition, so the one that closes the loop is the one named.
 */
function checkNoCycle(definition: Definition, name: string, facts: SchemaFacts, refuse: Refuse): void {
  const declared = isTypeExtensionDef(definition) ? definition.superType : definition.superType?.$refText;
  if (declared === undefined) return;
  if (declared !== name && !ancestorsOf(declared, facts).includes(name)) return;
  refuse(
    DiagnosticCode.cyclicHierarchy,
    `'${name} sub ${declared}' makes '${name}' its own ancestor. A type hierarchy has no cycles.`,
    rangeOf(definition),
  );
}

/**
 * The type-level annotations the validator could not settle without the schema: `@independent`
 * on a re-open must name an attribute, and `@abstract` cannot be put on a type that has direct
 * instances (`define.feature` L3142, L3159, L3177).
 *
 * 🔴 No memory of whether the type was abstract before, on purpose. Three review rounds guarded
 * such a record — for restatements, for databases from before it, for the first statement after
 * it — and each guard broke a neighbour. The record is not needed: `@abstract` is enforced at
 * insert, so a type that is abstract has no direct instances, and a restated `@abstract` finds
 * none to refuse on. The rule reads the instances and nothing else.
 *
 * ⚠️ The one way an abstract type CAN hold a direct instance: rows written before this phase,
 * when insert did not refuse them, or by a replicated change applied straight into `thing`
 * (`change-log.ts`, which inserts what the hub sent). A restated `@abstract` over such a row is
 * refused, and the route out is deleting the row. No production schema declares `@abstract`, so
 * this is a named edge and not a live one.
 */
function checkAnnotationsForKind(
  definition: Definition,
  name: string,
  proposed: SchemaFacts,
  data: DataFacts,
  refuse: Refuse,
): void {
  const kind = kindOf(name, proposed) ?? 'entity';
  for (const annotation of definition.annotations) {
    if (isIndependentAnnotation(annotation) && isTypeExtensionDef(definition) && kind !== 'attribute') {
      refuse(
        DiagnosticCode.annotationNotAdmitted,
        `\`@independent\` cannot be set on ${article(kind)} ${kind} type ('${name}'). It applies to ` +
          `an attribute type.`,
        rangeOf(annotation),
      );
    }
    if (isAbstractAnnotation(annotation)) {
      const instances = data.instancesOf(name);
      if (instances === 0) continue;
      refuse(
        DiagnosticCode.abstractWithInstances,
        `'${name}' cannot be made abstract: it has ${instances} existing instance(s). Delete ` +
          `them first.`,
        rangeOf(annotation),
      );
    }
  }
}

/**
 * An attribute's value type is fixed once declared, and a subtype's is its parent's.
 *
 * Three ways to contradict it, all refused (`define.feature` L1198, L2780, L1257):
 * - `attribute name value integer;` when `name value string` is applied — the message says which
 *   *"is already defined"*, the phrase the scenario matches on.
 * - `attribute code-name sub name, value integer;` under a string `name` — declared here, or
 *   already applied on `code-name` and only the `sub` is new.
 * - `attribute code-name value integer;` when `code-name sub name` is applied and `name` is a
 *   string — the parent is not restated, and still counts.
 *
 * 🔴 **Upward through the whole statement, downward through what came before.** The chain above
 * is read from the PROPOSED facts, so `x sub y, value string; y sub z;` under an integer `z` is
 * refused at `x` whichever order the two are written in (review, round 3). The chain below is
 * read from the facts BEFORE this definition — the applied schema plus the lines above — so a
 * subtype declared later in the statement is refused at its own line by its upward check, never
 * here with the parent's range (review, round 2); what the downward check catches is an APPLIED
 * subtype whose value type this definition's `value` or `sub` now contradicts. A parent with no
 * value type anywhere above it constrains nothing: an abstract `name` may have an integer
 * `code-name` and a string `nick-name` beneath it.
 */
function checkAttributeValueType(
  definition: AttributeDef | TypeExtensionDef,
  name: string,
  declaredParent: string | undefined,
  before: SchemaFacts,
  proposed: SchemaFacts,
  refuse: Refuse,
): void {
  const declaredBefore = before.valueTypes.get(name);
  const declaredHere = definition.valueType;
  if (declaredHere !== undefined && declaredBefore !== undefined && declaredHere !== declaredBefore) {
    refuse(
      DiagnosticCode.valueTypeConflict,
      `'${name}' cannot be given value type '${declaredHere}': a different '${name} value ` +
        `${declaredBefore}' is already defined, and an attribute's value type does not change ` +
        `through define.`,
      rangeOf(definition),
    );
  }
  const own = declaredHere ?? declaredBefore;
  const parent = declaredParent ?? proposed.parents.get(name);
  if (own !== undefined && parent !== undefined) {
    const inherited = valueTypeOf(parent, proposed);
    if (inherited !== undefined && inherited !== own) {
      refuse(
        DiagnosticCode.valueTypeConflict,
        `'${name} sub ${parent}' cannot have value type '${own}': '${parent}' has value type ` +
          `'${inherited}', and a subtype takes its parent's. Drop the value type, or restate ` +
          `'${inherited}'.`,
        rangeOf(definition),
      );
    }
  }
  if (declaredHere === undefined && declaredParent === undefined) return;
  const effective = valueTypeOf(name, proposed);
  if (effective === undefined) return;
  for (const descendant of descendantsOf(name, before)) {
    const theirs = before.valueTypes.get(descendant);
    if (theirs === undefined || theirs === effective) continue;
    refuse(
      DiagnosticCode.valueTypeConflict,
      `'${name}' cannot take value type '${effective}' here: its subtype '${descendant}' has ` +
        `value type '${theirs}', and a subtype takes its parent's.`,
      rangeOf(definition),
    );
  }
}

/** Every type below one, by repeated sweeps — the chain is small and fixed by `define`. */
function descendantsOf(type: string, facts: SchemaFacts): string[] {
  const below = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of facts.parents) {
      if ((parent === type || below.has(parent)) && !below.has(child) && child !== type) {
        below.add(child);
        grew = true;
      }
    }
  }
  return [...below];
}

/**
 * `owns` names an attribute type (`define.feature` L132, L139, L146, L167), and its
 * `@regex`/`@range`/`@values` arguments fit that attribute's value type — the half of the
 * argument check the validator left here, because only the schema knows what `description`
 * holds (L1622's outline, 58 rows). An attribute with no value type anywhere admits none of
 * the three.
 */
function checkOwns(trait: OwnsTrait, owner: string, proposed: SchemaFacts, data: DataFacts, refuse: Refuse): void {
  const attribute = trait.attribute.$refText;
  const kind = kindOf(attribute, proposed);
  if (kind === undefined) {
    refuse(
      DiagnosticCode.unknownAttribute,
      `Unknown attribute '${attribute}': '${owner} owns ${attribute}' names an attribute type that ` +
        `is neither defined here nor already applied. The applied schema defines: ` +
        `${[...proposed.attributes].sort().join(', ') || '(nothing)'}`,
      rangeOf(trait),
    );
  }
  if (kind !== 'attribute') {
    refuse(
      DiagnosticCode.ownsNotAttribute,
      `'${owner}' cannot own '${attribute}': it is ${article(kind)} ${kind} type, and only an ` +
        `attribute type can be owned.`,
      rangeOf(trait),
    );
  }
  // `owns name[]` and `owns name` are two definitions of one capability, and a type has one (L338).
  if (proposed.owns.has(ownershipKey(owner, attribute))) {
    checkOrderUnchanged(`${owner} owns ${attribute}`, proposed.ordered.has(ownsSubject(owner, attribute)), trait.ordered === true, trait, refuse);
  }
  const valueType = valueTypeOf(attribute, proposed);
  for (const annotation of trait.annotations) {
    checkArgumentsFit(annotation, attribute, valueType, refuse);
    // `product owns barcode @key;` when two products share a barcode: TypeDB refuses the schema
    // change the data does not conform to (`define.feature` L2735, L2949, L3056). Checked here,
    // before the DDL, so the refusal names the attribute; the UNIQUE index failing to build is
    // the backstop, not the rule.
    if (isKeyAnnotation(annotation) || isUniqueAnnotation(annotation)) {
      const repeated = data.repeatedValueOf(attribute);
      if (repeated !== undefined) {
        refuse(
          DiagnosticCode.dataDoesNotConform,
          `'${owner} owns ${attribute} ${keywordOf(annotation)}': the existing data does not conform — ` +
            `'${attribute}' ${repeated} is held by more than one owner. Remove the duplicates first.`,
          rangeOf(annotation),
        );
      }
    }
    // `@key` is also `@card(1..1)`: every existing owner must hold exactly one (L3056, converting
    // `@unique` to `@key` over a person with no phone-nr). ⚠️ Only when the key is NEW on this
    // OWNERSHIP — `(owner, attribute)`, not the attribute alone, or a second owner type taking
    // `@key` on an already-keyed attribute would never be checked (review, round 1). Re-applying
    // a schema is how every repository opens, and `@key`'s cardinality is not enforced at insert,
    // so a restated `@key` over existing rows must never refuse itself.
    if (isKeyAnnotation(annotation) && !proposed.keyOwnerships.has(ownershipKey(owner, attribute))) {
      const missing = data.ownersWithoutExactlyOne(owner, attribute);
      if (missing === 0) continue;
      refuse(
        DiagnosticCode.dataDoesNotConform,
        `'${owner} owns ${attribute} @key': the existing data does not conform — ${missing} ` +
          `'${owner}' instance(s) do not hold exactly one '${attribute}', and a key is @card(1..1).`,
        rangeOf(annotation),
      );
    }
  }
}

export function checkArgumentsFit(
  annotation: Annotation,
  attribute: string,
  valueType: string | undefined,
  refuse: Refuse,
): void {
  const constrains =
    isRegexAnnotation(annotation) || isRangeAnnotation(annotation) || isValuesAnnotation(annotation);
  if (!constrains) return;
  if (valueType === undefined) {
    refuse(
      DiagnosticCode.annotationArguments,
      `\`${keywordOf(annotation)}\` cannot constrain '${attribute}': it has no value type, so ` +
        `there is nothing to constrain.`,
      rangeOf(annotation),
    );
  }
  if (isRegexAnnotation(annotation) && valueType !== 'string') {
    refuse(
      DiagnosticCode.annotationArguments,
      `\`@regex\` constrains a string, and '${attribute}' is '${valueType}'.`,
      rangeOf(annotation),
    );
  }
  const literals: Literal[] = isValuesAnnotation(annotation)
    ? annotation.values
    : isRangeAnnotation(annotation)
      ? [annotation.min, annotation.max].filter((l): l is Literal => l !== undefined)
      : [];
  for (const literal of literals) {
    if (literalFits(literal, valueType)) continue;
    refuse(
      DiagnosticCode.annotationArguments,
      `\`${keywordOf(annotation)}\` has ${literalKind(literal)} (${literal.$cstNode?.text}) where ` +
        `'${attribute}' is '${valueType}'. Every argument is a '${valueType}'.`,
      rangeOf(literal),
    );
  }
}

/**
 * `plays employment:employee` names a relation the schema knows and a role that relation
 * DECLARES — not one it inherits. `person plays part-time-employment:employee` is refused when
 * `employee` is `employment`'s (`define.feature` L153, L770): the role is played as
 * `employment:employee`, whatever subtype the relation instance turns out to be.
 */
function checkPlays(trait: PlaysTrait, player: string, proposed: SchemaFacts, refuse: Refuse): void {
  const relation = trait.role.relation.$refText;
  const role = trait.role.role.$refText;
  if (!proposed.relations.has(relation)) {
    refuse(
      DiagnosticCode.unknownType,
      `Unknown relation '${relation}': '${player} plays ${relation}:${role}' names a relation that ` +
        `is neither defined here nor already applied.`,
      rangeOf(trait),
    );
  }
  const declaredBy = roleDeclaredBy(relation, role, proposed);
  if (declaredBy === relation) return;
  const why =
    declaredBy === undefined
      ? `'${relation}' relates no '${role}'. It relates: ` +
        `${[...(proposed.roles.get(relation) ?? [])].sort().join(', ') || '(nothing)'}.`
      : `'${role}' is declared by '${declaredBy}', which '${relation}' inherits it from — play it as ` +
        `'${declaredBy}:${role}'.`;
  refuse(
    DiagnosticCode.unknownRole,
    `'${player} plays ${relation}:${role}' names a role '${relation}' does not declare. ${why}`,
    rangeOf(trait),
  );
}

/**
 * `relates` belongs to a relation (`person relates employee;` on an entity is refused,
 * `define.feature` L2852), and a role is declared once in a hierarchy: `fathership relates
 * parent;` when `parentship relates parent` is above it is refused with the message the scenario
 * matches on (L1003).
 */
/**
 * A restated `owns`/`relates` keeps its ordering: TypeDB's *"different 'person owns name' is already
 * defined"* (define.feature L338, L599) names the one APPLIED. Changing it is `redefine`'s.
 */
function checkOrderUnchanged(capability: string, appliedOrdered: boolean, statedOrdered: boolean, trait: OwnsTrait | RelatesTrait, refuse: Refuse): void {
  if (appliedOrdered === statedOrdered) return;
  refuse(
    DiagnosticCode.alreadyDefined,
    `'${capability}${statedOrdered ? '[]' : ''}' cannot be defined: a different '${capability}${appliedOrdered ? '[]' : ''}' ` +
      `is already defined, and \`define\` does not change an ordering. Try redefine instead.`,
    rangeOf(trait),
  );
}

function checkRelates(trait: RelatesTrait, relation: string, proposed: SchemaFacts, refuse: Refuse, applied: SchemaFacts): void {
  if (applied.roles.get(relation)?.has(trait.name) === true) {
    checkOrderUnchanged(`${relation} relates ${trait.name}`, applied.ordered.has(relatesSubject(relation, trait.name)), trait.ordered === true, trait, refuse);
  }
  const kind = kindOf(relation, proposed) ?? 'entity';
  if (kind !== 'relation') {
    refuse(
      DiagnosticCode.relatesOnNonRelation,
      `'${relation}' is ${article(kind)} ${kind} type and cannot relate '${trait.name}'. Only a ` +
        `relation type relates roles.`,
      rangeOf(trait),
    );
  }
  // Above the relation only: the proposed facts already carry this very `relates`, so the
  // relation itself always "declares" it.
  const declaredBy = ancestorsOf(relation, proposed).find((type) => proposed.roles.get(type)?.has(trait.name));
  if (declaredBy === undefined) return;
  refuse(
    DiagnosticCode.roleRedeclared,
    `'${relation} relates ${trait.name}': '${declaredBy}:${trait.name}' should be unique in relation ` +
      `type hierarchy, and '${relation}' inherits it. Specialise it with \`relates ${trait.name} as …\` ` +
      `or use the inherited role.`,
    rangeOf(trait),
  );
}

const article = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');
