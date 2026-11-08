import type { AstNode, ValidationAcceptor, ValidationChecks } from 'langium';
import {
  isAbstractAnnotation,
  isAnonRelationPattern,
  isBinaryExpression,
  isComparisonPattern,
  isFunctionExpression,
  isNegationExpression,
  isVariableExpression,
  isAttributeDef,
  isDocAnnotation,
  isEntityDef,
  isHasProperty,
  isIsaProperty,
  isLinksProperty,
  isMetaAnnotation,
  isRangeAnnotation,
  isRedefineAnnotations,
  isRedefineValue,
  isRegexAnnotation,
  isThingPattern,
  isKeyAnnotation,
  isKindPattern,
  isLetPattern,
  isOwnsProperty,
  isOwnsTrait,
  isPipeline,
  isPlaysProperty,
  isRelatesProperty,
  isSubProperty,
  isTypePattern,
  isUniqueAnnotation,
  isRelationDef,
  isValuesAnnotation,
  type Annotation,
  type AttributeDef,
  type DefineClause,
  type EntityDef,
  type Expression,
  type Literal,
  type OwnsTrait,
  type Pattern,
  type Pipeline,
  type PlaysTrait,
  type Property,
  type RelatesTrait,
  type RedefineType,
  type RelationDef,
  type RolePlayers,
  type TypeExtensionDef,
  type TypeQLiteAstType,
} from './generated/ast.js';
import {
  ADMITTED,
  categoryOf,
  keywordOf,
  literalFits,
  literalKind,
  subjectsAdmitting,
  VALUE_TYPES,
  type AnnotationSubject,
} from './typeqlite-annotations.js';
import type { TypeQLiteServices } from './typeqlite-module.js';
import { TypeQLiteValidationCode } from './typeqlite-validation-codes.js';

/**
 * Validation for what the grammar accepts but the runtime does not implement.
 *
 * 🔴 [ADR-018](../../../../docs/architecture/adr-018-typeql-engine-as-a-port.md) Decision 7:
 * unsupported TypeQLite fails loudly at three layers and **never silently succeeds**. Unknown syntax
 * is a parse error; syntax deliberately not implemented is reported here, naming the construct;
 * anything reaching the interpreter unhandled throws.
 *
 * This is the middle layer, and it is the one with teeth, because these constructs *parse*. A
 * schema using `@card` is accepted, the generator ignores it, and without this layer the author
 * would be left believing a constraint exists that does not. That is the exact failure mode this
 * feature exists to avoid — GraphQLite 0.6.1 answering an edge to a missing node by silently
 * writing one between two unrelated nodes (spike, 2026-08-29).
 *
 * ⚠️ **"Loudly" changed shape on 2026-09-11, by founder decision.** An unenforced annotation was
 * an *error* — the schema was refused. That refused every valid TypeDB schema that used one:
 * `downstream-store`'s could not be applied at all, and every Background in TypeDB's own behaviour
 * specification was turned away before a single semantic could be measured (ADR-055). It is now a
 * diagnostic **below error severity**: `define` applies the schema and the runtime forwards the
 * diagnostic as a fact in its report, so the reader sees *"`@card` is parsed and not enforced"*
 * on every call. Not a refusal, not a silence. The conformance report card measures each
 * annotation's semantics scenario by scenario until it is enforced.
 *
 * **Removing a check here is how a silent success gets reintroduced.** An annotation leaves the
 * not-enforced list only when the runtime genuinely implements it, with a test proving so.
 */
