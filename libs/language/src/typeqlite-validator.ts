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
  isDisjunctionPattern,
  isOptionalPattern,
  isMatchStage,
  isGivenStage,
  isInsertStage,
  isPutStage,
  isSelectStage,
  isSortStage,
  isRequireStage,
  isReduceStage,
  isDeleteStage,
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
  type SelectStage,
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
 * This is the middle layer, and it is the one with teeth, because these constructs *parse*. A schema using `@card` is
 * accepted, the generator ignores it, and without this layer the author would be left believing a constraint exists
 * that does not. Unsupported TypeQLite fails loudly at three layers and never silently succeeds: unknown syntax is a
 * parse error; syntax deliberately not implemented is reported here, naming the construct; anything reaching the
 * interpreter unhandled throws.
 *
 * An annotation leaves the not-enforced list only when the runtime genuinely implements it, with a test proving so.
 *
 * @privateRemarks
 * 🔴 [ADR-002](../../../docs/architecture/adr-002-typeql-engine-as-a-port.md) Decision 7:
 * unsupported TypeQLite fails loudly at three layers and **never silently succeeds**. Unknown syntax
 * is a parse error; syntax deliberately not implemented is reported here, naming the construct;
 * anything reaching the interpreter unhandled throws.
 *
 * ⚠️ **"Loudly" changed shape on 2026-09-11, by founder decision.** An unenforced annotation was
 * an *error* — the schema was refused. That refused every valid TypeDB schema that used one:
 * a documentation store's schema could not be applied at all, and every Background in TypeDB's own behaviour
 * specification was turned away before a single semantic could be measured (ADR-005). It is now a
 * diagnostic **below error severity**: `define` applies the schema and the runtime forwards the
 * diagnostic as a fact in its report, so the reader sees *"`@card` is parsed and not enforced"*
 * on every call. Not a refusal, not a silence. The conformance report card measures each
 * annotation's semantics scenario by scenario until it is enforced.
 *
 * The failure mode this layer exists to avoid: GraphQLite 0.6.1 answering an edge to a missing node by silently
 * writing one between two unrelated nodes (spike, 2026-08-29).
 *
 * **Removing a check here is how a silent success gets reintroduced.**
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
    Pipeline: [validator.checkValueVariablesBound],
  };
  registry.register(checks, validator);
}

/**
 * TypeQLite's validation checks, as methods. `registerValidationChecks` registers them with the services'
 * validation registry; the runtime runs them synchronously through `validateSync`.
 */
export class TypeQLiteValidator {
  /**
   * An annotation the runtime does not enforce — reported on every parse, never refused.
   *
   * One rule, one message shape, for every kind: the annotation's name comes from the node's own
   * keyword, so adding an annotation to the grammar and registering it above is the whole cost of
   * reporting it.
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
    // An entity or a relation collects its `sub` and `value` clauses in lists (the grammar lets them sit
    // among the traits, so one can be written twice). A second one is refused, not silently dropped.
    if (isEntityDef(node) || isRelationDef(node)) {
      for (const [list, word, code] of [
        [node.superTypes, 'sub', TypeQLiteValidationCode.repeatedClause],
        [node.valueTypes, 'value', TypeQLiteValidationCode.repeatedClause],
      ] as const) {
        if (list.length > 1) {
          accept('error', `'${node.name}' has more than one '${word}' clause. A type has at most one.`, {
            node,
            property: word === 'sub' ? 'superTypes' : 'valueTypes',
            index: 1,
            code,
          });
        }
      }
    }
    const valueType = isEntityDef(node) || isRelationDef(node) ? node.valueTypes[0] : node.valueType;
    this.checkAnnotationList(node.valueAnnotations, 'value type', accept, valueType);

    if (valueType === undefined) return;
    if (isEntityDef(node) || isRelationDef(node)) {
      // Parses because TypeQLite's type-constraint grammar is kind-agnostic; refused here because a
      // thing type has no value (`define.feature` L392, `; fails`).
      accept(
        'error',
        `${isEntityDef(node) ? 'An entity' : 'A relation'} type has no value type: ` +
          `'${node.name} value ${valueType}' cannot be defined. Only an attribute has a value.`,
        { node, property: 'valueTypes', index: 0, code: TypeQLiteValidationCode.valueTypeOnThing },
      );
      return;
    }
    if (!VALUE_TYPES.has(valueType)) {
      accept(
        'error',
        `'${valueType}' is not a value type. TypeDB 3 has: ` +
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

  /**
   * Checks the annotations on an `owns`, `relates` or `plays` trait against the ones that subject admits. A list
   * (`owns name[]`, `relates parent[]`) admits `@distinct` besides.
   */
  checkAnnotationsOnTrait(node: OwnsTrait | RelatesTrait | PlaysTrait, accept: ValidationAcceptor): void {
    // A list — `owns name[]`, `relates parent[]` — admits `@distinct` besides (define.feature L1728).
    const list = (isOwnsTrait(node) || node.$type === 'RelatesTrait') && (node as OwnsTrait | RelatesTrait).ordered;
    const subject: AnnotationSubject = isOwnsTrait(node) ? (list ? 'owns list' : 'owns') : node.$type === 'RelatesTrait' ? (list ? 'relates list' : 'relates') : 'plays';
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
   * `tracker.schema.typeqlite`: a relation named `task` beside the entity of that name fails
   * with `[SVL2] Label 'task' should be unique, but is already used by 'entity'`, which is
   * why the relation is called `project-task`.
   */
  checkLabelsAreUnique(node: DefineClause, accept: ValidationAcceptor): void {
    const seen = new Map<string, string>();
    for (const definition of labelled(node)) {
      const previous = seen.get(definition.name);
      // The same label as the same kind is the one type stated again — additive, and a no-op where it
      // repeats (define.feature L2529). Only a second KIND is a second type.
      if (previous !== undefined && previous === definition.$type.replace(/Def$/, '').toLowerCase()) continue;
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
          reservedKeywordMessage(definition.name),
          { node: definition, property: 'name', code: TypeQLiteValidationCode.reservedKeyword },
        );
      }
    }
  }

  /**
   * Owning the same attribute twice is idempotent when the two say the same thing — `owns price, owns
   * price` — and refused when they disagree, on `@key` or
   * any annotation, or one is ordered: which would win is not the writer's to guess.
   */
  checkNoDuplicateOwns(
    node: EntityDef | RelationDef,
    accept: ValidationAcceptor,
  ): void {
    const seen = new Map<string, string>();
    for (const trait of node.traits) {
      if (!isOwnsTrait(trait)) continue;
      const name = trait.attribute.$refText;
      const said = `${trait.ordered ? '[]' : ''}${trait.annotations.map((a) => (a.$cstNode?.text ?? '').replace(/\s+/g, '')).join(' ')}`;
      const before = seen.get(name);
      if (before !== undefined && before !== said) {
        accept(
          'error',
          `'${node.name}' already owns '${name}' differently. Two \`owns\` of one attribute must agree, ` +
            'on `@key` and every other annotation.',
          { node: trait, property: 'attribute', code: TypeQLiteValidationCode.duplicateOwns },
        );
        continue;
      }
      seen.set(name, said);
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
   * must be bound to a value before it's used"*, and it is a compile-time
   * refusal there, so it is one here — not a zero-row answer from the engine.
   */
  checkValueVariablesBound(node: Pipeline, accept: ValidationAcceptor): void {
    walkStages(node, accept);
  }
}


/**
 * TypeQLite keywords that cannot be used as identifiers.
 *
 * 🔴 These PARSE here — the grammar has no reason to reject `attribute label`. The error surfaces
 * only against a real TypeDB, as `[DEX31] The reserved keyword "label" cannot be used as an
 * identifier`, which is how it cost time twice and why both schema headers record it. `project-name`
 * and `task-kind` exist because `name` and `kind` were unavailable.
 */
/**
 * What TypeDB 3.10.4 refuses as an identifier with `[DEX31]` — each word probed on the live server
 * on 2026-09-11 as `define attribute <word>, value string;`, and `test/reserved-keywords.spec.ts`
 * pins both halves of the answer.
 *
 * 🔴 The list was hand-written before that and over-reserved by twelve: `name`, `label`, `kind`,
 * `type`, `value`, `sort`, `limit`, `offset`, `require`, `distinct`, `select`, `reduce` are all
 * accepted by the server. `name` alone refused every Background in TypeDB's own behaviour spec,
 * and a real schema renamed `name` to `project-name` to dodge a refusal TypeDB never makes.
 * `d-20260911-the-validator-reserves-ten-identifiers-typedb`.
 */
const RESERVED = new Set([
  'match', 'isa', 'entity', 'of', 'fetch', 'relation', 'attribute', 'sub', 'owns', 'plays',
  'relates', 'has', 'links', 'insert', 'delete', 'define', 'undefine', 'put', 'update',
]);

/** Whether TypeDB refuses `word` as an identifier with `[DEX31]` — see `RESERVED`. */
export const isReservedKeyword = (word: string): boolean => RESERVED.has(word);

/** The `[DEX31]` refusal, worded once for the validator and for the engine's parse step. */
export const reservedKeywordMessage = (word: string): string =>
  `'${word}' is a reserved TypeQLite keyword and cannot be used as an ` +
  'identifier — TypeDB refuses it with [DEX31]. Qualify it: `project-id`, `task-kind`.';

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
 * An anonymous relation pattern binds no variable of its own and is deliberately absent from
 * `things` — the interpreter invents `__anonN` for it, and that is a name nobody wrote and nothing
 * should offer back.
 *
 * @privateRemarks
 * 🔴 Mirrors `constraintsOf`'s merging: two patterns naming the same variable are one thing, which
 * is what makes `$p has person-kind $old;` after `$p isa person, ...` a projection of the
 * thing the first pattern found rather than a second, unconstrained one.
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
  return [...walkStages(pipeline)];
}