export function registerValidationChecks(services: TypeQLiteServices): void {
  const registry = services.validation.ValidationRegistry;
  const validator = services.validation.TypeQLiteValidator;
  const notEnforced = validator.checkAnnotationNotEnforced;
  const checks: ValidationChecks<TypeQLiteAstType> = {
    // Every annotation kind but `@key` and `@unique` (a UNIQUE index each) and `@abstract` (an
    // insert of the type is refused) — the last two enforced since Phase 03 of the conformance
    // feature.
    CardAnnotation: notEnforced,
    IndependentAnnotation: notEnforced,
    DistinctAnnotation: notEnforced,
    CascadeAnnotation: notEnforced,
    RegexAnnotation: notEnforced,
    ValuesAnnotation: notEnforced,
    RangeAnnotation: notEnforced,
    DocAnnotation: notEnforced,
    MetaAnnotation: notEnforced,
    DefineClause: [validator.checkLabelsAreUnique, validator.checkReservedKeywords],
    EntityDef: [validator.checkNoDuplicateOwns, validator.checkAnnotationsOnDefinition],
    RelationDef: [validator.checkNoDuplicateOwns, validator.checkAnnotationsOnDefinition],
    AttributeDef: validator.checkAnnotationsOnDefinition,
    TypeExtensionDef: validator.checkAnnotationsOnDefinition,
    RedefineType: validator.checkAnnotationsOnRedefine,
    OwnsTrait: validator.checkAnnotationsOnTrait,
    RelatesTrait: validator.checkAnnotationsOnTrait,
    PlaysTrait: validator.checkAnnotationsOnTrait,
    Pipeline: [validator.checkSelectProjectsVariables, validator.checkValueVariablesBound],
  };
  registry.register(checks, validator);
}

export class TypeQLiteValidator {
  /**
   * An annotation the runtime does not enforce — reported on every parse, never refused.
   *
   * One rule, one message shape, for every kind: the annotation's name comes from the node's own
   * keyword, so adding an annotation to the grammar and registering it above is the whole cost of
   * reporting it. `@card(0..)` is the live one — `downstream-store`'s schema uses it.
   */
  checkAnnotationNotEnforced(node: Annotation, accept: ValidationAcceptor): void {
    if (isKeyAnnotation(node) || isUniqueAnnotation(node) || isAbstractAnnotation(node)) return;
    const keyword = keywordOf(node);
    // `@doc` and `@meta` constrain nothing; what is missing for them is retention — `get_doc()`
    // has nothing to read back. Same code, because a consumer branching on it wants the same
    // thing either way: this annotation does not yet mean what it means on TypeDB.
    const gap = isDocAnnotation(node) || isMetaAnnotation(node)
      ? 'is parsed and not retained — the schema is applied, and nothing stores this metadata.'
      : 'is parsed and not enforced — the schema is applied, and nothing checks this constraint at write time.';
    accept(
      'info',
      `\`${keyword}\` ${gap} It is measured, not assumed: see the TypeDBLite conformance report card.`,
      { node, code: TypeQLiteValidationCode.annotationNotEnforced },
    );
  }

  /**
   * Every annotation on a definition sits on a subject that admits it — `ADMITTED` in
   * `typeqlite-annotations.ts` — and the definition's `value`, if any, is a value type and belongs on
   * an attribute. The AST carries three lists per definition because an annotation belongs to the
   * thing it follows: `entity player sub person @abstract` puts `@abstract` on the *sub*, where
   * TypeDB refuses it, and only a split list can say so.
   */
  checkAnnotationsOnDefinition(
    node: EntityDef | RelationDef | AttributeDef | TypeExtensionDef,
    accept: ValidationAcceptor,
  ): void {
    const kind: AnnotationSubject = isEntityDef(node)
      ? 'entity type'
      : isRelationDef(node)
        ? 'relation type'
        : isAttributeDef(node)
          ? 'attribute type'
          : 'type';
    this.checkAnnotationList(node.annotations, kind, accept);
    this.checkAnnotationList(node.subAnnotations, 'sub', accept);
    this.checkAnnotationList(node.valueAnnotations, 'value type', accept, node.valueType);

    if (node.valueType === undefined) return;
    if (isEntityDef(node) || isRelationDef(node)) {
      // Parses because TypeQLite's type-constraint grammar is kind-agnostic; refused here because a
      // thing type has no value (`define.feature` L392, `; fails`).
      accept(
        'error',
        `${isEntityDef(node) ? 'An entity' : 'A relation'} type has no value type: ` +
          `'${node.name} value ${node.valueType}' cannot be defined. Only an attribute has a value.`,
        { node, property: 'valueType', code: TypeQLiteValidationCode.valueTypeOnThing },
      );
      return;
    }
    if (!VALUE_TYPES.has(node.valueType)) {
      accept(
        'error',
        `'${node.valueType}' is not a value type. TypeDB 3 has: ` +
          `${[...VALUE_TYPES].filter((v) => v !== 'long').join(', ')}.`,
        { node, property: 'valueType', code: TypeQLiteValidationCode.unknownValueType },
      );
    }
  }