const valueReadsOf = (pattern: Pattern): string[] =>
  isLetPattern(pattern)
    ? expressionVariables(pattern.expression)
    : isComparisonPattern(pattern)
      ? [pattern.left, ...expressionVariables(pattern.right)]
      : [];

/**
 * A pipeline's stages in order, with what each one sees bound — and, given `accept`, the two
 * findings that need nothing but the AST:
 *
 * - every variable a `let` or comparison reads is bound — by a concept pattern of its `match`, by
 *   an EARLIER stage, or by the parent of a `fetch` sub-query. `$v == $a; $v > $h;` with no `let $v`
 *   is TypeDB's *"The variable 'v' must be bound to a value before it's used"* (expression.feature
 *   L34), a compile-time refusal there and so here;
 * - every variable a `select` names is bound by then (`unprojectableVariable`), with the inventory
 *   of what is.
 *
 * What a stage leaves bound: a `match` or a write adds what it names, a `select` keeps what it names,
 * a `reduce` answers its reductions and groups, a `delete $x` removes `$x` (pipelines.feature L287–L336).
 * Returns what the last stage leaves bound — what `fetch` reads.
 */
function walkStages(node: Pipeline, accept?: ValidationAcceptor): Set<string> {
  let bound = new Set(enclosingOutputs(node));
  // Everything any stage has bound — so a variable an earlier stage DROPPED (a `delete`, a `reduce`,
  // a `select`) is told apart from one nothing ever bound (pipelines.feature L324, L336).
  const ever = new Set(bound);
  let last: MatchBindings | undefined;
  for (const stage of node.stages) {
    if (accept) checkNamed(stage, accept);
    if (isGivenStage(stage)) {
      // `given $x: integer;` — bound by the caller's rows.
      for (const declaration of stage.declarations) bound.add(declaration.variable);
    } else if (isMatchStage(stage) || isInsertStage(stage) || isPutStage(stage)) {
      const bindings = bindingsOf(stage.patterns);
      const local = new Set([...bound, ...bindings.selectable, ...bindings.things.keys(), ...bindings.rolePlayersOnly]);
      if (accept && isMatchStage(stage)) {
        for (const pattern of stage.patterns) {
          const unbound = valueReadsOf(pattern).find((variable) => !local.has(variable));
          if (unbound === undefined) continue;
          accept('error', `The variable '${unbound.slice(1)}' must be bound to a value before it's used.`, {
            node: pattern,
            code: TypeQLiteValidationCode.unboundValue,
          });
        }
      }
      if (isMatchStage(stage)) last = bindings;
      bound = local;
    } else if (isSelectStage(stage)) {
      if (accept) checkSelect(stage, bound, ever, last, accept);
      bound = new Set(stage.variables);
    } else if (isReduceStage(stage)) {
      bound = new Set([...stage.reductions.map((r) => r.variable), ...stage.groups]);
    } else if (isDeleteStage(stage)) {
      for (const deletion of stage.deletions) if (deletion.owner === undefined && deletion.target !== undefined) bound.delete(deletion.target);
    }
    for (const variable of bound) ever.add(variable);
  }
  return bound;
}

/** What a stage names a variable for — to project, order, require, reduce or group by. */
function namedBy(stage: AstNode): string[] {
  if (isSelectStage(stage)) return stage.variables;
  if (isSortStage(stage)) return stage.keys.map((key) => key.variable);
  if (isRequireStage(stage)) return stage.variables;
  if (isReduceStage(stage)) return [...stage.reductions.flatMap((r) => (r.argument === undefined ? [] : [r.argument])), ...stage.groups];
  return [];
}

/**
 * `$_` is anonymous: a pattern may use it to say "something", but a stage that projects, orders,
 * requires or groups by a variable needs one it can name (pipelines.feature L287).
 */
function checkNamed(stage: AstNode, accept: ValidationAcceptor): void {
  if (!namedBy(stage).includes('$_')) return;
  accept('error', 'A non-anonymous variable is expected in this statement for the query: `$_` cannot be selected, sorted, required, reduced or grouped by.', {
    node: stage,
    code: TypeQLiteValidationCode.anonymousVariable,
  });
}