  /**
   * The same table on a `redefine`: its one change is a type-level annotation, a value type's, or
   * a trait (whose own check runs on the trait node). The subject is the kind keyword's, or
   * `type` when the redefine names the type bare.
   */
  checkAnnotationsOnRedefine(node: RedefineType, accept: ValidationAcceptor): void {
    const change = node.change;
    if (isRedefineAnnotations(change)) {
      const kind: AnnotationSubject =
        node.kind === 'entity' ? 'entity type' : node.kind === 'relation' ? 'relation type' : node.kind === 'attribute' ? 'attribute type' : 'type';
      this.checkAnnotationList(change.annotations, kind, accept);
    }
    if (isRedefineValue(change)) {
      this.checkAnnotationList(change.annotations, 'value type', accept, change.valueType);
      if (node.kind === 'entity' || node.kind === 'relation') {
        accept(
          'error',
          `${node.kind === 'entity' ? 'An entity' : 'A relation'} type has no value type: ` +
            `'${node.type} value ${change.valueType}' cannot be redefined. Only an attribute has a value.`,
          { node: change, code: TypeQLiteValidationCode.valueTypeOnThing },
        );
      } else if (!VALUE_TYPES.has(change.valueType)) {
        accept(
          'error',
          `'${change.valueType}' is not a value type. TypeDB 3 has: ` +
            `${[...VALUE_TYPES].filter((v) => v !== 'long').join(', ')}.`,
          { node: change, code: TypeQLiteValidationCode.unknownValueType },
        );
      }
    }
  }

  checkAnnotationsOnTrait(node: OwnsTrait | RelatesTrait | PlaysTrait, accept: ValidationAcceptor): void {
    const subject: AnnotationSubject = isOwnsTrait(node) ? 'owns' : node.$type === 'RelatesTrait' ? 'relates' : 'plays';
    this.checkAnnotationList(node.annotations, subject, accept);
  }

  /**
   * One list, one subject: each annotation is admitted there; no category appears twice with
   * different arguments (*"Try redefine instead"* — the phrase the spec matches on); `@values`
   * repeats no argument; and where the value type is in the same statement, each argument fits it.
   *
   * ⚠️ An `owns`'s value type is the attribute's, which the AST alone cannot see — that half of the
   * argument check is the interpreter's (`schema-rules.ts`), against the applied schema.
   */
  private checkAnnotationList(
    annotations: readonly Annotation[],
    subject: AnnotationSubject,
    accept: ValidationAcceptor,
    valueType?: string,
  ): void {
    const seen = new Map<string, Annotation>();
    for (const annotation of annotations) {
      const category = categoryOf(annotation);
      // `@meta` is a map: `@meta("key1", "v1") @meta("key2", "v2")` is two entries, not two of one
      // category (`metadata.feature` L616), and `undefine @meta("key1")` names an entry by its
      // key. Two with ONE key are the repeat.
      const slot = isMetaAnnotation(annotation) ? `meta:${annotation.key}` : category;
      if (!ADMITTED[subject].has(category)) {
        const admitted = subjectsAdmitting(category);
        const where = admitted.length
          ? `It applies to ${admitted.map((s) => `\`${s}\``).join(', ')}.`
          : 'Nothing in this grammar admits it yet.';
        accept(
          'error',
          `\`${keywordOf(annotation)}\` cannot be set on ${article(subject)} ${subject}. ${where}`,
          { node: annotation, code: TypeQLiteValidationCode.annotationNotAdmitted },
        );
        continue;
      }
      const previous = seen.get(slot);
      const text = annotation.$cstNode?.text ?? '';
      if (previous !== undefined && (previous.$cstNode?.text ?? '') !== text) {
        accept(
          'error',
          `\`${previous.$cstNode?.text}\` and \`${text}\` are two \`${keywordOf(annotation)}\` ` +
            `annotations on one ${subject}. An annotation category is set once. Try redefine ` +
            'instead to change it.',
          { node: annotation, code: TypeQLiteValidationCode.annotationRepeated },
        );
        continue;
      }
      seen.set(slot, annotation);
      this.checkAnnotationArguments(annotation, subject, accept, valueType);
    }
  }

  private checkAnnotationArguments(
    annotation: Annotation,
    subject: AnnotationSubject,
    accept: ValidationAcceptor,
    valueType: string | undefined,
  ): void {
    const literals: Literal[] = isValuesAnnotation(annotation)
      ? annotation.values
      : isRangeAnnotation(annotation)
        ? [annotation.min, annotation.max].filter((l): l is Literal => l !== undefined)
        : [];
    if (isValuesAnnotation(annotation)) {
      const texts = new Set<string>();
      for (const literal of annotation.values) {
        const text = literal.$cstNode?.text ?? '';
        if (texts.has(text)) {
          accept(
            'error',
            `\`@values\` repeats ${text}. Each value is listed once.`,
            { node: literal, code: TypeQLiteValidationCode.annotationArguments },
          );
          return;
        }
        texts.add(text);
      }
    }
    if (valueType === undefined || !VALUE_TYPES.has(valueType)) return;
    if (isRegexAnnotation(annotation) && valueType !== 'string') {
      accept(
        'error',
        `\`@regex\` constrains a string, and this ${subject} is '${valueType}'.`,
        { node: annotation, code: TypeQLiteValidationCode.annotationArguments },
      );
      return;
    }
    for (const literal of literals) {
      if (literalFits(literal, valueType)) continue;
      accept(
        'error',
        `\`${keywordOf(annotation)}\` has ${literalKind(literal)} (${literal.$cstNode?.text}) where the ` +
          `${subject} is '${valueType}'. Every argument is a '${valueType}'.`,
        { node: literal, code: TypeQLiteValidationCode.annotationArguments },
      );
      return;
    }
  }

  /**
   * TypeDB labels are unique across **all** types, not per kind. Recorded the hard way in
   * `skills.schema.typeqlite`: a relation named `skill-step` beside the entity of that name fails
   * with `[SVL2] Label 'skill-step' should be unique, but is already used by 'entity'`, which is
   * why the relation is called `skill-composition`.
   */
  checkLabelsAreUnique(node: DefineClause, accept: ValidationAcceptor): void {
    const seen = new Map<string, string>();
    for (const definition of labelled(node)) {
      const previous = seen.get(definition.name);
      if (previous) {
        accept(
          'error',
          `Label '${definition.name}' is already used by '${previous}'. TypeDB labels are ` +
            'unique across all types, not per kind.',
          { node: definition, property: 'name', code: TypeQLiteValidationCode.duplicateLabel },
        );
        continue;
      }
      seen.set(definition.name, definition.$type.replace(/Def$/, '').toLowerCase());
    }
  }

  /** Reserved keywords parse here and fail only against a real TypeDB. */
  checkReservedKeywords(node: DefineClause, accept: ValidationAcceptor): void {
    for (const definition of labelled(node)) {
      if (RESERVED.has(definition.name)) {
        accept(
          'error',
          `'${definition.name}' is a reserved TypeQLite keyword and cannot be used as an ` +
            'identifier — TypeDB refuses it with [DEX31]. Qualify it: `skill-id`, `step-kind`.',
          { node: definition, property: 'name', code: TypeQLiteValidationCode.reservedKeyword },
        );
      }
    }
  }

  /** Owning the same attribute twice is redundant at best, and the two may disagree on `@key`. */
  checkNoDuplicateOwns(
    node: EntityDef | RelationDef,
    accept: ValidationAcceptor,
  ): void {
    const seen = new Set<string>();
    for (const trait of node.traits) {
      if (!isOwnsTrait(trait)) continue;
      const name = trait.attribute.$refText;
      if (seen.has(name)) {
        accept(
          'error',
          `'${node.name}' already owns '${name}'. A second \`owns\` is redundant, and the two ` +
            'may disagree about `@key`.',
          { node: trait, property: 'attribute', code: TypeQLiteValidationCode.duplicateOwns },
        );
        continue;
      }
      seen.add(name);
    }
  }

  /**
   * A `select` may only name a variable the `match` binds.
   *
   * 🔴 Until Phase 02 of the conformance feature this refused a **thing** variable too — `match $d
   * isa defect, has defect-id "x"; select $d;` answered zero rows at exit 0, because the projection
   * emitted attribute bindings only, and `TypeDBLiteDefectRepository.exists` was written exactly
   * that way. The refusal called itself the honest interim for a known deviation; the projection
   * now emits the thing (its `iid` and type), the deviation is closed, and the interim with it.
   *
   * What stays: a variable the `match` never bound — a typo, or a name that appears only as a role
   * player with no `isa` of its own — is refused, as TypeDB refuses an unbound `select`. ⚠️ The
   * role-player case is TypeDBLite's own gap, not TypeDB's: there the player *is* bound by the
   * relation pattern. The message says what this engine does, which is answer nothing for it.
   *
   * 🔴 **This lives here rather than in the interpreter because it needs the AST and nothing else.**
   * Every schema-dependent check — is this type known, does it own this attribute — has to stay in
   * the runtime, against the schema actually applied, because a repository passes a query string
   * with no schema document in scope.
   */
  /**
   * Every variable a `let` or a comparison reads is bound somewhere in the `match` — by a concept
   * pattern or another `let`. `$v == $a; $v > $h;` with no `let $v` is TypeDB's *"The variable 'v'
   * must be bound to a value before it's used"* (expression.feature L34), and it is a compile-time
   * refusal there, so it is one here — not a zero-row answer from the engine.
   */
  checkValueVariablesBound(node: Pipeline, accept: ValidationAcceptor): void {
    // A `match` after another is a later STAGE on TypeDB, and may read what the earlier ones
    // answered — so what an earlier pipeline selects, binds or reduces to counts as bound here
    // (variables.feature L38), and a variable NO stage binds is still the finding, whether the
    // document is one pipeline or several (review, round 2). Whether the stages chain is the
    // engine's to decide.
    const clauses = (node.$container as { clauses?: AstNode[] }).clauses ?? [];
    const earlier = new Set(clauses.slice(0, clauses.indexOf(node)).filter(isPipeline).flatMap(outputsOf));
    const patterns = node.match?.patterns ?? [];
    const { selectable, things, rolePlayersOnly } = bindingsOf(patterns);
    const bound = (variable: string): boolean =>
      selectable.has(variable) || things.has(variable) || rolePlayersOnly.has(variable) || earlier.has(variable);
    for (const pattern of patterns) {
      const reads = isLetPattern(pattern)
        ? expressionVariables(pattern.expression)
        : isComparisonPattern(pattern)
          ? [pattern.left, ...expressionVariables(pattern.right)]
          : [];
      const unbound = reads.find((variable) => !bound(variable));
      if (unbound === undefined) continue;
      accept('error', `The variable '${unbound.slice(1)}' must be bound to a value before it's used.`, {
        node: pattern,
        code: TypeQLiteValidationCode.unboundValue,
      });
    }
  }

  checkSelectProjectsVariables(node: Pipeline, accept: ValidationAcceptor): void {
    const select = node.select;
    if (!select) return;
    const { selectable, things, rolePlayersOnly } = bindingsOf(node.match?.patterns ?? []);

    const canSelect = [...new Set([...selectable, ...things.keys()])].sort();
    const unconstrainedPlayers = [...rolePlayersOnly]
      .filter((name) => !things.has(name) && !selectable.has(name))
      .sort();
    const inventory = canSelect.length
      ? ` Bound here: ${canSelect.join(', ')}.`
      : ' Nothing in this `match` is bound.';

    // 🔴 The hedge that keeps this check from handing out bad advice. Every name in `canSelect` is
    // projectable, but a `match` carrying an unconstrained role player answers **zero rows
    // regardless** — so offering the list without the warning trades one silent zero for another.
    const blockedByPlayers = unconstrainedPlayers.length
      ? ` ⚠️ ${unconstrainedPlayers.join(', ')} ${
          unconstrainedPlayers.length === 1 ? 'has' : 'have'
        } no \`isa\` pattern, so this \`match\` answers 0 rows whatever is selected.`
      : '';

    // A variable a `let` or comparison reads without anything binding it is
    // `checkValueVariablesBound`'s finding, in TypeDB's words; this check would only add a second,
    // and the engine throws the first (expression.feature L34).
    const valueReads = new Set(
      (node.match?.patterns ?? []).flatMap((pattern) =>
        isLetPattern(pattern)
          ? expressionVariables(pattern.expression)
          : isComparisonPattern(pattern)
            ? [pattern.left, ...expressionVariables(pattern.right)]
            : [],
      ),
    );
    for (const variable of select.variables) {
      if (selectable.has(variable) || things.has(variable) || valueReads.has(variable)) continue;

      const message = unconstrainedPlayers.includes(variable)
        ? `\`select\` names '${variable}', which appears only as a role player and has no ` +
          `\`isa\` pattern, so the \`match\` never bound it.${inventory}${blockedByPlayers}`
        : `\`select\` names '${variable}', which the \`match\` never bound.${inventory}` +
          blockedByPlayers;

      accept('error', message, {
        node: select,
        code: TypeQLiteValidationCode.unprojectableVariable,
      });
      return;
    }
  }
}