function checkSelect(select: SelectStage, bound: ReadonlySet<string>, ever: ReadonlySet<string>, _last: MatchBindings | undefined, accept: ValidationAcceptor): void {
  // A role player is bound like any other variable, `isa` or not — `relationBindings` binds it and
  // TypeDB answers it. This check used to hedge every selection with "has no `isa` pattern, so this
  // `match` answers 0 rows", which was true before relations bound their players and is not now.
  const canSelect = [...bound].filter((name) => !name.startsWith('$_')).sort();
  const inventory = canSelect.length ? ` Bound here: ${canSelect.join(', ')}.` : ' Nothing in this `match` is bound.';
  for (const variable of select.variables) {
    if (bound.has(variable)) continue;
    // A variable a `let` or comparison reads without anything binding it is the unbound-value
    // finding, in TypeDB's words; this one would only add a second (expression.feature L34).
    if (valueReadOutsideScope(select, variable)) continue;
    // Bound once, and dropped since — TypeDB's own words for it.
    if (ever.has(variable)) {
      accept('error', `The variable '${variable.slice(1)}' was not available in the stage: an earlier stage deleted, reduced or deselected it.`, {
        node: select,
        code: TypeQLiteValidationCode.unprojectableVariable,
      });
      return;
    }
    accept('error', `The variable '${variable.slice(1)}' was not available in the stage: \`select\` names '${variable}', which the \`match\` never bound.${inventory}`, {
      node: select,
      code: TypeQLiteValidationCode.unprojectableVariable,
    });
    return;
  }
}

/** Whether `variable` is read by a `let` or comparison in an earlier `match` of the same pipeline. */
function valueReadOutsideScope(select: SelectStage, variable: string): boolean {
  const pipeline = select.$container as Pipeline;
  const before = pipeline.stages.slice(0, pipeline.stages.indexOf(select));
  return before.some((stage) => isMatchStage(stage) && stage.patterns.some((pattern) => valueReadsOf(pattern).includes(variable)));
}

/**
 * What the pipelines ENCLOSING a `fetch` sub-query answer — `[ match $p has name $pn; $pn != $n; … ]`
 * reads `$n` from its parent (fetch.feature L1159). Empty for a top-level pipeline.
 */
function enclosingOutputs(node: AstNode): string[] {
  const outputs: string[] = [];
  for (let container = node.$container; container !== undefined; container = container.$container) {
    if (isPipeline(container)) outputs.push(...outputsOf(container));
  }
  return outputs;
}

/** The variables an expression reads, in order of appearance. */
export function expressionVariables(expression: Expression): string[] {
  if (isVariableExpression(expression)) return [expression.variable];
  if (isBinaryExpression(expression)) return [...expressionVariables(expression.left), ...expressionVariables(expression.right)];
  if (isNegationExpression(expression)) return expressionVariables(expression.operand);
  if (isFunctionExpression(expression)) return expression.arguments.flatMap(expressionVariables);
  return [];
}

/**
 * What the patterns of a `match` bind, read from the AST alone: the variables a `select` may name, the things
 * with what their patterns say of them, and the variables that only play roles.
 */
export function bindingsOf(patterns: readonly Pattern[]): MatchBindings {
  const selectable = new Set<string>();
  const things = new Map<
    string,
    { type?: string; bound: string[]; literals: string[] }
  >();
  const rolePlayersOnly = new Set<string>();

  const players = (list: RolePlayers | undefined): void => {
    for (const entry of list?.entries ?? []) {
      rolePlayersOnly.add(entry.player);
      // `($role: $x)` — the role is a type variable the relation binds.
      if (entry.roleVariable) selectable.add(entry.roleVariable);
    }
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
      for (const variable of [pattern.variable, ...pattern.others]) selectable.add(variable);
      continue;
    }
    if (isTypePattern(pattern)) {
      typeBound(pattern.properties);
      continue;
    }
    // A disjunction binds what EVERY branch binds; a `try` binds what it binds (when it matches); a
    // negation binds nothing outside itself (variables.feature L63–L252).
    if (isDisjunctionPattern(pattern)) {
      const branches = pattern.branches.map((branch) => {
        const inner = bindingsOf(branch.patterns);
        return new Set([...inner.selectable, ...inner.things.keys()]);
      });
      for (const variable of branches[0] ?? []) if (branches.every((branch) => branch.has(variable))) selectable.add(variable);
      continue;
    }
    if (isOptionalPattern(pattern)) {
      const inner = bindingsOf(pattern.patterns);
      for (const variable of [...inner.selectable, ...inner.things.keys()]) selectable.add(variable);
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
        } else if (property.attribute !== undefined) {
          thing.literals.push(property.attribute);
        }
      }
    }
    things.set(pattern.variable, thing);
  }
  return { selectable, things, rolePlayersOnly };
}