/**
 * TypeQLite keywords that cannot be used as identifiers.
 *
 * 🔴 These PARSE here — the grammar has no reason to reject `attribute label`. The error surfaces
 * only against a real TypeDB, as `[DEX31] The reserved keyword "label" cannot be used as an
 * identifier`, which is how it cost time twice and why both schema headers record it. `skill-name`
 * and `step-kind` exist because `name` and `kind` were unavailable.
 */
/**
 * What TypeDB 3.10.4 refuses as an identifier with `[DEX31]` — each word probed on the live server
 * on 2026-09-11 as `define attribute <word>, value string;`, and `test/reserved-keywords.spec.ts`
 * pins both halves of the answer.
 *
 * 🔴 The list was hand-written before that and over-reserved by twelve: `name`, `label`, `kind`,
 * `type`, `value`, `sort`, `limit`, `offset`, `require`, `distinct`, `select`, `reduce` are all
 * accepted by the server. `name` alone refused every Background in TypeDB's own behaviour spec,
 * and the Skills schema renamed `name` to `skill-name` to dodge a refusal TypeDB never makes.
 * `d-20260911-the-validator-reserves-ten-identifiers-typedb`.
 */
const RESERVED = new Set([
  'match', 'isa', 'entity', 'of', 'fetch', 'relation', 'attribute', 'sub', 'owns', 'plays',
  'relates', 'has', 'links', 'insert', 'delete', 'define', 'undefine', 'put', 'update',
]);

const article = (subject: AnnotationSubject): string => (/^[aeiou]/.test(subject) ? 'an' : 'a');

/** Every named definition in a `define` clause, with the label TypeDB would see. */
function* labelled(clause: DefineClause) {
  for (const definition of clause.definitions) {
    if (isEntityDef(definition) || isRelationDef(definition) || isAttributeDef(definition)) {
      yield definition;
    }
  }
}

/**
 * What a `match` binds, read from the AST alone.
 *
 * 🔴 Mirrors `constraintsOf`'s merging: two patterns naming the same variable are one thing, which
 * is what makes `$p has principal-type $old;` after `$p isa principal, ...` a projection of the
 * thing the first pattern found rather than a second, unconstrained one.
 *
 * An anonymous relation pattern binds no variable of its own and is deliberately absent from
 * `things` — the interpreter invents `__anonN` for it, and that is a name nobody wrote and nothing
 * should offer back.
 */
export interface MatchBindings {
  /** Attribute variables — those bound by a `has … $var`. A `select` may name these or `things`. */
  readonly selectable: ReadonlySet<string>;
  /** Thing variables, with what their patterns name. */
  readonly things: ReadonlyMap<
    string,
    { type?: string; bound: string[]; literals: string[] }
  >;
  /** Variables appearing only inside `links (...)`, with no `isa` of their own. */
  readonly rolePlayersOnly: ReadonlySet<string>;
}

/**
 * What a pipeline hands the stage after it: after a `reduce`, its reductions and `groupby`
 * variables and nothing else (variables.feature L51); else its `select` list; else everything
 * it binds.
 */
function outputsOf(pipeline: Pipeline): string[] {
  if (pipeline.reduce) return [...pipeline.reduce.reductions.map((r) => r.variable), ...pipeline.reduce.groups];
  const { selectable, things, rolePlayersOnly } = bindingsOf(pipeline.match?.patterns ?? []);
  return pipeline.select ? pipeline.select.variables : [...selectable, ...things.keys(), ...rolePlayersOnly];
}

/** The variables an expression reads, in order of appearance. */
export function expressionVariables(expression: Expression): string[] {
  if (isVariableExpression(expression)) return [expression.variable];
  if (isBinaryExpression(expression)) return [...expressionVariables(expression.left), ...expressionVariables(expression.right)];
  if (isNegationExpression(expression)) return expressionVariables(expression.operand);
  if (isFunctionExpression(expression)) return expression.arguments.flatMap(expressionVariables);
  return [];
}

export function bindingsOf(patterns: readonly Pattern[]): MatchBindings {
  const selectable = new Set<string>();
  const things = new Map<
    string,
    { type?: string; bound: string[]; literals: string[] }
  >();
  const rolePlayersOnly = new Set<string>();

  const players = (list: RolePlayers | undefined): void => {
    for (const entry of list?.entries ?? []) rolePlayersOnly.add(entry.player);
  };

  // A variable bound by a type property — `owns $y`, `plays $y`, `relates $y`, `sub $y`, `isa $t`
  // — or heading a kind pattern, is a type variable, and a `select` may name it (Phase 05).
  const typeBound = (properties: readonly Property[]): void => {
    for (const property of properties) {
      if (isSubProperty(property) && property.typeVariable) selectable.add(property.typeVariable);
      if (isOwnsProperty(property) && property.attributeVariable) selectable.add(property.attributeVariable);
      if (isPlaysProperty(property) && property.roleVariable) selectable.add(property.roleVariable);
      if (isRelatesProperty(property) && property.roleVariable) selectable.add(property.roleVariable);
      if (isIsaProperty(property) && property.typeVariable) selectable.add(property.typeVariable);
    }
  };

  for (const pattern of patterns) {
    if (isAnonRelationPattern(pattern)) {
      players(pattern.players);
      continue;
    }
    if (isKindPattern(pattern)) {
      selectable.add(pattern.variable);
      typeBound(pattern.properties);
      continue;
    }
    // `let $v = …` binds a value variable (Phase 06); a comparison binds nothing.
    if (isLetPattern(pattern)) {
      selectable.add(pattern.variable);
      continue;
    }
    if (isTypePattern(pattern)) {
      typeBound(pattern.properties);
      continue;
    }
    if (!isThingPattern(pattern)) continue;
    typeBound(pattern.properties);

    const thing = things.get(pattern.variable) ?? { bound: [], literals: [] };
    for (const property of pattern.properties) {
      if (isIsaProperty(property)) {
        thing.type ??= property.type;
        players(property.players);
      } else if (isLinksProperty(property)) {
        players(property.players);
      } else if (isHasProperty(property)) {
        if (property.valueVariable) {
          selectable.add(property.valueVariable);
          thing.bound.push(property.valueVariable);
        } else {
          thing.literals.push(property.attribute);
        }
      }
    }
    things.set(pattern.variable, thing);
  }
  return { selectable, things, rolePlayersOnly };
}
