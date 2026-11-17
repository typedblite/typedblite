import { defaultOpener } from '#default-opener';
import type { SqliteDatabase, SqliteOpener } from './sqlite-database.js';
import { cachingStatements } from './statement-cache.js';
import { AstUtils, EmptyFileSystem, type AstNode as LangiumNode } from 'langium';
import {
  createTypeQLiteServices,
  isReservedKeyword,
  reservedKeywordMessage,
  validateSync,
  isAbstractAnnotation,
  isAnonRelationPattern,
  isAttributeDef,
  isDefineClause,
  isEntityDef,
  isKeyAnnotation,
  isOwnsTrait,
  isRelatesTrait,
  isHasProperty,
  isIidProperty,
  isCallComparisonPattern,
  isBooleanLiteral,
  isDurationLiteral,
  isDateLiteral,
  isDatetimeLiteral,
  isDatetimeTzLiteral,
  isDecimalLiteral,
  isDoubleLiteral,
  isIntLiteral,
  isIsaProperty,
  isComparisonPattern,
  isKindPattern,
  isLetPattern,
  VALUE_TYPES,
  isDisjunctionPattern,
  isIsPattern,
  isNegationPattern,
  isOptionalPattern,
  isVariableExpression,
  isLiteralExpression,
  isMatchStage,
  isSelectStage,
  literalFits,
  literalKind,
  isLinksProperty,
  isRelationDef,
  isTypeExtensionDef,
  isPlaysTrait,
  isStringLiteral,
  isThingPattern,
  type Annotation,
  type Definition,
  type Literal,
  type Pattern,
  type LetPattern,
  type ComparisonPattern,
  type ReduceStage,
  type FetchStage,
  type Pipeline,
  type MatchStage,
  type SelectStage,
  type DeleteStage,
  type InsertStage,
  type FunctionDefinition,
  type ReturnStage,
  type UpdateStage,
  type ThingPattern,
  type Expression,
  type Property,
  type IsaProperty,
  type Deletion,
  type AnonRelationPattern,
  type OptionalPattern,
  type PutStage,
  type WriteStage,
  type SortStage,
  type Stage,
  type LeadStage,
  type RedefineClause,
  type RolePlayers,
  type TypeQLiteFile,
  type UndefineClause,
  type TypeDefinition,
} from '@typedblite/language';
import { declaredParentOf, isTypeDefinition } from './type-definitions.js';
import type { Range } from 'vscode-languageserver';
import {
  attachDiagnostic,
  type DiagnosticCodeValue,
  DIAGNOSTIC_SOURCE,
  DiagnosticCode,
  DiagnosticCollector,
  rangeFromOffset,
  rangeOf,
  type ExecutionReport,
} from './diagnostics.js';
import { OWNED, attributeId, ensureAttribute, ensureScopedUniqueness, hasAttributeTables, migrateAttrTable, ownAttribute, ownersOfValue, rescopeOwnerships, sweepAttributes } from './attribute-store.js';
import { generateSchema } from './sqlite-generator.js';
import { attributeIid, decodeIid, thingIid } from './iid.js';
import { checkSchemaRules, type DataFacts, type Refuse, type SchemaFacts } from './schema-rules.js';
import { applyRedefine, applyUndefine } from './schema-mutation.js';
import { type SchemaContext } from './expressions.js';
import { applyValueStatements, useSchemaFunctions, compareStrings, compareValues, temporalKey, variablesOf, inferValueType, letVariables, type ValueStatements, numericOf, orderValueStatements, valueOf, INTEGER_MAX, INTEGER_MIN, type ValueBinding } from './expressions.js';
import { applyReduce, checkReduce } from './reduce.js';
import { canonicalTemporal } from './temporal.js';
import { checkFetch, fetchDocument, ownershipMax, roleMax, type FetchContext, type FetchScope, type JsonValue } from './fetch.js';
import { isTypeHead, solveTypes, typeConstraintsOf, type Binding } from './type-patterns.js';
import {
  ownsKey,
  playsSubject,
  recordCategory,
  recordText,
  roleRef,
  subSubject,
  traitSubject,
  typeSubject,
  valueSubject,
  relatesSubject,
  ownsSubject,
} from './schema-subjects.js';
import { ChangeLog, type EntityIdentity } from './change-log.js';

const { TypeQLite } = createTypeQLiteServices(EmptyFileSystem);

/**
 * What a row cell can be — the driver's `Concept` kinds TypeDBLite answers with.
 *
 * @category Engine
 */
export type ConceptKind = 'entity' | 'relation' | 'attribute' | 'value' | 'type';

/**
 * A result cell: a concept, the way the TypeDB driver hands one back. A cell carries what it is:
 *
 * - an **entity** or **relation**: its `iid` and its actual `type` — `writer`, not the `person` the query wrote, because TypeDB answers the instance's own type;
 * - an **attribute**: its actual `type` and its value;
 * - a **value**: a value type and a value (an expression's or a reducer's result);
 * - a **type**: a schema type by its label — `person`, or a role type as `employment:employee` — which is what `match $x sub person;` answers. It has no iid and no value.
 *
 * The three `as…()` readers work on an attribute or value cell and **throw on a thing or a type**, with the driver's
 * own message shape. A repository that projects a thing reads `iid` and `type` and nothing else.
 *
 * @privateRemarks
 * 🔴 **A cell was a string, and only a string, until Phase 02 of the conformance feature.** The
 * projection emitted one column per `has` binding and nothing else, so a thing variable contributed
 * nothing to its row and the empty row was dropped — `match $x isa person;` answered zero rows at
 * exit 0 (`d-20260911-a-match-pipeline-with-no-select`). A cell now carries what it is:
 *
 * - an **entity** or **relation**: its `iid` and its actual `type` — `writer`, not the `person` the
 *   query wrote, because TypeDB answers the instance's own type;
 * - an **attribute**: its actual `type` and its value;
 * - a **value**: a value type and a value (an expression's or a reducer's result);
 * - a **type** (Phase 05): a schema type by its label — `person`, or a role type as
 *   `employment:employee` — what `match $x sub person;` answers. No iid, no value.
 *
 * @category Engine
 */
export class TypeDBLiteValue {
  private constructor(
    private readonly kind: ConceptKind,
    /** The type label: a thing's type, an attribute's type, or a value's value type. */
    public readonly type: string,
    private readonly raw: string,
    private readonly id: number | undefined,
  ) {}

  /** An entity cell: its `iid` and its own type. */
  static entity(iid: number, type: string): TypeDBLiteValue {
    return new TypeDBLiteValue('entity', type, '', iid);
  }

  /** A relation cell: its `iid` and its own type. */
  static relation(iid: number, type: string): TypeDBLiteValue {
    return new TypeDBLiteValue('relation', type, '', iid);
  }

  /** An attribute cell: its type, and its value as text. */
  static attribute(type: string, value: string): TypeDBLiteValue {
    return new TypeDBLiteValue('attribute', type, value, undefined);
  }

  /** A value cell: the result of an expression or a reducer, with its value type and its value as text. */
  static value(valueType: string, value: string): TypeDBLiteValue {
    return new TypeDBLiteValue('value', valueType, value, undefined);
  }

  /** A schema type, by label — `person`, or a role type as `relation:role`. */
  static type(label: string): TypeDBLiteValue {
    return new TypeDBLiteValue('type', label, '', undefined);
  }

  /** Whether this cell is a schema type, as `match $x sub person;` answers. */
  isType(): boolean {
    return this.kind === 'type';
  }

  /** The type cell's label. Throws on any other kind — a thing has a `type`, not a `label`. */
  get label(): string {
    if (this.kind !== 'type') throw new Error(`Cannot extract label from ${this.kind}('${this.type}')`);
    return this.type;
  }

  /** Whether this cell is an entity. */
  isEntity(): boolean {
    return this.kind === 'entity';
  }

  /** Whether this cell is a relation. */
  isRelation(): boolean {
    return this.kind === 'relation';
  }

  /** Whether this cell is a thing, an entity or a relation: one with an `iid`. */
  isThing(): boolean {
    return this.id !== undefined;
  }

  /** Whether this cell is an attribute. */
  isAttribute(): boolean {
    return this.kind === 'attribute';
  }

  /** Whether this cell is a value: the result of an expression or a reducer. */
  isValue(): boolean {
    return this.kind === 'value';
  }

  /** A thing's internal id. Throws on an attribute or value cell, which have none. */
  get iid(): number {
    if (this.id === undefined) {
      throw new Error(`Cannot extract iid from ${this.kind}('${this.raw}')`);
    }
    return this.id;
  }

  /**
   * The concept's iid as TypeQL writes it — `0x…`, what `iid($x)` answers and `$x iid …` matches (see
   * `iid.ts`). A thing or an attribute has one; a value or a type does not.
   */
  get iidHex(): string {
    if (this.id !== undefined) return thingIid(this.kind === 'relation', this.id);
    if (this.kind === 'attribute') return attributeIid(this.type, this.raw);
    throw new Error(`Cannot extract iid from ${this.kind}('${this.type}')`);
  }

  /** 🔴 A thing, or a type, has no string value. Reading one as a string is the driver's error, not `''`. */
  private valueOrThrow(as: string): string {
    if (this.id !== undefined || this.kind === 'type') {
      throw new Error(`Cannot extract ${as} from ${this.kind}('${this.type}')`);
    }
    return this.raw;
  }

  /**
   * An attribute's or value's text.
   *
   * @throws on a thing or a type, which have no string value.
   */
  asString(): string {
    return this.valueOrThrow('string');
  }

  /**
   * An attribute's or value's integer. It throws rather than coercing, matching the driver.
   *
   * @throws on a thing or a type, and on a value that is not an integer.
   *
   * @privateRemarks
   * 🔴 Throws rather than coercing, matching the driver. `rowString` cannot read a numeric
   * attribute because `asString()` throws there; `rowNumber` tries `asInteger` first and falls
   * through to `asDouble`. Coercing here would make `rowNumber` return a number for a genuinely
   * non-numeric attribute and quietly break that distinction — found by a real schema's
   * `ordinal`.
   */
  asInteger(): number {
    const raw = this.valueOrThrow('integer');
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`Cannot extract integer from attribute('${raw}')`);
    }
    return Number.parseInt(raw, 10);
  }

  /**
   * An attribute's or value's number as a double.
   *
   * @throws on a thing or a type, and on a value that is not a number.
   */
  asDouble(): number {
    const raw = this.valueOrThrow('double');
    const value = Number.parseFloat(raw);
    if (Number.isNaN(value)) {
      throw new Error(`Cannot extract double from attribute('${raw}')`);
    }
    return value;
  }

  /** A stable rendering for every kind — what a shell prints and a set comparison keys on. */
  toString(): string {
    if (this.kind === 'type') return `type:${this.type}`;
    return this.id === undefined ? this.raw : `${this.kind}:${this.type}:#${this.id}`;
  }
}

/**
 * The schema applied to a database, as sorted lists: what `schemaSnapshot()` returns.
 *
 * @category Engine
 */
export interface TypeDBLiteSchemaSnapshot {
  /** The entity and relation types, which are the things that can have instances. */
  readonly types: readonly string[];
  /** Which of `types` are relations. */
  readonly relations: readonly string[];
  /** The attribute types. */
  readonly attributes: readonly string[];
  /** Each attribute a type owns directly, not through a parent. */
  readonly owns: readonly { readonly owner: string; readonly attribute: string }[];
  /** Each type with the type it is a subtype of. */
  readonly parents: readonly { readonly type: string; readonly parent: string }[];
  /** The value type of each attribute. */
  readonly valueTypes: readonly { readonly attribute: string; readonly valueType: string }[];
  /** The roles of each relation. */
  readonly roles: readonly { readonly relation: string; readonly role: string }[];
  /** The roles each type plays, written `relation:role`. */
  readonly plays: readonly { readonly player: string; readonly role: string }[];
  /** The annotations set on types, ownerships and roles: where, which, and as written. */
  readonly annotations: readonly { readonly subject: string; readonly category: string; readonly text: string }[];
}

/**
 * What `define` applied, so a query can be checked against it. The `SchemaFacts` view of it is
 * what `schema-rules.ts` reads; this is the mutable whole the interpreter maintains.
 */
interface SchemaModel extends SchemaFacts {
  readonly types: Set<string>;
  /**
   * Which of `types` are relations. `schema_element` cannot say — its `kind` CHECK admits `type`
   * and `attribute` only, and SQLite cannot alter a CHECK in place — so this is read from the
   * additive `schema_relation` table, the way `key_attribute` is. A thing whose type is not here
   * projects as an entity.
   */
  readonly relations: Set<string>;
  readonly attributes: Set<string>;
  /**
   * Which type owns which attribute — `"node\u0000edge-id"`.
   *
   * 🔴 This was missing, and its absence was mistaken for an impossibility. With only the two sets
   * above, `checkKnown` could say `edge-id` is a known attribute and nothing more, so
   * `match $n isa node, has edge-id $e;` answered zero rows and the diagnostic had no way to say
   * why. Two attempts to infer it from candidate counts were wrong in different ways before the
   * inference was deleted as underivable — which it was, from *these* sets. The schema AST always
   * carried it; nothing had ever written it down.
   */
  readonly owns: Set<string>;
  /**
   * Each type's direct supertype, in memory.
   *
   * ⚠️ **Not a query.** The first version of the ownership check walked `type_parent` with a
   * recursive CTE per constraint, inside `execute`'s transaction — and the concurrent-writer
   * durability test failed with `database is locked`. A check that makes writes contend is not
   * worth the diagnostic; the parent chain is small, fixed by `define`, and belongs beside the
   * other schema facts.
   */
  readonly parents: Map<string, string>;
  /**
   * Each attribute type's declared value type, from `schema_value_type`. A subtype declaring none
   * inherits — `valueTypeOf` in `schema-rules.ts` walks `parents` for it.
   */
  readonly valueTypes: Map<string, string>;
  /** Each relation's declared roles, from `schema_relates`. Inherited roles are the parent's. */
  readonly roles: Map<string, Set<string>>;
  /** Types declared `@abstract`, from `schema_abstract`. An insert of one is refused. */
  readonly abstracts: Set<string>;
  /** Ownerships declared `@key`, from `schema_key_owns`, as `ownsKey(owner, attribute)`. */
  readonly keyOwnerships: Set<string>;
  /** Every annotation per subject, from `schema_annotation` — category → text as written. */
  readonly annotations: Map<string, Map<string, string>>;
  /** Which types play which roles, from `schema_plays`, as `playsSubject`-shaped `type\u0000plays\u0000rel:role`. */
  readonly plays: Set<string>;
  /** The ordered capabilities — `owns name[]`, `relates parent[]` — by subject, from `schema_ordered`. */
  readonly ordered: Set<string>;
  /** `relates father as parent` — `relation:role` to the specialised `relation:role`, from `schema_specialises`. */
  readonly specialises: Map<string, string>;
  /** `define fun …`, by name, from `schema_function`. */
  readonly functions: Set<string>;
  /** `define struct …`, each with its fields, from `schema_struct`. */
  readonly structs: Map<string, Set<string>>;
}

/**
 * The subtype closure of one label, as a SQL subquery taking the label as its single parameter.
 * `type_parent` carries thing types and attribute types alike, so the same closure answers
 * `isa doc` with an `adr` and `has name` with a `first-name`.
 */
const SUBTYPES_OF =
  '(WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT type FROM type_parent, sub WHERE parent = sub.x) SELECT x FROM sub)';

/**
 * What the engine did for ONE `query()` call — counts, never times, so a regression test can
 * assert that a join is not a cartesian product (a real performance defect: one
 * `subSkillsIn` call evaluated ~211,000 combinations and took 32 s).
 *
 * Off by default and then costs nothing: no proxy wraps the database and every hook is a single
 * `undefined` check. Enabled by the `trace` constructor option or `TYPEDBLITE_TRACE=1`, and read
 * with `lastQueryTrace()` — nothing is printed.
 *
 * @category Engine
 */
export interface QueryTrace {
  /** Output size of each stage of `combinations()`, in the order the stages ran. */
  readonly stages: Array<{ stage: string; combinations: number }>;
  /** The sum of every stage's output: the combinations the engine built. */
  combinationsCreated: number;
  /** `relationHolds` evaluations, early (pushed-down) and final alike. */
  relationHoldsCalls: number;
  /** `findRelations` evaluations, `relationHolds` and named-relation expansion alike. */
  findRelationsCalls: number;
  /** `candidates()` lookups, and the rows they returned. */
  candidatesCalls: number;
  /** The rows those lookups returned. */
  candidateRows: number;
  /** Rows the relation lookups read (`findRelationsCalls`): role-player combinations, before they are bound. */
  relationRows: number;
  /** `prepare()` calls the engine made during the query. */
  statementsPrepared: number;
  /** Statements the engine ran during the query: its `all`, `get`, `run`, `iterate` and `exec` calls. */
  statementsExecuted: number;
}

/**
 * How an interpreter opens its database and runs queries: the third argument of its constructor.
 *
 * @category Engine
 */
export interface TypeDBLiteOptions {
  /** Record a `QueryTrace` per `query()`; defaults to `TYPEDBLITE_TRACE` being set to a truthy value. */
  trace?: boolean;
  /**
   * Plan joins: apply a relation constraint as soon as its role players are bound, and draw a role
   * player's candidates from the relation's `role_player` rows. `true` by default. `false` is the
   * original engine -- every thing variable bound as a cartesian product, relations filtered
   * afterwards -- kept so a differential test can prove the two agree row for row, in order.
   */
  planJoins?: boolean;
  /**
   * How to open the database. Defaults to `node:sqlite`. Pass another binding (a WASM SQLite in a
   * worker) to run the interpreter where Node's built-ins do not exist; see `sqlite-database.ts` for
   * what a binding must honour.
   */
  openDatabase?: SqliteOpener;
}

const newTrace = (): QueryTrace => ({
  stages: [],
  combinationsCreated: 0,
  relationHoldsCalls: 0,
  findRelationsCalls: 0,
  candidatesCalls: 0,
  candidateRows: 0,
  relationRows: 0,
  statementsPrepared: 0,
  statementsExecuted: 0,
});

/** The database behind a proxy that counts statements into whichever trace is current. */
function tracingDatabase(raw: SqliteDatabase, current: () => QueryTrace | undefined): SqliteDatabase {
  const countingStatement = (statement: object): object =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        if (property === 'all' || property === 'get' || property === 'run' || property === 'iterate') {
          return (...args: unknown[]) => {
            const trace = current();
            if (trace) trace.statementsExecuted++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  return new Proxy(raw, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'prepare') {
        return (sql: string) => {
          const trace = current();
          if (trace) trace.statementsPrepared++;
          return countingStatement(target.prepare(sql));
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          const trace = current();
          if (trace) trace.statementsExecuted++;
          return target.exec(sql);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}


/**
 * 🔴 Every entry carries the range of the AST node it came from — the provenance Phase 00 measured
 * as the single reason two throw sites had no source position.
 *
 * `constraintsOf()` is where the AST link was dropped: it converts `Pattern`s into plain
 * `{ attribute, value }` / `{ role, player }` objects, and every downstream throw inherited that
 * loss. Carrying a `Range` costs one field and is why this phase needed no reshape of execution.
 */
/** Which statement a constraint came from — the ownership refusal is worded by it. */
type OwnershipStatement = 'match' | 'write';

/** One `isa`: a written type or a type variable, exact (`isa!`) or through the subtypes. */
interface Isa {
  readonly type?: string;
  /** `$x isa $t` — bound by a type pattern, or by the thing's own type (Phase 05). */
  readonly typeVariable?: string;
  readonly exact: boolean;
}

interface ThingConstraint {
  variable: string;
  /**
   * The first WRITTEN type — what the ownership check, the diagnostics and an insert read when
   * they want one label. Derived from `isas`; never set apart from it.
   */
  type?: string;
  /**
   * Every `isa` on the variable, in one pattern or across patterns, each its own filter or
   * binding. 🔴 Three review rounds of Phase 05 patched a `type`/`exact`/`typeVariable` triple
   * plus an overflow list; the triple could not hold two of anything, and every reader that
   * looked at one field missed the others. One list, read whole.
   */
  isas: Isa[];
  /** Where the pattern that introduced this constraint sits in the source. */
  range?: Range;
  /** `$x iid 0x…` — the one concept with that iid (`iid.ts`); a thing's narrows the candidates. */
  iids?: string[];
  /** `has project-id "x"` — narrows the candidates. */
  literals: Array<{
    attribute: string;
    value: string;
    range?: Range;
    /**
     * `has measure 60` where `measure` is abstract with no value type: the literal spelt per
     * concrete subtype that can read it — `height` as `60`, `weight` as `60.0` — because
     * `attr.value` is compared as text in each subtype's own spelling (review, round 16).
     */
    alternatives?: Array<{ type: string; value: string }>;
  }>;
  /** `has project-name $n` — projected into the result. `has $a` names no attribute type: any. */
  bindings: Array<{ attribute?: string; variable: string; range?: Range }>;
  /**
   * `$n isa name "John"` — an ATTRIBUTE instance (ADR-006), not a thing. The constraint's own
   * variable is a synthetic `__anonattrN`, and its one binding binds `$n` as an attribute value,
   * so everything that reads bindings — bound variables, kinds, projection — sees `$n` as `has name
   * $n` would leave it. `combinations` enumerates `attribute` for it instead of `thing`.
   */
  instance?: {
    readonly variable: string;
    readonly type: string;
    readonly exact: boolean;
    /** `isa name "John"`, or a write's `isa name == "John"`. */
    readonly literal?: { value: string; alternatives?: Array<{ type: string; value: string }> };
    /** A write's `isa name == $v` — the value `$v` holds. */
    readonly valueVariable?: string;
    readonly range?: Range;
  };
  /** `$r isa task-dependency (dependent: $d, ...)` — the relation's own role players. */
  roles: Array<{
    /** `(employee: $p)` names it; `($p)` leaves it to the schema — any role in a match. */
    role?: string;
    /** `($r: $p)` — a type variable bound to the role type the player plays. */
    roleVariable?: string;
    player: string;
    /** Which `links (...)` list this slot was written in — see `rolesOf`. */
    statement: number;
    range?: Range;
  }>;
}

/**
 * The rows a `given` stage receives (given.feature): one record per row, keyed by variable name
 * without its `$`. `null` is an absent value — admitted only for a variable declared optional (`?`).
 *
 * @category Engine
 */
export type GivenRows = ReadonlyArray<Readonly<Record<string, TypeDBLiteValue | null>>>;

/**
 * What `execute()` reports: its diagnostics, and what its last write pipeline answers.
 *
 * @category Engine
 */
export interface WriteReport extends ExecutionReport {
  /** The rows the last write pipeline answers, when it ends in `select` or similar. */
  readonly rows: ReadonlyArray<Record<string, TypeDBLiteValue>>;
  /** When the pipeline ends in `fetch`: a document per answer, and `rows` is empty. */
  readonly documents?: ReadonlyArray<JsonValue>;
}

/** What the stage planner and runner read: a pipeline's stages, or a function body's. */
type Stages = { readonly stages: ReadonlyArray<LeadStage | Stage> };

/**
 * One `match` (and what used to follow it in a fixed order) — the unit the per-match machinery
 * (`combinations`, `selectedOf`, `project`) reads. A pipeline is a list of stages now; each `match`
 * stage is evaluated as a segment of its own, seeded with the answers before it.
 */
interface Segment {
  readonly match?: MatchStage;
  readonly select?: SelectStage;
  readonly reduce?: ReduceStage;
}

type StreamKind = 'thing' | 'type' | 'value';

/**
 * What a pipeline has bound at one point between its stages, from the query and the schema alone —
 * what the static pass checks each stage against, so a refusal never depends on whether an earlier
 * stage answered anything.
 */
interface StreamScope {
  readonly available: Set<string>;
  readonly kinds: Map<string, StreamKind>;
  /** Every pattern of every `match` so far — what a write reads its bindings' attribute types from. */
  readonly patterns: Pattern[];
  /** Each `match` so far, for the types a variable can be. */
  readonly segments: Segment[];
  /** The attribute type a value variable was bound through (`has age $a`); `undefined` for `has $a`. */
  readonly attributeOf: Map<string, string | undefined>;
  /** A value variable's value type, where the schema or the `let` says. */
  readonly valueTypes: Map<string, string | undefined>;
  /** Variables that may be EMPTY — from a `try`, or a `given` declared `?` — which a write may read only inside `try`. */
  readonly optional: Set<string>;
  /** A `given` thing variable's declared type — what a write's ownership is inferred from (given.feature L346). */
  readonly declared?: Map<string, string>;
  /** The type an insert or put stage wrote a variable as — what a later `update` is checked against. */
  readonly inserted?: Map<string, string>;
}

/**
 * The engine: executes TypeQLite against SQLite. Open a database with `new TypeDBLiteInterpreter(path)`, `define` a
 * schema, then `execute` writes and `query` reads.
 *
 * Deliberately an **interpreter, not a SQL generator**: bindings are resolved by executing, so a
 * failing statement can say which one it was and a constraint violation knows which attribute it
 * was writing. That last point is not a nicety — see `translateConstraintError`.
 *
 * @category Engine
 */
export class TypeDBLiteInterpreter {
  private readonly db: SqliteDatabase;
  private schema: SchemaModel = {
    types: new Set(),
    relations: new Set(),
    attributes: new Set(),
    owns: new Set(),
    parents: new Map(),
    valueTypes: new Map(),
    roles: new Map(),
    abstracts: new Set(),
    keyOwnerships: new Set(),
    annotations: new Map(),
    plays: new Set(),
    ordered: new Set(),
    specialises: new Map(),
    functions: new Set(),
    structs: new Map(),
  };
  /** The schema's functions, parsed from `schema_function` — what a call in any query may name. */
  private schemaFunctionDefinitions = new Map<string, FunctionDefinition>();
  /** Functions whose planning is under way — a recursive call is not planned again. */
  private readonly planningFunctions = new Set<FunctionDefinition>();

  /**
   * The change log (ADR-003 D1). Its rows are written inside `execute`'s existing transaction, so a
   * write and its log entry commit or roll back together — never a commit followed by a publish
   * that a crash can lose.
   */
  public readonly changeLog: ChangeLog;

  /** Things written during the current pipeline. Reset per pipeline, because each has its own transaction. */
  private touched = new Set<number>();

  /** Identities captured *before* a delete runs — afterwards there is nothing left to read. */
  private tombstones: EntityIdentity[] = [];

  /**
   * Diagnostics for the call in progress (ADR-004).
   *
   * 🔴 Per call, not per interpreter. A report describes one statement; keeping it on the instance
   * would leak one caller's diagnostics into the next caller's report, which is the same
   * cross-contamination `touched` is reset per pipeline to avoid.
   */
  private diagnostics = new DiagnosticCollector();

  /** Counts for the `wrote` execution fact. Counts, never lists — payloads replicate. */
  private written = { things: 0, attributes: 0, roles: 0 };

  /** A constructor-time warning, waiting for a report that will actually be read. */
  private startupFact: string | undefined;

  /** The trace being filled, only while a traced `query()` runs. */
  private trace: QueryTrace | undefined;
  private lastTrace: QueryTrace | undefined;
  private readonly tracing: boolean;
  private readonly planJoins: boolean;

  /**
   * Opens a database, creating it if it does not exist.
   *
   * @param location `:memory:` for a database that lives only in this object, or the path of a SQLite file, which is also
   * what `openDatabase` in `options` is given.
   * @param busyTimeoutMs How long a write waits for another writer's lock before failing with `SQLITE_BUSY`. Default 5000.
   * @param options Tracing, join planning, and which SQLite binding to open the database with.
   */
  constructor(location = ':memory:', busyTimeoutMs = 5000, options: TypeDBLiteOptions = {}) {
    // Beneath the tracing proxy, so a trace still counts every `prepare()` the engine asks for —
    // the shape of the work, which is what tests assert on — not whether the cache answered it.
    const raw = cachingStatements((options.openDatabase ?? defaultOpener)(location));
    // `process` does not exist in a browser or a WebView; there the environment switches are off.
    const processEnv = typeof process === 'undefined' ? {} : process.env;
    const env = processEnv['TYPEDBLITE_TRACE'];
    // `TYPEDBLITE_PLAN_JOINS=0` restores the original engine for a whole process (bisecting, and
    // the conformance suite's before/after comparison).
    this.planJoins = options.planJoins ?? processEnv['TYPEDBLITE_PLAN_JOINS'] !== '0';
    this.tracing = options.trace ?? (env !== undefined && env !== '' && env !== '0' && env !== 'false');
    this.db = this.tracing ? tracingDatabase(raw, () => this.trace) : raw;
    // 🔴 SQLite permits one writer at a time, and `node:sqlite` sets **no busy timeout** — so a
    // second process attempting a write fails immediately with SQLITE_BUSY rather than waiting for
    // the lock. Found by making a concurrency test genuinely concurrent: an earlier version used
    // `spawnSync` in a `map`, which runs each child to completion before the next starts, so three
    // "concurrent" writers never contended and this was invisible.
    //
    // Replication is a multi-process design by definition — a hub and its spokes, and the
    // Phase 01 durability suite — so waiting is the correct behaviour, not an optimisation.
    this.db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
    // 🔴 SQLite's `LIKE` folds ASCII case by default, and TypeQLite labels are case-sensitive:
    // `undefine foo;` deleted `Foo`'s annotation rows (Phase 04 review, round 2). No reader in
    // this engine wants the folding — the only `LIKE`s are `schema-mutation.ts`'s, on labels.
    this.db.exec('PRAGMA case_sensitive_like = ON');

    // 🔴 WAL, so a reader does not block the writer and the writer does not block readers.
    //
    // The default rollback journal takes an exclusive lock for the whole write, so every read in
    // another process waits for it and the writer waits for every open read. That is the shape
    // replication has by design — a hub and its spokes, the durability suite's concurrent writers —
    // and it is what surfaced as `database is locked` the moment a per-constraint lookup was added
    // inside `execute`'s transaction.
    //
    // ⚠️ **WAL does not make writes parallel.** SQLite still permits one writer at a time; what
    // changes is that readers no longer contend with it. `busy_timeout` above remains required, and
    // is what makes a second writer wait rather than fail.
    //
    // ⚠️ **It is a property of the DATABASE FILE, not the connection** — persisted in the header, so
    // it survives reopening and every later process inherits it. Setting it here rather than in the
    // schema prelude is deliberate: it must apply to a database that has never had `define` run.
    this.applyJournalMode(location);

    this.changeLog = new ChangeLog(this.db);
    this.changeLog.ensureSchema();
    // A store written before ADR-006 keeps its attributes in `attr`; move them, once, before anything
    // reads the store. A store `define` never reached has neither table and nothing to move.
    migrateAttrTable(this.db);
    ensureScopedUniqueness(this.db);
    this.loadSchema();
    this.ensureRolePlayerIndex();
  }

  /**
   * A store created before `role_player_by_player` existed has the table without it, and `define` is not re-run on
   * open. Adding it is idempotent and only a lookup path (it changes no row, no rule and no answer), so a failure
   * to add one (a read-only file, a contended lock) is not a reason to refuse to open: the lookup is merely slower.
   */
  private ensureRolePlayerIndex(): void {
    try {
      const table = this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'role_player'").get();
      if (table !== undefined) {
        this.db.exec('CREATE INDEX IF NOT EXISTS role_player_by_player ON role_player(player, role, rel)');
        // Repeated role players: a store from before them holds each edge once, which is a count of one.
        const columns = (this.db.prepare("SELECT name FROM pragma_table_info('role_player')").all() as Array<{ name: string }>).map((c) => String(c.name));
        if (!columns.includes('count')) this.db.exec('ALTER TABLE role_player ADD COLUMN count INTEGER NOT NULL DEFAULT 1');
        // A store defined before lists existed has no `schema_ordered`; `undefine` and `redefine`
        // write to it whether or not a list was ever declared. Additive and empty: no list was.
        this.db.exec('CREATE TABLE IF NOT EXISTS schema_ordered (subject TEXT PRIMARY KEY)');
        this.db.exec('CREATE TABLE IF NOT EXISTS schema_specialises (relation TEXT NOT NULL, role TEXT NOT NULL, specialises TEXT NOT NULL, PRIMARY KEY (relation, role))');
      }
    } catch {
      /* slower, not wrong */
    }
  }

  /**
   * Put a file-backed database into WAL, and say so if it refuses.
   *
   * 🔴 **`:memory:` cannot do WAL and does not error** — it reports `memory` and carries on, which
   * is correct and is why this is not treated as a failure. Every test using `:memory:` therefore
   * runs under the default journal, so **WAL is only exercised by the file-backed suites** — the
   * durability and replication ones. A green `:memory:` suite says nothing about it.
   *
   * ⚠️ A file-backed database that answers anything other than `wal` is reported rather than
   * ignored: the filesystem may not support the shared-memory file WAL needs, and silently running
   * with the concurrency this was added to fix would be the failure mode, not the fix.
   */
  private applyJournalMode(location: string): void {
    if (location === ':memory:') return;

    // 🔴 A failure to enable WAL must not stop the database opening.
    //
    // The PRAGMA does not merely answer a different mode when it cannot switch — it **throws**:
    // `database is locked`, if another connection holds a read open at that moment. Left
    // uncaught, a *contended* database could not be opened at all, and the engine would be less
    // available than before WAL was added to make it more so. Failing to optimise the journal is
    // not a reason to refuse the store.
    let mode: string | undefined;
    try {
      const rows = this.db.prepare('PRAGMA journal_mode = WAL').all() as Array<{
        journal_mode?: string;
      }>;
      mode = rows[0]?.journal_mode?.toLowerCase();
    } catch (error) {
      mode = error instanceof Error ? `refused (${error.message})` : 'refused';
    }

    if (mode !== 'wal') {
      // 🔴 Held, not reported here. `define`, `execute` and `query` each REPLACE `this.diagnostics`
      // with a fresh collector, so a fact written in the constructor is discarded before anything
      // can read it — a warning nobody could ever see, which is the same dead-guard shape as an
      // ownership set that is never populated. It is emitted on the first report instead.
      this.startupFact =
        `Could not enable WAL on '${location}': SQLite reports journal_mode='${mode}'. ` +
        'Readers and writers will contend as they did before. This usually means the filesystem ' +
        'cannot host the -shm file WAL requires.';
    }
  }

  /**
   * A fresh collector for one call, carrying any constructor-time warning forward exactly once.
   *
   * The three entry points each reset diagnostics, which is deliberate — a report describes one
   * statement — but it also meant nothing written before the first call could survive to be read.
   */
  /** Below-error validator diagnostics from the last `parse()`, flushed after the call's own facts. */
  private deferredFacts: ReadonlyArray<{ code?: string | number; message: string; range: Range }> = [];

  private flushDeferredFacts(): void {
    for (const diagnostic of this.deferredFacts) {
      this.diagnostics.fact(
        String(diagnostic.code) as DiagnosticCodeValue,
        diagnostic.message,
        diagnostic.range,
      );
    }
    this.deferredFacts = [];
  }

  private freshDiagnostics(): DiagnosticCollector {
    const collector = new DiagnosticCollector();
    if (this.startupFact !== undefined) {
      collector.fact(DiagnosticCode.journalMode, this.startupFact);
      this.startupFact = undefined;
    }
    return collector;
  }

  /** Whether a schema has been applied — to THIS database, not this process. */
  get hasSchema(): boolean {
    return this.schema.types.size > 0 || this.schema.attributes.size > 0;
  }

  /** The schema applied to this database, as sorted lists. Survives a reopen. */
  schemaSnapshot(): TypeDBLiteSchemaSnapshot {
    return {
      types: [...this.schema.types].sort(),
      relations: [...this.schema.relations].sort(),
      attributes: [...this.schema.attributes].sort(),
      owns: [...this.schema.owns].map((key) => {
        const [owner, attribute] = key.split('\u0000');
        return { owner, attribute };
      }).sort((left, right) => `${left.owner}:${left.attribute}`.localeCompare(`${right.owner}:${right.attribute}`)),
      parents: [...this.schema.parents.entries()].map(([type, parent]) => ({ type, parent }))
        .sort((left, right) => `${left.type}:${left.parent}`.localeCompare(`${right.type}:${right.parent}`)),
      valueTypes: [...this.schema.valueTypes.entries()].map(([attribute, valueType]) => ({ attribute, valueType }))
        .sort((left, right) => `${left.attribute}:${left.valueType}`.localeCompare(`${right.attribute}:${right.valueType}`)),
      roles: [...this.schema.roles.entries()].flatMap(([relation, roles]) =>
        [...roles].map((role) => ({ relation, role })),
      ).sort((left, right) => `${left.relation}:${left.role}`.localeCompare(`${right.relation}:${right.role}`)),
      plays: [...this.schema.plays].map((key) => {
        const [player, , role] = key.split('\u001f');
        return { player, role };
      }).sort((left, right) => `${left.player}:${left.role}`.localeCompare(`${right.player}:${right.role}`)),
      annotations: [...this.schema.annotations.entries()].flatMap(([subject, values]) =>
        [...values.entries()].map(([category, text]) => ({
          subject: subject.split('\u001f').join('/'),
          category,
          text,
        })),
      ).sort((left, right) => `${left.subject}:${left.category}`.localeCompare(`${right.subject}:${right.category}`)),
    };
  }

  /**
   * 🔴 Reload the applied vocabulary from the database on open.
   *
   * Without this the type list lives only in the process that ran `define`, so a fresh process
   * against a file-backed database believes no schema exists — `--database` would persist data
   * that nothing could then query, and `checkKnown` would silently check nothing.
   */
  private loadSchema(): void {
    try {
      const rows = this.db
        .prepare('SELECT kind, name FROM schema_element')
        .all() as Array<{ kind: string; name: string }>;
      for (const row of rows) {
        if (row.kind === 'type') this.schema.types.add(row.name);
        else this.schema.attributes.add(row.name);
      }
    } catch {
      // No `schema_element` table: an empty database that has never had `define` run against it.
    }
    try {
      const rows = this.db.prepare('SELECT name FROM schema_relation').all() as Array<{ name: string }>;
      for (const row of rows) this.schema.relations.add(row.name);
    } catch {
      // A database defined before `schema_relation` existed. `define` cannot recover the kinds by
      // being re-applied: the kind rule reads them from here and would refuse `relation x` as an
      // entity becoming a relation. A relation that has instances is recorded in the data itself —
      // its things own `role_player` rows — so those kinds are derived now, in memory, and
      // persisted by the first `define`, which creates the table. A relation with NO instance
      // leaves nothing to tell it from an entity, so it stays an entity here and the kind rule
      // stays strict for it: guessing would convert real entities, and the rule is not relaxed.
      this.deriveRelationsFromData();
    }
    try {
      const rows = this.db
        .prepare('SELECT type, attribute FROM schema_owns')
        .all() as Array<{ type: string; attribute: string }>;
      for (const row of rows) this.schema.owns.add(ownsKey(row.type, row.attribute));
    } catch {
      // A database defined before `schema_owns` existed. The ownership check degrades to silence
      // rather than to a false accusation — see `checkOwns`.
    }
    try {
      const rows = this.db
        .prepare('SELECT type, parent FROM type_parent')
        .all() as Array<{ type: string; parent: string }>;
      for (const row of rows) this.schema.parents.set(row.type, row.parent);
    } catch {
      // No `type_parent` table yet; an empty database.
    }
    try {
      const rows = this.db
        .prepare('SELECT attribute, value_type FROM schema_value_type')
        .all() as Array<{ attribute: string; value_type: string }>;
      for (const row of rows) this.schema.valueTypes.set(row.attribute, row.value_type);
    } catch {
      // A database defined before `schema_value_type` existed. The value-type rules see no
      // declared type and refuse nothing — silence, never a false refusal — until `define` is
      // re-applied, which every repository does on open.
    }
    try {
      const rows = this.db
        .prepare('SELECT relation, role FROM schema_relates')
        .all() as Array<{ relation: string; role: string }>;
      for (const row of rows) this.rememberRole(row.relation, row.role);
    } catch {
      // A database defined before `schema_relates` existed — the same degradation as above.
    }
    try {
      // A table written on this phase's branch between two review rounds carried an `abstract`
      // column, with `0` rows that `SELECT name` would read as abstract. Dropped; the next
      // `define` — every repository's first call — recreates it in the shape that stayed.
      const columns = this.db
        .prepare("SELECT name FROM pragma_table_info('schema_abstract')")
        .all() as Array<{ name: string }>;
      if (columns.some((column) => column.name === 'abstract')) this.db.exec('DROP TABLE schema_abstract');
      const rows = this.db.prepare('SELECT name FROM schema_abstract').all() as Array<{ name: string }>;
      for (const row of rows) this.schema.abstracts.add(row.name);
    } catch {
      // Before `schema_abstract`: no type is known abstract, so no insert is refused for it until
      // `define` is re-applied — which every repository does on open. Silence, never a false
      // refusal, as the tables above degrade.
    }
    try {
      const rows = this.db
        .prepare('SELECT type, attribute FROM schema_key_owns')
        .all() as Array<{ type: string; attribute: string }>;
      for (const row of rows) this.schema.keyOwnerships.add(ownsKey(row.type, row.attribute));
    } catch {
      // Before `schema_key_owns`: every `@key` this database already has would look new on the
      // first `define`, and a restated one over an owner holding no key value (which insert never
      // refused) would be refused as *data does not conform*. So the ownerships are derived NOW,
      // in memory, from what an older database does record — the key attribute types
      // (`key_attribute`, kept since ADR-003 for identity) crossed with who owns them
      // (`schema_owns`) — and persisted by the first `define`, which creates the table. In memory
      // before that define, not after it: the first statement is the one that restates the keys,
      // and its rules run before its DDL (review, round 5 — the round-2 defect back by ordering).
      // Once, not on every open: the derivation is per attribute, and taken every time it would
      // read every owner of an already-keyed attribute as keyed, which skipped the second-owner
      // check after a reopen (round 4). ⚠️ Coarse in that direction for the one database it
      // migrates: an attribute keyed by one owner reads as keyed by every owner it had, and that
      // is persisted — a check skipped for those ownerships, never a schema refused. The same
      // migrate-once shape as `ChangeLog.migrate()`.
      for (const key of this.changeLog.keyTypes()) {
        for (const owns of this.schema.owns) {
          if (owns.endsWith(`\u0000${key}`)) this.schema.keyOwnerships.add(owns);
        }
      }
      this.persistKeyOwnerships = true;
    }
    this.loadRecords();
  }

  /** Set when `schema_relation` was absent at open — see `loadSchema`; cleared by the first `define`. */
  private persistRelations = false;

  /**
   * Types in `schema_element` that are the type of some relation instance, i.e. of a thing with
   * `role_player` rows, and every ancestor of one: a subtype of a relation is a relation, and the data
   * of a relation that has instances only of its subtype says nothing about the parent itself.
   */
  private deriveRelationsFromData(): void {
    const present = (name: string): boolean =>
      this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    if (!present('thing') || !present('role_player')) return;
    const rows = this.db
      .prepare('SELECT DISTINCT t.type AS type FROM thing t JOIN role_player rp ON rp.rel = t.iid')
      .all() as Array<{ type: string }>;
    const parents = new Map<string, string>();
    if (present('type_parent')) {
      const links = this.db.prepare('SELECT type, parent FROM type_parent').all() as Array<{ type: string; parent: string }>;
      for (const link of links) parents.set(link.type, link.parent);
    }
    for (const row of rows) {
      // The visited set bounds the climb if the persisted hierarchy is cyclic.
      const seen = new Set<string>();
      for (let type: string | undefined = row.type; type !== undefined && !seen.has(type); type = parents.get(type)) {
        seen.add(type);
        if (this.schema.types.has(type)) this.schema.relations.add(type);
      }
    }
    // A subtype of a relation is a relation, whether or not it has an instance of its own.
    for (const start of parents.keys()) {
      const seen = new Set<string>();
      for (let type: string | undefined = parents.get(start); type !== undefined && !seen.has(type); type = parents.get(type)) {
        seen.add(type);
        if (this.schema.relations.has(type)) {
          if (this.schema.types.has(start)) this.schema.relations.add(start);
          break;
        }
      }
    }
    this.persistRelations = this.schema.relations.size > 0;
  }

  /** Set when `schema_key_owns` was absent at open — see `loadSchema`; cleared by the first `define`. */
  private persistKeyOwnerships = false;

  /**
   * Whether a caller-held transaction is open on this handle.
   *
   * 🔴 While it is, `execute` must not issue its own `BEGIN`: SQLite rejects a nested one, so each
   * write pipeline takes a `SAVEPOINT` instead, and a failing pipeline rolls back to it without
   * ending the transaction around it.
   */
  private transactionOpen = false;
  /** What the caller's open transaction has written — what `validateCommit` checks, as TypeDB checks what changed. */
  private transactionTouched = new Set<number>();
  /** Whether the open transaction changed the schema — then the whole store is checked at commit. */
  private transactionChangedSchema = false;
  private savepointSeq = 0;

  private loadRecords(): void {
    try {
      const rows = this.db
        .prepare('SELECT subject, category, text FROM schema_annotation')
        .all() as Array<{ subject: string; category: string; text: string }>;
      for (const row of rows) this.rememberAnnotation(row.subject, row.category, row.text);
    } catch {
      // Before `schema_annotation`: no annotation is known, so `undefine @card from …` reports
      // it as not defined until `define` is re-applied — which every repository does on open.
    }
    try {
      const rows = this.db.prepare('SELECT type, role FROM schema_plays').all() as Array<{ type: string; role: string }>;
      for (const row of rows) this.schema.plays.add(playsSubject(row.type, row.role));
    } catch {
      // Before `schema_plays` — the same degradation.
    }
    this.loadOrdered();
  }

  /**
   * `schema_ordered` and `schema_specialises` into the model — none before the tables existed, which
   * is none declared. A specialised role is resolved to the relation above that declares it, so the
   * model holds role TYPES (`parentship:parent`), not names.
   */
  private loadOrdered(): void {
    this.schema.ordered.clear();
    this.schema.specialises.clear();
    try {
      const rows = this.db.prepare('SELECT subject FROM schema_ordered').all() as Array<{ subject: string }>;
      for (const row of rows) this.schema.ordered.add(String(row.subject));
    } catch {
      // Before `schema_ordered`: no list was ever declared.
    }
    try {
      const rows = this.db.prepare('SELECT relation, role, specialises FROM schema_specialises').all() as Array<{ relation: string; role: string; specialises: string }>;
      for (const row of rows) {
        const relation = String(row.relation);
        const declaring = this.typeFamily(relation, 'inherited').slice(1).find((t) => this.schema.roles.get(t)?.has(String(row.specialises)));
        if (declaring !== undefined) this.schema.specialises.set(roleRef(relation, String(row.role)), roleRef(declaring, String(row.specialises)));
      }
    } catch {
      // Before `schema_specialises`: no role was ever specialised.
    }
    this.loadFunctionsAndStructs();
  }

  /**
   * `schema_function` and `schema_struct` into the model. A function is parsed again from its stored
   * definition — one evaluator serves it and a query's `with fun` — and made callable from every query.
   */
  private loadFunctionsAndStructs(): void {
    // Every annotation, from the table: `define` records a type's in memory as it applies them, but a
    // function's, a struct's and a `#!` doc comment's reach only the table (metadata.feature L153, L189).
    try {
      const rows = this.db.prepare('SELECT subject, category, text FROM schema_annotation').all() as Array<{ subject: string; category: string; text: string }>;
      this.schema.annotations.clear();
      for (const row of rows) this.rememberAnnotation(String(row.subject), String(row.category), String(row.text));
    } catch {
      // Before `schema_annotation`: nothing to read.
    }
    this.schema.functions.clear();
    this.schema.structs.clear();
    this.schemaFunctionDefinitions = new Map();
    try {
      const rows = this.db.prepare('SELECT name, source FROM schema_function ORDER BY name').all() as Array<{ name: string; source: string }>;
      if (rows.length > 0) {
        const file = this.parse(`define\n${rows.map((r) => String(r.source)).join('\n')}`);
        for (const clause of file.clauses) {
          if (!isDefineClause(clause)) continue;
          for (const definition of clause.definitions) {
            if (definition.$type !== 'FunctionDefinition') continue;
            const fn = definition as FunctionDefinition;
            this.schemaFunctionDefinitions.set(fn.name, fn);
            this.schema.functions.add(fn.name);
          }
        }
      }
    } catch {
      // Before `schema_function`: no function was ever defined.
    }
    try {
      const rows = this.db.prepare('SELECT name, fields FROM schema_struct').all() as Array<{ name: string; fields: string }>;
      for (const row of rows) {
        const fields = JSON.parse(String(row.fields)) as Array<{ name: string }>;
        this.schema.structs.set(String(row.name), new Set(fields.map((f) => f.name)));
      }
    } catch {
      // Before `schema_struct`: no struct was ever defined.
    }
    useSchemaFunctions(this.schemaFunctionDefinitions);
  }

  private rememberAnnotation(subject: string, category: string, text: string): void {
    const bySubject = this.schema.annotations.get(subject) ?? new Map<string, string>();
    bySubject.set(category, text);
    this.schema.annotations.set(subject, bySubject);
  }

  /** What `define` records for one definition's annotations and traits — the same rows the DDL writes. */
  private recordDefinition(name: string, definition: TypeDefinition): void {
    const record = (subject: string, list: readonly Annotation[]): void => {
      for (const annotation of list) this.rememberAnnotation(subject, recordCategory(annotation), recordText(annotation));
    };
    record(typeSubject(name), definition.annotations);
    record(subSubject(name), definition.subAnnotations);
    record(valueSubject(name), definition.valueAnnotations);
    if (isAttributeDef(definition)) return;
    for (const trait of definition.traits) {
      record(traitSubject(name, trait).subject, trait.annotations);
      if (isPlaysTrait(trait)) {
        this.schema.plays.add(playsSubject(name, roleRef(trait.role.relation.$refText, trait.role.role.$refText)));
      }
    }
  }

  /**
   * The model, rebuilt from the tables. `undefine` and `redefine` change the tables and never the
   * maps: a mirror patched alongside a removal or a rename drifts silently, and the rules would
   * read a schema that is not the one applied.
   */
  private reloadSchema(): void {
    for (const set of [this.schema.types, this.schema.relations, this.schema.attributes, this.schema.owns, this.schema.abstracts, this.schema.keyOwnerships, this.schema.plays, this.schema.ordered, this.schema.functions]) set.clear();
    for (const map of [this.schema.parents, this.schema.valueTypes, this.schema.roles, this.schema.annotations, this.schema.specialises, this.schema.structs]) map.clear();
    this.loadSchema();
  }

  private rememberRole(relation: string, role: string): void {
    const roles = this.schema.roles.get(relation) ?? new Set<string>();
    roles.add(role);
    this.schema.roles.set(relation, roles);
  }

  /** Apply a schema. Re-applying is normal — a projector replays, and `IF NOT EXISTS` carries it. */
  define(text: string): ExecutionReport {
    useSchemaFunctions(this.schemaFunctionDefinitions);
    // Inside a caller's transaction the schema change is a savepoint within it (applySchemaDdl,
    // schema-mutation's `transaction`), so the caller's COMMIT or ROLLBACK decides for the schema too
    // — TypeDB's schema transaction, where a define and the writes beside it commit together.
    this.diagnostics = this.freshDiagnostics();
    if (this.transactionOpen) this.transactionChangedSchema = true;
    // 🔴 No second `@card`/`@unique` walk here. `parse()` runs `TypeQLiteValidator`, which owns
    // those rules — they were defined twice, with two different diagnostic codes.
    const file = this.parse(text);
    // `undefine` and `redefine` — Phase 04 of the conformance feature — are applied by
    // `schema-mutation.ts`, one clause at a time, each in its own transaction, the model reloaded
    // from the tables after each. A statement mixing them with `define` is refused: nothing in
    // TypeDB's specification writes one, and applying the stages in text order would need the
    // define half re-run against a model the mutation half just changed.
    const mutations = file.clauses.filter(
      (clause): clause is UndefineClause | RedefineClause =>
        clause.$type === 'UndefineClause' || clause.$type === 'RedefineClause',
    );
    if (mutations.length > 0) {
      if (file.clauses.some(isDefineClause)) {
        const message = 'A statement mixes `define` with `undefine`/`redefine`; send them separately.';
        throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.notImplemented, message, rangeOf(file)));
      }
      const refuse: Refuse = (code, message, range) => {
        throw attachDiagnostic(new Error(message), this.diagnostics.error(code, message, range));
      };
      let changed = 0;
      for (const clause of mutations) {
        const context = { db: this.db, schema: this.schema, data: this.dataFacts(), refuse, reload: () => this.reloadSchema(), nested: this.transactionOpen };
        if (clause.$type === 'UndefineClause') {
          applyUndefine(clause, context);
          changed += clause.undefinitions.length;
        } else {
          applyRedefine(clause, context);
          changed += clause.redefinition === undefined ? 0 : 1;
        }
        this.reloadSchema();
      }
      // `undefine @independent from email` takes the emails nothing owns with it, at once — it is not
      // refused (ADR-006 D4, delete.feature L1329). Every attribute is looked at: the change touched
      // no ownership, so the sweep table holds none of them.
      if (hasAttributeTables(this.db)) sweepAttributes(this.db, 'all');
      this.diagnostics.fact(
        DiagnosticCode.schemaChanged,
        `\`${mutations[0].$type === 'UndefineClause' ? 'undefine' : 'redefine'}\` applied ${changed} change(s).`,
        rangeOf(file),
      );
      this.flushDeferredFacts();
      return this.diagnostics.report();
    }
    this.checkSupertypesExist(file);
    checkSchemaRules(file, this.schema, this.dataFacts(), (code, message, range) => {
      throw attachDiagnostic(new Error(message), this.diagnostics.error(code, message, range));
    });
    const { ddl, keys } = generateSchema(file);
    this.applySchemaDdl(ddl, file);
    // Identity is the @key attribute's value (ADR-003 D3, canonical.ts). `loadSchema` restores only
    // types and attributes, so without persisting these a reopened database could not tell which
    // attribute names an entity, and every entity would fall back to a node-local id.
    this.changeLog.ensureSchema();
    this.changeLog.rememberKeys(keys);

    let declared = 0;
    let alreadyPresent = 0;
    for (const clause of file.clauses) {
      if (!isDefineClause(clause)) continue;
      for (const definition of clause.definitions.filter(isTypeDefinition)) {
        const name = 'name' in definition ? definition.name : undefined;
        if (name === undefined) continue;
        declared += 1;
        if (this.schema.types.has(name) || this.schema.attributes.has(name)) {
          alreadyPresent += 1;
        }
      }
    }

    for (const clause of file.clauses) {
      if (!isDefineClause(clause)) continue;
      for (const definition of clause.definitions.filter(isTypeDefinition)) {
        if (isEntityDef(definition) || isRelationDef(definition) || isTypeExtensionDef(definition)) {
          // A re-open names an existing type; its traits register as a definition's do.
          const name = isTypeExtensionDef(definition) ? definition.type : definition.name;
          if (!isTypeExtensionDef(definition)) this.schema.types.add(definition.name);
          if (isRelationDef(definition)) this.schema.relations.add(definition.name);
          // 🔴 Ownership and the parent chain, in the SAME process that ran `define`.
          //
          // `loadSchema` reads them from the database, and it runs only in the constructor — so
          // populating them there alone left `schema.owns` empty for the whole life of the process
          // that applied the schema, and `checkOwns` returned early on an empty set every time. The
          // check looked active and did nothing until a reopen. Found by the test written for the
          // *other* branch of that early return.
          // A definition's parent is a cross-reference; a re-open's is a plain name. Both are the
          // type's parent once applied.
          const superType = declaredParentOf(definition);
          if (superType) this.schema.parents.set(name, superType);
          if (isTypeExtensionDef(definition) && definition.valueType) {
            this.schema.valueTypes.set(name, definition.valueType);
          }
          if (definition.annotations.some(isAbstractAnnotation)) this.schema.abstracts.add(name);
          this.recordDefinition(name, definition);
          for (const trait of definition.traits) {
            if (isOwnsTrait(trait)) {
              this.schema.owns.add(ownsKey(name, trait.attribute.$refText));
              if (trait.annotations.some(isKeyAnnotation)) {
                this.schema.keyOwnerships.add(ownsKey(name, trait.attribute.$refText));
              }
            }
            if (isRelatesTrait(trait)) this.rememberRole(name, trait.name);
          }
        } else if (isAttributeDef(definition)) {
          this.schema.attributes.add(definition.name);
          // 🔴 An attribute's `sub` is a sub. This branch recorded the name and nothing else, so
          // `first-name sub name` was accepted and forgotten — no parent, no closure, `has name $n`
          // answering nothing for a first-name (`d-20260911-an-attribute-subtype-is-accepted-by`).
          const superType = definition.superType?.$refText;
          if (superType) this.schema.parents.set(definition.name, superType);
          if (definition.valueType) this.schema.valueTypes.set(definition.name, definition.valueType);
          if (definition.annotations.some(isAbstractAnnotation)) this.schema.abstracts.add(definition.name);
          this.recordDefinition(definition.name, definition);
        }
      }
    }

    // 🔴 Re-applying a schema is normal — a projector replays and `IF NOT EXISTS` carries it — so
    // a `define` that changed nothing is today indistinguishable from one that did. That is the
    // fact worth reporting, not the success.
    const applied = declared - alreadyPresent;
    // After the in-memory roles and parents above: a specialisation resolves through them.
    this.loadOrdered();
    this.diagnostics.fact(
      DiagnosticCode.schemaApplied,
      `\`define\` applied ${applied} new definition(s); ${alreadyPresent} already present.`,
      rangeOf(file),
    );
    this.diagnostics.fact(
      DiagnosticCode.keysRegistered,
      // Identity is the @key attribute's value (ADR-003 D3). A type that registered no key is
      // `local:` and is refused at the replication boundary, which is worth saying out loud.
      `Registered ${keys.length} key attribute(s).`,
      rangeOf(file),
    );
    this.flushDeferredFacts();
    return this.diagnostics.report();
  }

  /** The one way this engine refuses: a diagnostic on the report, attached to the error thrown. */
  private readonly refuse: Refuse = (code, message, range) => {
    throw attachDiagnostic(new Error(message), this.diagnostics.error(code, message, range));
  };

  /** What the schema rules ask of the data — one count per question, outside any transaction. */
  private dataFacts(): DataFacts {
    return {
      instancesOf: (type: string): number => {
        // An attribute type's instances are its stored values (ADR-006), owned or not.
        const table = this.schema.attributes.has(type) ? 'attribute' : 'thing';
        try {
          const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE type = ?`).get(type) as
            | { n: number }
            | undefined;
          return Number(row?.n ?? 0);
        } catch {
          // The first `define` on an empty database: the prelude has not created the tables yet,
          // and a database with no tables has no instances.
          return 0;
        }
      },
      ownersWithoutExactlyOne: (owner: string, attribute: string): number => {
        try {
          const row = this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM thing t WHERE t.type IN ${SUBTYPES_OF} ` +
                'AND (SELECT COUNT(*) FROM has h WHERE h.owner = t.iid AND h.type = ?) <> 1',
            )
            .get(owner, attribute) as { n: number } | undefined;
          return Number(row?.n ?? 0);
        } catch {
          return 0; // As above: no tables, no data.
        }
      },
      repeatedValueOf: (attribute: string, owner: string): string | undefined => {
        try {
          const row = this.db
            // One attribute instance owned more than once among the owner type and its subtypes —
            // what the scoped `@key`/`@unique` index would refuse (ADR-006 amendment).
            .prepare(`SELECT v.value AS value FROM ${OWNED} JOIN thing t ON t.iid = h.owner WHERE h.type = ? AND t.type IN ${SUBTYPES_OF} GROUP BY h.attribute HAVING COUNT(*) > 1 LIMIT 1`)
            .get(attribute, owner) as { value: string } | undefined;
          return row === undefined ? undefined : JSON.stringify(String(row.value));
        } catch {
          return undefined; // As above: no tables, no data.
        }
      },
    };
  }

  /**
   * The DDL, in one transaction, so a refused statement leaves nothing behind.
   *
   * 🔴 A `@key` or `@unique` on an ownership whose data repeats is refused before this by
   * `schema-rules.ts`, naming the attribute; the UNIQUE index failing to build is the backstop.
   * Before the transaction that failure came after the `schema_*` rows were already inserted, so
   * the schema was half-applied, and it surfaced as SQLite's own message with no diagnostic. The
   * pragma runs first because it is a no-op inside a transaction, and the prelude's copy of it
   * then is.
   *
   * ⚠️ `BEGIN IMMEDIATE`, not `BEGIN`. The DDL reads the schema (`IF NOT EXISTS`) before it
   * writes, and a deferred transaction that upgrades from read to write while another process
   * holds the write lock gets SQLITE_BUSY at once — `busy_timeout` does not apply to an upgrade.
   * Three spoke processes each running `define` on open found it. Taking the write lock up front
   * waits instead.
   */
  private applySchemaDdl(ddl: string, file: TypeQLiteFile): void {
    const nested = this.transactionOpen;
    if (!nested) this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(nested ? 'SAVEPOINT schema_ddl' : 'BEGIN IMMEDIATE');
    try {
      this.db.exec(ddl);
      if (this.persistKeyOwnerships) {
        // The DDL just created `schema_key_owns`; write down what `loadSchema` derived, so the
        // next open reads it from the table like any other. 🔴 Inside the same transaction as the
        // CREATE TABLE: a kill between the two would leave the table present and empty, and a
        // present table is never re-derived — that database would be locked out of restating its
        // keys on every later open (review, round 6).
        const insert = this.db.prepare('INSERT OR IGNORE INTO schema_key_owns(type, attribute) VALUES (?, ?)');
        for (const owns of this.schema.keyOwnerships) {
          const [type, attribute] = owns.split('\u0000');
          insert.run(type, attribute);
        }
      }
      if (this.persistRelations) {
        // Same transaction as the CREATE TABLE, for the reason above: a present table is never re-derived.
        const insert = this.db.prepare('INSERT OR IGNORE INTO schema_relation(name) VALUES (?)');
        for (const name of this.schema.relations) insert.run(name);
      }
      // Inside the DDL's transaction: a new `@key`/`@unique` the data repeats fails the scoped index
      // here, and the whole define rolls back (ADR-006 amendment).
      rescopeOwnerships(this.db);
      this.db.exec(nested ? 'RELEASE schema_ddl' : 'COMMIT');
      this.persistKeyOwnerships = false;
      this.persistRelations = false;
    } catch (error) {
      if (nested) {
        this.db.exec('ROLLBACK TO schema_ddl');
        this.db.exec('RELEASE schema_ddl');
      } else {
        this.db.exec('ROLLBACK');
      }
      const text = error instanceof Error ? error.message : String(error);
      if (!/UNIQUE constraint failed/.test(text)) throw error;
      // The rule in `schema-rules.ts` names the attribute before the DDL runs; this is the backstop
      // for a database whose rows changed between the check and the index, and it cannot name it.
      const message =
        'The existing data does not conform: an attribute has repeated values among existing ' +
        'instances, so it cannot be made @key or @unique. Remove the duplicates first.';
      throw attachDiagnostic(
        new Error(message),
        this.diagnostics.error(DiagnosticCode.dataDoesNotConform, message, rangeOf(file)),
      );
    }
  }

  /**
   * Run a write pipeline: `insert`, `put`, or `delete`, optionally preceded by a `match`.
   *
   * @privateRemarks
   * 🔴 Each pipeline runs in a transaction. TypeDB's `execute` is atomic per statement, and here
   * one TypeQLite insert becomes several SQL statements — the thing, then each attribute, then each
   * role. Without this, a `@key` violation on the second attribute leaves the thing row behind:
   * an attribute-less thing, **invisible to every TypeQLite query** because they all filter on an
   * attribute, and therefore accumulating unnoticed. Unobservable is not the same as harmless.
   */
  execute(text: string, given?: GivenRows): WriteReport {
    useSchemaFunctions(this.schemaFunctionDefinitions);
    this.diagnostics = this.freshDiagnostics();
    this.written = { things: 0, attributes: 0, roles: 0 };
    // What the LAST write pipeline answers — its rows, or its documents when it ends in `fetch`
    // (update.feature, fetch.feature L2996): TypeDB answers a write's stream as it answers a read's.
    let answered: { rows: Array<Record<string, TypeDBLiteValue>>; documents?: JsonValue[] } = { rows: [] };
    for (const pipeline of this.pipelines(text)) {
      // A pipeline with no write stage writes nothing; `query()` reads it.
      const firstWrite = pipeline.stages.findIndex(isWriteStage);
      if (firstWrite < 0) continue;
      // `match …; insert …; reduce …;` — a write reports what it wrote, not rows, so a `reduce`
      // after it is refused by name rather than dropped (review, round 7), BEFORE anything runs (round 8).
      const reduceAfter = pipeline.stages.slice(firstWrite).find((stage) => stage.$type === 'ReduceStage');
      if (reduceAfter !== undefined) {
        this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not evaluate a `reduce` after a write stage yet.', rangeOf(reduceAfter));
      }
      if (pipeline.returnStage !== undefined) {
        this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not evaluate `return` yet: it ends a function, which this engine does not have.', rangeOf(pipeline.returnStage));
      }
      // 🔴 Every stage checked before anything runs — `insert $p has nick $zz` with nothing binding
      // `$zz` is refused even when the match is empty (review, round 11).
      //
      // An empty match means the write runs ZERO times, which is a success, not an error:
      // `TypeDBLiteSkillRepository.linkDependency` relies on the no-op and reports its own message.
      // Each write stage runs once per row it receives (`d-20260905-match-delete-removes-one-match-of`,
      // `d-20260905-match-insert-writes-to-one-match`), and one that receives none reports
      // `emptyMatch`.
      this.planFunctions(pipeline);
      const scopes = this.planStages(pipeline);
      const start = this.givenStart(pipeline, given);
      const final = scopes[scopes.length - 1];
      const fetchContext = pipeline.fetch === undefined ? undefined : this.fetchContext();
      const fetchScope = fetchContext?.scopeFor(final);
      if (pipeline.fetch !== undefined && fetchContext !== undefined && fetchScope !== undefined) checkFetch(pipeline.fetch.body, fetchScope, fetchContext);
      this.writeRan = false;

      this.touched = new Set();
      this.tombstones = [];

      if (this.transactionOpen && this.sqliteTransactionIsAlive() === false) {
        // The engine ended the transaction under the caller (SQLITE_FULL, SQLITE_IOERR) and the work
        // carried on. A write now would autocommit outside it, so the atomicity the caller asked for
        // is already lost; refuse loudly and let the transaction's own COMMIT or ROLLBACK report it.
        throw new Error(
          'The transaction was ended by the database (for example a full disk); nothing more can be written inside it.',
        );
      }
      const savepoint = this.transactionOpen ? `write_${(this.savepointSeq += 1)}` : null;
      // 🔴 `BEGIN IMMEDIATE`, as `beginTransaction()` and `applySchemaDdl` already were. A write
      // pipeline reads before it writes, so a deferred `BEGIN` holds a read snapshot that must then
      // be upgraded — and when another process committed in between, SQLite refuses the upgrade
      // with SQLITE_BUSY at once, without waiting out `busy_timeout`. Two processes sharing one
      // store lost ~30% of their writes to "database is locked" (`write-lock-contention.test.ts`,
      // docs/development/performance.md). Taking the write lock first turns that into a wait.
      this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      try {
        const streamed = this.runStages(pipeline, scopes, start);
        // Read inside the transaction, after every write the pipeline made.
        answered =
          pipeline.fetch !== undefined && fetchContext !== undefined && fetchScope !== undefined
            ? { rows: [], documents: streamed.map((row) => fetchDocument((pipeline.fetch as FetchStage).body, row, fetchScope, fetchContext)) }
            : { rows: this.projectRows(streamed, final) };
        // After the answers, which may name an attribute the statement left with no owner — the insert
        // answers it, a later query does not find it (ADR-006 D4, match.feature L4214).
        sweepAttributes(this.db);
        // 🔴 Inside the transaction, before COMMIT. This is the whole point of attaching the log
        // here rather than in `SqliteEngine`, which wraps this method and could only act once the
        // transaction had already closed.
        for (const identity of this.tombstones) {
          this.changeLog.recordTombstone(identity);
        }
        for (const iid of this.touched) {
          this.changeLog.recordWrite(iid);
          if (this.transactionOpen) this.transactionTouched.add(iid);
        }
        this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      } catch (error) {
        if (savepoint) {
          // Undo this pipeline only; the transaction around it stays open and usable.
          try {
            this.db.exec(`ROLLBACK TO ${savepoint}`);
            this.db.exec(`RELEASE ${savepoint}`);
          } catch (unwindError) {
            // Swallow ONLY when SQLite already ended the transaction (SQLITE_FULL, SQLITE_IOERR):
            // the savepoint went with it, and the pipeline's own error is the one to report. If the
            // transaction is still alive the rollback genuinely failed, the pipeline's writes may
            // survive, and that must not be hidden.
            if (this.sqliteTransactionIsAlive() !== false && !/no such savepoint/i.test(String(unwindError))) {
              throw unwindError;
            }
          }
        } else {
          this.db.exec('ROLLBACK');
        }
        throw error;
      }

      if (!this.writeRan) continue;
      this.diagnostics.fact(
        DiagnosticCode.wrote,
        // Counts, never lists. "What this write touched" is unbounded on a large write, and this
        // report can travel in a replicated event payload (ADR-004 D5).
        `Wrote ${this.written.things} thing(s), ${this.written.attributes} attribute(s), ` +
          `${this.written.roles} role player(s).`,
        rangeOf(pipeline),
      );
      if (this.tombstones.length > 0) {
        this.diagnostics.fact(
          DiagnosticCode.tombstones,
          // A delete that matched nothing produces no tombstone, so no replica learns of it.
          `Recorded ${this.tombstones.length} tombstone(s).`,
          rangeOf(pipeline),
        );
      }
    }
    this.flushDeferredFacts();
    return { ...this.diagnostics.report(), ...answered };
  }

  /** The counts of the most recent `query()`, or `undefined` when tracing is off. */
  lastQueryTrace(): Readonly<QueryTrace> | undefined {
    return this.lastTrace;
  }

  /**
   * Run a read pipeline and project its `select` — or, when it ends in `fetch`, answer one JSON
   * document per answer in `documents` (fetch.feature), with `rows` empty.
   */
  query(text: string, given?: GivenRows): {
    rows: Array<Record<string, TypeDBLiteValue>>;
    diagnostics: ExecutionReport['diagnostics'];
    documents?: JsonValue[];
  } {
    useSchemaFunctions(this.schemaFunctionDefinitions);
    if (!this.tracing) return this.runQuery(text, given);
    this.trace = newTrace();
    this.lastTrace = this.trace;
    try {
      return this.runQuery(text, given);
    } finally {
      this.trace = undefined;
    }
  }

  private runQuery(text: string, given?: GivenRows): {
    rows: Array<Record<string, TypeDBLiteValue>>;
    diagnostics: ExecutionReport['diagnostics'];
    documents?: JsonValue[];
  } {
    this.diagnostics = this.freshDiagnostics();
    const rows: Array<Record<string, TypeDBLiteValue>> = [];
    let documents: JsonValue[] | undefined;
    const pipelines = this.pipelines(text);
    // One read per call: several queries in one text (`… end; …`) would answer one row set that is
    // neither's. A `match` after a `match` is a STAGE of one pipeline now, and chains.
    if (pipelines.length > 1) {
      this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite answers one read query per call; this text holds several pipelines.', rangeOf(pipelines[1]));
    }
    for (const pipeline of pipelines) {
      // 🔴 Every read pipeline is evaluated — a `match` with no `select` projects every variable it
      // names, as TypeDB does (`d-20260911-a-match-pipeline-with-no-select`). The projectability of
      // a `select` is `TypeQLiteValidator`'s, run by `parse()`.
      if (pipeline.returnStage) {
        // `return` ends a function body or a fetch sub-query; a read query does not return.
        this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not evaluate `return` yet: it ends a function, which this engine does not have.', rangeOf(pipeline.returnStage));
      }
      // 🔴 `query()` reads. A write stage here used to be skipped by the projection — a read that
      // reported success for an insert that never ran.
      const write = pipeline.stages.find(isWriteStage);
      if (write) {
        this.refuse(DiagnosticCode.writeInRead, `\`query()\` reads; this pipeline has a \`${write.$type.replace(/Stage$/, '').toLowerCase()}\` stage, which \`execute()\` runs.`, rangeOf(write));
      }
      this.planFunctions(pipeline);
      const scopes = this.planStages(pipeline);
      const start = this.givenStart(pipeline, given);
      const final = scopes[scopes.length - 1];
      if (pipeline.fetch) {
        const context = this.fetchContext();
        const scope = context.scopeFor(final);
        checkFetch(pipeline.fetch.body, scope, context);
        const body = pipeline.fetch.body;
        const fetched = this.runStages(pipeline, scopes, start).map((row) => fetchDocument(body, row, scope, context));
        documents = [...(documents ?? []), ...fetched];
        this.diagnostics.fact(DiagnosticCode.projected, `Fetched ${fetched.length} document(s).`, rangeOf(pipeline.fetch));
        continue;
      }
      const projected = this.projectRows(this.runStages(pipeline, scopes, start), final);
      rows.push(...projected);
      const firstMatch = pipeline.stages.find(isMatchStage);
      const select = [...pipeline.stages].reverse().find(isSelectStage);

      // 🔴 Diagnosed only when the projection came back EMPTY, and that is not a nicety.
      //
      // Running a candidate lookup per constraint on every query doubled the work the engine does
      // to read, and hung the replication and oracle suites — thousands of queries, each paying for
      // a diagnosis of a result that was fine. It is also the only case where the fact means
      // anything: when rows came back, "no candidates" cannot be true.
      if (projected.length === 0) {
        // Distinguishes "nothing of this type exists" from "the constraints excluded everything" —
        // a schema problem from a data problem. Neither is recoverable from an empty row set.
        const constraints = this.constraintsOf(firstMatch === undefined ? [] : (this.segmentFor(firstMatch, firstMatch.patterns).match?.patterns ?? []));
        for (const constraint of constraints) {
          if (!constraint.type) continue;
          if (this.hasCandidate(constraint)) {
            // 🔴 Type and attributes alone find candidates — for a relation, that leaves exactly
            // one thing left that could have excluded every row: its OWN role constraints, which
            // `candidates()` never reads (d-20260912-an-empty-result-caused-only-by).
            // `relationBindings` applies three rules `candidates()` cannot see — same-role
            // distinctness, the already-bound-relation pin, and the subtype closure on the
            // relation's own `isa` — any of which can silently zero out a relation `candidates()`
            // finds fine. Probed with an EMPTY combination: no outer pattern's binding is assumed,
            // so a zero here is provably the relation's own doing, not a guess about one.
            if (constraint.roles.length === 0) continue;
            // 🔴 …except when this relation's own variable is ITSELF a role player of another
            // relation in the same match (`relation-plays-a-role.test.ts`'s shape). An empty-
            // combination probe cannot know which instance the outer pattern actually pinned it
            // to — and an unrelated relation of the same type elsewhere in the store can satisfy
            // the probe while the pinned instance is the one that was excluded, suppressing the
            // diagnostic for exactly the row that needed it (QA, adversarial pass). Declining to
            // guess preserves the pre-existing silence there rather than risking a wrong answer.
            const boundByOuterRelation = constraints.some(
              (other) => other.variable !== constraint.variable && other.roles.some((role) => role.player === constraint.variable),
            );
            if (boundByOuterRelation) continue;
            if (this.relationBindings({ ...constraint, isas: resolveIsas(constraint.isas, {}) }, {}, true).length !== 0) continue;
            this.diagnostics.fact(
              DiagnosticCode.noCandidates,
              `\`${constraint.isas.filter((isa) => isa.type !== undefined).map((isa) => `isa${isa.exact ? '!' : ''} ${isa.type}`).join(', ')}\` matched ${this.candidateCount(constraint)} candidate(s) before ` +
                `${constraint.variable.startsWith('__anon') ? 'its role constraints' : `the role constraints on '${constraint.variable}'`}` +
                `, and 0 after.`,
              constraint.range,
            );
            continue;
          }

          // 🔴 `candidates()` applies the literals AND the bindings, so its zero cannot say which
          // half was responsible — and this block exists for nothing else. Saying "before
          // constraints were applied" over a store that holds the type sends a reader to the
          // schema for a fault in the data. The type-only count is what separates them.
          //
          // ⚠️ This was once called affordable because it is reached only on an empty answer. Empty
          // answers are routine — an optional attribute is read by a query of its own — so it runs
          // on ordinary reads, and it is a count over the whole type: `candidateCount`, in SQL,
          // never rows read into memory (docs/development/performance.md).
          // Skipped when the pattern carries neither, because the query would be byte-identical
          // to the one that just returned 0. That is ALL it does — keeping `__anonN` out of the
          // message is the job of the ternary in the message below, and an earlier version of this
          // comment claimed the skip handled it.
          const constrained =
            constraint.literals.length > 0 || constraint.bindings.length > 0;
          const ofType = constrained
            ? this.candidateCount({ ...constraint, literals: [], bindings: [] })
            : 0;

          // 🔴 Two counts, and no interpretation of them. Earlier revisions tried to name WHICH
          // fault produced the zero — a literal that excluded the rows, or a binding on an
          // attribute the type does not own — and each attempt was wrong in a new way, because
          // **`SchemaModel` records `types` and `attributes` as two flat sets and never which type
          // owns which attribute.** Ownership cannot be derived from candidate counts: the outer
          // zero only says no candidate satisfied *all* the constraints, never which one failed,
          // nor for how many. Four review rounds went into successive guesses at it.
          //
          // ⚠️ Phrased as the constraints on the VARIABLE, not on "this pattern": `constraintsOf`
          // merges every pattern naming the same variable into one constraint, while
          // `constraint.range` points at the first of them. `match $n isa node, has node-id "a";
          // $n has edge-id $x;` would otherwise blame a pattern that matches a row.
          //
          // 🔴 …except for an anonymous relation, whose variable is the synthetic `__anonN` that
          // `constraintsOf` invented. Naming it tells the reader to look for a variable that is
          // not in their query, so the ternary below substitutes a neutral phrase.
          //
          // So the fact states what it can prove and lets the reader draw the inference. The two
          // numbers already separate the schema case from the data case, which is all this block
          // was ever for: `0 … 0` means nothing of the type exists, `5 … 0` means this pattern
          // excluded them. Naming the culprit needs per-type ownership in the schema model — a
          // real change, not a better sentence.
          this.diagnostics.fact(
            DiagnosticCode.noCandidates,
            `\`${constraint.isas.filter((isa) => isa.type !== undefined).map((isa) => `isa${isa.exact ? '!' : ''} ${isa.type}`).join(', ')}\` matched ${ofType} candidate(s) before ` +
              `${constraint.variable.startsWith('__anon') ? 'its constraints' : `the constraints on '${constraint.variable}'`}` +
              `, and 0 after.`,
            constraint.range,
          );
        }
      }
      this.diagnostics.fact(
        DiagnosticCode.projected,
        // Kept as a count of what a *successful* projection returned. An unbound `select` variable
        // is `TypeQLiteValidator`'s finding, thrown by `parse()` before this line is reached.
        `Matched ${projected.length} row(s); ` +
          (select
            ? `\`select\` names ${select.variables.length} variable(s).`
            : 'no `select`, so every named variable is projected.'),
        rangeOf(select ?? pipeline),
      );
    }
    this.flushDeferredFacts();
    return { rows, diagnostics: this.diagnostics.report().diagnostics, ...(documents === undefined ? {} : { documents }) };
  }

  // ── fetch ─────────────────────────────────────────────────────────────────

  /**
   * What `fetch` needs from the engine. `scopeFor` turns a stream scope into what a fetch reads;
   * `scopeOf` plans a sub-query under its parent's scope, and `rows` runs it from one parent answer.
   */
  private fetchContext(): FetchContext & { scopeFor: (stream: StreamScope, parent?: FetchScope) => FetchScope } {
    const streams = new WeakMap<FetchScope, StreamScope>();
    const scopeFor = (stream: StreamScope, parent?: FetchScope): FetchScope => {
      const scope = this.fetchScope(stream, parent);
      streams.set(scope, stream);
      return scope;
    };
    const plans = new WeakMap<Pipeline, StreamScope[]>();
    const plan = (pipeline: Pipeline, parent: FetchScope): StreamScope[] => {
      const known = plans.get(pipeline);
      if (known !== undefined) return known;
      const start = streams.get(parent) ?? this.initialScope();
      const scopes = this.planStages(pipeline, start);
      this.checkSubqueryAgainstParent(pipeline, parent);
      plans.set(pipeline, scopes);
      return scopes;
    };
    return {
      facts: this.schema,
      refuse: this.refuse,
      scopeFor,
      scopeOf: (pipeline, parent) => {
        const scopes = plan(pipeline, parent);
        return scopeFor(scopes[scopes.length - 1], parent);
      },
      rows: (pipeline, parent, seed) => this.runStages(pipeline, plan(pipeline, parent), [seed]),
      returned: (pipeline, parent, seed) => {
        const scopes = plan(pipeline, parent);
        return this.returned(pipeline.returnStage as ReturnStage, this.runStages(pipeline, scopes, [seed]), scopes[scopes.length - 1], rangeOf(pipeline));
      },
      contextFor: (combination) => this.evaluationContext(combination),
      attributes: (owner, attribute) =>
        attribute === undefined
          ? this.readAttributes(owner, undefined)
          : this.readAttributes(owner, attribute),
      typeOfThing: (iid) => this.typeOfThing(iid),
      valueTypeOf: (attribute) => this.valueTypeOfAttribute(attribute),
    };
  }

  /** The types a thing variable can be in one `match`, and the labels each type variable can take. */
  private segmentTypes(segment: Segment): { typesOf: (variable: string) => string[] | undefined; labels: Map<string, Set<string>> } {
    const patterns = segment.match?.patterns ?? [];
    const constraints = this.constraintsOf(patterns);
    const labels = new Map<string, Set<string>>();
    for (const combination of solveTypes(typeConstraintsOf(patterns, this.refuse), this.schema, [{}], this.refuse)) {
      for (const [variable, binding] of Object.entries(combination)) {
        if (typeof binding === 'string') labels.set(variable, new Set([...(labels.get(variable) ?? []), binding]));
      }
    }
    const descendants = (type: string): string[] => this.typeFamily(type).filter((t) => this.typeFamily(t, 'inherited').includes(type));
    const typesOf = (variable: string): string[] | undefined => {
      const typed = constraints.find((c) => c.variable === variable)?.isas.filter((isa) => isa.type !== undefined || isa.typeVariable !== undefined) ?? [];
      if (typed.length === 0) return undefined;
      let types: string[] | undefined;
      for (const isa of typed) {
        const named = isa.type !== undefined ? [isa.type] : [...(labels.get(isa.typeVariable as string) ?? [])];
        const these = named.flatMap((label) => (isa.exact ? [label] : descendants(label)));
        types = types === undefined ? these : types.filter((t) => these.includes(t));
      }
      return types;
    };
    return { typesOf, labels };
  }

  /** What a `fetch` may read after the stages that `stream` describes — see `FetchScope`. */
  private fetchScope(stream: StreamScope, parent?: FetchScope): FetchScope {
    const segments = stream.segments.map((segment) => this.segmentTypes(segment));
    const intersect = (sets: Array<readonly string[] | undefined>): string[] | undefined =>
      sets.reduce<string[] | undefined>((acc, next) => (next === undefined ? acc : acc === undefined ? [...next] : acc.filter((t) => next.includes(t))), undefined);
    return {
      available: new Set([...stream.available].filter((variable) => !isAnonymous(variable))),
      kindOf: (variable) => stream.kinds.get(variable) ?? (stream.available.has(variable) ? 'value' : undefined),
      typesOf: (variable) => intersect([...segments.map((s) => s.typesOf(variable)), parent?.typesOf(variable)]),
      labelsOf: (variable) =>
        intersect([...segments.map((s) => (s.labels.has(variable) ? [...(s.labels.get(variable) as Set<string>)] : undefined)), parent?.labelsOf(variable)]),
    };
  }

  /**
   * 🔴 A sub-query may constrain its parent's variables further, never contradict them: `relation
   * $t` under a parent's `entity $t`, `$p isa! $t2; relation $t2` under a parent `$p` that is an
   * entity, `relation $p` under a parent thing `$p` — each is a type-inference failure on TypeDB, and
   * here would quietly answer an empty list (fetch.feature L1047).
   */
  private checkSubqueryAgainstParent(pipeline: Pipeline, parent: FetchScope): void {
    for (const stage of pipeline.stages) {
      if (!isMatchStage(stage)) continue;
      const segment = this.segmentFor(stage, stage.patterns);
      const patterns = segment.match?.patterns ?? [];
      const constraints = this.constraintsOf(patterns);
      const kind = this.conceptKindOf(constraints, patterns);
      const { typesOf, labels } = this.segmentTypes(segment);
      const contradiction = (variable: string, why: string): never =>
        this.refuse(DiagnosticCode.mixedPattern, `Type-inference was unable to find compatible types for '${variable.slice(1)}' in the fetch sub-query: ${why}.`, rangeOf(stage));
      for (const variable of parent.available) {
        const own = kind(variable);
        const inherited = parent.kindOf(variable);
        if (own !== undefined && inherited !== undefined && inherited !== 'value' && own !== inherited) {
          contradiction(variable, `it is a ${inherited} in the parent and a ${own} here`);
        }
        const types = typesOf(variable);
        const parentTypes = parent.typesOf(variable);
        if (types !== undefined && parentTypes !== undefined && !types.some((t) => parentTypes.includes(t))) {
          contradiction(variable, 'no type it can be here is a type it can be in the parent');
        }
        const own_labels = labels.get(variable);
        const parentLabels = parent.labelsOf(variable);
        if (own_labels !== undefined && parentLabels !== undefined && ![...own_labels].some((l) => parentLabels.includes(l))) {
          contradiction(variable, 'no label it can take here is one it can take in the parent');
        }
      }
    }
  }

  // ── given ───────────────────────────────────────────────────────────────────

  /**
   * The rows a pipeline starts from: `[{}]`, or — for `given $x: integer, $y: string?;` — the
   * caller's rows, checked as TypeDB checks them (given.feature): a given stage needs rows and rows
   * need a given stage; every column is declared; a required variable is present and not None; a
   * value decodes as the declared value type (an integer or decimal widens to a double); a concept
   * exists and is of the declared type. An absent optional value is EMPTY, as a `try` leaves one.
   */
  private givenStart(pipeline: Pipeline, given: GivenRows | undefined): Array<Record<string, Binding>> {
    const first = pipeline.stages[0];
    const stage = first?.$type === 'GivenStage' ? first : undefined;
    const refuse = (message: string): never => this.refuse(DiagnosticCode.given, message, rangeOf(stage ?? pipeline));
    if (stage === undefined) {
      if (given !== undefined) refuse('The query contains no given stage, but given rows were provided.');
      return [{}];
    }
    if (given === undefined) return refuse('The query contains a given stage, but no given rows were provided.');
    const declared = new Map(stage.declarations.map((d) => [d.variable.slice(1), d] as const));
    return given.map((row, rowIndex) => {
      const columns = Object.keys(row);
      for (const name of columns) if (!declared.has(name)) refuse(`The variable '${name}' was not declared in the query.`);
      const seeded: Record<string, Binding | undefined> = {};
      for (const [name, declaration] of declared) {
        const column = columns.indexOf(name);
        const cell = column < 0 ? null : row[name];
        if (cell === null || cell === undefined) {
          if (!declaration.optional) {
            refuse(
              column < 0
                ? `The given rows are missing the required variable '${name}'.`
                : `The given value at row '${rowIndex}' and column '${column}' was None, but the variable was not declared optional.`,
            );
          }
          seeded[declaration.variable] = undefined;
          continue;
        }
        seeded[declaration.variable] = this.givenBinding(cell, declaration.type, rowIndex, column, refuse);
      }
      return seeded as Record<string, Binding>;
    });
  }

  private givenBinding(cell: TypeDBLiteValue, type: string, row: number, column: number, refuse: (message: string) => never): Binding {
    if (this.schema.types.has(type)) {
      if (!cell.isThing()) return refuse(`The given value at row '${row}' and column '${column}' does not not satisfy the declared type '${type}'.`);
      const actual = this.typeOfThing(cell.iid);
      if (actual === '') return refuse(`The given instance at row '${row}' and column '${column}' does not exist in the database.`);
      if (!this.typeFamily(actual, 'inherited').includes(type)) return refuse(`The given value at row '${row}' and column '${column}' does not not satisfy the declared type '${type}'.`);
      return cell.iid;
    }
    if (cell.isThing() || cell.isType()) return refuse(`The given value at row '${row}' and column '${column}' does not not satisfy the declared type '${type}'.`);
    const attribute = this.schema.attributes.has(type) ? type : undefined;
    const wanted = attribute === undefined ? type : (this.valueTypeOfAttribute(attribute) ?? 'string');
    const has = cell.isAttribute() ? (this.valueTypeOfAttribute(cell.type) ?? 'string') : cell.type;
    const widens = has === wanted || (wanted === 'double' && (has === 'integer' || has === 'decimal')) || (wanted === 'decimal' && has === 'integer');
    if (!widens) {
      const shown = has === 'string' ? `"${cell.asString()}"` : cell.asString();
      return refuse(`The provided value '${shown}' has type '${has}' and could not be decoded as the value type '${wanted}'.`);
    }
    return attribute === undefined
      ? { kind: 'value', valueType: wanted, value: cell.asString() }
      : { kind: 'attribute', attributeType: attribute, valueType: wanted, value: this.canonicalValue(attribute, cell.asString(), undefined) };
  }

  // ── query-local functions ───────────────────────────────────────────────────

  /**
   * What evaluating an expression in one combination may read: the schema, the bindings, and calls.
   * Public so the interpreter's own modules can call it; not part of the API (docs/guides/compatibility.md).
   * @internal
   */
  evaluationContext(combination: Record<string, Binding>): SchemaContext {
    return {
      facts: this.schema,
      typeOf: (variable) => {
        const binding = combination[variable];
        return typeof binding === 'string' ? binding : undefined;
      },
      bindingOf: (variable) => combination[variable],
      iidOf: (variable) => {
        const binding = combination[variable];
        if (binding === undefined || typeof binding === 'string' || (typeof binding === 'object' && binding.kind !== 'attribute')) return undefined;
        return this.cellOf(binding).iidHex;
      },
      call: (definition, args, at) => this.callFunction(definition, args, at),
    };
  }

  /** Each function body, planned once — its stages checked before any row, as any pipeline's are. */
  private readonly functionPlans = new WeakMap<FunctionDefinition, StreamScope[]>();

  private planFunction(definition: FunctionDefinition): StreamScope[] {
    const known = this.functionPlans.get(definition);
    if (known !== undefined) return known;
    const start = this.initialScope();
    // A function that calls itself (expression.feature L1382, `names_helper`) is being planned when
    // its own call is checked: that call reads the parameters' scope, and planning goes on.
    if (this.planningFunctions.has(definition)) return [start];
    this.planningFunctions.add(definition);
    for (const parameter of definition.parameters) {
      const type = parameter.type;
      start.available.add(parameter.variable);
      start.kinds.set(parameter.variable, this.schema.types.has(type) ? 'thing' : 'value');
      if (this.schema.attributes.has(type)) start.attributeOf.set(parameter.variable, type);
      start.valueTypes.set(parameter.variable, VALUE_TYPES.has(type) ? type : this.schema.attributes.has(type) ? this.valueTypeOfAttribute(type) : undefined);
      if (!this.schema.types.has(type) && !this.schema.attributes.has(type) && !VALUE_TYPES.has(type)) this.checkKnown('type', type, rangeOf(parameter));
    }
    const plan = this.planStages(definition.body, start);
    const last = plan[plan.length - 1];
    const answered = [...definition.body.returnStage.streamed, ...definition.body.returnStage.selected, ...definition.body.returnStage.reductions.flatMap((r) => (r.argument === undefined ? [] : [r.argument]))];
    for (const variable of answered) {
      if (!last.available.has(variable)) this.refuse(DiagnosticCode.unboundValue, `The variable '${variable.slice(1)}' must be bound to a value before it's used: '${definition.name}' returns it.`, rangeOf(definition.body.returnStage));
    }
    this.functionPlans.set(definition, plan);
    this.planningFunctions.delete(definition);
    return plan;
  }

  /** Every pipeline's functions, checked before the query runs — a refusal never waits for a call. */
  private planFunctions(pipeline: Pipeline): void {
    for (const definition of pipeline.functions) this.planFunction(definition);
  }

  /**
   * One call: the body runs seeded with the arguments, and its `return` answers — `{ … }` a tuple per
   * answer, `first`/`last` one tuple or none, reducers one tuple over every answer.
   */
  private callFunction(definition: FunctionDefinition, args: ReadonlyArray<Binding | undefined>, at: Range | undefined): Array<Array<ValueBinding | undefined>> {
    if (args.length !== definition.parameters.length) {
      this.refuse(DiagnosticCode.functionArity, `Function '${definition.name}' expects '${definition.parameters.length}' arguments but received '${args.length}'.`, at);
    }
    const seed: Record<string, Binding> = {};
    definition.parameters.forEach((parameter, i) => {
      const argument = args[i];
      if (argument !== undefined) seed[parameter.variable] = argument;
    });
    const plan = this.planFunction(definition);
    return this.returned(definition.body.returnStage, this.runStages(definition.body, plan, [seed]), plan[plan.length - 1], at);
  }

  /**
   * What a `return` answers over a body's rows — shared by functions and fetch's return sub-queries.
   * Public so the interpreter's own modules can call it; not part of the API (docs/guides/compatibility.md).
   * @internal
   */
  returned(stage: ReturnStage, rows: Array<Record<string, Binding>>, scope: StreamScope, at: Range | undefined): Array<Array<ValueBinding | undefined>> {
    const value = (binding: Binding | undefined): ValueBinding | undefined => {
      if (binding === undefined || typeof binding === 'object') return binding;
      return this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not return a thing or a type from a function yet: return its attributes.', at);
    };
    if (stage.streamed.length > 0) return rows.map((row) => stage.streamed.map((variable) => value(row[variable])));
    if (stage.selector !== undefined) {
      const row = stage.selector === 'first' ? rows[0] : rows[rows.length - 1];
      return row === undefined ? [] : [stage.selected.map((variable) => value(row[variable]))];
    }
    if (stage.reductions.length > 0) {
      const reduce = { $type: 'ReduceStage', reductions: stage.reductions.map((r, i) => ({ variable: `$__returned${i}`, reducer: r.reducer, argument: r.argument, $cstNode: r.$cstNode })), groups: [] } as unknown as ReduceStage;
      const [row] = this.reduceRows(reduce, rows, scope);
      return [stage.reductions.map((_, i) => value(row?.[`$__returned${i}`]))];
    }
    return this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not evaluate `return check` yet.', at);
  }

  // ── the stage pipeline ──────────────────────────────────────────────────────

  private initialScope(): StreamScope {
    return { available: new Set(), kinds: new Map(), patterns: [], segments: [], attributeOf: new Map(), valueTypes: new Map(), optional: new Set() };
  }

  /**
   * Every stage checked against what the stages before it bind, before any row flows — the scope
   * before each stage, then the one after the last. `start` is a fetch sub-query's parent scope.
   * 🔴 Static by construction: a later stage is refused whether or not an earlier one answers.
   */
  private planStages(pipeline: Stages, start: StreamScope = this.initialScope()): StreamScope[] {
    const scopes = [start];
    for (const stage of pipeline.stages) scopes.push(this.planStage(stage, scopes[scopes.length - 1]));
    return scopes;
  }

  private planStage(stage: LeadStage | Stage, before: StreamScope): StreamScope {
    const scope: StreamScope = {
      available: new Set(before.available),
      kinds: new Map(before.kinds),
      patterns: [...before.patterns],
      segments: [...before.segments],
      attributeOf: new Map(before.attributeOf),
      valueTypes: new Map(before.valueTypes),
      optional: new Set(before.optional),
      declared: new Map(before.declared),
      inserted: new Map(before.inserted),
    };
    const conceptOf = (variable: string): 'thing' | 'type' | undefined => {
      const kind = before.kinds.get(variable);
      return kind === 'value' ? undefined : kind;
    };
    const drop = (variable: string): void => {
      scope.available.delete(variable);
      scope.kinds.delete(variable);
    };
    switch (stage.$type) {
      case 'GivenStage': {
        for (const declaration of stage.declarations) {
          const type = declaration.type;
          const isThingType = this.schema.types.has(type);
          if (!isThingType && !this.schema.attributes.has(type) && !VALUE_TYPES.has(type)) this.checkKnown('type', type, rangeOf(declaration));
          scope.available.add(declaration.variable);
          scope.kinds.set(declaration.variable, isThingType ? 'thing' : 'value');
          if (this.schema.attributes.has(type)) scope.attributeOf.set(declaration.variable, type);
          scope.valueTypes.set(declaration.variable, VALUE_TYPES.has(type) ? type : this.schema.attributes.has(type) ? this.valueTypeOfAttribute(type) : undefined);
          if (declaration.optional) scope.optional.add(declaration.variable);
          if (isThingType) scope.declared?.set(declaration.variable, type);
        }
        return scope;
      }
      case 'MatchStage': {
        const segment = this.segmentFor(stage, stage.patterns);
        const patterns = segment.match?.patterns ?? [];
        const constraints = this.constraintsOf(patterns);
        this.matchStatements(patterns, constraints, before.available, conceptOf, before.available);
        this.refuseValueAsAttribute(before, constraints, patterns, rangeOf(stage));
        // Each block's own rules first — a cycle inside one block is refused there, in its words — then
        // the order across branches, which only the whole stage can see.
        this.checkNested(patterns, new Set([...before.available, ...this.ownBound(patterns)]), conceptOf, 'conjunction', before.available, undefined, before.available);
        this.checkLetOrder(patterns);
        this.checkBranchReuse(patterns, new Set(before.available));
        this.checkUntypedReads(patterns, constraints);
        const kind = this.nestedKind(patterns);
        for (const variable of this.selectedOf(segment, constraints)) {
          scope.available.add(variable);
          scope.kinds.set(variable, kind(variable) ?? before.kinds.get(variable) ?? 'value');
        }
        for (const constraint of constraints) {
          for (const binding of constraint.bindings) {
            scope.attributeOf.set(binding.variable, binding.attribute);
            scope.valueTypes.set(binding.variable, binding.attribute === undefined ? undefined : this.valueTypeOfAttribute(binding.attribute));
          }
        }
        // An attribute a `try` or a branch binds is an attribute too: `try { $p has email $e; };
        // delete try { $e; };` deletes it (delete.feature L2838).
        for (const binding of this.nestedAttributeBindings(patterns)) {
          if (scope.attributeOf.has(binding.variable)) continue;
          scope.attributeOf.set(binding.variable, binding.attribute);
          scope.valueTypes.set(binding.variable, binding.attribute === undefined ? undefined : this.valueTypeOfAttribute(binding.attribute));
        }
        for (const pattern of patterns) {
          if (!isLetPattern(pattern)) continue;
          const inferred = inferValueType(pattern.expression, (v) => scope.valueTypes.get(v));
          for (const variable of letVariables(pattern)) scope.valueTypes.set(variable, inferred);
        }
        scope.patterns.push(...patterns);
        scope.segments.push(segment);
        for (const variable of this.nestedBound(patterns.filter(isOptionalPattern))) scope.optional.add(variable);
        return scope;
      }
      case 'InsertStage':
      case 'PutStage':
      case 'DeleteStage': {
        this.checkWriteStage(before, stage);
        if (stage.$type === 'DeleteStage') {
          // pipelines.feature L324: a deleted thing is not visible in later stages.
          for (const deletion of openDeletions(stage.deletions, this.refuse)) if (deletion.owner === undefined && deletion.target !== undefined) drop(deletion.target);
        } else {
          for (const pattern of stage.patterns) {
            // What an insert's `try { … }` inserts is answered too — EMPTY where the block did not run
            // (insert.feature L2816). A `put`'s is not: the spec answers it `none` (put.feature L696).
            const inner = isOptionalPattern(pattern) ? (stage.$type === 'InsertStage' ? pattern.patterns.filter(isThingPattern) : []) : isThingPattern(pattern) ? [pattern] : [];
            for (const thing of inner) {
              scope.available.add(thing.variable);
              // `$n isa person-name "John"` inserts an ATTRIBUTE, which a later `fetch` reads as one
              // (fetch.feature L3047).
              const instance = this.attributeInstanceOf(thing, 'write')?.instance;
              if (instance !== undefined) {
                scope.kinds.set(thing.variable, 'value');
                scope.attributeOf.set(thing.variable, instance.type);
                scope.valueTypes.set(thing.variable, this.valueTypeOfAttribute(instance.type));
                continue;
              }
              if (!scope.kinds.has(thing.variable)) scope.kinds.set(thing.variable, 'thing');
              const written = thing.properties.find(isIsaProperty)?.type;
              if (written !== undefined) scope.inserted?.set(thing.variable, written);
              if (isOptionalPattern(pattern) && !before.available.has(thing.variable)) scope.optional.add(thing.variable);
            }
          }
        }
        return scope;
      }
      case 'UpdateStage':
        this.checkUpdateStage(stage, before);
        return scope;
      case 'SelectStage': {
        for (const variable of [...scope.available]) if (!stage.variables.includes(variable)) drop(variable);
        return scope;
      }
      case 'SortStage':
        this.checkSort(stage, before);
        return scope;
      case 'RequireStage':
        for (const variable of stage.variables) {
          if (!before.available.has(variable)) {
            this.refuse(DiagnosticCode.unboundValue, `The variable '${variable.slice(1)}' is not available to \`require\`: no stage before it answers it.`, rangeOf(stage));
          }
        }
        return scope;
      case 'ReduceStage': {
        checkReduce(stage, before.available, conceptOf, (variable) => before.valueTypes.get(variable), this.refuse);
        // pipelines.feature L336: what a reduce aggregated over is gone; its groups and results remain.
        for (const variable of [...scope.available]) if (!stage.groups.includes(variable)) drop(variable);
        for (const reduction of stage.reductions) {
          scope.available.add(reduction.variable);
          scope.kinds.set(reduction.variable, 'value');
          scope.valueTypes.set(reduction.variable, reduction.reducer === 'count' ? 'integer' : undefined);
        }
        return scope;
      }
      default:
        return scope;
    }
  }

  /**
   * `sort` orders values: a variable the stages before it answer, holding attributes or values of
   * one comparable kind — numbers with numbers whatever their type, strings with strings
   * (modifiers.feature L419, L439, L565).
   */
  private checkSort(stage: SortStage, before: StreamScope): void {
    for (const key of stage.keys) {
      const at = rangeOf(key);
      const name = key.variable.slice(1);
      if (!before.available.has(key.variable)) {
        this.refuse(DiagnosticCode.unboundValue, `The variable '${name}' is not available to sort by: no stage before \`sort\` answers it.`, at);
      }
      const kind = before.kinds.get(key.variable);
      if (kind === 'thing' || kind === 'type') {
        this.refuse(DiagnosticCode.valueTypeConflict, `'${name}' is a ${kind}; \`sort\` orders attributes and values.`, at);
      }
      if (!before.attributeOf.has(key.variable)) continue;
      // `has $a` may be any attribute the schema has (modifiers.feature L439).
      const attribute = before.attributeOf.get(key.variable);
      const classes = new Set(
        (attribute === undefined ? [...this.schema.attributes] : this.typeFamily(attribute).filter((t) => this.typeFamily(t, 'inherited').includes(attribute)))
          .map((t) => this.schema.valueTypes.get(t))
          .filter((t): t is string => t !== undefined)
          .map(sortClass),
      );
      if (classes.size > 1) {
        this.refuse(DiagnosticCode.valueTypeConflict, `'${name}' may hold values of incomparable types (${[...classes].join(', ')}), and cannot be sorted.`, at);
      }
    }
  }

  /** Stream rows through each stage; `start` is the rows before the first (`[{}]`, or a parent answer). */
  private runStages(pipeline: Stages, scopes: readonly StreamScope[], start: Array<Record<string, Binding>>): Array<Record<string, Binding>> {
    let rows = start;
    pipeline.stages.forEach((stage, index) => {
      const before = scopes[index];
      switch (stage.$type) {
        case 'MatchStage': {
          // Trimmed to what the stage makes available: a variable one disjunction branch alone
          // bound, or a synthetic `__anonN`, is not carried into the next stage (pipelines.feature L314).
          const available = scopes[index + 1].available;
          rows = rows
            .flatMap((row) => this.combinations(this.segmentFor(stage, stage.patterns), row))
            .map((row) => Object.fromEntries(Object.entries(row).filter(([variable]) => available.has(variable))));
          break;
        }
        case 'InsertStage':
        case 'PutStage':
          rows = this.runInsertStage(stage, rows);
          break;
        case 'DeleteStage':
          rows = this.runDeleteStage(stage, rows, before);
          break;
        case 'UpdateStage':
          rows = this.runUpdateStage(stage, rows);
          break;
        case 'SelectStage':
          rows = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([variable]) => stage.variables.includes(variable))));
          break;
        case 'SortStage':
          rows = this.sortRows(stage, rows);
          break;
        case 'OffsetStage':
          rows = rows.slice(stage.count);
          break;
        case 'LimitStage':
          rows = rows.slice(0, stage.count);
          break;
        case 'DistinctStage': {
          const seen = new Set<string>();
          rows = rows.filter((row) => {
            const key = rowKeyOf(row);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          break;
        }
        case 'RequireStage':
          rows = rows.filter((row) => stage.variables.every((variable) => row[variable] !== undefined));
          break;
        case 'ReduceStage':
          rows = this.reduceRows(stage, rows, before);
          break;
      }
    });
    return rows;
  }

  /** Set by a write stage that ran over at least one row — `execute` reports `wrote` only then. */
  private writeRan = false;

  /** `insert`/`put` once per distinct row; the row carries on with what the stage bound. */
  private runInsertStage(stage: InsertStage | PutStage, rows: Array<Record<string, Binding>>): Array<Record<string, Binding>> {
    if (rows.length === 0) {
      this.diagnostics.fact(DiagnosticCode.emptyMatch, '`match` bound 0 combinations, so the write ran 0 times.', rangeOf(stage));
      return rows;
    }
    this.writeRan = true;
    // 🔴 One write per distinct assignment of CONCEPTS — and of the VALUES the write reads (review,
    // rounds 3 and 5): a combination is one per attribute value, and a person with two names would
    // otherwise be written to twice.
    // Attribute instances first: `insert $p isa person, has name $n; $n isa name "Ann";` is one
    // insert, a set of statements and not a script, so `$n` exists before anything reads it.
    const written = insertionOrder(stage.patterns);
    const ordered = [...written.filter((p) => this.isAttributeInstance(p)), ...written.filter((p) => !this.isAttributeInstance(p))];
    // `put` is match-or-insert of the WHOLE stage: every answer its statements already have, or — when
    // they have none — one insert of all of them (put.feature L103: two people, `put $x isa person;`
    // answers both). A `try` block is put on its own, when its inputs are bound.
    const required = stage.patterns.filter((p) => !isOptionalPattern(p));
    const asMatch = stage.$type === 'PutStage' && required.length > 0 ? this.segmentFor(stage, required) : undefined;
    return uniqueRows(rows, valueVariablesReadBy(stage)).flatMap((row): Array<Record<string, Binding>> => {
      if (asMatch !== undefined) {
        const found = this.combinations(asMatch, row);
        if (found.length > 0) return found;
      }
      const scoped = singleBinding(row);
      const values = valueBindingsOf(row);
      for (const pattern of ordered) {
        if (isOptionalPattern(pattern)) {
          // Runs only when what it reads is bound (given.feature L353).
          if (this.blockReady(pattern, row)) for (const inner of insertionOrder(pattern.patterns)) this.runInsert(this.concreteWrite(inner, row), scoped, values, stage.$type === 'PutStage');
          continue;
        }
        this.runInsert(this.concreteWrite(pattern, row), scoped, values, stage.$type === 'PutStage');
      }
      const next: Record<string, Binding> = { ...row };
      for (const [variable, iids] of scoped) if (iids[0] !== undefined) next[variable] = iids[0];
      // The attributes this insert created are answered as concepts, as its things are (delete.feature L162).
      for (const [variable, value] of values) if (next[variable] === undefined) next[variable] = value;
      return [next];
    });
  }

  /**
   * A written statement with its type and role VARIABLES replaced by what this row bound them to —
   * `insert $x isa $p;` with `$p label person` writes a person (insert.feature L2140). A role is
   * written by its name; a role labelled through a relation that does not declare it (an alias,
   * `part-time-employment:employee`, L2203) names no role there, and is refused.
   */
  private concreteWrite(pattern: Pattern, row: Record<string, Binding>): Pattern {
    if (typeVariablesWritten(pattern).length === 0) return pattern;
    const typeOf = (variable: string): string => {
      const bound = row[variable];
      if (typeof bound !== 'string') return this.refuse(DiagnosticCode.unboundValue, `The type variable '${variable.slice(1)}' is not bound to a type, so the write has no type to write.`, rangeOf(pattern));
      return bound;
    };
    const players = (list: RolePlayers | undefined, relation: string | undefined): RolePlayers | undefined =>
      list === undefined
        ? undefined
        : ({
            ...list,
            entries: list.entries.map((entry) => {
              if (entry.roleVariable === undefined) return entry;
              const label = typeOf(entry.roleVariable);
              const separator = label.lastIndexOf(':');
              const [declaring, name] = [label.slice(0, separator), label.slice(separator + 1)];
              if (separator < 0 || !this.schema.roles.get(declaring)?.has(name) || (relation !== undefined && !this.typeFamily(relation, 'inherited').includes(declaring))) {
                this.refuse(DiagnosticCode.unknownRole, `'${label}' is not a role ${relation === undefined ? 'a relation declares' : `of '${relation}'`}; a role is written as the relation that declares it names it.`, rangeOf(pattern));
              }
              return { ...entry, role: name, roleVariable: undefined };
            }),
          } as RolePlayers);
    if (isAnonRelationPattern(pattern)) {
      const type = pattern.type ?? (pattern.typeVariable === undefined ? undefined : typeOf(pattern.typeVariable));
      return { ...pattern, type, typeVariable: undefined, players: players(pattern.players, type) } as Pattern;
    }
    if (!isThingPattern(pattern)) return pattern;
    const isa = pattern.properties.find(isIsaProperty);
    const type = isa?.type ?? (isa?.typeVariable === undefined ? undefined : typeOf(isa.typeVariable));
    const properties = pattern.properties.map((property) => {
      if (isIsaProperty(property)) return { ...property, type, typeVariable: undefined, players: players(property.players, type) } as Property;
      if (isLinksProperty(property)) return { ...property, players: players(property.players, type) } as Property;
      return property;
    });
    return { ...pattern, properties } as Pattern;
  }

  /**
   * A write may read a variable that can be EMPTY — from a `try`, or a `given` declared `?` — only
   * inside a `try` of its own, which runs only when it is bound (given.feature L353, update.feature
   * L3031): TypeDB's *"A write stage uses the optional variable 'name' outside a 'try' block"*.
   */
  private checkOptionalUse(patterns: readonly Pattern[], scope: StreamScope): void {
    for (const pattern of patterns) {
      if (isOptionalPattern(pattern)) continue;
      const used = variablesWritten(pattern).find((variable) => scope.optional.has(variable));
      if (used !== undefined) {
        this.refuse(DiagnosticCode.unboundValue, `A write stage uses the optional variable '${used.slice(1)}' outside a 'try' block.`, rangeOf(pattern));
      }
    }
  }

  /** Whether a write's `try` block may run on this row: every variable it reads from the row is bound. */
  private blockReady(block: OptionalPattern, row: Record<string, Binding>): boolean {
    return variablesWritten(block).every((variable) => !(variable in row) || row[variable] !== undefined);
  }

  // ── update ──────────────────────────────────────────────────────────────────

  /**
   * What an `update` stage is refused for before any row (update.feature): it changes what a thing an
   * earlier stage bound OWNS or PLAYS — `$p has name "Bob";`, `$f links (friend: $x);` — and nothing
   * else, each capability single-valued, each in TypeDB's words.
   */
  private checkUpdateStage(stage: UpdateStage, before: StreamScope): void {
    const illegal = (at: Range | undefined): never => this.refuse(DiagnosticCode.mixedPattern, 'Illegal statement provided for an update stage: it changes the `has` and `links` of things an earlier stage bound.', at);
    const unavailable = (variable: string, at: Range | undefined): never =>
      this.refuse(
        DiagnosticCode.unboundValue,
        isAnonymous(variable)
          ? 'An anonymous variable cannot be updated: `$_` names nothing an earlier stage bound (update.feature L2585).'
          : `The variable '${variable.slice(1)}' referenced in the update stage is unavailable: no earlier stage binds it.`,
        at,
      );
    const scope = this.fetchScope(before);
    this.checkOptionalUse(stage.patterns, before);
    for (const pattern of writtenPatterns(stage.patterns, this.refuse)) {
      if (!isThingPattern(pattern)) illegal(rangeOf(pattern));
      const thing = pattern as ThingPattern;
      if (isAnonymous(thing.variable)) {
        this.refuse(DiagnosticCode.mixedPattern, 'An update changes a thing an earlier stage bound; an anonymous variable names none.', rangeOf(pattern));
      }
      if (!before.available.has(thing.variable)) unavailable(thing.variable, rangeOf(pattern));
      if (before.kinds.get(thing.variable) !== 'thing') illegal(rangeOf(pattern));
      const types = this.streamTypesOf(thing.variable, before, scope);
      for (const property of thing.properties) {
        const at = rangeOf(property);
        if (isIsaProperty(property)) {
          this.refuse(DiagnosticCode.mixedPattern, `Illegal 'isa' provided for variable '${thing.variable.slice(1)}' that is input from a previous stage: an update changes a thing, never its type.`, at);
        }
        if (isHasProperty(property)) {
          if (property.expression !== undefined) {
            this.refuse(DiagnosticCode.mixedPattern, `Illegal statement 'expression' provided for an update stage. Only 'has' and 'links' constraints are allowed.`, at);
          }
          // `has $b + 15`, `has $b < 15` — TypeDB reads `$b` as the attribute TYPE, and `$b` is an
          // attribute already (update.feature L479, L488).
          if (property.attribute === undefined && property.valueVariable !== undefined && (property.value !== undefined || property.comparator !== undefined)) {
            this.refuse(DiagnosticCode.mixedPattern, `The variable '${property.valueVariable.slice(1)}' cannot be declared as both a 'ThingType' and as a 'Attribute'.`, at);
          }
          const variable = property.valueVariable ?? (property.comparator === '==' && property.compared !== undefined && isVariableExpression(property.compared) ? property.compared.variable : undefined);
          // `has name $n` with `$n` an earlier stage's attribute says `$n isa name` of an input — an update
          // changes what a thing has, never what an input is (update.feature L391; `has $n` and
          // `has name == $n` are the forms that read it).
          if (property.attribute !== undefined && property.valueVariable !== undefined && before.available.has(property.valueVariable) && before.attributeOf.has(property.valueVariable)) {
            this.refuse(DiagnosticCode.mixedPattern, `Illegal 'isa' provided for variable '${property.valueVariable.slice(1)}' that is input from a previous stage: write \`has ${property.valueVariable}\` or \`has ${property.attribute} == ${property.valueVariable}\`.`, at);
          }
          if (property.comparator !== undefined && property.comparator !== '==') illegal(at);
          if (variable !== undefined && !before.available.has(variable)) unavailable(variable, at);
          const attribute = property.attribute ?? (variable === undefined ? undefined : before.attributeOf.get(variable));
          if (attribute === undefined) continue;
          this.checkKnown('attribute', attribute, at);
          if (this.schema.abstracts.has(attribute)) {
            this.refuse(DiagnosticCode.abstractType, `Type-inference was unable to find compatible types for the pair of variables: '${attribute}' is abstract and cannot have a value of its own. Write a concrete subtype.`, at);
          }
          for (const type of types ?? []) {
            if (!this.typeFamily(type, 'inherited').some((t) => this.schema.owns.has(ownsKey(t, attribute)))) {
              if (types !== undefined && types.every((t) => !this.typeFamily(t, 'inherited').some((u) => this.schema.owns.has(ownsKey(u, attribute))))) {
                this.refuse(DiagnosticCode.unownedAttribute, `Left type '${type}' across constraint 'has' is not compatible with right type '${attribute}'.`, at);
              }
              continue;
            }
            if (ownershipMax(type, attribute, this.schema) > 1) {
              this.refuse(DiagnosticCode.valueTypeConflict, `'${type}' can own more than one '${attribute}', and an update replaces one: its cardinality should not exceed 1.`, at);
            }
          }
          continue;
        }
        if (isLinksProperty(property)) {
          for (const entry of property.players.entries) {
            if (!before.available.has(entry.player)) unavailable(entry.player, at);
            if (entry.roleVariable !== undefined) this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not update through a role variable yet: name the role.', at);
            // TypeDB's annotation check of the update, read off 3.10.4: each type the stream lets the
            // relation be relates a live, concrete role the player's types can play — or, when none
            // does, type inference finds nothing (update.feature L2106: an abstract `friend`, or one
            // `best-friendship` specialised away); when some do, the others are "not compatible"
            // (L2786: `$f has ref $_` may be a person, which relates nothing).
            // A role no relation declares is "not found" before anything is inferred (update.feature L1536).
            if (entry.role !== undefined && ![...this.schema.roles.values()].some((roles) => roles.has(entry.role as string))) {
              this.refuse(DiagnosticCode.unknownRole, `Role label not found '${entry.role}'.`, at);
            }
            const playerTypes = this.streamTypesOf(entry.player, before, scope);
            const fitting = (relation: string): string[] => {
              if (!this.schema.relations.has(relation) && !this.typeFamily(relation, 'inherited').some((t) => this.schema.relations.has(t))) return [];
              const names = entry.role !== undefined ? [entry.role] : [...new Set(this.typeFamily(relation, 'inherited').flatMap((t) => [...(this.schema.roles.get(t) ?? [])]))];
              return names.flatMap((name) => {
                const declared = this.unspecialisedRole(relation, name);
                if (declared === undefined || !declared.live) return [];
                const [declarer, roleName] = [declared.role.slice(0, declared.role.lastIndexOf(':')), name];
                if (this.schema.annotations.get(relatesSubject(declarer, roleName))?.has('abstract')) return [];
                if (playerTypes !== undefined && !playerTypes.some((p) => this.typeFamily(p, 'inherited').some((t) => this.schema.plays.has(playsSubject(t, declared.role))))) return [];
                return [declared.role];
              });
            };
            if (types !== undefined && types.length > 0) {
              const fits = types.map((type) => ({ type, roles: fitting(type) }));
              const anywhere = fits.find((f) => f.roles.length > 0)?.roles[0];
              if (anywhere === undefined) {
                this.refuse(DiagnosticCode.unknownRole, `Type-inference was unable to find compatible types for the pair of variables '${thing.variable.slice(1)}' & '${entry.player.slice(1)}' across a 'links' constraint.`, at);
              }
              const misfit = fits.find((f) => f.roles.length === 0);
              if (misfit !== undefined) this.refuse(DiagnosticCode.unknownRole, `Left type '${misfit.type}' across constraint 'links' is not compatible with right type '${anywhere}'.`, at);
              // A role the player may take, named or not, must hold ONE player for an update to replace it.
              if (entry.role === undefined) {
                for (const { type, roles } of fits) {
                  for (const role of roles) {
                    const name = role.slice(role.lastIndexOf(':') + 1);
                    if (roleMax(type, name, this.schema) > 1) this.refuse(DiagnosticCode.valueTypeConflict, `'${type}' can relate more than one '${name}', and an update replaces one: its cardinality should not exceed 1.`, at);
                  }
                }
              }
            }
            if (entry.role === undefined) continue;
            const role = entry.role;
            const relations = (types ?? []).filter((t) => this.schema.relations.has(t));
            if (relations.length > 0 && relations.every((r) => !this.typeFamily(r, 'inherited').some((t) => this.schema.roles.get(t)?.has(role)))) {
              this.refuse(DiagnosticCode.unknownRole, `Role label not found '${role}'.`, at);
            }
            for (const relation of relations) {
              if (this.typeFamily(relation, 'inherited').some((t) => this.schema.roles.get(t)?.has(role)) && roleMax(relation, role, this.schema) > 1) {
                this.refuse(DiagnosticCode.valueTypeConflict, `'${relation}' can relate more than one '${role}', and an update replaces one: its cardinality should not exceed 1.`, at);
              }
            }
          }
          continue;
        }
        illegal(at);
      }
    }
  }

  /**
   * `update` once per distinct row: each `has` replaces the owner's values of exactly that attribute
   * type (a subtype's or supertype's are left alone — update.feature L959), each `links` replaces the
   * role's player. The new value or player is written as `insert` writes it, so `@key`/`@unique` and
   * `plays` hold. A pattern reading a variable a `try` left empty does nothing (update.feature L2976).
   */
  private runUpdateStage(stage: UpdateStage, rows: Array<Record<string, Binding>>): Array<Record<string, Binding>> {
    if (rows.length === 0) {
      this.diagnostics.fact(DiagnosticCode.emptyMatch, '`match` bound 0 combinations, so the write ran 0 times.', rangeOf(stage));
      return rows;
    }
    this.writeRan = true;
    const distinct = uniqueRows(rows, valueVariablesReadBy(stage));
    for (const row of distinct) {
      const values = valueBindingsOf(row);
      // A `try` block updates only when what it reads is bound (update.feature L2976).
      const patterns = stage.patterns.flatMap((p) => (isOptionalPattern(p) ? (this.blockReady(p, row) ? [...p.patterns] : []) : [p]));
      for (const pattern of patterns) {
        if (!isThingPattern(pattern)) continue;
        const owner = row[pattern.variable];
        if (typeof owner !== 'number') continue;
        for (const property of pattern.properties) {
          const at = rangeOf(property);
          if (isHasProperty(property)) {
            const variable = property.valueVariable ?? (property.compared !== undefined && isVariableExpression(property.compared) ? property.compared.variable : undefined);
            if (variable !== undefined && row[variable] === undefined) continue;
            let written: { attribute: string; value: string };
            if (variable !== undefined) {
              written = this.writtenValue({ attribute: property.attribute, variable, range: at }, values);
            } else {
              const literal = property.value ?? (property.compared !== undefined && isLiteralExpression(property.compared) ? property.compared.literal : undefined);
              if (literal === undefined || property.attribute === undefined) continue;
              written = { attribute: property.attribute, value: this.checkedLiteralText(literal, property.attribute, at) };
            }
            const ownerType = this.typeOfThing(owner);
            if (!this.typeFamily(ownerType, 'inherited').some((t) => this.schema.owns.has(ownsKey(t, written.attribute)))) {
              this.refuse(DiagnosticCode.unownedAttribute, `Left type '${ownerType}' across constraint 'has' is not compatible with right type '${written.attribute}'.`, at);
            }
            this.db.prepare('DELETE FROM has WHERE owner = ? AND type = ?').run(owner, written.attribute);
            this.touched.add(owner);
            this.insertAttribute(owner, written.attribute, written.value, at);
          } else if (isLinksProperty(property)) {
            for (const entry of property.players.entries) {
              const player = row[entry.player];
              if (typeof player !== 'number') continue;
              let role = entry.role;
              if (role === undefined) {
                try {
                  role = this.inferRole(owner, player, entry.player, at);
                } catch {
                  return this.refuse(DiagnosticCode.unknownRole, `Updating 'links (${entry.player})' requires unambiguous role type: '${entry.player}' can play more than one role, or none, of '${this.typeOfThing(owner)}'.`, at);
                }
              }
              this.checkPlays(owner, player, role, entry.player, at);
              this.db.prepare('DELETE FROM role_player WHERE rel = ? AND role = ?').run(owner, role);
              this.db.prepare('INSERT INTO role_player(rel, role, player) VALUES (?, ?, ?)').run(owner, role, player);
              this.touched.add(owner);
              this.written.roles += 1;
            }
          }
        }
      }
    }
    return distinct;
  }

  /** `delete` over every row at once — see `runDeletes`; the deleted things leave the stream. */
  private runDeleteStage(stage: DeleteStage, rows: Array<Record<string, Binding>>, before: StreamScope): Array<Record<string, Binding>> {
    if (rows.length === 0) {
      this.diagnostics.fact(DiagnosticCode.emptyMatch, '`match` bound 0 combinations, so the write ran 0 times.', rangeOf(stage));
      return rows;
    }
    this.writeRan = true;
    const distinct = uniqueRows(rows, valueVariablesReadBy(stage));
    this.runDeletes(before.patterns, stage, resolveEveryMatch(distinct), distinct);
    const deleted = new Set(openDeletions(stage.deletions, this.refuse).flatMap((d) => (d.owner === undefined && d.target !== undefined ? [d.target] : [])));
    return distinct.map((row) => Object.fromEntries(Object.entries(row).filter(([variable]) => !deleted.has(variable))));
  }

  /** Stable, so ties keep stream order (modifiers.feature L382). */
  private sortRows(stage: SortStage, rows: Array<Record<string, Binding>>): Array<Record<string, Binding>> {
    return [...rows].sort((a, b) => {
      for (const key of stage.keys) {
        const order = this.compareSortValues(a[key.variable], b[key.variable], rangeOf(key));
        if (order !== 0) return key.order === 'desc' ? -order : order;
      }
      return 0;
    });
  }

  private compareSortValues(a: Binding | undefined, b: Binding | undefined, at: Range | undefined): number {
    // An unbound value (after a `try`) sorts last.
    if (a === undefined || b === undefined) return a === undefined ? (b === undefined ? 0 : 1) : -1;
    if (typeof a !== 'object' || typeof b !== 'object') {
      return this.refuse(DiagnosticCode.valueTypeConflict, '`sort` orders attributes and values, not things or types.', at);
    }
    const [left, right] = [a, b].map((binding) => ({ ...binding, valueType: binding.valueType === 'long' ? 'integer' : binding.valueType }));
    const [leftClass, rightClass] = [sortClass(left.valueType), sortClass(right.valueType)];
    if (leftClass !== rightClass) {
      return this.refuse(DiagnosticCode.valueTypeConflict, `\`sort\` cannot order a ${left.valueType} against a ${right.valueType}.`, at);
    }
    switch (leftClass) {
      case 'number':
        return compareValues(numericOf(left.valueType, left.value, this.refuse, at), numericOf(right.valueType, right.value, this.refuse, at));
      case 'string':
        return compareStrings(left.value, right.value);
      case 'datetime':
        return compareStrings(temporalKey(left.value), temporalKey(right.value));
      default:
        return compareStrings(left.value, right.value);
    }
  }

  /** `reduce` over the stream: one row, or one per group, of value cells — see `reduce.ts`. */
  private reduceRows(stage: ReduceStage, rows: Array<Record<string, Binding>>, before: StreamScope): Array<Record<string, Binding>> {
    const cells = rows.map((row) => {
      const out: Record<string, TypeDBLiteValue> = {};
      for (const [variable, binding] of Object.entries(row)) if (before.available.has(variable) && binding !== undefined) out[variable.slice(1)] = this.cellOf(binding);
      return out;
    });
    const reduced = applyReduce(stage, cells, (variable) => before.valueTypes.get(variable), (attribute) => this.valueTypeOfAttribute(attribute), this.refuse);
    return reduced.map((row) => Object.fromEntries(Object.entries(row).map(([name, cell]) => [`$${name}`, this.bindingOf(cell)])));
  }

  /** A cell back as a binding — the inverse of `cellOf`. */
  private bindingOf(cell: TypeDBLiteValue): Binding {
    if (cell.isThing()) return cell.iid;
    if (cell.isType()) return cell.label;
    return cell.isAttribute()
      ? { kind: 'attribute', attributeType: cell.type, valueType: this.valueTypeOfAttribute(cell.type) ?? 'string', value: cell.asString() }
      : { kind: 'value', valueType: cell.type, value: cell.asString() };
  }

  /**
   * The rows a read answers: a cell per available variable the query wrote — never `__anonN`.
   * 🔴 Every row, columns or not: `match not { … };` that holds is ONE answer with no variables
   * (disjunction.feature L158), as `match person sub entity;` is. Column-less rows used to be dropped.
   */
  private projectRows(rows: Array<Record<string, Binding>>, scope: StreamScope): Array<Record<string, TypeDBLiteValue>> {
    const projected: Array<Record<string, TypeDBLiteValue>> = [];
    // 🔴 A row that differed from another only in a `$_` is the same ANSWER once `$_` is dropped:
    // `match $_ relates $x as member;` answers each role once, however many relations relate it
    // (define.feature L943, match.feature L3546). Only then — rows the query's own variables tell
    // apart are never merged.
    let droppedAnonymous = false;
    const seen = new Set<string>();
    for (const row of rows) {
      const cells: Record<string, TypeDBLiteValue> = {};
      for (const [variable, binding] of Object.entries(row)) {
        if (isAnonymous(variable) && binding !== undefined) droppedAnonymous = true;
        if (!scope.available.has(variable) || variable.startsWith('__') || isAnonymous(variable) || binding === undefined) continue;
        // `select $x` — the caller reads `row.x`, without the `$`.
        cells[variable.slice(1)] = this.cellOf(binding);
      }
      if (droppedAnonymous) {
        // `type` beside the rendering: an attribute `name "W"` and a string value "W" render alike.
        const key = Object.keys(cells).sort().map((k) => `${k}=${cells[k].isAttribute() ? 'a' : cells[k].isValue() ? 'v' : 't'}:${cells[k].type}:${String(cells[k])}`).join(String.fromCharCode(30));
        if (seen.has(key)) continue;
        seen.add(key);
      }
      projected.push(cells);
    }
    return projected;
  }

  /**
   * Whether SQLite still has a transaction open on this handle: `undefined` where this Node has no
   * `DatabaseSync.isTransaction` (added in 22.16 and 24.0). The tracing wrapper forwards it.
   */
  private sqliteTransactionIsAlive(): boolean | undefined {
    const flag = (this.db as unknown as { isTransaction?: unknown }).isTransaction;
    return typeof flag === 'boolean' ? flag : undefined;
  }

  /**
   * Open a caller-held transaction: `BEGIN IMMEDIATE`, the write lock up front, for the reason
   * `applySchemaDdl` gives (a deferred transaction that upgrades while another process holds the
   * lock gets SQLITE_BUSY at once, and `busy_timeout` does not apply to an upgrade).
   */
  beginTransaction(): void {
    if (this.transactionOpen) throw new Error('A transaction is already open on this handle.');
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionOpen = true;
    this.transactionTouched = new Set();
    this.transactionChangedSchema = false;
  }

  /**
   * Commit — after what TypeDB checks at commit, which no single statement could: a relation left
   * with no player is removed, and the schema and data must stand as a whole
   * (`validateCommit`). A commit that fails rolls the whole transaction back, as TypeDB's does.
   */
  commitTransaction(): void {
    try {
      this.removePlayerlessRelations();
      this.validateCommit();
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
    try {
      this.db.exec('COMMIT');
    } finally {
      this.transactionOpen = false;
    }
  }

  /** Relations this transaction wrote that have no player left — tombstoned, as `deleteThing` does. */
  private removePlayerlessRelations(): void {
    if (!this.schema.relations.size || this.transactionTouched.size === 0) return;
    const marks = [...this.schema.relations].map(() => '?').join(', ');
    const touched = [...this.transactionTouched];
    const empty = this.db
      .prepare(`SELECT t.iid AS iid FROM thing t WHERE t.iid IN (${touched.map(() => '?').join(', ')}) AND t.type IN (${marks}) AND NOT EXISTS (SELECT 1 FROM role_player rp WHERE rp.rel = t.iid)`)
      .all(...touched, ...this.schema.relations) as Array<{ iid: number }>;
    if (empty.length === 0) return;
    this.tombstones = [];
    for (const row of empty) this.deleteThing(Number(row.iid));
    for (const identity of this.tombstones) this.changeLog.recordTombstone(identity);
    sweepAttributes(this.db);
  }

  /**
   * What TypeDB refuses at commit (define.feature L507, L1118; insert.feature L1126, L1646, L1654;
   * delete.feature L2735; undefine.feature L1049):
   * - a relation type that is not abstract relates at least one role, its own or inherited;
   * - an attribute type that is not abstract has a value type, its own or inherited;
   * - every instance of a type with a `@key` ownership holds exactly one key value.
   */
  private validateCommit(): void {
    const fail = (message: string): never => {
      throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.constraintViolated, message, undefined));
    };
    // The schema is checked when this transaction changed it; the data, where this transaction wrote —
    // or everywhere, when the schema moved under it.
    const whole = this.transactionChangedSchema;
    // ⚠️ Silent on a store that never recorded what a check reads — roles before `schema_relates`,
    // value types before `schema_value_type` — as the ownership check is before `schema_owns`: an
    // empty record means "not recorded", never "relates nothing" (a 2026-10 production store).
    const recorded = (table: string): boolean => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    const rolesRecorded = recorded('schema_relates');
    const valueTypesRecorded = recorded('schema_value_type');
    for (const relation of whole && rolesRecorded ? this.schema.relations : []) {
      if (this.schema.abstracts.has(relation)) continue;
      if (!this.typeFamily(relation, 'inherited').some((t) => (this.schema.roles.get(t)?.size ?? 0) > 0)) {
        fail(`Relation type '${relation}' must relate at least one role; make it @abstract, or give it a role.`);
      }
    }
    for (const attribute of whole && valueTypesRecorded ? this.schema.attributes : []) {
      if (this.schema.abstracts.has(attribute)) continue;
      if (this.valueTypeOfAttribute(attribute) === undefined) {
        fail(`Attribute type '${attribute}' has no value type; a concrete attribute type needs one, its own or inherited.`);
      }
    }
    // An annotation a type restates on what it already inherits, unchanged, is TypeDB's "redeclared
    // without specialisation" — `child owns email @key` under `person owns email @key`, a subtype's
    // `value string @regex(…)` repeating its parent's (define.feature L2266). Narrowing one is fine.
    for (const [subject, annotations] of whole ? this.schema.annotations : []) {
      const parts = subject.split('\u001f');
      const inherited = (ancestor: string): string | undefined =>
        parts.length === 3 && parts[1] === 'owns' ? ownsSubject(ancestor, parts[2]) : parts.length === 2 && parts[1] === 'value' ? valueSubject(ancestor) : undefined;
      if (inherited(parts[0]) === undefined) continue;
      for (const ancestor of this.typeFamily(parts[0], 'inherited').filter((t) => t !== parts[0])) {
        const theirs = this.schema.annotations.get(inherited(ancestor) as string);
        for (const [category, text] of annotations) {
          if (category === 'doc' || category.startsWith('meta:') || theirs?.get(category) !== text) continue;
          const what = parts[1] === 'owns' ? `'${parts[0]} owns ${parts[2]}'` : `the value type of '${parts[0]}'`;
          fail(`${what} redeclares ${text}, which it inherits from '${ancestor}', without specialisation.`);
        }
      }
    }
    if (!whole && this.transactionTouched.size === 0) return;
    const touched = [...this.transactionTouched];
    const only = whole ? '' : ` AND t.iid IN (${touched.map(() => '?').join(', ')})`;
    for (const ownership of this.schema.keyOwnerships) {
      const [owner, attribute] = ownership.split('\u0000');
      const wrong = this.db
        .prepare(`SELECT COUNT(*) AS n FROM thing t WHERE t.type IN ${SUBTYPES_OF}${only} AND (SELECT COUNT(*) FROM has h WHERE h.owner = t.iid AND h.type IN ${SUBTYPES_OF}) <> 1`)
        .get(owner, ...(whole ? [] : touched), attribute) as { n: number };
      if (Number(wrong.n) > 0) {
        fail(`Commit failed: key constraint violation — ${wrong.n} instance(s) of '${owner}' do not hold exactly one '${attribute}' key, and a key is @card(1..1).`);
      }
    }
  }

  /** Never throws: a rollback that fails after the engine already ended the transaction is moot. */
  rollbackTransaction(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // SQLite has already rolled back (for example after SQLITE_FULL); nothing is left to undo.
    } finally {
      this.transactionOpen = false;
      // A schema change made inside the transaction is undone in the tables; the model follows them.
      this.reloadSchema();
    }
  }

  /** Closes the database. The interpreter cannot be used afterwards. */
  close(): void {
    this.db.close();
  }

  // ── parsing ───────────────────────────────────────────────────────────────

  /**
   * Parse, then run the language's OWN validators over the AST.
   *
   * 🔴 **The validators used not to run at all here.** This called `LangiumParser.parse` and looked
   * only at lexer and parser errors, so every rule in `TypeQLiteValidator` — `@card`, `@unique`,
   * duplicate labels, reserved keywords, `@key` on a role, duplicate `owns` — fired in an editor
   * and never for anything the engine executed. `rejectUnimplemented` then hand-rolled two of those
   * rules again in this file, so `@card` had two definitions and only one of them guarded a real
   * write.
   *
   * ⚠️ **And queries here are TypeScript string literals, not `.typeqlite` documents**, so no editor
   * ever sees them. Running validation on the AST the interpreter just built is what makes the
   * language layer authoritative for both: one rule, registered once, enforced wherever TypeQLite
   * arrives from.
   *
   * `validateSync` is Langium's own `validateAstNodes` loop without the `await` — see its header for
   * why the async `DocumentValidator` is not usable from a synchronous engine.
   */
  private parse(text: string): TypeQLiteFile {
    const result = TypeQLite.parser.LangiumParser.parse<TypeQLiteFile>(text);
    const errors = [...result.lexerErrors, ...result.parserErrors];
    if (errors.length > 0) {
      const message = `TypeQLite could not be parsed: ${errors
        .map((e) => e.message)
        .join('; ')}`;
      // 🔴 There is no AST here — parsing is what failed — so the range cannot come from a
      // `CstNode`. Chevrotain carries its own offsets on both error kinds, under different shapes:
      // a lexer error has `offset`/`length`, a parser error carries the offending `token`.
      const first = errors[0] as {
        offset?: number;
        length?: number;
        token?: { startOffset?: number; image?: string };
      };
      const offset = first.offset ?? first.token?.startOffset ?? 0;
      const length = first.length ?? first.token?.image?.length ?? 1;
      // 🔴 A reserved word where a label belongs is TypeDB's `[DEX31]`, not a bare parse failure.
      // The validator used to say so for `fetch` and `update`, the two the grammar did not know;
      // once `fetch` became a grammar keyword (the fetch phase) `attribute fetch` stopped parsing,
      // and the refusal lost its reason. Every reserved word that is a keyword lands here instead.
      const image = first.token?.image;
      if (image !== undefined && isReservedKeyword(image) && /Expecting token of type 'ID'/.test(String((errors[0] as { message?: string }).message))) {
        const reserved = reservedKeywordMessage(image);
        throw attachDiagnostic(
          new Error(reserved),
          this.diagnostics.error(DiagnosticCode.reservedKeyword, reserved, rangeFromOffset(text, offset, length)),
        );
      }
      throw attachDiagnostic(
        new Error(message),
        this.diagnostics.error(
          DiagnosticCode.parseFailed,
          message,
          rangeFromOffset(text, offset, length),
        ),
      );
    }

    // 🔴 The language's rules, run where the engine can act on them. An `error` here is a construct
    // the grammar accepts and the runtime refuses — ADR-002 D7's middle layer, which had no teeth
    // for anything but an editor until this call existed.
    //
    // ⚠️ Anything BELOW error is forwarded as a fact, not dropped. Since 2026-09-11 an annotation
    // the runtime does not enforce (`@card`, `@unique`, `@independent`, …) is reported by the
    // validator at info severity and the schema is applied; dropping it here would turn the
    // founder's "accept, and report" into "accept, silently" — the one outcome ADR-002 D7 forbids.
    const reported = validateSync(TypeQLite, result.value);
    const problem = reported.find((diagnostic) => diagnostic.severity === 1);
    if (problem) {
      const message = problem.message;
      throw attachDiagnostic(new Error(message), {
        range: problem.range,
        severity: 1,
        code: problem.code,
        message,
        source: DIAGNOSTIC_SOURCE,
      });
    }
    // Deferred, not pushed: the collector caps facts, and a define with fifty annotations would
    // otherwise push fifty "not enforced" facts BEFORE the two that say what the call did. Each
    // entry point flushes these after its own facts, so what happened survives the cap and the
    // annotations are what get truncated.
    this.deferredFacts = reported.filter((diagnostic) => diagnostic.severity !== 1);
    renameAnonymous(result.value);
    this.mergeWrittenStatements(result.value);
    return result.value;
  }

  /**
   * An insert is a SET of statements, so every statement about one variable is one statement:
   * `$x has name "Bond"; $x isa person, has ref 0;` inserts ONE person with both (insert.feature
   * L100), and `$x isa person; $x isa person;` one person (L243). Two different types for one
   * variable cannot both be written — TypeDB's type inference finds no type for it (L227).
   * Merged once, on the AST, so every reader of the stage sees one statement per variable.
   */
  private mergeWrittenStatements(root: TypeQLiteFile): void {
    const merge = (patterns: Pattern[]): Pattern[] => {
      const byVariable = new Map<string, ThingPattern>();
      const merged: Pattern[] = [];
      for (const pattern of patterns) {
        if (isOptionalPattern(pattern)) {
          (pattern as { patterns: Pattern[] }).patterns = merge(pattern.patterns);
          merged.push(pattern);
          continue;
        }
        if (!isThingPattern(pattern) || isAnonymous(pattern.variable)) {
          merged.push(pattern);
          continue;
        }
        const first = byVariable.get(pattern.variable);
        if (first === undefined) {
          byVariable.set(pattern.variable, pattern);
          merged.push(pattern);
          continue;
        }
        const types = new Set([...first.properties, ...pattern.properties].flatMap((p) => (isIsaProperty(p) ? [`${p.exact ? '!' : ''}${p.type ?? p.typeVariable}`] : [])));
        if (types.size > 1) {
          this.refuse(DiagnosticCode.mixedPattern, `Type-inference was unable to find compatible types for the pair of variables: '${pattern.variable}' is written as ${[...types].map((t) => `'${t.replace(/^!/, '')}'`).join(' and ')}, and one thing has one type.`, rangeOf(pattern));
        }
        // The `isa` once, first — the rest of both statements after it.
        const isa = first.properties.find(isIsaProperty) ?? pattern.properties.find(isIsaProperty);
        const rest = [...first.properties, ...pattern.properties].filter((p) => !isIsaProperty(p) || (p.players !== undefined && p !== isa));
        (first as { properties: Property[] }).properties = isa === undefined ? rest : [isa, ...rest.filter((p) => p !== isa)];
      }
      return merged;
    };
    for (const node of AstUtils.streamAst(root)) {
      if (node.$type === 'InsertStage' || node.$type === 'PutStage') {
        const stage = node as unknown as { patterns: Pattern[] };
        stage.patterns = merge(stage.patterns);
      }
    }
  }

  private pipelines(text: string): Pipeline[] {
    return this.parse(text).clauses.filter(
      (clause): clause is Pipeline => clause.$type === 'Pipeline',
    );
  }

  // ── the schema re-check Phase 01 forced ───────────────────────────────────

  /**
   * 🔴 ADR-002 Decision 7's third layer, and the backstop that must never become a no-op.
   *
   * Phase 01 proved a standalone query cannot be validated against a schema that is not loaded —
   * repositories pass a query string with no schema document in scope — so this is the only place
   * the check can be sound: against the schema this interpreter actually applied.
   */
  /**
   * Every `sub <parent>` names a type the schema knows — as TypeDB refuses `[SYR1] The type … was
   * not found`. 🔴 It was applied silently: the interpreter parses without linking, so the parent
   * was only ever a string, recorded into `schema.parents` and `type_parent` unchecked, and every
   * later `isa` on the child resolved through a parent that did not exist
   * (`d-20260911-define-accepts-a-supertype-that-does`).
   *
   * **And every re-open names a type the schema knows.** `nobody owns ref @key;` — a
   * `TypeExtensionDef` on a type never defined — was applied too, writing `schema_owns` and a
   * UNIQUE index for a type that did not exist; found by the Phase 01 review. Same check, same
   * refusal.
   *
   * ⚠️ Checked BEFORE the DDL runs, and against the names this define declares plus those already
   * applied — a parent or a re-opened type defined later in the same statement is fine, as it is
   * on TypeDB.
   */
  private checkSupertypesExist(file: TypeQLiteFile): void {
    const types = new Set(this.schema.types);
    const attributes = new Set(this.schema.attributes);
    for (const clause of file.clauses) {
      if (!isDefineClause(clause)) continue;
      for (const definition of clause.definitions.filter(isTypeDefinition)) {
        if (isEntityDef(definition) || isRelationDef(definition)) types.add(definition.name);
        if (isAttributeDef(definition)) attributes.add(definition.name);
      }
    }
    for (const clause of file.clauses) {
      if (!isDefineClause(clause)) continue;
      for (const definition of clause.definitions.filter(isTypeDefinition)) {
        if (isTypeExtensionDef(definition)) {
          // An attribute is a type too: `name @abstract;`, `email @independent;` re-open one — with
          // annotations only. A trait on an attribute (`email owns name @key;`) is refused, as
          // TypeDB refuses it; admitting it wrote a UNIQUE index on `name` from a statement no
          // schema should accept (Phase 01 review, round 3).
          if (attributes.has(definition.type) && !types.has(definition.type)) {
            const parent = definition.superType;
            if (parent !== undefined && !attributes.has(parent)) {
              const message =
                `Unknown attribute '${parent}': '${definition.type} sub ${parent}' names a parent that is ` +
                `neither defined here nor already applied. The applied schema defines: ` +
                `${[...attributes].sort().join(', ') || '(nothing)'}`;
              throw attachDiagnostic(
                new Error(message),
                this.diagnostics.error(DiagnosticCode.unknownAttribute, message, rangeOf(definition)),
              );
            }
            if (definition.traits.length === 0) continue;
            const message =
              `attribute '${definition.type}' cannot own, relate or play: an attribute re-open ` +
              `takes annotations only.`;
            throw attachDiagnostic(
              new Error(message),
              // Its own code: the attribute IS known, so `unknownType` would steer a consumer
              // toward defining it when the remedy is to drop the trait (review, round 4).
              this.diagnostics.error(DiagnosticCode.traitOnAttribute, message, rangeOf(definition)),
            );
          }
          if (types.has(definition.type)) {
            // `person sub parent;` — a re-open assigning a parent. The parent is a plain name in
            // the AST (the re-opened type's kind is not in the text); it must be a thing type
            // the schema knows, as an entity's `sub` must.
            const parent = definition.superType;
            if (parent !== undefined && !types.has(parent)) {
              const message =
                `Unknown type '${parent}': '${definition.type} sub ${parent}' names a parent that is ` +
                `neither defined here nor already applied. The applied schema defines: ` +
                `${[...types].sort().join(', ') || '(nothing)'}`;
              throw attachDiagnostic(
                new Error(message),
                this.diagnostics.error(DiagnosticCode.unknownType, message, rangeOf(definition)),
              );
            }
            continue;
          }
          const message =
            `Unknown type '${definition.type}': it is re-opened here but neither defined here nor ` +
            `already applied. The applied schema defines: ` +
            `${[...types, ...attributes].sort().join(', ') || '(nothing)'}`;
          throw attachDiagnostic(
            new Error(message),
            this.diagnostics.error(DiagnosticCode.unknownType, message, rangeOf(definition)),
          );
        }
        const parent = declaredParentOf(definition);
        if (parent === undefined) continue;
        const known = isAttributeDef(definition) ? attributes : types;
        if (known.has(parent)) continue;
        const kind = isAttributeDef(definition) ? 'attribute' : 'type';
        const message =
          `Unknown ${kind} '${parent}': '${definition.name} sub ${parent}' names a parent that is ` +
          `neither defined here nor already applied. The applied schema defines: ` +
          `${[...known].sort().join(', ') || '(nothing)'}`;
        throw attachDiagnostic(
          new Error(message),
          this.diagnostics.error(
            kind === 'type' ? DiagnosticCode.unknownType : DiagnosticCode.unknownAttribute,
            message,
            rangeOf(definition),
          ),
        );
      }
    }
  }

  private checkKnown(
    kind: 'type' | 'attribute',
    name: string,
    at?: Range,
  ): void {
    const known =
      kind === 'type' ? this.schema.types : this.schema.attributes;
    if (known.size === 0) return; // No schema applied yet; `define` has not run.
    if (!known.has(name)) {
      const message =
        // TypeDB says "Type label 'dog' not found." (define.feature L3458) — its words, then ours.
        `Unknown ${kind} '${name}': type label '${name}' not found. The applied schema defines: ` +
        `${[...known].sort().join(', ')}`;
      throw attachDiagnostic(
        new Error(message),
        this.diagnostics.error(
          kind === 'type'
            ? DiagnosticCode.unknownType
            : DiagnosticCode.unknownAttribute,
          message,
          at,
        ),
      );
    }
  }

  // ── matching ──────────────────────────────────────────────────────────────

  private constraintsOf(
    patterns: readonly Pattern[],
    statement: OwnershipStatement = 'match',
  ): ThingConstraint[] {
    // Named apart: the loop below mints a numeric `statement` id per pattern.
    const ownership = statement;
    const constraints: ThingConstraint[] = [];
    // A variable that heads a type pattern in one place and a thing pattern in another is refused,
    // as one pattern mixing both is — `$x sub person; $x has ref $r;` (review, round 1).
    const typeHeads = new Set<string>();
    const thingHeads = new Map<string, Pattern>();
    for (const pattern of patterns) {
      if (isThingPattern(pattern) && !isTypeHead(pattern, this.refuse)) {
        thingHeads.set(pattern.variable, pattern);
        // `$x isa $t` uses `$t` as a type (review, round 2).
        for (const property of pattern.properties) {
          if (isIsaProperty(property) && property.typeVariable !== undefined) typeHeads.add(property.typeVariable);
        }
        continue;
      }
      if (isThingPattern(pattern) || isKindPattern(pattern)) typeHeads.add(pattern.variable);
    }
    for (const variable of typeHeads) {
      const conflicting = thingHeads.get(variable);
      if (conflicting !== undefined) {
        this.refuse(
          DiagnosticCode.mixedPattern,
          `'${variable}' is used as a type in one pattern and as a thing in another; a variable is one or the other.`,
          rangeOf(conflicting),
        );
      }
    }
    if (statement === 'write') {
      for (const pattern of patterns) {
        // `insert $x sub person;`, `put person owns name;` — a type statement writes schema, and a
        // write stage writes data (put.feature L596). `insert $x isa $t` is a THING statement, its
        // type through a variable an earlier stage bound — resolved per row (`concreteWrite`).
        if (isTypeHead(pattern, this.refuse)) {
          this.refuse(DiagnosticCode.mixedPattern, 'A write stage may only contain thing statements: a type statement belongs to `define`, `undefine` or `redefine`.', rangeOf(pattern));
        }
        // `insert $x isa person, isa writer;` — a write names ONE type (review, round 4): the
        // match side ANDs every `isa`, and an insert can only write one.
        if (isThingPattern(pattern) && pattern.properties.filter(isIsaProperty).length > 1) {
          this.refuse(DiagnosticCode.mixedPattern, `'${pattern.variable}' names more than one type in a write; an insert or put names exactly one.`, rangeOf(pattern));
        }
      }
    }
    for (const pattern of patterns) {
      // A `let` or a comparison is `orderValueStatements`'s — see `expressions.ts`.
      if (isLetPattern(pattern) || isComparisonPattern(pattern)) continue;
      // A type pattern is `typeConstraintsOf`'s — see `type-patterns.ts`; a mixed head is refused there.
      if (isTypeHead(pattern, this.refuse)) continue;
      if (isAnonRelationPattern(pattern)) {
        if (pattern.type !== undefined) this.checkKnown('type', pattern.type, rangeOf(pattern));
        const owned = this.anonymousOwnership(pattern);
        constraints.push({
          variable: `__anon${constraints.length}`,
          type: pattern.type,
          isas: pattern.type !== undefined ? [{ type: pattern.type, exact: false }] : pattern.typeVariable !== undefined ? [{ typeVariable: pattern.typeVariable, exact: false }] : [],
          range: rangeOf(pattern),
          literals: owned.literals,
          bindings: owned.bindings,
          roles: rolesOf(pattern.players, (patternCounter += 1)),
        });
        continue;
      }
      if (!isThingPattern(pattern)) continue;

      // `isa person` where person and everything below it is abstract — or `isa! name` on an abstract
      // `name` — can have no instance: TypeDB's type inference finds no type for the variable
      // (match.feature L942, L4092).
      for (const property of pattern.properties) {
        if (ownership !== 'match' || !isIsaProperty(property) || property.type === undefined) continue;
        if (!this.schema.types.has(property.type) && !this.schema.attributes.has(property.type)) continue;
        const candidates = property.exact ? [property.type] : this.subtypesOf(property.type);
        if (candidates.every((t) => this.schema.abstracts.has(t))) {
          this.refuse(DiagnosticCode.abstractType, `Type-inference was unable to find compatible types for the pair of variables: '${pattern.variable}' \`isa${property.exact ? '!' : ''} ${property.type}\` names only abstract types, which have no instances.`, rangeOf(property));
        }
      }
      const instance = this.attributeInstanceOf(pattern, ownership);
      if (instance !== undefined) {
        constraints.push(instance);
        continue;
      }

      const constraint: ThingConstraint = {
        variable: pattern.variable,
        range: rangeOf(pattern),
        literals: [],
        bindings: [],
        roles: [],
        isas: [],
      };
      // One id for the whole pattern, so its `isa (...)` list and its `links (...)` list are the
      // same statement — they are written together and mean one thing.
      const statement = (patternCounter += 1);
      for (const property of pattern.properties) {
        if (isIsaProperty(property)) {
          if (property.type !== undefined) this.checkKnown('type', property.type, rangeOf(property));

          // Every `isa` is kept — two in one pattern, `isa! writer, isa person`, are two filters.
          constraint.isas.push({ type: property.type, typeVariable: property.typeVariable, exact: property.exact === true });
          constraint.type ??= property.type;
          if (property.players) constraint.roles.push(...rolesOf(property.players, statement));
        } else if (isLinksProperty(property)) {
          constraint.roles.push(...rolesOf(property.players, statement));
        } else if (isIidProperty(property)) {
          // An iid is the engine's to assign — TypeDB parses `insert $x iid 0x…` and refuses it.
          if (ownership === 'write') this.refuse(DiagnosticCode.mixedPattern, `'${pattern.variable}' cannot be given an iid: an iid is assigned by the database, never written.`, rangeOf(property));
          (constraint.iids ??= []).push(property.iid);
        } else if (isHasProperty(property)) {
          if (property.attribute === undefined) {
            // `has $a` — an attribute of any type (163 uses in the behaviour spec).
            if (property.valueVariable) constraint.bindings.push({ variable: property.valueVariable, range: rangeOf(property) });
            continue;
          }
          this.checkKnown('attribute', property.attribute, rangeOf(property));
          if (property.comparator !== undefined && property.compared !== undefined) {
            // A match never reaches here — `desugarHas` rewrote it into a binding and a comparison.
            // A write takes `has name == $n` as the value of `$n` (fetch.feature L2996), and nothing
            // else: `has age > 5` writes no value.
            if (ownership !== 'write' || property.comparator !== '==') {
              this.refuse(DiagnosticCode.mixedPattern, `\`has ${property.attribute} ${property.comparator} …\` constrains a match; a write names the value it writes.`, rangeOf(property));
            }
            if (isVariableExpression(property.compared)) {
              constraint.bindings.push({ attribute: property.attribute, variable: property.compared.variable, range: rangeOf(property) });
            } else if (isLiteralExpression(property.compared)) {
              constraint.literals.push({
                attribute: property.attribute,
                value: this.checkedLiteralText(property.compared.literal, property.attribute, rangeOf(property)),
                range: rangeOf(property),
              });
            } else {
              this.refuse(DiagnosticCode.notImplemented, `TypeDBLite does not write a computed value through \`has ${property.attribute} == …\` yet; bind it with \`let\` first.`, rangeOf(property));
            }
            continue;
          }
          if (property.value) {
            const matched = ownership === 'match' ? this.matchedLiteral(property.value, property.attribute, rangeOf(property)) : undefined;
            constraint.literals.push({
              attribute: property.attribute,
              value: matched?.value ?? this.checkedLiteralText(property.value, property.attribute, rangeOf(property)),
              range: rangeOf(property),
              alternatives: matched === undefined ? this.literalAlternatives(property.value, property.attribute, rangeOf(property)) : matched.alternatives,
            });
          } else if (property.valueVariable) {
            constraint.bindings.push({
              attribute: property.attribute,
              variable: property.valueVariable,
              range: rangeOf(property),
            });
          }
        }
      }
      // (Phase 05) `isa $t` and `isa!` merge too — a later pattern's `isa` is not dropped.
      // 🔴 A variable repeated across patterns NARROWS; it does not start again.
      //
      // `TypeDBLitePrincipalRepository.findById` writes exactly this:
      //
      //     match $p isa person, has person-id "s";
      //           $p has person-id $id, has person-kind $type;
      //
      // Two patterns, one `$p`. Treating them as separate constraints let the second — which has
      // no `isa` and no literal, so it matches every person — overwrite the first, and
      // `findById('s')` returned whichever person came first. Merging by variable is what makes
      // the second pattern a projection of the thing the first one found.
      const existing = constraints.find((c) => c.variable === constraint.variable);
      if (existing) {
        existing.isas.push(...constraint.isas);
        existing.type ??= constraint.type;
        existing.literals.push(...constraint.literals);
        existing.bindings.push(...constraint.bindings);
        existing.roles.push(...constraint.roles);
        if (constraint.iids !== undefined) (existing.iids ??= []).push(...constraint.iids);
        continue;
      }
      constraints.push(constraint);
    }
    // 🔴 After merging, not during. `constraintsOf` folds every pattern naming a variable into one
    // constraint, and the `isa` may arrive in a later pattern than the `has` — checking mid-walk
    // would accuse `$p has person-kind "user";` of naming an unowned attribute purely because
    // its type had not been seen yet.
    for (const constraint of constraints) this.checkOwns(constraint, statement);
    if (statement === 'match') for (const constraint of constraints) this.checkRelationRoles(constraint, constraints);
    return constraints;
  }

  /**
   * `$n isa name "John"`, `$a isa! age`, `insert $_ isa name == $v` — a pattern whose `isa` names an
   * attribute type is an attribute instance (ADR-006); any other pattern answers `undefined`.
   *
   * An attribute owns nothing and plays nothing in TypeDB 3, so one pattern may not give it `has`,
   * `links` or a second `isa`. In a match the value is a literal or nothing — `isa age > 18` was
   * rewritten into a comparison by `desugarIsa`; a write names the value it writes, as `has` does.
   */
  private attributeInstanceOf(pattern: ThingPattern, statement: OwnershipStatement): ThingConstraint | undefined {
    const named = pattern.properties.find((p): p is IsaProperty => isIsaProperty(p) && p.type !== undefined && this.schema.attributes.has(p.type));
    if (named === undefined) return undefined;
    const type = named.type as string;
    const range = rangeOf(pattern);
    if (pattern.properties.length > 1 || named.players !== undefined) {
      this.refuse(DiagnosticCode.mixedPattern, `'${pattern.variable}' is an attribute of type '${type}': it owns nothing, plays nothing and has one type, so it takes no other property.`, range);
    }
    let literal: { value: string; alternatives?: Array<{ type: string; value: string }> } | undefined;
    let valueVariable: string | undefined;
    if (named.value !== undefined) {
      literal =
        statement === 'match'
          ? this.matchedLiteral(named.value, type, rangeOf(named))
          : { value: this.checkedLiteralText(named.value, type, rangeOf(named)) };
    } else if (named.comparator !== undefined && named.compared !== undefined) {
      // A match's comparison was rewritten before here; a write takes `==` as the value it writes
      // (expression.feature L1407), and nothing else: `insert $x isa age > 18` writes no value
      // (insert.feature L1619).
      if (statement !== 'write' || named.comparator !== '==') {
        this.refuse(DiagnosticCode.mixedPattern, `\`isa ${type} ${named.comparator} …\` constrains a match; a write names the value it writes.`, rangeOf(named));
      }
      if (isVariableExpression(named.compared)) valueVariable = named.compared.variable;
      else if (isLiteralExpression(named.compared)) literal = { value: this.checkedLiteralText(named.compared.literal, type, rangeOf(named)) };
      else this.refuse(DiagnosticCode.notImplemented, `TypeDBLite does not write a computed value through \`isa ${type} == …\` yet; bind it with \`let\` first.`, rangeOf(named));
    } else if (statement === 'write') {
      // insert.feature L1605: an attribute IS its value, so an insert without one writes nothing.
      this.refuse(DiagnosticCode.mixedPattern, `An inserted attribute names its value: \`insert ${pattern.variable} isa ${type} <value>;\`.`, rangeOf(named));
    }
    return {
      // Anonymous, like `__anonN`: no query can name it, and the projection never shows it.
      variable: `__anonattr${pattern.variable}`,
      isas: [],
      literals: [],
      roles: [],
      range,
      bindings: [{ attribute: type, variable: pattern.variable, range }],
      instance: { variable: pattern.variable, type, exact: named.exact === true, literal, valueVariable, range },
    };
  }

  /**
   * Every stored attribute an instance constraint admits, as `$n`'s binding — or, when `$n` is already
   * bound (`$p has name $n; $n isa name;`, a `fetch` parent, a `given` row), whether that one is.
   * An attribute nothing owns and whose type is not `@independent` is never stored past the
   * statement that left it so (`sweepAttributes`), so every row here is one a query may see.
   */
  private bindAttributeInstance(instance: NonNullable<ThingConstraint['instance']>, combination: Record<string, Binding>): Array<Record<string, Binding>> {
    const where = [instance.exact ? 'type = ?' : `type IN ${SUBTYPES_OF}`];
    const params: Array<string | number> = [instance.type];
    const literal = instance.literal;
    if (literal?.alternatives !== undefined) {
      if (literal.alternatives.length === 0) return [];
      where.push(`(${literal.alternatives.map(() => '(type = ? AND value = ?)').join(' OR ')})`);
      for (const alternative of literal.alternatives) params.push(alternative.type, alternative.value);
    } else if (literal !== undefined) {
      where.push('value = ?');
      params.push(literal.value);
    }
    const already = combination[instance.variable];
    if (already !== undefined) {
      // A thing or a type in `$x isa name` was refused before any combination; a plain value is not
      // an attribute instance, and an attribute of another type is not this one.
      if (typeof already !== 'object' || already.kind !== 'attribute') return [];
      const held = this.db.prepare(`SELECT 1 FROM attribute WHERE ${where.join(' AND ')} AND type = ? AND value = ?`).get(...params, already.attributeType, already.value);
      return held === undefined ? [] : [combination];
    }
    const rows = this.db.prepare(`SELECT type, value FROM attribute WHERE ${where.join(' AND ')} ORDER BY id`).all(...params) as Array<{ type: string; value: string }>;
    return rows.map((row) => {
      const type = String(row.type);
      const bound: ValueBinding = { kind: 'attribute', attributeType: type, valueType: this.valueTypeOfAttribute(type) ?? 'string', value: String(row.value) };
      return { ...combination, [instance.variable]: bound };
    });
  }

  /**
   * A relation pattern that can never match is refused, as TypeDB's type inference refuses it
   * (match.feature L1433–L1484): a role no relation declares; a relation type that is no relation;
   * a role the named relation type relates nowhere in its hierarchy — `isa marriage` reaches a
   * `hetero-marriage`'s husband, `isa civil-marriage` does not; a player whose type plays no role
   * of the relation. Only what is WRITTEN is judged; a type variable constrains nothing here.
   */
  /**
   * `delete has $e of $p` — every type the match lets `$p` be owns every type it lets `$e` be, or the
   * write is refused before any row, in TypeDB's words: `$p isa person; $e isa email;` fails on
   * `encrypted-email`, which a person does not own (delete.feature L1902, read off TypeDB 3.10.4).
   * A match that already says `$p has … $e` pairs them itself, and is not checked again.
   */
  private checkDeletedOwnership(owner: string, target: string, constraints: readonly ThingConstraint[], at: Range | undefined): void {
    const ownerConstraint = constraints.find((c) => c.variable === owner);
    if (ownerConstraint?.bindings.some((b) => b.variable === target)) return;
    const concrete = (types: string[]): string[] => [...new Set(types)].filter((t) => !this.schema.abstracts.has(t));
    const ownerTypes = concrete((ownerConstraint?.isas ?? []).flatMap((isa) => (isa.type === undefined ? [] : isa.exact ? [isa.type] : this.subtypesOf(isa.type))));
    const instance = constraints.find((c) => c.instance?.variable === target)?.instance;
    const bound = constraints.flatMap((c) => c.bindings).find((b) => b.variable === target && b.attribute !== undefined)?.attribute;
    const attribute = instance?.type ?? bound;
    if (ownerTypes.length === 0 || attribute === undefined) return;
    const attributeTypes = concrete(instance?.exact ? [attribute] : this.subtypesOf(attribute));
    for (const type of ownerTypes) {
      const family = this.typeFamily(type, 'inherited');
      const unowned = attributeTypes.find((a) => !family.some((t) => this.schema.owns.has(ownsKey(t, a))));
      if (unowned !== undefined) this.refuse(DiagnosticCode.unownedAttribute, `Left type '${type}' across constraint 'has' is not compatible with right type '${unowned}'.`, at);
    }
  }

  /** The concrete thing types that can own an instance of every one of `attributes` (or a subtype of it). */
  private ownersOfAll(attributes: readonly string[]): string[] {
    return [...this.schema.types].filter((t) => !this.schema.abstracts.has(t) && attributes.every((a) => this.subtypesOf(a).some((sub) => this.typeFamily(t, 'inherited').some((up) => this.schema.owns.has(ownsKey(up, sub))))));
  }

  /**
   * The types a thing variable can be after `before`'s stages: its `isa`s, else what an insert wrote
   * it as, else — `$f has ref $_` alone — every type that can own what it has.
   */
  private streamTypesOf(variable: string, before: StreamScope, scope: FetchScope): readonly string[] | undefined {
    const typed = scope.typesOf(variable);
    if (typed !== undefined) return typed;
    const inserted = before.inserted?.get(variable);
    if (inserted !== undefined) return [inserted];
    const matched = this.constraintsOf(before.patterns).find((c) => c.variable === variable);
    if (matched === undefined || matched.isas.length > 0) return undefined;
    const owned = [...matched.literals, ...matched.bindings].flatMap((n) => (n.attribute === undefined ? [] : [n.attribute]));
    return owned.length === 0 ? undefined : this.ownersOfAll(owned);
  }

  /** A type and every type below it, at any depth. */
  private subtypesOf(type: string): string[] {
    return [...this.schema.types, ...this.schema.attributes].filter((t) => this.typeFamily(t, 'inherited').includes(type));
  }

  /**
   * The role `name` as `relation` reaches it — declared by it or an ancestor (`role`, as
   * `relation:role` of the declarer) — and whether it is still LIVE there: not specialised away by
   * `relation` or any type between it and the declarer (`relates intern as employee`). `undefined`
   * when nothing above `relation` declares it.
   */
  private unspecialisedRole(relation: string, name: string): { role: string; live: boolean } | undefined {
    const chain = this.typeFamily(relation, 'inherited');
    const declarer = chain.find((t) => this.schema.roles.get(t)?.has(name));
    if (declarer === undefined) return undefined;
    const role = roleRef(declarer, name);
    const below = chain.slice(0, chain.indexOf(declarer));
    const live = ![...this.schema.specialises].some(([child, parent]) => parent === role && below.includes(child.slice(0, child.lastIndexOf(':'))));
    return { role, live };
  }

  private checkRelationRoles(constraint: ThingConstraint, all: readonly ThingConstraint[]): void {
    if (constraint.roles.length === 0 || this.schema.relations.size === 0) return;
    const incompatible = (detail: string): never =>
      this.refuse(DiagnosticCode.unknownRole, `Type-inference was unable to find compatible types for the pair of variables: ${detail}`, constraint.range);
    const declared = (role: string): boolean => [...this.schema.roles.values()].some((roles) => roles.has(role));
    const relationTypes = constraint.isas.flatMap((isa) => (isa.type === undefined ? [] : [isa.type]));
    for (const type of relationTypes) {
      if (!this.typeFamily(type, 'inherited').some((t) => this.schema.relations.has(t))) {
        incompatible(`'${type}' is not a relation type, so it has no roles to link.`);
      }
    }
    // The roles a relation type can link: those it or an ancestor declares, and — since `isa T`
    // answers T's subtypes — those its subtypes declare.
    // Above it and below it — never a SIBLING: `civil-marriage` relates no `wife` because
    // `hetero-marriage`, beside it under `marriage`, does (match.feature L1512).
    const related = (type: string): Set<string> => new Set([...this.typeFamily(type, 'inherited'), ...this.subtypesOf(type)].flatMap((t) => [...(this.schema.roles.get(t) ?? [])]));
    for (const role of constraint.roles) {
      if (role.role === undefined) continue;
      if (!declared(role.role)) {
        this.refuse(DiagnosticCode.unknownRole, `Role label not found '${role.role}': no relation type relates it.`, role.range ?? constraint.range);
      }
      for (const type of relationTypes) {
        if (!related(type).has(role.role)) incompatible(`'${type}' relates no role '${role.role}', nor does any type above or below it.`);
      }
    }
    // A player with a written type that can play no role of the relation — `$x isa company;
    // friendship ($x);` (L1473). Both directions of each hierarchy count, as `isa` does.
    if (relationTypes.length === 0 || this.schema.plays.size === 0) return;
    const roles = new Set(relationTypes.flatMap((type) => this.typeFamily(type, 'both').flatMap((t) => [...(this.schema.roles.get(t) ?? [])].map((r) => roleRef(t, r)))));
    for (const role of constraint.roles) {
      const playerTypes = all.find((c) => c.variable === role.player)?.isas.flatMap((isa) => (isa.type === undefined ? [] : [isa.type])) ?? [];
      for (const playerType of playerTypes) {
        if (!this.schema.types.has(playerType)) continue;
        const plays = this.typeFamily(playerType, 'both').some((t) => [...roles].some((r) => (role.role === undefined || r.split(':')[1] === role.role) && this.schema.plays.has(playsSubject(t, r))));
        if (!plays) incompatible(`'${playerType}' plays no role of '${relationTypes.join("', '")}'${role.role === undefined ? '' : ` as '${role.role}'`}.`);
      }
    }
  }

  /**
   * Refuse a pattern that constrains an attribute its type does not own.
   *
   * 🔴 `match $n isa node, has edge-id $e;` can never match, however the data changes — `node` does
   * not own `edge-id`. It answered **zero rows at exit code 0**, and the `noCandidates` fact could
   * not say so: two attempts to derive it from candidate counts reported a *data* problem for a
   * *schema* fault, in different wrong ways, before the inference was deleted. The fault was that
   * `SchemaModel` recorded no ownership, not that the question was underivable.
   *
   * ⚠️ **Silent when the schema predates `schema_owns`**, rather than accusing every pattern of
   * naming an unowned attribute. An empty ownership set means "not recorded", never "owns nothing"
   * — the distinction that makes this safe to add to a database written by an older build.
   *
   * ⚠️ **Both directions of the hierarchy count** — see `typeFamily`. `isa doc` may be answered by
   * an `adr` that owns more than `doc` does, and an `adr` inherits what `doc` owns.
   *
   * ⚠️ **A write is refused for the same reason, but not in the same words.** Nothing is being
   * matched in `insert $n isa node, has edge-id "e";` — the fault is that the row it would write is
   * one the engine could never read back, because every read of it is the refusal above.
   *
   * 🔴 **And a write's type is concrete, so only the inherited direction counts for it.** A row
   * inserted as, or bound as, a `doc` *is* a `doc`; that `adr sub doc` owns `adr-status` says nothing
   * about it. Walking downward on a write accepted a `doc` row carrying an attribute only `adr`
   * owns — which the read side then refuses on `isa doc`.
   */
  private checkOwns(constraint: ThingConstraint, statement: OwnershipStatement = 'match'): void {
    if (this.schema.owns.size === 0) return;
    const named = [
      ...constraint.literals.map((l) => ({ attribute: l.attribute, range: l.range })),
      ...constraint.bindings.flatMap((b) => (b.attribute === undefined ? [] : [{ attribute: b.attribute, range: b.range }])),
    ];
    if (named.length === 0) return;

    // Every WRITTEN type on the variable is checked — `isa person, isa! vehicle, has ref $r` is
    // refused whichever `isa` comes first (review, round 4). A type variable constrains nothing here.
    const written = [...new Set(constraint.isas.flatMap((isa) => (isa.type === undefined ? [] : [isa.type])))];
    for (const type of written) {
      const family = statement === 'match' ? this.typeFamily(type) : this.typeFamily(type, 'inherited');
      for (const { attribute, range } of named) {
        // 🔴 A match reads through the attribute's subtypes, as `has name "Alice"` is satisfied by a
        // `first-name`: an owner of any subtype can match. `owner owns score, owns quantity` (both
        // `sub base-attr`) matches `has base-attr $x` on TypeDB (modifiers.feature L565). A write
        // names the type it writes, and that type must be owned.
        const readable = statement === 'match' ? this.typeFamily(attribute).filter((a) => this.typeFamily(a, 'inherited').includes(attribute)) : [attribute];
        if (family.some((t) => readable.some((a) => this.schema.owns.has(ownsKey(t, a))))) continue;
        const consequence =
          statement === 'match'
            ? `\`${constraint.variable} isa ${type}, has ${attribute} …\` can never match.`
            : `\`${constraint.variable} isa ${type}, has ${attribute} …\` could never be read back.`;
        // TypeDB's words first — a caller matching on them gets them (insert.feature L605) — then why.
        const message =
          `Type-inference was unable to find compatible types for the pair of variables '${constraint.variable}' and its '${attribute}': ` +
          `'${type}' does not own '${attribute}', so ${consequence} ` +
          `Declare \`owns ${attribute}\` on '${type}', or name an attribute it has.`;
        throw attachDiagnostic(
          new Error(message),
          this.diagnostics.error(DiagnosticCode.unownedAttribute, message, range),
        );
      }
    }
  }

  /**
   * Every type an `isa` of this one could involve — **both** directions of the hierarchy.
   *
   * 🔴 Upward alone was wrong, and wrongly refused a valid query. `adr sub doc, owns adr-status`
   * makes `match $d isa doc, has adr-status $s;` legitimate: `isa doc` is satisfied by an `adr`, and
   * the `adr` owns the attribute. Checking only `doc` and its supertypes threw on it —
   * A documentation store's schema has several subtype-owned attributes, so that was live
   * for the corpus this engine targets, not hypothetical.
   *
   * - **Upward** (supertypes), because ownership declared on a parent is inherited: an `adr` owns
   *   `doc-title` without redeclaring it.
   * - **Downward** (subtypes), because `candidates()` resolves `isa` through the subtype closure, so
   *   the thing that matched may own more than the named type does.
   *
   * Refusing only when NOTHING in that closure owns the attribute is the conservative reading, and
   * conservative is the right bias: a false refusal breaks a working query, where a missed one
   * merely leaves the old silence.
   *
   * Cycle-guarded — a malformed `sub` chain would otherwise spin here rather than report anything.
   */
  private typeFamily(type: string, direction: 'both' | 'inherited' = 'both'): string[] {
    const family = new Set<string>([type]);

    let current = this.schema.parents.get(type);
    while (current && !family.has(current)) {
      family.add(current);
      current = this.schema.parents.get(current);
    }
    if (direction === 'inherited') return [...family];

    // Descendants: repeated sweeps, because `parents` is child → parent and a chain may be listed
    // in any order. The type count is small and fixed by `define`.
    let grew = true;
    while (grew) {
      grew = false;
      for (const [child, parent] of this.schema.parents) {
        if (family.has(parent) && !family.has(child)) {
          family.add(child);
          grew = true;
        }
      }
    }
    return [...family];
  }

  /**
   * One thing constraint against one combination: its candidates, each extending the combination.
   * `$x isa $t` with `$t` bound reads the label as the type; unbound, `$t` is bound to each
   * candidate's own type (match.feature L842: `$x isa $y` answers `label:person` per person).
   */
  private bindThing(
    constraint: ThingConstraint,
    combination: Record<string, Binding>,
    relations: readonly ThingConstraint[] = [],
  ): Array<Record<string, Binding>> {
    // Every `isa` whose type is known — written, or a type variable already bound — filters the
    // candidates; the unbound type variables bind afterwards, from the candidate's own type.
    const resolved = resolveIsas(constraint.isas, combination);
    const unbound = resolved.filter((isa) => isa.typeVariable !== undefined && isa.type === undefined);
    // `$x iid 0x20…` names an ATTRIBUTE (ADR-006: its type and value): that one, if it exists and
    // satisfies every `isa`. An attribute owns nothing and plays nothing, so a `has` or a role on it
    // answers nothing.
    const byIid = (constraint.iids ?? []).map(decodeIid).find((d) => d?.kind === 'attribute');
    if (byIid?.kind === 'attribute') {
      const named = (constraint.iids ?? []).map(decodeIid);
      const same = named.every((d) => d?.kind === 'attribute' && d.type === byIid.type && d.value === byIid.value);
      if (!same || constraint.literals.length > 0 || constraint.bindings.length > 0 || constraint.roles.length > 0) return [];
      const binding: ValueBinding = { kind: 'attribute', attributeType: byIid.type, valueType: this.valueTypeOfAttribute(byIid.type) ?? 'string', value: byIid.value };
      const already = combination[constraint.variable];
      if (already !== undefined && !sameConcept(already, binding)) return [];
      return this.bindAttributesThroughTypes(constraint.variable, resolved, unbound, { ...combination, [constraint.variable]: binding });
    }
    // `$a isa $t` with nothing else said of `$a` may be an attribute instance too (ADR-006): `attribute
    // $t; $a isa $t;` answers every stored attribute (insert.feature L276, update.feature L1178).
    // An attribute plays no role in TypeDB 3, so a variable some relation links is a thing.
    const plays = relations.some((relation) => relation.roles.some((role) => role.player === constraint.variable));
    const bare = !plays && constraint.isas.length > 0 && constraint.isas.every((isa) => isa.type === undefined) && constraint.literals.length === 0 && constraint.bindings.length === 0 && constraint.roles.length === 0;
    const attributes = bare ? this.bindAttributesThroughTypes(constraint.variable, resolved, unbound, combination) : [];
    // Already bound — by a `fetch` sub-query's parent: the constraint filters that one thing.
    const bound = combination[constraint.variable];
    if (bound !== undefined && typeof bound !== 'number') return attributes;
    const seed =
      typeof bound === 'number'
        ? { sql: 'SELECT ?', params: [bound] }
        : this.planJoins
          ? this.relationSeed(constraint.variable, relations, combination)
          : undefined;
    const things = this.candidates({ ...constraint, isas: resolved }, seed).flatMap((iid) =>
      unbound.length === 0
        ? [{ ...combination, [constraint.variable]: iid }]
        : this.bindTypeVariables(unbound, iid, { ...combination, [constraint.variable]: iid }),
    );
    return attributes.length === 0 ? things : [...things, ...attributes];
  }

  /**
   * `$a isa $t` over attribute instances: those of the types already bound, and for an unbound `$t`
   * each instance's own type and — for `isa`, not `isa!` — every ancestor, as `bindTypeVariables`
   * does for a thing.
   */
  private bindAttributesThroughTypes(variable: string, resolved: readonly Isa[], unbound: readonly Isa[], combination: Record<string, Binding>): Array<Record<string, Binding>> {
    const where: string[] = [];
    const params: string[] = [];
    for (const isa of resolved) {
      if (isa.type === undefined) continue;
      // A label that is no attribute type admits no attribute — and costs no query.
      if (!this.schema.attributes.has(isa.type)) return [];
      where.push(isa.exact ? 'type = ?' : `type IN ${SUBTYPES_OF}`);
      params.push(isa.type);
    }
    const bound = combination[variable];
    if (bound !== undefined) {
      if (typeof bound !== 'object' || bound.kind !== 'attribute') return [];
      where.push('type = ?', 'value = ?');
      params.push(bound.attributeType, bound.value);
    }
    const rows = this.db.prepare(`SELECT type, value FROM attribute${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`).all(...params) as Array<{ type: string; value: string }>;
    return rows.flatMap((row) => {
      const type = String(row.type);
      const binding: ValueBinding = { kind: 'attribute', attributeType: type, valueType: this.valueTypeOfAttribute(type) ?? 'string', value: String(row.value) };
      let answers: Array<Record<string, Binding>> = [{ ...combination, [variable]: binding }];
      for (const isa of unbound) {
        const typeVariable = isa.typeVariable as string;
        const types = isa.exact ? [type] : this.typeFamily(type, 'inherited');
        answers = answers.flatMap((answer) => {
          const already = answer[typeVariable];
          if (typeof already === 'string') return types.includes(already) ? [answer] : [];
          return types.map((t) => ({ ...answer, [typeVariable]: t }));
        });
      }
      return answers;
    });
  }

  /**
   * Unbound type variables on a thing, bound from its own type: the type itself, and — for `isa`,
   * not `isa!` — every ancestor, so that `$x isa $t` agrees with `$t sub worker; $x isa $t` on what
   * `$t` can be (match.feature L146: each worker answers its own type and every type above it).
   * `typeOfThing` is one SQL round-trip, taken only here (review, round 3).
   */
  private bindTypeVariables(unbound: readonly Isa[], iid: number, combination: Record<string, Binding>): Array<Record<string, Binding>> {
    const own = this.typeOfThing(iid);
    let rows: Array<Record<string, Binding>> = [combination];
    for (const isa of unbound) {
      const variable = isa.typeVariable as string;
      const types = isa.exact ? [own] : [own, ...this.typeFamily(own, 'inherited').filter((t) => t !== own)];
      rows = rows.flatMap((row) => {
        // `$x isa $t; $x isa! $t;` — the second sees the first's binding (review, round 3).
        const already = row[variable];
        if (typeof already === 'string') return types.includes(already) ? [row] : [];
        return types.map((type) => ({ ...row, [variable]: type }));
      });
    }
    return rows;
  }

  /** Candidate row ids per variable, before relation constraints are applied. */
  private candidates(constraint: ThingConstraint, seed?: { sql: string; params: Array<string | number> }): number[] {
    if (this.trace) this.trace.candidatesCalls++;
    const { sql, params } = this.candidateQuery(constraint, seed);
    const found = this.db
      .prepare(sql)
      .all(...params)
      .map((row: unknown) => Number((row as { iid: number }).iid));
    if (this.trace) this.trace.candidateRows += found.length;
    return found;
  }

  /**
   * How many candidates `candidates()` would return, counted by SQLite rather than read into rows.
   *
   * 🔴 For the `noCandidates` fact only, which states counts. It used to call `candidates()` and
   * take `.length` — reading every instance of the type into memory to report one number, on every
   * empty answer. Empty answers are routine (an optional attribute most rows lack is read by its own
   * query), so that was a full read of the type on ordinary reads: 27 ms at 125,000 entities
   * (docs/development/performance.md). `COUNT(*)` still visits the rows, in C, without
   * materialising them.
   */
  private candidateCount(constraint: ThingConstraint): number {
    const { sql, params } = this.candidateQuery(constraint);
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params) as { n: number }).n);
  }

  /** Whether `candidates()` would return anything — it stops at the first row. */
  private hasCandidate(constraint: ThingConstraint): boolean {
    const { sql, params } = this.candidateQuery(constraint);
    return this.db.prepare(`${sql} LIMIT 1`).get(...params) !== undefined;
  }

  /** The SQL `candidates()` runs. */
  private candidateQuery(constraint: ThingConstraint, seed?: { sql: string; params: Array<string | number> }): { sql: string; params: Array<string | number> } {
    const where: string[] = [];
    const params: Array<string | number> = [];

    for (const isa of constraint.isas) {
      if (isa.type === undefined) continue;
      if (isa.exact) {
        // `isa!` — the type alone, no subtypes (match.feature L899).
        where.push('t.type = ?');
      } else {
        // Subtype closure, so `isa doc` also matches `adr` (a documentation store's `entity adr sub doc`).
        where.push(`t.type IN ${SUBTYPES_OF}`);
      }
      params.push(isa.type);
    }
    // 🔴 The same closure on the attribute type: `has name "Alice"` is satisfied by a `first-name`,
    // as `isa doc` is by an `adr`. Exact matching here is what made an attribute subtype a subtype
    // in the schema and nowhere else.
    //
    // 🔴 **One literal drives; the rest are probed.** Each literal used to be its own `t.iid IN
    // (owners of the value)`, and SQLite materialises every such list — so `has project-id "x", has
    // revision "r1"` read every owner of `r1` (thousands) to intersect with the one owner of `x`:
    // 5 ms where 0.017 ms suffices (docs/development/performance.md, finding 5). SQLite cannot tell
    // which list is short without `ANALYZE` statistics, so `literalOrder` asks: a count of each
    // value's owners, stopped at 256, picks the smallest to drive, and every other literal becomes an
    // `EXISTS` on the candidate — two index lookups, `attribute(type, value)` and `has(owner,
    // attribute)`. The rows are the same rows; `ORDER BY t.iid` keeps their order the scan's order
    // whichever literal drives.
    const condition = (literal: ThingConstraint['literals'][number]): { sql: string; params: string[] } | undefined => {
      if (literal.alternatives === undefined) {
        return { sql: `v.type IN ${SUBTYPES_OF} AND v.value = ?`, params: [literal.attribute, literal.value] };
      }
      // An abstract attribute with no value type: one spelling per concrete subtype, or none at all.
      if (literal.alternatives.length === 0) return undefined;
      return {
        sql: `(${literal.alternatives.map(() => '(v.type = ? AND v.value = ?)').join(' OR ')})`,
        params: literal.alternatives.flatMap((alternative) => [alternative.type, alternative.value]),
      };
    };
    const conditions = constraint.literals.map(condition);
    if (conditions.some((c) => c === undefined)) where.push('0');
    const present = conditions.filter((c): c is { sql: string; params: string[] } => c !== undefined);
    const ordered = present.length > 1 ? this.literalOrder(present) : present;
    ordered.forEach((c, index) => {
      where.push(
        index === 0
          ? `t.iid IN (${ownersOfValue(c.sql)})`
          : `EXISTS (SELECT 1 FROM attribute v JOIN has h ON h.attribute = v.id AND h.owner = t.iid WHERE ${c.sql})`,
      );
      params.push(...c.params);
    });
    const probed = ordered.length > 1;
    // `$x iid 0x…` — that one thing, or nothing when the iid names no thing (`iid.ts`).
    for (const iid of constraint.iids ?? []) {
      const decoded = decodeIid(iid);
      if (decoded?.kind !== 'thing') {
        where.push('0');
        continue;
      }
      where.push('t.iid = ?');
      params.push(decoded.id);
    }
    // A variable with a bound attribute must actually own that attribute.
    for (const binding of constraint.bindings) {
      if (binding.attribute === undefined) {
        where.push('EXISTS (SELECT 1 FROM has h WHERE h.owner = t.iid)');
        continue;
      }
      where.push(`EXISTS (SELECT 1 FROM has h WHERE h.owner = t.iid AND h.type IN ${SUBTYPES_OF})`);
      params.push(binding.attribute);
    }

    // Candidates drawn from a relation's role players -- see `relationSeed`. `ORDER BY t.iid` is
    // what the unseeded scan returns anyway (`thing` has no index but its rowid), stated so the
    // seeded plan cannot reorder the rows.
    if (seed !== undefined) {
      where.push(`t.iid IN (${seed.sql})`);
      params.push(...seed.params);
    }
    const sql = `SELECT t.iid FROM thing t${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${seed !== undefined || probed ? ' ORDER BY t.iid' : ''}`;
    return { sql, params };
  }

  /**
   * Literal conditions, the one with the fewest owners first — counted up to 256 each, which is
   * enough to tell a selective value from a broad one and bounds what the asking costs.
   */
  private literalOrder<T extends { sql: string; params: string[] }>(conditions: readonly T[]): T[] {
    const owners = conditions.map((c) =>
      Number((this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM attribute v JOIN has h ON h.attribute = v.id WHERE ${c.sql} LIMIT 256)`).get(...c.params) as { n: number }).n),
    );
    // A stable sort: equally selective literals keep the order they were written in.
    return conditions.map((c, i) => ({ c, n: owners[i] ?? 0, i })).sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.c);
  }


  /**
   * Every assignment of variables to row ids that satisfies the match.
   *
   * Cartesian across the thing variables, in the order they are written, pruned by relation
   * constraints as early as their role players allow: a relation filters the moment every player is
   * bound (`pushDownRelations`), and a role player's candidates come from the relation's
   * `role_player` rows once the other players are bound (`relationSeed`). Neither changes a row or
   * the order of rows -- `planJoins: false` is the original engine, and
   * `relation-join-planning-differential.test.ts` holds the two to the same answers.
   *
   * Still no cost model: the order is the query's order, and a variable no relation reaches is
   * enumerated whole. A real nested-project query was 211,000 combinations and 32 s before
   * this; it is 59 combinations now (`relation-join-planning.test.ts` asserts the counts).
   */
  /**
   * `given $t: string; match $b isa book, has title $t;` — an earlier stage's VALUE (a `given` of a value type,
   * a `let`, a `reduce`) read where an attribute is bound. TypeDB refuses it when it compiles the query:
   * *"The variable 't' cannot be declared as both a 'Value' and as a 'Attribute'."* — the same words as for a
   * `let` that reassigns an attribute (`orderValueStatements`). Without this it matched nothing, and said so
   * only in an `empty-match` fact. `has title == $t` is the form that compares a value.
   *
   * Only a variable with an inferred value type is refused, and never one an earlier stage bound as an
   * attribute (`attributeOf`), which a later `has` joins on: a `given $t: title` is an attribute too.
   */
  private refuseValueAsAttribute(before: StreamScope,constraints: readonly ThingConstraint[], patterns: readonly Pattern[], stageRange: Range | undefined): void {
    const isEarlierValue = (variable: string): boolean =>
      before.kinds.get(variable) === 'value' && before.valueTypes.get(variable) !== undefined && !before.attributeOf.has(variable);
    const refuseAt = (variable: string, range: Range | undefined): void => {
      if (isEarlierValue(variable)) {
        this.refuse(DiagnosticCode.mixedPattern, `The variable '${variable.slice(1)}' cannot be declared as both a 'Value' and as a 'Attribute'.`, range ?? stageRange);
      }
    };
    for (const constraint of constraints) for (const binding of constraint.bindings) refuseAt(binding.variable, binding.range);
    for (const binding of this.nestedAttributeBindings(patterns)) refuseAt(binding.variable, undefined);
  }

  /**
   * What a `match` is refused for WITHOUT a row — a thing or a type as an attribute value, and its
   * `let`s and comparisons (`orderValueStatements`) — and the `let`s in evaluation order. `combinations`
   * calls it per seed; the stage planner calls it once per `match` whether or not rows reach it, so a
   * later stage's refusal does not depend on an earlier one answering anything.
   */
  private matchStatements(
    patterns: readonly Pattern[],
    constraints: readonly ThingConstraint[],
    seedVariables: Iterable<string>,
    seedKind: (variable: string) => 'thing' | 'type' | undefined,
    /**
     * What EARLIER STAGES bound — a `let` reassigning one is TypeDB's "already bound in a previous
     * stage". Only the stage planner knows it: a nested block's seed is its own stage's outer
     * conjunction, where a reassignment is "assigned to multiple times" (expression.feature L124).
     */
    previous: ReadonlySet<string> = new Set(),
  ): ValueStatements {
    // `$p isa person; $q has name $p` — a thing or a type as an attribute value, refused before a
    // single combination exists, so an empty store refuses it too (review, round 12).
    const kindOf = this.conceptKindOf(constraints, patterns);
    for (const constraint of constraints) {
      for (const binding of constraint.bindings) {
        const kind = kindOf(binding.variable);
        if (kind !== undefined) {
          this.refuse(DiagnosticCode.mixedPattern, `'${binding.variable}' is bound as a ${kind} and cannot be an attribute value in \`has ${binding.attribute} ${binding.variable}\`.`, binding.range);
        }
      }
    }
    // Every `let` and comparison is checked before a single combination is evaluated — an unbound
    // operand or a cycle fails a match with no answers too (expression.feature).
    const attributeOf = new Map(constraints.flatMap((c) => c.bindings.map((b) => [b.variable, b.attribute] as const)));
    // `$x isa $t;` alone may be an attribute instance too (`bindThing`), so a comparison may read it:
    // the rows decide, and one binding a thing is dropped (`applyStatements`, match.feature L4878).
    const either = new Set(constraints.filter(isBareTypeIsa).map((c) => c.variable));
    const conceptKind = this.conceptKindOf(constraints, patterns);
    const ownKind = (variable: string): 'thing' | 'type' | undefined => (either.has(variable) ? undefined : conceptKind(variable));
    const statements = orderValueStatements(
      patterns,
      // What a `try` binds may be EMPTY, so the conjunction around it may not read it (expression.feature
      // L137); what every branch of a disjunction binds, it may.
      new Set([...this.conceptVariablesOf(constraints, patterns), ...seedVariables, ...this.nestedBound(patterns.filter(isDisjunctionPattern))]),
      this.refuse,
      (variable) => {
        const own = ownKind(variable);
        if (own !== undefined) return own;
        return seedKind(variable);
      },
      (variable) => {
        const attribute = attributeOf.get(variable);
        return attribute === undefined ? undefined : this.valueTypeOfAttribute(attribute);
      },
      this.schema,
      previous,
    );
    return statements;
  }

  /**
   * `seed` is what is already bound before this match runs — a `fetch` sub-query's parent answer
   * (fetch.feature L1159). Every binding in it stays as it is: a thing variable is a filter, not a
   * fresh enumeration.
   */
  private combinations(pipeline: Segment, seed: Record<string, Binding> = {}): Array<Record<string, Binding>> {
    const patterns = pipeline.match?.patterns ?? [];
    const constraints = this.constraintsOf(patterns);
    const things = constraints.filter((c) => c.roles.length === 0 && c.instance === undefined);
    const relations = constraints.filter((c) => c.roles.length > 0);

    // A variable an earlier `try` left EMPTY satisfies no pattern that uses it directly — this
    // conjunction answers nothing for the row; a nested `try` or `not` reading it decides for itself.
    const uses = [...this.ownBound(patterns), ...patterns.flatMap((p) => (isComparisonPattern(p) ? [p.left, ...variablesOf(p.right)] : isLetPattern(p) ? variablesOf(p.expression) : []))];
    if (uses.some((variable) => variable in seed && seed[variable] === undefined)) return [];

    // Type variables first — they are answered from the schema alone, and a thing pattern's
    // `isa $t` reads the label they bound (Phase 05).
    let combinations = solveTypes(typeConstraintsOf(patterns, this.refuse), this.schema, [seed], this.refuse);
    const note = (stage: string): void => {
      if (!this.trace) return;
      this.trace.stages.push({ stage, combinations: combinations.length });
      this.trace.combinationsCreated += combinations.length;
    };
    note('types');
    // 🔴 A relation constraint is a FILTER that depends only on its role players (and its `isa`
    // type variables), so it can run the moment they are bound instead of after every thing
    // variable is. The combinations it drops are exactly the ones the final filter would drop --
    // a filter keeps order, and the binding order of the thing variables is unchanged -- so the
    // rows are the same rows in the same order. Without this, `$st isa task; $child isa
    // project; $r isa subproject (parent-task: $st, child-project: $child)` was 1,209 x 175
    // combinations, each its own SQL statement, to find nine rows.
    const filtered = new Set<ThingConstraint>();
    const pushDownRelations = (): void => {
      if (!this.planJoins || combinations.length === 0) return;
      const sample = combinations[0] as Record<string, Binding>;
      for (const relation of relations) {
        if (filtered.has(relation) || !this.relationBound(relation, sample)) continue;
        filtered.add(relation);
        combinations = combinations.filter((combination) =>
          this.relationHolds({ ...relation, isas: resolveIsas(relation.isas, combination) }, combination),
        );
        note(`relation ${relation.variable} early filter`);
      }
    };
    pushDownRelations();
    for (const constraint of things) {
      combinations = combinations.flatMap((combination) => this.bindThing(constraint, combination, relations));
      note(`thing ${constraint.variable}`);
      pushDownRelations();
    }
    const statements = this.matchStatements(patterns, constraints, Object.keys(seed), (variable) => {
      const seeded = seed[variable];
      return typeof seeded === 'number' ? 'thing' : typeof seeded === 'string' ? 'type' : undefined;
    });

    // 🔴 A relation **binds** its role players; it does not merely check them.
    //
    // This used to filter the existing combinations and read `combination[player] ?? -1`, so a
    // variable named only inside `links (...)` — never seeded above, because it produces no
    // constraint of its own — joined on a player id of `-1` and matched nothing. The query then
    // answered zero rows at exit code 0, with no diagnostic. Reading a relation to discover who
    // plays its roles is the normal use of one, and it was the case that failed; every existing
    // repository query happens to give each player its own `isa`, which is why the suite was green.
    for (const relation of relations) {
      // `$r isa $t (employee: $x)` — the relation's type through a type variable (review, round 1);
      // every `isa` on it a filter or a binding, as for a thing (round 3).
      const withTypes = (combination: Record<string, Binding>): ThingConstraint => ({ ...relation, isas: resolveIsas(relation.isas, combination) });
      // An anonymous relation that was pushed down has no remaining variables to bind.
      if (filtered.has(relation) && relation.variable.startsWith('__anon')) continue;
      // Bind any remaining role players and named relation variable. A relation already pushed
      // down was only checked, not expanded; named relations still need their ids.
      combinations = combinations.flatMap((combination) =>
        this.relationBindings(withTypes(combination), combination),
      );
      note(`relation ${relation.variable} bind`);
    }

    // 🔴 One combination per attribute VALUE, not per owner. An attribute may hold several values
    // — a task owning two `log-field`s is the live case — and TypeQLite yields a row for
    // each. Until Phase 06 `project()` expanded them; a `let` reads them, so the combination
    // carries them. A variable two patterns bind (`$x has name $n; $y has name $n`) joins on
    // the value.
    for (const constraint of constraints) {
      // `$n isa name "John"` — an attribute instance, read from `attribute`, not through an owner.
      const instance = constraint.instance;
      if (instance !== undefined) {
        combinations = combinations.flatMap((combination) => this.bindAttributeInstance(instance, combination));
        note(`attribute ${instance.variable}`);
        continue;
      }
      for (const binding of constraint.bindings) {
        combinations = combinations.flatMap((combination) => {
          const owner = combination[constraint.variable];
          if (typeof owner !== 'number') return [combination];
          const already = combination[binding.variable];
          return this.readAttributes(owner, binding.attribute).flatMap((value) => {
            const bound: ValueBinding = { kind: 'attribute', attributeType: value.type, valueType: this.valueTypeOfAttribute(value.type) ?? 'string', value: value.value };
            if (already !== undefined) {
              // A thing or a type here was refused above, before any combination (rounds 9, 12).
              if (typeof already !== 'object') return [];
              // One variable is ONE attribute instance: a `name` and a `nick` of the same text
              // are two, and `has name $n; … has nick $n` answers nothing (review, round 2).
              return already.kind === 'attribute' && already.attributeType === bound.attributeType && already.value === bound.value
                ? [combination]
                : [];
            }
            return [{ ...combination, [binding.variable]: bound }];
          });
        });
      }
    }
    // `let`s and comparisons whose inputs the concepts already bind run BEFORE the nested blocks, so a
    // block can read them (`let $x = 1; { $x < 5; } or { … };` — variables.feature L126); the rest
    // read what a block binds, and run after it.
    const ready = new Set([...this.conceptVariablesOf(constraints, patterns), ...Object.keys(seed)]);
    const early = { lets: [] as LetPattern[], comparisons: [] as ComparisonPattern[] };
    const late = { lets: [] as LetPattern[], comparisons: [] as ComparisonPattern[] };
    for (const statement of statements.lets) {
      const isReady = variablesOf(statement.expression).every((variable) => ready.has(variable));
      (isReady ? early : late).lets.push(statement);
      if (isReady) for (const variable of letVariables(statement)) ready.add(variable);
    }
    for (const comparison of statements.comparisons) {
      ([comparison.left, ...variablesOf(comparison.right)].every((variable) => ready.has(variable)) ? early : late).comparisons.push(comparison);
    }
    const either = new Set(constraints.filter(isBareTypeIsa).map((c) => c.variable));
    combinations = this.applyStatements(early, combinations, either);
    // Nested blocks that EXTEND an answer, each a sub-match seeded with it: every branch of a
    // disjunction answers its own extensions (disjunction.feature L38), and a `try` extends the
    // answer when it matches and keeps it unextended when it does not (optional.feature L66).
    for (const pattern of patterns) {
      if (isDisjunctionPattern(pattern)) {
        // 🔴 A match answers a SET: a row both branches produce is one answer, not two
        // (variables.feature L126 — `{ $x < 5; } or { $a < 15; }` with both true answers once). What
        // only some branches bind is local to them and dropped first, so it cannot keep two copies apart.
        const common = new Set(this.nestedBound([pattern]));
        const local = new Set(pattern.branches.flatMap((branch) => [...this.boundBy(this.segmentFor(branch, branch.patterns).match?.patterns ?? [])]).filter((v) => !common.has(v)));
        const seen = new Set<string>();
        combinations = combinations.flatMap((row) =>
          pattern.branches.flatMap((branch) => this.combinations(this.segmentFor(branch, branch.patterns), row)).flatMap((answer) => {
            const kept = Object.fromEntries(Object.entries(answer).filter(([variable]) => !local.has(variable) || variable in row));
            const key = rowKeyOf(kept);
            if (seen.has(key)) return [];
            seen.add(key);
            return [kept];
          }),
        );
        note('disjunction');
      } else if (isOptionalPattern(pattern)) {
        const segment = this.segmentFor(pattern, pattern.patterns);
        const introduced = [...this.boundBy(segment.match?.patterns ?? [])];
        combinations = combinations.flatMap((row) => {
          const extended = this.combinations(segment, row);
          if (extended.length > 0) return extended;
          // 🔴 Unmatched, its variables are EMPTY — present and unbound — not absent: a later stage
          // that uses one directly answers nothing for this row, where an absent one would be read as
          // a fresh variable and enumerated (optional.feature L207).
          const empty: Record<string, Binding> = { ...row };
          for (const variable of introduced) if (!(variable in row)) (empty as Record<string, Binding | undefined>)[variable] = undefined;
          return [empty];
        });
        note('optional');
      }
    }
    combinations = this.applyStatements(late, combinations, either);
    // Then the FILTERS, last, so everything they read is bound: `$x is $y` holds when both are the
    // one concept (binding one from the other when only one is bound), and `not { … }` keeps the
    // answer only if its block, seeded with it, matches nothing (negation.feature).
    for (const pattern of patterns) {
      if (isIsPattern(pattern)) {
        combinations = combinations.flatMap((row) => {
          const [left, right] = [row[pattern.left], row[pattern.right]];
          if (left === undefined && right === undefined) return [];
          if (left === undefined) return [{ ...row, [pattern.left]: right as Binding }];
          if (right === undefined) return [{ ...row, [pattern.right]: left }];
          return sameConcept(left, right) ? [row] : [];
        });
      } else if (isNegationPattern(pattern)) {
        const segment = this.segmentFor(pattern, pattern.patterns);
        combinations = combinations.filter((row) => this.combinations(segment, row).length === 0);
        note('negation');
      }
    }
    return combinations;
  }

  /**
   * 🔴 Everything a write stage can be refused for WITHOUT data, checked before the match runs —
   * so an empty match does not turn a refusal into `emptyMatch` at exit 0 (review, rounds 11 and
   * 14): a `let` or comparison in the stage, a literal the attribute cannot hold, a value nothing
   * binds, a bound value whose inferred type the attribute cannot hold, and a `delete $v of $p`
   * whose `$v` is not an attribute the match bound. `runInsert` repeats the literal checks per
   * combination; this is the pass that does not depend on there being one.
   */
  /**
   * `scope` is what the stages before this write leave bound — every earlier `match`'s patterns, and
   * the variables and their kinds (a pipeline streams: `match …; insert $x …; insert $x has …;`).
   */
  private checkWriteStage(scope: StreamScope, write: WriteStage): void {
    const matchPatterns = scope.patterns;
    const matchConstraints = this.constraintsOf(matchPatterns);
    const attributeOf = new Map(matchConstraints.flatMap((c) => c.bindings.map((b) => [b.variable, b.attribute] as const)));
    const lets = new Map(matchPatterns.filter(isLetPattern).map((p) => [p.variable, p.expression] as const));
    const matchBinds = new Set([...this.conceptVariablesOf(matchConstraints, matchPatterns), ...lets.keys(), ...scope.available]);
    const typeOfVariable = (variable: string, seen: ReadonlySet<string> = new Set()): string | undefined => {
      const attribute = attributeOf.get(variable);
      if (attribute !== undefined) return this.valueTypeOfAttribute(attribute);
      const expression = lets.get(variable);
      if (expression === undefined || seen.has(variable)) return undefined;
      return inferValueType(expression, (v) => typeOfVariable(v, new Set([...seen, variable])));
    };
    const ownKind = this.conceptKindOf(matchConstraints, matchPatterns);
    const kindOf = (variable: string): 'thing' | 'type' | undefined => {
      const kind = ownKind(variable) ?? scope.kinds.get(variable);
      return kind === 'value' ? undefined : kind;
    };
    if (write.$type === 'DeleteStage') {
      // An optional variable is deleted only inside `try` (delete.feature L2929).
      for (const deletion of write.deletions) {
        if (deletion.optional) continue;
        const used = [deletion.target, deletion.owner, ...(deletion.players?.entries.map((e) => e.player) ?? [])].find((v) => v !== undefined && scope.optional.has(v));
        if (used !== undefined) this.refuse(DiagnosticCode.unboundValue, `A write stage uses the optional variable '${used.slice(1)}' outside a 'try' block.`, rangeOf(deletion));
      }
      for (const deletion of openDeletions(write.deletions, this.refuse)) {
        // `delete has $_ of $_` deletes nothing anyone named (delete.feature L2791).
        if ([deletion.target, deletion.owner].some((v) => v !== undefined && isAnonymous(v))) {
          this.refuse(DiagnosticCode.mixedPattern, 'A delete names what it deletes: an anonymous variable `$_` cannot be deleted, or deleted from.', rangeOf(deletion));
        }
        // `delete links (friend: $x) of $r` — a relation the match bound, and things playing in it.
        if (deletion.links) {
          if (kindOf(deletion.owner as string) !== 'thing') {
            this.refuse(DiagnosticCode.mixedPattern, `'${deletion.owner}' is not a relation the \`match\` bound; \`delete links … of ${deletion.owner}\` has nothing to remove from.`, rangeOf(deletion));
          }
          // TypeDB's annotation check of the write, read off 3.10.4 (delete.feature L511, L793, L909,
          // L947): no relation/player type pair that fits is "unable to find compatible types"; a
          // relation type the match allows that cannot hold the role — `$e isa employment` may be an
          // `internship`, which specialised `employee` into `intern` — is "Left type … not compatible".
          const typesOf = (variable: string): string[] | undefined => {
            const isas = matchConstraints.find((c) => c.variable === variable)?.isas.filter((isa) => isa.type !== undefined) ?? [];
            if (isas.length === 0) return undefined;
            return [...new Set(isas.flatMap((isa) => (isa.exact ? [isa.type as string] : this.subtypesOf(isa.type as string))))].filter((t) => !this.schema.abstracts.has(t));
          };
          // The match narrows them: `$e isa employment, links (intern: $p)` is an internship — a type
          // must reach every role the match links on it, a specialised one included (L538).
          const matchedRoles = (matchConstraints.find((c) => c.variable === deletion.owner)?.roles ?? []).flatMap((r) => (r.role === undefined ? [] : [r.role]));
          const relationTypes = typesOf(deletion.owner as string)?.filter((type) => matchedRoles.every((role) => this.unspecialisedRole(type, role) !== undefined));
          for (const entry of deletion.players?.entries ?? []) {
            if (entry.role === undefined || relationTypes === undefined) continue;
            const roles = relationTypes.map((type) => ({ type, role: this.unspecialisedRole(type, entry.role as string) }));
            const playerTypes = typesOf(entry.player);
            if (playerTypes !== undefined) {
              const fits = roles.some(({ role }) => role?.live === true && playerTypes.some((p) => this.typeFamily(p, 'inherited').some((t) => this.schema.plays.has(playsSubject(t, role.role)))));
              if (!fits) {
                this.refuse(DiagnosticCode.unknownRole, `Type-inference was unable to find compatible types for the pair of variables '${entry.player.slice(1)}' & '${(deletion.owner as string).slice(1)}' across a 'links' constraint.`, rangeOf(deletion));
              }
            }
            const declaredAnywhere = [...this.schema.roles].find(([, names]) => names.has(entry.role as string))?.[0];
            for (const { type, role } of roles) {
              if (role?.live === true) continue;
              const right = role?.role ?? (declaredAnywhere === undefined ? entry.role : roleRef(declaredAnywhere, entry.role));
              this.refuse(DiagnosticCode.unknownRole, `Left type '${type}' across constraint 'links' is not compatible with right type '${right}'.`, rangeOf(deletion));
            }
          }
          for (const entry of deletion.players?.entries ?? []) {
            // `links ($role: $x)` — the role the match bound `$role` to (delete.feature L998).
            if (entry.roleVariable !== undefined && kindOf(entry.roleVariable) !== 'type') {
              this.refuse(DiagnosticCode.mixedPattern, `'${entry.roleVariable}' is not a role type the \`match\` bound; it names no role to remove.`, rangeOf(deletion));
            }
            if (kindOf(entry.player) !== 'thing') {
              this.refuse(DiagnosticCode.mixedPattern, `'${entry.player}' is not a thing the \`match\` bound; it plays no role to remove.`, rangeOf(deletion));
            }
          }
          continue;
        }
        const target = deletion.target as string;
        if (deletion.owner !== undefined) {
          this.checkDeletedOwnership(deletion.owner, target, matchConstraints, rangeOf(deletion));
          if (!attributeOf.has(target) && !scope.attributeOf.has(target)) {
            this.refuse(DiagnosticCode.mixedPattern, `'${target}' is not an attribute the \`match\` bound with \`has <attribute> ${target}\`; \`delete ${target} of ${deletion.owner}\` has nothing to remove.`, rangeOf(deletion));
          }
          // The owner is a thing the match bound — not a type, a value, or nothing (QA, F).
          if (kindOf(deletion.owner) !== 'thing') {
            this.refuse(DiagnosticCode.mixedPattern, `'${deletion.owner}' is not a thing the \`match\` bound; \`delete ${deletion.target} of ${deletion.owner}\` has no owner to remove from.`, rangeOf(deletion));
          }
        } else if (kindOf(target) !== 'thing' && !attributeOf.has(target) && !scope.attributeOf.has(target)) {
          // `delete $v` of a value, a type, or nothing at all (QA, F). An attribute the match bound is
          // deleted, with every ownership of it (ADR-006, delete.feature L162 and L1019).
          this.refuse(DiagnosticCode.mixedPattern, `'${deletion.target}' is not a thing the \`match\` bound; \`delete ${deletion.target}\` has nothing to remove.`, rangeOf(deletion));
        }
      }
      return;
    }
    // The type each write variable already has from the match — `$c isa company` — so ownership
    // is checked before the match runs (QA, A6).
    // EVERY written `isa` of the variable, not the last (review, round 20): `isa! memo, isa doc`
    // is refused by the `isa!` whichever comes first.
    const matchIsasOf = new Map(matchConstraints.map((c) => [c.variable, c.isas.filter((isa) => isa.type !== undefined)] as const));
    this.checkOptionalUse(write.patterns, scope);
    // An attribute the write itself inserts is bound for the rest of it, whatever the order the
    // statements are written in: `insert $p isa person, has name $n; $n isa name "Ann";`.
    for (const pattern of writtenPatterns(write.patterns, this.refuse)) {
      if (!isThingPattern(pattern)) continue;
      const instance = this.attributeInstanceOf(pattern, 'write')?.instance;
      if (instance === undefined) continue;
      matchBinds.add(instance.variable);
      attributeOf.set(instance.variable, instance.type);
    }
    const stageName = write.$type === 'PutStage' ? 'put' : 'insert';
    for (const pattern of writtenPatterns(write.patterns, this.refuse)) {
      if (isLetPattern(pattern) || isComparisonPattern(pattern) || isCallComparisonPattern(pattern)) {
        this.refuse(DiagnosticCode.mixedPattern, 'A `let` or a comparison belongs to a `match`, not to a write stage.', rangeOf(pattern));
      }
      // A write states what it writes: `not`, `or` and `is` constrain a match, and an insert would
      // otherwise pass over them without a word. (`try` is a write's own — `writtenPatterns`.)
      if (isNegationPattern(pattern) || isDisjunctionPattern(pattern) || isIsPattern(pattern)) {
        this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not write through `not`, `or` or `is`; they constrain a `match`.', rangeOf(pattern));
      }
      // `insert $x isa $p; ($rt: $x) isa $r;` — a type or a role through a variable, which an earlier
      // stage must have bound to a type (insert.feature L2140); unbound, nothing names what to write
      // (L2178). Each row writes the type it bound — `concreteWrite`.
      for (const variable of typeVariablesWritten(pattern)) {
        if (kindOf(variable) !== 'type') {
          this.refuse(DiagnosticCode.unboundValue, `The type variable '${variable.slice(1)}' is not bound to a type by an earlier stage, so the write has no type to write.`, rangeOf(pattern));
        }
      }
      // `put $p has age 10;` — no `isa`, and nothing before binds `$p`: there is no thing to give it
      // to (put.feature L588). Statements about one variable are merged, so an `isa` anywhere counts.
      const insertedHere = writtenPatterns(write.patterns, this.refuse).some((p) => isThingPattern(p) && p.variable === (pattern as ThingPattern).variable && p.properties.some(isIsaProperty));
      if (isThingPattern(pattern) && !isTypeHead(pattern, this.refuse) && !insertedHere && !matchBinds.has(pattern.variable) && !scope.optional.has(pattern.variable)) {
        const links = pattern.properties.some(isLinksProperty);
        this.refuse(
          links ? DiagnosticCode.danglingRelation : DiagnosticCode.unboundValue,
          `${links ? 'Refusing a dangling relation: ' : ''}the variable '${pattern.variable.slice(1)}' is neither bound by an earlier stage nor inserted here. Ensure the variable is available from a previous stage or is inserted in this stage.`,
          rangeOf(pattern),
        );
      }
      // The literal checks — kind, spelling, range — run here as they do per combination.
      const [constraint] = this.constraintsOf([pattern], 'write');
      if (!isThingPattern(pattern)) continue;
      if (constraint !== undefined) {
        // An abstract attribute has no values of its own (QA, A5), and the match's type owns what
        // the write names (A6) — both before any combination.
        for (const named of [...constraint.literals, ...constraint.bindings]) {
          if (named.attribute !== undefined && this.schema.abstracts.has(named.attribute)) {
            this.refuse(DiagnosticCode.abstractType, `'${named.attribute}' is abstract and cannot have a value of its own. Write a concrete subtype.`, named.range);
          }
        }
        // The match's `isa doc` may bind an `adr`, and `adr` owns what `doc` does not — so the
        // static pass refuses only when NOTHING in the type's closure owns the attribute; which
        // concrete type the match bound is the per-combination check's (review, round 18). An
        // `isa!` binds the one type, and that type's own closure decides here (round 19).
        // A `given` thing is inferred as its DECLARED type, not as the thing passed: `given $p: animal;
        // insert $p has age 12;` is refused though the person passed owns `age` (given.feature L346).
        const declared = constraint.type === undefined ? scope.declared?.get(constraint.variable) : undefined;
        if (declared !== undefined) {
          const family = this.typeFamily(declared, 'inherited');
          for (const named of [...constraint.literals, ...constraint.bindings]) {
            if (named.attribute === undefined || family.some((t) => this.schema.owns.has(ownsKey(t, named.attribute as string)))) continue;
            this.refuse(DiagnosticCode.unownedAttribute, `Left type '${declared}' across constraint 'has' is not compatible with right type '${named.attribute}'.`, named.range);
          }
        }
        // A match variable with no `isa` is every type that can own what it `has`: `match $p has name
        // $_;` may be a company, which owns no `first-name`, so `insert $p has first-name …` is refused
        // before any row (insert.feature L560) — each such type must own what the write adds.
        if (constraint.type === undefined && declared === undefined && (matchIsasOf.get(constraint.variable) ?? []).length === 0) {
          const matched = matchConstraints.find((c) => c.variable === constraint.variable);
          // `$p isa $pt; $pt owns first-name` narrows it through a type variable — left to the rows (L567).
          const owned = matched === undefined || matched.isas.length > 0 ? [] : [...matched.literals, ...matched.bindings].flatMap((n) => (n.attribute === undefined ? [] : [n.attribute]));
          if (owned.length > 0) {
            const owners = [...this.schema.types].filter((t) => !this.schema.abstracts.has(t) && owned.every((a) => this.subtypesOf(a).some((sub) => this.typeFamily(t, 'inherited').some((up) => this.schema.owns.has(ownsKey(up, sub))))));
            for (const type of owners) {
              const family = this.typeFamily(type, 'inherited');
              for (const named of [...constraint.literals, ...constraint.bindings]) {
                if (named.attribute === undefined || family.some((t) => this.schema.owns.has(ownsKey(t, named.attribute as string)))) continue;
                this.refuse(DiagnosticCode.unownedAttribute, `Left type '${type}' across constraint 'has' is not compatible with right type '${named.attribute}'.`, named.range);
              }
            }
          }
        }
        if (constraint.type === undefined) {
          for (const isa of matchIsasOf.get(constraint.variable) ?? []) {
            const type = isa.type as string;
            this.checkOwns({ ...constraint, type, isas: [{ type, exact: false }] }, isa.exact ? 'write' : 'match');
          }
        }
      }
      // `insert $_ isa name == $v` — the attribute's value is the one `$v` holds.
      const read = constraint?.instance?.valueVariable;
      if (read !== undefined && constraint?.instance !== undefined) {
        if (!matchBinds.has(read)) {
          this.refuse(DiagnosticCode.unboundValue, unboundInWrite(read), constraint.instance.range);
        }
        const from = typeOfVariable(read);
        if (from !== undefined) this.checkValueFits(read, from, constraint.instance.type, constraint.instance.range);
      }
      for (const property of pattern.properties) {
        if (!isHasProperty(property)) continue;
        // `has age (10 + 5)` — an expression where a write takes a value (put.feature L610).
        if (property.expression !== undefined) {
          this.refuse(DiagnosticCode.mixedPattern, `Illegal statement 'expression' provided for a ${stageName} stage. Only 'has', 'links' and 'isa' constraints are allowed.`, rangeOf(property));
        }
        // `has age $v`, or `has age == $v` — the write reads `$v`.
        const variable = property.valueVariable ?? (property.comparator === '==' && property.compared !== undefined && isVariableExpression(property.compared) ? property.compared.variable : undefined);
        if (variable === undefined) continue;
        if (!matchBinds.has(variable)) {
          // `has name $_` names the attribute and no value for it — TypeDB's words (insert.feature L2761).
          const message = isAnonymous(variable) && property.attribute !== undefined
            ? `Could not determine the value of the insert attribute '${property.attribute}': an anonymous variable \`$_\` holds no value.`
            : unboundInWrite(variable);
          this.refuse(DiagnosticCode.unboundValue, message, rangeOf(property));
        }
        // An ATTRIBUTE variable is written as itself, so its type must be the one named, or below it:
        // `has ref $age` with `$age isa age 10` has no type both can be (insert.feature L235).
        // `has age == $v` writes $v's VALUE, whatever holds it (L2884).
        const attributeType = property.valueVariable === undefined ? undefined : (attributeOf.get(variable) ?? scope.attributeOf.get(variable));
        if (attributeType !== undefined && property.attribute !== undefined && !this.typeFamily(attributeType, 'inherited').includes(property.attribute)) {
          this.refuse(DiagnosticCode.valueTypeConflict, `Type-inference was unable to find compatible types for the pair of variables: '${variable}' is a '${attributeType}', and \`has ${property.attribute}\` writes a '${property.attribute}'.`, rangeOf(property));
        }
        const from = typeOfVariable(variable);
        if (from !== undefined && property.attribute !== undefined) this.checkValueFits(variable, from, property.attribute, rangeOf(property));
      }
    }
  }

  /** A value of type `from` may be written to `attribute`: the same type, or an integer to a double or decimal. */
  private checkValueFits(variable: string, from: string, attribute: string, at: Range | undefined): void {
    const normalise = (t: string): string => (t === 'long' ? 'integer' : t);
    const declared = this.valueTypeOfAttribute(attribute);
    if (declared === undefined) return;
    const to = normalise(declared);
    // A date is a datetime at midnight — `let $x = 2020-01-01; insert $a isa published-date == $x;`
    // (insert.feature L1288).
    const fits = normalise(from) === to || (normalise(from) === 'integer' && (to === 'double' || to === 'decimal')) || (normalise(from) === 'date' && to === 'datetime');
    if (!fits) {
      this.refuse(DiagnosticCode.valueTypeConflict, `'${variable}' is a ${normalise(from)} and '${attribute}' holds a ${to}; the value cannot be written.`, at);
    }
  }

  /** Whether a variable is a thing or a type in this match — neither is a value an expression or a reducer can take. */
  private conceptKindOf(constraints: readonly ThingConstraint[], patterns: readonly Pattern[]): (variable: string) => 'thing' | 'type' | undefined {
    const typeVariables = new Set([
      ...this.conceptVariablesOf([], patterns),
      ...constraints.flatMap((c) => c.isas.flatMap((isa) => (isa.typeVariable === undefined ? [] : [isa.typeVariable]))),
      ...constraints.flatMap((c) => c.roles.flatMap((r) => (r.roleVariable === undefined ? [] : [r.roleVariable]))),
    ]);
    // `$y iid 0x…` alone says nothing of the kind: an iid may name an attribute (match.feature L4016,
    // `$x has name $y; $y iid …`).
    const onlyIid = (c: ThingConstraint): boolean =>
      (c.iids?.length ?? 0) > 0 && c.isas.length === 0 && c.literals.length === 0 && c.bindings.length === 0 && c.roles.length === 0;
    const thingVariables = new Set(constraints.flatMap((c) => [...(onlyIid(c) ? [] : [c.variable]), ...c.roles.map((r) => r.player)]));
    return (variable) => (thingVariables.has(variable) ? 'thing' : typeVariables.has(variable) ? 'type' : undefined);
  }

  /** Every variable the match's concept patterns bind — a `let` may not reuse one, and may read one. */
  private conceptVariablesOf(constraints: readonly ThingConstraint[], patterns: readonly Pattern[]): Set<string> {
    return new Set([
      ...constraints.flatMap((c) => [
        c.variable,
        ...c.isas.flatMap((isa) => (isa.typeVariable === undefined ? [] : [isa.typeVariable])),
        ...c.bindings.map((b) => b.variable),
        ...c.roles.map((r) => r.player),
        ...c.roles.flatMap((r) => (r.roleVariable === undefined ? [] : [r.roleVariable])),
      ]),
      ...typeConstraintsOf(patterns, this.refuse).flatMap((t) => [
        t.variable,
        ...t.subs.flatMap((o) => (o.variable === undefined ? [] : [o.variable])),
        ...t.owns.flatMap((o) => (o.variable === undefined ? [] : [o.variable])),
        ...t.plays.flatMap((o) => (o.variable === undefined ? [] : [o.variable])),
        ...t.relates.flatMap((o) => [o.variable, o.asVariable].filter((v): v is string => v !== undefined)),
      ]),
    ]);
  }

  /** The value type an attribute type carries, through its parent chain — `string` when unknown. */
  private valueTypeOfAttribute(attribute: string): string | undefined {
    let current: string | undefined = attribute;
    while (current !== undefined) {
      const valueType = this.schema.valueTypes.get(current);
      if (valueType !== undefined) return valueType;
      current = this.schema.parents.get(current);
    }
    // An abstract attribute with no value type anywhere in its chain — the schema admits one —
    // has NO type to check against; `undefined` leaves every static check to evaluation, where
    // the cells carry their real types (review, round 15). It used to be `'string'`, and every
    // pre-data check ran against a fabricated type.
    return undefined;
  }

  /**
   * Is everything `relationHolds` reads already bound -- every role player a thing, every `isa`
   * type variable a label? Then the filter answers now exactly what it would answer at the end.
   */
  private relationBound(relation: ThingConstraint, combination: Record<string, Binding>): boolean {
    if (!relation.roles.every((role) => typeof combination[role.player] === 'number')) return false;
    return relation.isas.every(
      (isa) => isa.type !== undefined || isa.typeVariable === undefined || typeof combination[isa.typeVariable] === 'string',
    );
  }

  /**
   * Candidates for `variable` drawn from a relation it plays in, once that relation's OTHER role
   * players are bound: the players of that role among the relation instances the bound players
   * already select. A relation instance is a handful of `role_player` rows, where `thing` is every
   * entity of every type.
   *
   * Only ever narrows: `candidates()` still applies the variable's own `isa`, literals and
   * bindings, and the relation filter still runs once the variable is bound. So a seed that is too
   * wide costs time and a seed that is absent costs nothing -- neither changes a row. The seed
   * mirrors `relationBindings` (same role spelling, same type match, a variable in two roles must be
   * the same player in both) and is `undefined` whenever it cannot be built that way.
   */
  private relationSeed(
    variable: string,
    relations: readonly ThingConstraint[],
    combination: Record<string, Binding>,
    // 🔴 Relations already on the path, and how deep it is — see the nested seed below.
    path: ReadonlySet<ThingConstraint> = new Set(),
  ): { sql: string; params: Array<string | number> } | undefined {
    // 🔴 Two passes: a relation whose other players are all bound first, exactly as before nesting
    // existed, and only then one reached through a nested seed. Taking the first relation in written
    // order that could seed either way chose a nested seed over a later direct one: `$c` drawn from
    // the 50 two-hop neighbours of `$a` instead of its one direct partner (review of finding 6). A
    // nested seed may only add a seed where there was none, never replace a better one.
    for (const nesting of [false, true]) {
      for (const relation of relations) {
        if (path.has(relation)) continue;
        const mine = relation.roles.filter((role) => role.player === variable);
        if (mine.length === 0) continue;
        const others = relation.roles.filter((role) => role.player !== variable);
        const allBound = others.every((role) => typeof combination[role.player] === 'number');
        if (nesting === allBound) continue;
        // 🔴 An unbound other player may still be SEEDABLE through another relation from players that
        // are bound — `$a` pinned, `(dependent: $a, prerequisite: $b) …; (dependent: $b, prerequisite:
        // $c) …` with `$b` untyped. `$b` has no constraint of its own, so it is bound only when the
        // relations bind, after every thing variable; without this, `$c` was enumerated whole —
        // 21,000 candidates and 42,000 statements to answer one row (docs/development/performance.md,
        // finding 6). Nesting `$b`'s own seed keeps the guarantee above: it is a necessary condition on
        // `$c`, so it only narrows, and the enumeration order of `$c` is unchanged. Three relations
        // deep at most, and never back through one already on the path.
        const nested = new Map<string, { sql: string; params: Array<string | number> }>();
        if (nesting && path.size < 3) {
          for (const role of others) {
            if (typeof combination[role.player] === 'number' || nested.has(role.player)) continue;
            const inner = this.relationSeed(role.player, relations, combination, new Set([...path, relation]));
            if (inner !== undefined) nested.set(role.player, inner);
          }
        }
        if (!others.every((role) => typeof combination[role.player] === 'number' || nested.has(role.player))) continue;

        const resolved = resolveIsas(relation.isas, combination);
        const params: Array<string | number> = [];
        const joins: string[] = [];
        // A roleless slot (`($p)`) joins on any role (optional.feature L46).
        const roleOf = (alias: string, role: string | undefined): string => (role === undefined ? '' : this.roleFilter(alias, role, params));
        mine.forEach((role, index) => {
          joins.push(
            index === 0
              ? `JOIN role_player rv0 ON rv0.rel = t.iid${roleOf('rv0', role.role)}`
              : `JOIN role_player rv${index} ON rv${index}.rel = t.iid${roleOf(`rv${index}`, role.role)} AND rv${index}.player = rv0.player`,
          );
        });
        others.forEach((role, index) => {
          const bound = combination[role.player];
          const inner = nested.get(role.player);
          if (typeof bound === 'number' || inner === undefined) {
            joins.push(`JOIN role_player ro${index} ON ro${index}.rel = t.iid${roleOf(`ro${index}`, role.role)} AND ro${index}.player = ?`);
            params.push(bound as number);
            return;
          }
          // `roleOf` pushes its parameters as the string is built, so the subquery's go after them.
          joins.push(`JOIN role_player ro${index} ON ro${index}.rel = t.iid${roleOf(`ro${index}`, role.role)} AND ro${index}.player IN (${inner.sql})`);
          params.push(...inner.params);
        });
        const typed: string[] = [];
        for (const isa of resolved) {
          if (isa.type === undefined) continue;
          typed.push(isa.exact ? 't.type = ?' : `t.type IN ${SUBTYPES_OF}`);
          params.push(isa.type);
        }
        const where = typed.length > 0 ? ` WHERE ${typed.join(' AND ')}` : '';
        return { sql: `SELECT rv0.player FROM thing t ${joins.join(' ')}${where}`, params };
      }
    }
    return undefined;
  }

  /**
   * A role in `links (…)` matches the role and every role that specialises it, at any depth:
   * `(spouse: $x)` finds a `husband` of a `hetero-marriage` (match.feature L1484). `role_player`
   * holds role NAMES, so the family is a set of names; the relation's own `isa` keeps it honest.
   */
  private roleFilter(alias: string, role: string, params: Array<string | number>): string {
    const family = new Set([role]);
    for (const [child] of this.schema.specialises) {
      let current: string | undefined = child;
      while (current !== undefined) {
        if (current.split(':')[1] === role) {
          family.add(child.split(':')[1]);
          break;
        }
        current = this.schema.specialises.get(current);
      }
    }
    params.push(...family);
    return family.size === 1 ? ` AND ${alias}.role = ?` : ` AND ${alias}.role IN (${[...family].map(() => '?').join(', ')})`;
  }

  /**
   * Every way `combination` can be extended so this relation holds — reading role players it does
   * not already know and applying the relation's own attribute constraints, then (Phase 05)
   * resolving an unbound type variable on the relation's own `isa` from each match found.
   *
   * Roles whose player is already bound constrain the join; roles whose player is not are read out
   * of it and bound. Returning a list rather than one row is what makes a partially-constrained
   * relation work — pinning one end and leaving the other free yields a row per link, where the
   * removed `findRelation`'s trailing `[0]` silently kept the first.
   */
  private relationBindings(
    relation: ThingConstraint,
    combination: Record<string, Binding>,
    // Only whether there is ANY way: stop at the first row instead of reading them all. For the callers
    // that ask `.length > 0`, where a relation type with many instances would otherwise be read whole.
    existenceOnly = false,
  ): Array<Record<string, Binding>> {
    if (this.trace) this.trace.findRelationsCalls++;
    const params: Array<string | number> = [];
    // The most recent role each variable played, so a repeat joins to it instead of rebinding.
    // Chained rather than all-to-first, which is equivalent: the equalities are transitive.
    const seenAtRole = new Map<string, number>();
    // Every slot already emitted, keyed by the STATEMENT it was written in plus the role name —
    // the mirror case below needs all of them, and must not reach across merged statements.
    const sameRoleSlots = new Map<string, Array<[number, string]>>();
    const statementSlots = new Map<number, Array<[number, string, string | undefined]>>();
    const joins = relation.roles
      .map((role, index) => {
        const player = combination[role.player];
        const boundPlayer = typeof player === 'number' ? player : undefined;
        // A roleless slot (`($p, $c)`) joins on any role (optional.feature L46).
        let join = `JOIN role_player rp${index} ON rp${index}.rel = t.iid`;
        if (role.role !== undefined) join += this.roleFilter(`rp${index}`, role.role, params);

        // 🔴 One variable in two roles must be the SAME thing in both.
        //
        // `links (source: $x, target: $x)` was joined as two independent free roles and then bound
        // twice, last one winning — so an a→b link answered a query for a self-link. That is a
        // false positive, which this method's own comment rates worse than the zero-row class it
        // was written to close.
        const earlier = seenAtRole.get(role.player);
        if (earlier !== undefined) {
          join += ` AND rp${index}.player = rp${earlier}.player`;
        } else if (boundPlayer !== undefined) {
          join += ` AND rp${index}.player = ?`;
          params.push(boundPlayer);
        }
        seenAtRole.set(role.player, index);
        // `$l links (member: $l)` — the relation playing in ITSELF, not any loop with some member
        // (match.feature L5298; TypeDB 3.10.4 itself answers every loop here, against its own spec).
        if (role.player === relation.variable) join += ` AND rp${index}.player = t.iid`;

        // 🔴 …and two slots of the same ROLE need two different players — the mirror case.
        //
        // `links (source: $x, source: $y)` asks for a link with two sources; both joins were free
        // to match the same `role_player` row, so a link with ONE source answered it with `$x` and
        // `$y` bound to that single player. `PRIMARY KEY (rel, role, player)` makes an edge unique
        // per player, so distinct edges is distinct players here.
        //
        // ✅ Verified against real TypeDB 3, 2026-09-10: the same query against a one-source link
        // answers zero rows there too.
        //
        // ⚠️ Against every earlier slot, not just the previous one — inequality is not transitive,
        // so chaining `$z <> $y <> $x` would let `$x` and `$z` be the same thing.
        //
        // ⚠️ And only between slots written in the SAME `links (...)` list — `constraintsOf` merges
        // roles across every pattern naming the variable, so two statements each mentioning one
        // source must not be treated as one statement asking for two.
        const key = role.statement + ' ' + role.role;
        for (const [earlierIndex, earlierPlayer] of sameRoleSlots.get(key) ?? []) {
          // `(friend: $x, friend: $x)` asks for $x as a friend TWICE: one edge counted twice or more
          // answers it (match.feature L1185); one edge played once does not (L1314).
          if (earlierPlayer === role.player) {
            join += ` AND (rp${index}.rowid <> rp${earlierIndex}.rowid OR rp${index}.count >= 2)`;
            continue;
          }
          join += ` AND rp${index}.player <> rp${earlierIndex}.player`;
        }
        const slots = sameRoleSlots.get(key);
        if (slots) slots.push([index, role.player]);
        else sameRoleSlots.set(key, [[index, role.player]]);
        // A roleless slot is still its OWN role-player edge: `($p, $c)` is two players of the
        // relation, never one edge read twice. Against every earlier slot of the statement where
        // either side named no role (two named roles are told apart by the rule above).
        for (const [earlierIndex, earlierPlayer, earlierRole] of statementSlots.get(role.statement) ?? []) {
          if (earlierPlayer === role.player || (role.role !== undefined && earlierRole !== undefined)) continue;
          join += ` AND NOT (rp${index}.role = rp${earlierIndex}.role AND rp${index}.player = rp${earlierIndex}.player)`;
        }
        statementSlots.set(role.statement, [...(statementSlots.get(role.statement) ?? []), [index, role.player, role.role]]);
        return join;
      })
      .join(' ');

    // 🔴 The relation's OWN attribute constraints, applied here because nothing else applies them.
    //
    // `candidates()` is the only place `literals` and `bindings` become SQL, and `combinations()`
    // calls it on `things` alone — relations never reach it. So `has edge-id "absent"` was parsed,
    // carried and ignored, and the match answered the link anyway.
    const where: string[] = [];
    // A typed relation matches its type and its subtypes, as a thing's `isa` does; `isa!` its type
    // alone — the same closure `candidates()` applies to an entity, so `isa link` also matches a
    // `strong-link` whether or not a role list is named (the exact `t.type = ?` this replaced
    // silently narrowed the type the moment a role list was added).
    for (const isa of relation.isas) {
      if (isa.type === undefined) continue;
      where.push(isa.exact ? 't.type = ?' : `t.type IN ${SUBTYPES_OF}`);
      params.push(isa.type);
    }
    // 🔴 If the relation's own variable is already bound, pin it — reachable only because this
    // method binds free players: a relation that plays a role is bound by whichever pattern names
    // it first, and without this the second pattern re-queried every relation of the type and
    // overwrote the binding with the last one found.
    const already = combination[relation.variable];
    if (typeof already === 'number') {
      where.push('t.iid = ?');
      params.push(already);
    }
    for (const literal of relation.literals) {
      where.push(`t.iid IN (${ownersOfValue('v.type = ? AND v.value = ?')})`);
      params.push(literal.attribute, literal.value);
    }
    // A binding is an ownership requirement, not a value test — the same rule `candidates()`
    // applies to an entity.
    for (const binding of relation.bindings) {
      if (binding.attribute === undefined) {
        where.push('EXISTS (SELECT 1 FROM has h WHERE h.owner = t.iid)');
        continue;
      }
      where.push('EXISTS (SELECT 1 FROM has h WHERE h.owner = t.iid AND h.type = ?)');
      params.push(binding.attribute);
    }

    // 🔴 `t.iid` only when the relation has a name, and `DISTINCT` is why it matters — an anonymous
    // relation is a test, not a binding: `(source: $s, target: $t) isa link` names no variable for
    // the relation itself, so two links between the same pair are two ways of satisfying one
    // indistinguishable condition, and TypeQLite answers it once. Selecting `t.iid` regardless made
    // them distinct rows and doubled every downstream combination.
    const named = !relation.variable.startsWith('__anon');
    const roleVariables = relation.roles.some((role) => role.roleVariable !== undefined);
    const columns = [
      ...(named ? ['t.iid'] : []),
      ...relation.roles.map((_, index) => `rp${index}.player AS p${index}`),
      // `($r: $x)` — the role each slot plays, and the relation's type to name its declaring relation.
      ...(roleVariables ? ['t.type AS relationType', ...relation.roles.map((_, index) => `rp${index}.role AS r${index}`)] : []),
    ].join(', ');
    // (Phase 05) `$r isa $t (employee: $x)` with `$t` unbound — every relation this found rebinds
    // it, one row per candidate type, as `bindTypeVariables` does for an entity.
    const unbound = relation.isas.filter((isa) => isa.typeVariable !== undefined && isa.type === undefined);

    // 🔴 One row answers "is there any?" only when every row found yields a binding. A role variable
    // or an unbound type variable can still reject a row below, so those read every row as before.
    const firstRowDecides = existenceOnly && !roleVariables && unbound.length === 0;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ${columns} FROM thing t ${joins}` +
          `${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${firstRowDecides ? ' LIMIT 1' : ''}`,
      )
      .all(...params) as Array<Record<string, number>>;
    if (this.trace) this.trace.relationRows += rows.length;

    return rows.flatMap((row) => {
      const next: Record<string, Binding> = { ...combination };
      relation.roles.forEach((role, index) => {
        next[role.player] = Number(row[`p${index}`]);
      });
      // A role variable binds the role TYPE, labelled by the relation that declares it — an inherited
      // role is `employment:employee` on a `part-time-employment` too — and filters when bound already.
      for (const [index, role] of relation.roles.entries()) {
        if (role.roleVariable === undefined) continue;
        const name = String((row as unknown as Record<string, string>)[`r${index}`]);
        const relationType = String((row as unknown as Record<string, string>)['relationType']);
        const declaring = this.typeFamily(relationType, 'inherited').find((t) => this.schema.roles.get(t)?.has(name)) ?? relationType;
        const label = roleRef(declaring, name);
        const already = next[role.roleVariable];
        if (already !== undefined && already !== label) return [];
        next[role.roleVariable] = label;
      }
      // A named relation variable binds too, so `$r isa task-dependency (...)` is usable later.
      // The anonymous form has no name anybody wrote, so nothing should be able to select it — and
      // `iid` is not in the row for it either, which is what keeps the answer from doubling.
      if (!named) return [next];
      const iid = Number(row['iid']);
      const extended = { ...next, [relation.variable]: iid };
      return unbound.length === 0 ? [extended] : this.bindTypeVariables(unbound, iid, extended);
    });
  }

  private relationHolds(
    relation: ThingConstraint,
    combination: Record<string, Binding>,
  ): boolean {
    if (this.trace) this.trace.relationHoldsCalls++;
    return this.relationBindings(relation, combination, true).length > 0;
  }

  // ── projection ────────────────────────────────────────────────────────────


  /** The variables a pipeline's rows carry: the `select` list, or every variable the `match` names. */
  private selectedOf(pipeline: Segment, constraints: readonly ThingConstraint[]): Set<string> {
    const patterns = pipeline.match?.patterns ?? [];
    // 🔴 No `select` projects every variable the `match` names — thing, attribute and type alike.
    // An anonymous relation (`__anonN`) or a label-headed type pattern (`__typeN`) is not a
    // variable the query wrote, and is never a column.
    return pipeline.select
      ? new Set(pipeline.select.variables)
      : new Set([
          ...constraints.flatMap((c) => [
            ...(c.variable.startsWith('__anon') ? [] : [c.variable]),
            ...c.isas.flatMap((isa) => (isa.typeVariable === undefined ? [] : [isa.typeVariable])),
            ...c.bindings.map((b) => b.variable),
            // 🔴 A role player is a named variable like any other, `isa` or not: `links (friend: $a)`
            // binds `$a`, and TypeDB answers it (negation.feature L241). Leaving it out also dropped it
            // from the stream, so a later stage would have read it as unbound.
            ...c.roles.map((r) => r.player),
            ...c.roles.flatMap((r) => (r.roleVariable === undefined ? [] : [r.roleVariable])),
          ]),
          ...typeConstraintsOf(patterns, this.refuse).flatMap((t) => [
            ...(t.variable.startsWith('__type') ? [] : [t.variable]),
            ...t.subs.flatMap((o) => (o.variable === undefined ? [] : [o.variable])),
            ...t.owns.flatMap((o) => (o.variable === undefined ? [] : [o.variable])),
            ...t.plays.flatMap((o) => (o.variable === undefined ? [] : [o.variable])),
            ...t.relates.flatMap((o) => [o.variable, o.asVariable].filter((v): v is string => v !== undefined)),
          ]),
          ...patterns.flatMap((p) => (isLetPattern(p) ? letVariables(p) : [])),
          // What a disjunction binds in EVERY branch, and what a `try` binds — never a negation's.
          ...this.nestedBound(patterns),
        ]);
  }

  /** An anonymous relation's own `has` properties, as a thing pattern's would be read. */
  private anonymousOwnership(pattern: AnonRelationPattern): Pick<ThingConstraint, 'literals' | 'bindings'> {
    const literals: ThingConstraint['literals'] = [];
    const bindings: ThingConstraint['bindings'] = [];
    for (const property of pattern.properties) {
      if (property.attribute === undefined) {
        if (property.valueVariable) bindings.push({ variable: property.valueVariable, range: rangeOf(property) });
        continue;
      }
      this.checkKnown('attribute', property.attribute, rangeOf(property));
      if (property.value) {
        literals.push({
          attribute: property.attribute,
          value: this.checkedLiteralText(property.value, property.attribute, rangeOf(property)),
          range: rangeOf(property),
          alternatives: this.literalAlternatives(property.value, property.attribute, rangeOf(property)),
        });
      } else if (property.valueVariable) {
        bindings.push({ attribute: property.attribute, variable: property.valueVariable, range: rangeOf(property) });
      } else if (property.comparator !== undefined) {
        this.refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not compare an anonymous relation’s attribute yet: name the relation.', rangeOf(property));
      }
    }
    return { literals, bindings };
  }

  /** Each `let` (in dependency order) and comparison, per combination — see `applyValueStatements`. */
  private applyStatements(statements: ValueStatements, combinations: Array<Record<string, Binding>>, either: ReadonlySet<string> = new Set()): Array<Record<string, Binding>> {
    // `let $v = $a * 2; $v > 10;` — evaluated per combination, binding the value variables and
    // filtering (Phase 06).
    if (statements.lets.length === 0 && statements.comparisons.length === 0) return combinations;
    // `$x isa $a; $x >= 1;` — a variable that may be a thing OR an attribute is narrowed by the
    // comparison to the attributes it can compare: a row binding it to a thing answers nothing
    // (match.feature L4878), as TypeDB's type inference excludes those types.
    const compared = statements.comparisons.flatMap((c) => [c.left, ...(isVariableExpression(c.right) ? [c.right.variable] : [])]).filter((v) => either.has(v));
    return combinations.flatMap((combination) => {
      if (compared.some((variable) => typeof combination[variable] === 'number')) return [];
      const values = new Map<string, ValueBinding>();
      for (const [variable, binding] of Object.entries(combination)) {
        if (typeof binding === 'object') values.set(variable, binding);
      }
      const concept = (variable: string): 'thing' | 'type' | undefined => {
        const binding = combination[variable];
        return typeof binding === 'number' ? 'thing' : typeof binding === 'string' ? 'type' : undefined;
      };
      const typeOf = (variable: string): string | undefined => {
        const binding = combination[variable];
        return typeof binding === 'string' ? binding : undefined;
      };
      return applyValueStatements(statements, values, concept, this.refuse, this.evaluationContext(combination)).map((answered) => {
        const extended: Record<string, Binding> = { ...combination };
        for (const [variable, binding] of answered) extended[variable] = binding;
        return extended;
      });
    });
  }

  /** The `match` a segment of patterns is, with `has T op expr` rewritten — once per AST node. */
  private readonly segments = new WeakMap<LangiumNode, Segment>();

  /**
   * The segment for `key`, built once.
   * Public so the interpreter's own modules can call it; not part of the API (docs/guides/compatibility.md).
   * @internal
   */
  segmentFor(key: LangiumNode, patterns: readonly Pattern[]): Segment {
    const known = this.segments.get(key);
    if (known !== undefined) return known;
    const segment: Segment = { match: { $type: 'MatchStage', patterns: desugarHas(patterns), $cstNode: key.$cstNode } as unknown as MatchStage };
    this.segments.set(key, segment);
    return segment;
  }

  /**
   * The variables nested blocks bind for the conjunction around them: what every branch of a
   * disjunction binds, and what a `try` binds. A negation's are its own (variables.feature L181).
   */
  private nestedBound(patterns: readonly Pattern[]): string[] {
    return patterns.flatMap((pattern) => {
      if (isDisjunctionPattern(pattern)) {
        const branches = pattern.branches.map((branch) => this.boundBy(this.segmentFor(branch, branch.patterns).match?.patterns ?? []));
        return [...(branches[0] ?? [])].filter((variable) => branches.every((branch) => branch.has(variable)));
      }
      if (isOptionalPattern(pattern)) return [...this.boundBy(this.segmentFor(pattern, pattern.patterns).match?.patterns ?? [])];
      return [];
    });
  }

  /**
   * `let`s must admit ONE evaluation order across every branch of a stage: `{ let $y = $x; } or
   * { let $x = $y; }` is circular although each branch alone is not (expression.feature L195).
   */
  private checkLetOrder(patterns: readonly Pattern[]): void {
    const reads = new Map<string, Set<string>>();
    const collect = (list: readonly Pattern[]): void => {
      for (const pattern of list) {
        if (isLetPattern(pattern)) {
          for (const variable of letVariables(pattern)) reads.set(variable, new Set([...(reads.get(variable) ?? []), ...variablesOf(pattern.expression)]));
        } else if (isNegationPattern(pattern) || isOptionalPattern(pattern)) collect(pattern.patterns);
        else if (isDisjunctionPattern(pattern)) for (const branch of pattern.branches) collect(branch.patterns);
      }
    };
    collect(patterns);
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (variable: string): void => {
      if (done.has(variable)) return;
      if (visiting.has(variable)) {
        // A cycle within one conjunction is refused earlier, in `orderValueStatements`' words; one
        // that only closes across branches is TypeDB's other message (expression.feature L195).
        this.refuse(DiagnosticCode.valueCycle, `illegal circular expression assignment & usage: '${variable.slice(1)}' is assigned from itself across the branches of this stage.`, undefined);
      }
      visiting.add(variable);
      for (const read of reads.get(variable) ?? []) if (reads.has(read)) visit(read);
      visiting.delete(variable);
      done.add(variable);
    };
    for (const variable of reads.keys()) visit(variable);
  }

  /**
   * `{ $x isa person; } or { $x isa company; } or { $a isa name; };` — `$x` in two branches and not the
   * third, bound nowhere outside: the branches share no binding for it, which TypeDB refuses
   * (match.feature L5065). Every disjunction, at every depth, against what its conjunction binds.
   */
  private checkBranchReuse(patterns: readonly Pattern[], outer: ReadonlySet<string>): void {
    const bound = new Set([...outer, ...this.ownBound(patterns)]);
    for (const pattern of patterns) {
      const blocks = isDisjunctionPattern(pattern) ? pattern.branches : isNegationPattern(pattern) || isOptionalPattern(pattern) ? [pattern] : [];
      for (const block of blocks) this.checkBranchReuse(block.patterns, bound);
      if (!isDisjunctionPattern(pattern)) continue;
      const mentions = pattern.branches.map((branch) => new Set(variablesWritten(branch)));
      for (const variable of new Set(mentions.flatMap((m) => [...m]))) {
        if (bound.has(variable) || isAnonymous(variable)) continue;
        const count = mentions.filter((m) => m.has(variable)).length;
        if (count > 1 && count < mentions.length) {
          this.refuse(DiagnosticCode.unboundValue, `The variable '${variable.slice(1)}' is used in ${count} branches of a disjunction but not all of them, and nothing outside binds it: the branches have no common binding for it.`, rangeOf(pattern));
        }
      }
    }
  }

  /**
   * `has $a` may bind attributes of several value types; an expression needs one (expression.feature
   * L281): the types the owner can own, through `has $a`, must agree.
   */
  private checkUntypedReads(patterns: readonly Pattern[], constraints: readonly ThingConstraint[]): void {
    const untyped = new Map(constraints.flatMap((c) => c.bindings.filter((b) => b.attribute === undefined).map((b) => [b.variable, c] as const)));
    if (untyped.size === 0) return;
    for (const pattern of patterns) {
      // A comparison's own operands NARROW instead: `$x has $_ 9` and `$p has $pid; $pid == $id;` read
      // only the attributes of a type the other side can be compared with (match.feature L4501, L5217).
      // Arithmetic inside one still needs a single value type.
      const read = isLetPattern(pattern)
        ? variablesOf(pattern.expression)
        : isComparisonPattern(pattern)
          ? isVariableExpression(pattern.right) || isLiteralExpression(pattern.right) ? [] : variablesOf(pattern.right)
          : [];
      for (const variable of read) {
        const owner = untyped.get(variable);
        if (owner === undefined) continue;
        const types = owner.isas.flatMap((isa) => (isa.type === undefined ? [] : this.typeFamily(isa.type).filter((t) => this.typeFamily(t, 'inherited').includes(isa.type as string))));
        const owned = [...this.schema.attributes].filter((a) => (types.length === 0 ? true : types.some((t) => this.typeFamily(t, 'inherited').some((u) => this.schema.owns.has(ownsKey(u, a))))));
        const valueTypes = new Set(owned.map((a) => this.valueTypeOfAttribute(a)).filter((t): t is string => t !== undefined).map((t) => (t === 'long' ? 'integer' : t)));
        if (valueTypes.size > 1) {
          this.refuse(DiagnosticCode.valueTypeConflict, `The variable '${variable.slice(1)}' must have a single possible value type to be used in an expression: it may hold ${[...valueTypes].sort().join(', ')}.`, rangeOf(pattern));
        }
      }
    }
  }

  /** A variable's kind in a conjunction or any block that binds for it (a disjunction branch, a `try`). */
  private nestedKind(patterns: readonly Pattern[]): (variable: string) => 'thing' | 'type' | undefined {
    const own = this.conceptKindOf(this.constraintsOf(patterns), patterns);
    const inner = patterns.flatMap((pattern) =>
      isDisjunctionPattern(pattern)
        ? pattern.branches.map((branch) => this.nestedKind(this.segmentFor(branch, branch.patterns).match?.patterns ?? []))
        : isOptionalPattern(pattern)
          ? [this.nestedKind(this.segmentFor(pattern, pattern.patterns).match?.patterns ?? [])]
          : [],
    );
    return (variable) => own(variable) ?? inner.reduce<'thing' | 'type' | undefined>((found, kind) => found ?? kind(variable), undefined);
  }

  /**
   * The nested blocks' rules, checked before any row (variables.feature, optional.feature):
   *
   * - a variable two sibling blocks both use must be bound by the conjunction around them — two
   *   negations each `let $x`, two `try`s both binding `$y`, a disjunction branch and a negation
   *   sharing `$x`: TypeDB's *"The variable 'x' must be bound to a value before it's used"*;
   * - `try` is not allowed in a negation, nor in a disjunction branch;
   * - each block's own `let`s and comparisons, against what is bound around it.
   */
  private checkNested(
    patterns: readonly Pattern[],
    bound: ReadonlySet<string>,
    conceptOf: (variable: string) => 'thing' | 'type' | undefined,
    context: 'conjunction' | 'negation' | 'branch',
    /** What is bound outside this conjunction altogether. */
    outer: ReadonlySet<string> = new Set(),
    /** What the enclosing conjunctions assign with `let` — a nested `let` may not assign one again. */
    lets: ReadonlySet<string> = new Set(patterns.flatMap((p) => (isLetPattern(p) ? letVariables(p) : []))),
    /** What earlier STAGES bound — reassigning one is "already bound in a previous stage". */
    previous: ReadonlySet<string> = outer,
  ): void {
    const blocks: Array<{ node: LangiumNode; patterns: readonly Pattern[]; kind: 'negation' | 'branch' | 'optional' }> = [];
    for (const pattern of patterns) {
      // `$x is $y` compares two concepts something else binds (match.feature L5036).
      // `$x is $y` binds one side from the other; with neither bound it has nothing to compare (match.feature L5036).
      if (isIsPattern(pattern) && !bound.has(pattern.left) && !bound.has(pattern.right)) {
        this.refuse(DiagnosticCode.unboundValue, `The variable '${pattern.left.slice(1)}' must be bound to a value before it's used: \`is\` needs one side bound by something else.`, rangeOf(pattern));
      }
      if (isNegationPattern(pattern)) blocks.push({ node: pattern, patterns: pattern.patterns, kind: 'negation' });
      else if (isOptionalPattern(pattern)) {
        if (context === 'negation') this.refuse(DiagnosticCode.mixedPattern, 'Optionals are not allowed in negations.', rangeOf(pattern));
        if (context === 'branch') {
          const first = variablesWritten(pattern)[0] ?? '$_';
          this.refuse(DiagnosticCode.unboundValue, `The variable '${first.slice(1)}' must be bound to a value before it's used: an optional is not allowed inside a disjunction branch.`, rangeOf(pattern));
        }
        blocks.push({ node: pattern, patterns: pattern.patterns, kind: 'optional' });
      } else if (isDisjunctionPattern(pattern)) {
        for (const branch of pattern.branches) blocks.push({ node: branch, patterns: branch.patterns, kind: 'branch' });
      }
    }
    // Sibling blocks — the branches of ONE disjunction count as one block, since only one answers.
    const owner = new Map<string, LangiumNode>();
    for (const block of blocks) {
      const group = block.kind === 'branch' ? (block.node.$container as LangiumNode) : block.node;
      for (const variable of variablesWritten(block.node)) {
        if (variable === '$_' || bound.has(variable)) continue;
        const first = owner.get(variable);
        if (first !== undefined && first !== group) {
          this.refuse(DiagnosticCode.unboundValue, `The variable '${variable.slice(1)}' must be bound to a value before it's used. Two nested blocks here use it, and nothing around them binds it.`, rangeOf(block.node));
        }
        owner.set(variable, group);
      }
    }
    for (const block of blocks) {
      const inner = this.segmentFor(block.node, block.patterns).match?.patterns ?? [];
      // What is bound AROUND this block — not what its own disjunction contributes, which its branch
      // is what binds (variables.feature L63: `{ let $x = 1; } or { let $x = 11; }`).
      const own = block.kind === 'branch' ? new Set(this.nestedBound([block.node.$container as Pattern])) : new Set<string>();
      const around = new Set([...bound].filter((variable) => !own.has(variable) || outer.has(variable)));
      // `let $v = …; not { not { let $v = 10; }; };` — one variable, assigned twice in one branch of
      // the pipeline (expression.feature L124), not a value "declared as both" kinds.
      const group = block.kind === 'branch' ? block.node.$container : block.node;
      const siblingLets = new Set(
        blocks
          .filter((other) => (other.kind === 'branch' ? other.node.$container : other.node) !== group)
          .flatMap((other) => other.patterns.flatMap((p) => (isLetPattern(p) ? letVariables(p) : []))),
      );
      for (const statement of inner.filter(isLetPattern)) {
        for (const variable of letVariables(statement)) {
          if (previous.has(variable)) {
            this.refuse(DiagnosticCode.valueAssignedTwice, `The variable '${variable.slice(1)}' may not be assigned to, as it was already bound in a previous stage.`, rangeOf(statement));
          }
          if (lets.has(variable) || siblingLets.has(variable)) {
            this.refuse(DiagnosticCode.valueAssignedTwice, `Variable '${variable.slice(1)}' cannot be assigned to multiple times in the same branch.`, rangeOf(statement));
          }
        }
      }
      this.matchStatements(inner, this.constraintsOf(inner), around, conceptOf);
      const innerLets = new Set([...lets, ...inner.flatMap((p) => (isLetPattern(p) ? letVariables(p) : []))]);
      this.checkNested(inner, new Set([...around, ...this.ownBound(inner)]), conceptOf, block.kind === 'optional' ? 'conjunction' : block.kind, around, innerLets, previous);
    }
    // Every branch of a disjunction assigns its common variables ONE value type (expression.feature L281).
    for (const pattern of patterns) {
      if (!isDisjunctionPattern(pattern)) continue;
      const typed = new Map<string, Set<string>>();
      // What the enclosing conjunction binds counts too: `has age $a; { let $v = $a * 2; } or …`.
      const around = this.constraintsOf(patterns).flatMap((c) => c.bindings.flatMap((b) => (b.attribute === undefined ? [] : [[b.variable, b.attribute] as const])));
      for (const branch of pattern.branches) {
        const inner = this.segmentFor(branch, branch.patterns).match?.patterns ?? [];
        const attributeOf = new Map([...around, ...this.constraintsOf(inner).flatMap((c) => c.bindings.flatMap((b) => (b.attribute === undefined ? [] : [[b.variable, b.attribute] as const])))]);
        const lets = new Map(inner.filter(isLetPattern).map((l) => [l.variable, l.expression] as const));
        const typeOf = (variable: string, seen: ReadonlySet<string> = new Set()): string | undefined => {
          const attribute = attributeOf.get(variable);
          if (attribute !== undefined) return this.valueTypeOfAttribute(attribute);
          const expression = lets.get(variable);
          return expression === undefined || seen.has(variable) ? undefined : inferValueType(expression, (v) => typeOf(v, new Set([...seen, variable])));
        };
        for (const variable of lets.keys()) {
          const type = typeOf(variable);
          if (type !== undefined) typed.set(variable, new Set([...(typed.get(variable) ?? []), type === 'long' ? 'integer' : type]));
        }
      }
      for (const [variable, types] of typed) {
        if (types.size > 1) {
          this.refuse(DiagnosticCode.valueTypeConflict, `All assignments of the variable '${variable.slice(1)}' must have the same value type. The branches here assign ${[...types].sort().join(' and ')}.`, rangeOf(pattern));
        }
      }
    }
  }

  /**
   * What a conjunction binds for its nested blocks to share: its own concepts and `let`s, and what
   * every branch of a disjunction binds — never what a `try` binds, since sibling optionals may not
   * overlap (optional.feature L176).
   */
  private ownBound(patterns: readonly Pattern[]): Set<string> {
    const constraints = this.constraintsOf(patterns);
    return new Set([
      ...this.conceptVariablesOf(constraints, patterns),
      ...patterns.flatMap((p) => (isLetPattern(p) ? letVariables(p) : [])),
      ...this.nestedBound(patterns.filter(isDisjunctionPattern)),
    ]);
  }

  /** The attribute bindings inside a conjunction's `try` blocks and disjunction branches, at any depth. */
  private nestedAttributeBindings(patterns: readonly Pattern[]): Array<{ attribute?: string; variable: string }> {
    return patterns.flatMap((pattern) => {
      const blocks = isOptionalPattern(pattern)
        ? [this.segmentFor(pattern, pattern.patterns)]
        : isDisjunctionPattern(pattern)
          ? pattern.branches.map((branch) => this.segmentFor(branch, branch.patterns))
          : [];
      return blocks.flatMap((segment) => {
        const inner = segment.match?.patterns ?? [];
        return [...this.constraintsOf(inner).flatMap((c) => c.bindings), ...this.nestedAttributeBindings(inner)];
      });
    });
  }

  /** Every variable a conjunction binds — its concepts, its `let`s, `is` (from its other side), and its nested blocks'. */
  private boundBy(patterns: readonly Pattern[]): Set<string> {
    const constraints = this.constraintsOf(patterns);
    return new Set([
      ...this.conceptVariablesOf(constraints, patterns),
      ...patterns.flatMap((p) => (isLetPattern(p) ? letVariables(p) : isIsPattern(p) ? [p.left, p.right] : [])),
      ...this.nestedBound(patterns),
    ]);
  }


  /** A binding as a cell — a thing by iid, a type by label (Phase 05), a value by its type (Phase 06). */
  private cellOf(binding: Binding): TypeDBLiteValue {
    if (typeof binding === 'number') return this.thingCell(binding);
    if (typeof binding === 'string') return TypeDBLiteValue.type(binding);
    return binding.kind === 'attribute'
      ? TypeDBLiteValue.attribute(binding.attributeType, binding.value)
      : TypeDBLiteValue.value(binding.valueType, binding.value);
  }

  /**
   * A literal as the attribute's value type spells it — see `canonicalValue`. Applied where a
   * literal is read (`has weight 80` matches what `has weight 80.0` wrote) and where one is
   * written, so `attr.value`, compared as text, has ONE text per value.
   */
  /**
   * For an attribute with no value type of its own, the literal in each concrete subtype's
   * spelling — the subtypes whose type can read it; `undefined` when the attribute has a type
   * and the plain comparison applies.
   */
  private literalAlternatives(literal: Literal, attribute: string, at: Range | undefined): Array<{ type: string; value: string }> | undefined {
    if (this.valueTypeOfAttribute(attribute) !== undefined) return undefined;
    const text = literalText(literal);
    const alternatives: Array<{ type: string; value: string }> = [];
    const seen = new Set<string>();
    let firstRefusal: { code: DiagnosticCodeValue; message: string } | undefined;
    // A refusal that records nothing: a subtype that cannot read the text is skipped, and the
    // report carries no error for it (review, round 17).
    const silently: Refuse = (code, message) => {
      throw new SilentRefusal(code, message);
    };
    for (const type of this.typeFamily(attribute)) {
      // The subtype's value type through ITS chain — `tall-height sub height` inherits `height`'s
      // (review, round 17).
      const valueType = this.valueTypeOfAttribute(type);
      if (valueType === undefined || this.schema.abstracts.has(type)) continue;
      if (!literalFits(literal, valueType)) {
        firstRefusal ??= { code: DiagnosticCode.valueTypeConflict, message: `'${type}' holds a ${valueType}, and this is ${literalKind(literal)}.` };
        continue;
      }
      try {
        const value = this.canonicalValue(type, text, at, silently);
        if (!seen.has(`${type}:${value}`)) {
          seen.add(`${type}:${value}`);
          alternatives.push({ type, value });
        }
      } catch (error) {
        if (!(error instanceof SilentRefusal)) throw error;
        firstRefusal ??= { code: error.code, message: error.message };
      }
    }
    // No subtype at all can read the literal: the refusal the typed form would give, not an
    // empty answer (round 17). No typed subtype at all: nothing can match, and nothing is wrong.
    if (alternatives.length === 0 && firstRefusal !== undefined) this.refuse(firstRefusal.code, firstRefusal.message, at);
    return alternatives;
  }

  /**
   * A literal as a MATCH reads it: by value. `isa shoe-size 92.00` finds the integer 92
   * (insert.feature L1550), and `92.5` finds nothing — an integer attribute holds no such value,
   * which is an empty answer, not the refusal a write gets for trying to store one.
   */
  private matchedLiteral(literal: Literal, attribute: string, at: Range | undefined): { value: string; alternatives?: Array<{ type: string; value: string }> } {
    const valueType = this.valueTypeOfAttribute(attribute);
    if ((valueType === 'integer' || valueType === 'long') && (isDoubleLiteral(literal) || isDecimalLiteral(literal))) {
      const whole = /^(-?\d+)(?:\.0*)?$/.exec(literalText(literal));
      return whole === null ? { value: '', alternatives: [] } : { value: this.canonicalValue(attribute, whole[1], at) };
    }
    return { value: this.checkedLiteralText(literal, attribute, at), alternatives: this.literalAlternatives(literal, attribute, at) };
  }

  private checkedLiteralText(literal: Literal, attribute: string, at: Range | undefined): string {
    // The literal's KIND fits the attribute's type, as `literalFits` says for an annotation: a
    // `5dec` is a decimal and no integer or double attribute holds one (review, round 12).
    const valueType = this.valueTypeOfAttribute(attribute);
    if (valueType !== undefined && !literalFits(literal, valueType)) {
      return this.refuse(DiagnosticCode.valueTypeConflict, `'${attribute}' holds a ${valueType}, and this is ${literalKind(literal)}.`, at);
    }
    return this.canonicalValue(attribute, literalText(literal), at);
  }

  /**
   * 🔴 ONE stored spelling per (value type, value) — by the ATTRIBUTE's type, not the literal's
   * syntax (review, round 10: `has price 1.0e2` on a decimal stored `100.0` beside `100dec`'s
   * `100`; `has weight 80` stored `80` beside `80.0`; `has ref 001` stored `001` beside `1` and
   * evaded the `@key`). `attr.value` is compared as text everywhere — candidates, joins, the
   * UNIQUE index — so the text is decided here and nowhere else:
   *
   * - integer: the digits, no leading zeros, range-checked at 64 bits (`has age 99999999999999999999`
   *   had stored what a `let` refuses);
   * - double: `String(Number)`, `.0` on a whole number — what a computed double renders as;
   * - decimal: no trailing zeros in the fraction — what a decimal literal renders as;
   * - anything else: as written.
   *
   * A text the type cannot read is refused, as TypeDB refuses a string on an integer attribute.
   */
  private canonicalValue(attribute: string, text: string, at: Range | undefined, refuse: Refuse = this.refuse): string {
    const valueType = this.valueTypeOfAttribute(attribute);
    switch (valueType) {
      case 'integer':
      case 'long': {
        if (!/^-?\d+$/.test(text)) return refuse(DiagnosticCode.valueTypeConflict, `'${text}' is not an integer, and '${attribute}' holds integers.`, at);
        const value = BigInt(text);
        if (value < INTEGER_MIN || value > INTEGER_MAX) return refuse(DiagnosticCode.valueOutOfRange, `Integer overflow: ${text} is outside the 64-bit range.`, at);
        return value.toString();
      }
      case 'double': {
        const value = Number(text);
        if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) || Number.isNaN(value)) {
          return refuse(DiagnosticCode.valueTypeConflict, `'${text}' is not a double, and '${attribute}' holds doubles.`, at);
        }
        // An integer literal is a 64-bit integer wherever it is written (L656) — on a double
        // attribute too (QA, B4).
        if (/^-?\d+$/.test(text) && (BigInt(text) < INTEGER_MIN || BigInt(text) > INTEGER_MAX)) {
          return refuse(DiagnosticCode.valueOutOfRange, `Integer overflow: ${text} is outside the 64-bit range.`, at);
        }
        if (!Number.isFinite(value)) return refuse(DiagnosticCode.valueOutOfRange, `Double overflow: ${text} is outside the 64-bit range.`, at);
        return Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.0` : String(value);
      }
      case 'decimal': {
        const parsed = numericOf('decimal', text, refuse, at);
        const { text: canonical } = valueOf(parsed);
        return canonicalDecimal(canonical);
      }
      case 'datetime':
      case 'datetime-tz': {
        // A date on a datetime attribute is midnight of that day, in the datetime's one spelling
        // (review, round 13): `2000-01-01` and `2000-01-01T00:00:00` are one stored text — and a
        // fraction of zeros is no fraction: `…:00.000` is `…:00` (round 14).
        const dated = (/^[+-]?\d{4,}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text)
          // Minutes without seconds are TypeDB's too (expression.feature L704): `…T10:00` is `…T10:00:00`.
          .replace(/(T\d{2}:\d{2})(?=$|[+\-Z ])/, '$1:00');
        const trimmed = dated.replace(/(\d{2}:\d{2}:\d{2})\.(\d*?)0*(?=$|[+\-Z ])/, (_m, time: string, fraction: string) => (fraction === '' ? time : `${time}.${fraction}`));
        // One spelling per offset (QA, B1): `+00:00`, `+0000`, `-00:00` and `Z` are one, and every
        // other offset carries its colon. A zone NAME is kept as written — an offset and a zone
        // are two values on TypeDB. Two offsets naming one instant stay two texts.
        return trimmed.replace(/([+-])(\d{2}):?(\d{2})$/, (_m, sign: string, hh: string, mm: string) => (hh === '00' && mm === '00' ? 'Z' : `${sign}${hh}:${mm}`));
      }
      case 'duration':
        // `P66W` is `P462D`, `PT90M` is `PT1H30M` — one spelling per duration.
        return canonicalTemporal('duration', text, refuse, at);
      default:
        return text;
    }
  }

  /** A bound thing as a cell — its own type, and whether that type is a relation. */
  private thingCell(iid: number): TypeDBLiteValue {
    const type = this.typeOfThing(iid);
    return this.schema.relations.has(type)
      ? TypeDBLiteValue.relation(iid, type)
      : TypeDBLiteValue.entity(iid, type);
  }

  /** The value type an attribute type holds, through its parents — what a driver reads off the schema. */
  attributeValueType(attribute: string): string | undefined {
    return this.valueTypeOfAttribute(attribute);
  }

  /**
   * Every attribute of the given type that the thing with this `iid` owns, as attribute cells: the driver's `getHas`.
   * Read the thing's own attributes through this rather than trusting anything a cell carries.
   */
  attributesOf(iid: number, attribute: string): ReadonlyArray<TypeDBLiteValue> {
    return this.readAttributes(iid, attribute).map((v) => TypeDBLiteValue.attribute(v.type, v.value));
  }

  /**
   * The thing TypeDB would number `<kind>:<type id>:<object id>` (`iid:entity:0:1`): the `object`th thing of exactly
   * the `type`th type of that kind. TypeDB allocates a type id per kind, in definition order, and an object id per
   * type, in creation order. Returns `undefined` when there is no such thing.
   *
   * TypeDB never reuses an object id, and a deleted thing leaves no row here, so after a delete the numbering of
   * later things in the type shifts down.
   */
  thingNumbered(kind: 'entity' | 'relation', type: number, object: number): number | undefined {
    const types = (this.db.prepare("SELECT name FROM schema_element WHERE kind = 'type' ORDER BY rowid").all() as Array<{ name: string }>)
      .map((row) => String(row.name))
      .filter((name) => this.schema.relations.has(name) === (kind === 'relation'));
    const label = types[type];
    if (label === undefined) return undefined;
    const row = this.db.prepare('SELECT iid FROM thing WHERE type = ? ORDER BY iid LIMIT 1 OFFSET ?').get(label, object) as { iid: number } | undefined;
    return row === undefined ? undefined : Number(row.iid);
  }

  /** The type a bound thing was inserted as — what an attach-form write checks ownership against. */
  private typeOfThing(iid: number): string {
    const row = this.db.prepare('SELECT type FROM thing WHERE iid = ?').get(iid) as
      | { type: string }
      | undefined;
    return String(row?.type ?? '');
  }

  /**
   * Every value of an attribute on a thing — plural, because attributes can be, and through the
   * subtype closure, because a `first-name` is a `name` — with the row's own type, so a cell says
   * what it actually is rather than what the query asked for.
   */
  /** An owner's attributes of one type and its subtypes — or, for `has $a`, of every type. */
  private readAttributes(owner: number, attribute: string | undefined): Array<{ type: string; value: string }> {
    const rows =
      attribute === undefined
        ? this.db.prepare(`SELECT v.type AS type, v.value AS value FROM ${OWNED} WHERE h.owner = ? ORDER BY h.rowid`).all(owner)
        : this.db.prepare(`SELECT v.type AS type, v.value AS value FROM ${OWNED} WHERE h.owner = ? AND h.type IN ${SUBTYPES_OF} ORDER BY h.rowid`).all(owner, attribute);
    return rows
      .map((row: unknown) => {
        const r = row as { type: string; value: string };
        return { type: String(r.type), value: String(r.value) };
      });
  }

  // ── writing ───────────────────────────────────────────────────────────────

  private runInsert(
    pattern: Pattern,
    bindings: Map<string, number[]>,
    values: Map<string, ValueBinding>,
    isPut: boolean,
  ): void {
    // A `let` or a comparison belongs to a `match`; the grammar's `Pattern` admits them in a write
    // stage and nothing here evaluates one (review, round 5).
    if (isLetPattern(pattern) || isComparisonPattern(pattern)) {
      this.refuse(DiagnosticCode.mixedPattern, 'A `let` or a comparison belongs to a `match`, not to a write stage.', rangeOf(pattern));
    }
    if (isAnonRelationPattern(pattern)) {
      if (pattern.type === undefined) {
        return this.refuse(DiagnosticCode.mixedPattern, 'An inserted relation names its type: `(employee: $x) isa employment;`.', rangeOf(pattern));
      }
      this.checkKnown('type', pattern.type, rangeOf(pattern));
      const iid = this.insertThing(pattern.type, isPut, rangeOf(pattern));
      this.insertRoles(iid, rolesOf(pattern.players, 0), bindings);
      // `(friend: $x) isa friendship, has ref 0;` — the relation's own attributes.
      const owned = this.anonymousOwnership(pattern);
      this.checkOwns({ variable: '__anon', type: pattern.type, isas: [{ type: pattern.type, exact: false }], literals: owned.literals, bindings: owned.bindings, roles: [] }, 'write');
      for (const literal of owned.literals) this.insertAttribute(iid, literal.attribute, literal.value, literal.range);
      for (const binding of owned.bindings) {
        const written = this.writtenValue(binding, values);
        this.insertAttribute(iid, written.attribute, written.value, binding.range);
      }
      return;
    }
    if (!isThingPattern(pattern)) return;

    const constraint = this.constraintsOf([pattern], 'write')[0];
    if (constraint?.instance !== undefined) {
      this.insertAttributeInstance(constraint.instance, bindings, values);
      return;
    }
    if (!constraint?.type) {
      // 🔴 Refused, not silently ignored — and deliberately not implemented.
      //
      // `insert $l links (source: $b);` against a matched relation took this branch, found no
      // literals, and returned having written nothing while reporting
      // `Wrote 0 thing(s), 0 attribute(s), 0 role player(s).` at exit code 0
      // (d-20260910-insert-of-a-role-player-into-2).
      //
      // ⚠️ **Enabling it was worse than leaving it inert.** Nothing here knows the bound owner is a
      // relation, so `insert $a links (source: $b);` with `$a` matched as an *entity* wrote a
      // `role_player` row keyed on that entity and reported success — a corruption where there had
      // only been a no-op. The role name was never checked against the schema either.
      //
      // The capability is not missing: naming every player in ONE `insert` writes them correctly,
      // and that is what every caller does. Implementing the incremental form needs a relation
      // check, `checkKnown` on the role, and an error path that does not report a foreign-key or
      // busy failure as a duplicate edge. That is on the parking lot; until then this refuses,
      // which is the same trade `select` takes on an unprojectable variable.
      //
      // ⚠️ **Checked before the unbound-owner guard, not after.** `if (owner === undefined) return;`
      // used to run first, so the refusal never fired for an UNBOUND relation variable —
      // `insert $nope links (source: $x);` still reported
      // `Wrote 0 thing(s), 0 attribute(s), 0 role player(s).` at exit 0. A refusal reachable only
      // on the half of the inputs that were already the safer half is not a refusal.
      // `match $r isa friendship; insert $r links (friend: $x);` — a player added to a relation an
      // earlier stage bound. 🔴 Refused until the fetch-and-writes phase, because nothing knew the
      // bound owner was a relation or checked the role: `insert $a links (source: $b)` with `$a` an
      // ENTITY wrote a `role_player` row keyed on it (d-20260910-insert-of-a-role-player-into-2).
      // Both are checked now — the owner's kind here, the role and `plays` in `checkPlays`.
      if (constraint?.roles.length) {
        const relation = bindings.get(constraint.variable)?.[0];
        if (relation === undefined) {
          const message = `Refusing a dangling relation: '${constraint.variable}' is not bound, so there is no relation to add a player to.`;
          throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.danglingRelation, message, constraint.range));
        }
        const relationType = this.typeOfThing(relation);
        if (!this.typeFamily(relationType, 'inherited').some((t) => this.schema.relations.has(t))) {
          this.refuse(DiagnosticCode.mixedPattern, `'${constraint.variable}' is a '${relationType}', not a relation: it has no roles to add a player to.`, constraint.range);
        }
        this.insertRoles(relation, constraint.roles, bindings);
      }

      // `$p has person-kind "user"` with no `isa` — attach to the already-bound thing.
      const owner = bindings.get(constraint?.variable ?? '')?.[0];
      if (owner === undefined) return;
      // 🔴 The check above saw no `isa`, so it saw no type and returned early — this form wrote
      // attributes the type does not own, and every later read of them was the refusal. The type
      // is on the bound thing; resolve it and check against the same ownership the `isa` form uses.
      if (constraint) {
        const type = this.typeOfThing(owner);
        this.checkOwns({ ...constraint, type, isas: [{ type, exact: false }] }, 'write');
      }
      for (const literal of constraint?.literals ?? []) {
        this.insertAttribute(owner, literal.attribute, literal.value, literal.range);
      }
      for (const binding of constraint?.bindings ?? []) {
        const written = this.writtenValue(binding, values);
        this.insertAttribute(owner, written.attribute, written.value, binding.range);
      }
      return;
    }

    // `insert $x isa person; $x isa writer;`, or `match $x isa person; insert $x isa writer;` — an
    // `isa` on a variable a match or an earlier pattern already bound would insert a SECOND thing
    // under that name and rebind it; TypeDB refuses a re-typed variable (review, round 5).
    if (bindings.has(constraint.variable)) {
      this.refuse(
        DiagnosticCode.mixedPattern,
        `'${constraint.variable}' is already bound and cannot be inserted with \`isa ${constraint.type}\`; attach attributes to it without an \`isa\`.`,
        constraint.range,
      );
    }

    // `put` is match-or-insert: if a @key already matches, reuse it rather than inserting. A
    // `has ref $a` looks up the VALUE the match bound, not any `ref` (review, round 10).
    if (isPut) {
      const bound = constraint.bindings.map((b) => ({ ...this.writtenValue(b, values), range: b.range }));
      const existing = this.candidates({ ...constraint, literals: [...constraint.literals, ...bound], bindings: [] })[0];
      if (existing !== undefined) {
        bindings.set(constraint.variable, [existing]);
        return;
      }
    }

    const iid = this.insertThing(constraint.type, false, constraint.range);
    for (const literal of constraint.literals) {
      this.insertAttribute(iid, literal.attribute, literal.value, literal.range);
    }
    // `insert $x isa person, has age $v` — the value the match bound (review, round 5).
    for (const binding of constraint.bindings) {
      const written = this.writtenValue(binding, values);
      this.insertAttribute(iid, written.attribute, written.value, binding.range);
    }
    // Bound before its players are linked: a relation may play a role in itself —
    // `$r isa comparison, links (compared: $r)` (match.feature L1259).
    bindings.set(constraint.variable, [iid]);
    this.insertRoles(iid, constraint.roles, bindings);
  }

  /**
   * The value a write reads through `has <attribute> $v` — bound by the match, or refused; and of
   * a type the attribute holds: an integer may be written to a double or decimal attribute, and
   * nothing else crosses (review, round 6 — `let $v = 2.5; insert $p has age $v;` had stored
   * `2.5` on an integer `age`).
   */
  private valueFor(variable: string, attribute: string, values: ReadonlyMap<string, ValueBinding>, at: Range | undefined): string {
    const bound = values.get(variable);
    if (bound === undefined) {
      return this.refuse(DiagnosticCode.unboundValue, unboundInWrite(variable), at);
    }
    this.checkValueFits(variable, bound.valueType, attribute, at);
    // Stored as the attribute's type spells it — `canonicalValue` — so an integer `10` on a
    // double attribute is `10.0` and a computed decimal `3.0` is `3` (review, rounds 7 and 10).
    return this.canonicalValue(attribute, bound.value, at);
  }

  /**
   * What `has <attribute> $v` writes — the value `$v` holds, as `<attribute>` spells it — and what
   * `has $a` writes: the attribute the match bound to `$a`, under its own type (fetch.feature L2996).
   */
  private writtenValue(binding: { attribute?: string; variable: string; range?: Range }, values: ReadonlyMap<string, ValueBinding>): { attribute: string; value: string } {
    if (binding.attribute !== undefined) {
      return { attribute: binding.attribute, value: this.valueFor(binding.variable, binding.attribute, values, binding.range) };
    }
    const bound = values.get(binding.variable);
    if (bound?.kind !== 'attribute') {
      return this.refuse(DiagnosticCode.mixedPattern, `\`has ${binding.variable}\` writes an attribute the match bound; '${binding.variable.slice(1)}' ${bound === undefined ? 'is not bound' : 'is a value, not an attribute — name its type: `has <attribute> ' + binding.variable + '`'}.`, binding.range);
    }
    return { attribute: bound.attributeType, value: bound.value };
  }

  /** A write pattern that inserts an attribute instance, `$n isa name "Ann"` (ADR-006). */
  private isAttributeInstance(pattern: Pattern): boolean {
    return isThingPattern(pattern) && pattern.properties.some((p) => isIsaProperty(p) && p.type !== undefined && this.schema.attributes.has(p.type));
  }

  /**
   * `insert $n isa name "Ann";` — the attribute, created if it is not stored yet, and `$n` bound to
   * it. With no owner it lasts the statement unless its type is `@independent` (ADR-006 D4): the
   * insert answers it, and the sweep after the answers removes it.
   */
  private insertAttributeInstance(instance: NonNullable<ThingConstraint['instance']>, bindings: Map<string, number[]>, values: Map<string, ValueBinding>): void {
    const { variable, type, range } = instance;
    if (bindings.has(variable) || values.has(variable)) {
      this.refuse(DiagnosticCode.mixedPattern, `'${variable}' is already bound and cannot be inserted with \`isa ${type}\`.`, range);
    }
    if (this.schema.abstracts.has(type)) {
      const message = `'${type}' is abstract and cannot have a value of its own. Write a concrete subtype.`;
      throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.abstractType, message, range));
    }
    const value =
      instance.literal !== undefined
        ? instance.literal.value
        : this.valueFor(instance.valueVariable as string, type, values, range);
    this.checkWrittenValue(type, undefined, value, range);
    if (ensureAttribute(this.db, type, value).created) this.written.attributes += 1;
    values.set(variable, { kind: 'attribute', attributeType: type, valueType: this.valueTypeOfAttribute(type) ?? 'string', value });
  }

  private insertThing(type: string, _isPut: boolean, at?: Range): number {
    // 🔴 Enforced since Phase 03 of the conformance feature — it was parsed and reported as not
    // enforced. An abstract type has no direct instances (`insert.feature` L199), and that is also
    // what lets `define` convert a type to abstract by looking at its instances alone.
    if (this.schema.abstracts.has(type)) {
      const message = `'${type}' is abstract and cannot have an instance of its own. Insert a concrete subtype.`;
      throw attachDiagnostic(
        new Error(message),
        this.diagnostics.error(DiagnosticCode.abstractType, message, at),
      );
    }
    this.db.prepare('INSERT INTO thing(type) VALUES (?)').run(type);
    const row = this.db.prepare('SELECT last_insert_rowid() AS iid').get() as {
      iid: number;
    };
    const iid = Number(row.iid);
    this.touched.add(iid);
    this.written.things += 1;
    return iid;
  }

  /**
   * A written value meets the `@regex` its attribute type or the ownership states — the whole value
   * matches, as TypeDB matches it (insert.feature L1357). The pattern is the annotation's text as
   * written, never unescaped: `\d` is a digit class, not a `d`.
   */
  private checkWrittenValue(attribute: string, ownerType: string | undefined, value: string, at: Range | undefined): void {
    const subjects = [
      ...this.typeFamily(attribute, 'inherited').map((a) => valueSubject(a)),
      ...(ownerType === undefined ? [] : this.typeFamily(ownerType, 'inherited').flatMap((o) => this.typeFamily(attribute, 'inherited').map((a) => ownsSubject(o, a)))),
    ];
    for (const subject of subjects) {
      const text = this.schema.annotations.get(subject)?.get('regex');
      if (text === undefined) continue;
      const pattern = /^@regex\(\s*"((?:\\.|[^"\\])*)"\s*\)$/.exec(text)?.[1]?.replace(/\\"/g, '"');
      if (pattern === undefined) continue;
      let matches: boolean;
      try {
        matches = new RegExp(`^(?:${pattern})$`, 'u').test(value);
      } catch {
        continue;
      }
      if (!matches) {
        this.refuse(DiagnosticCode.constraintViolated, `'${attribute}' does not admit this value: it must match ${text}.`, at);
      }
    }
  }

  private insertAttribute(
    owner: number,
    attribute: string,
    value: string,
    at?: Range,
  ): void {
    this.checkKnown('attribute', attribute, at);
    this.checkWrittenValue(attribute, this.typeOfThing(owner), value, at);
    // An abstract attribute type has no values of its own, as an abstract entity has no instances.
    if (this.schema.abstracts.has(attribute)) {
      const message = `'${attribute}' is abstract and cannot have a value of its own. Write a concrete subtype.`;
      throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.abstractType, message, at));
    }
    // An owner owns an attribute VALUE once, as on TypeDB — a second `has age 5` on the same
    // thing is the same ownership, not a second row a `count` would see twice (QA, B5).
    try {
      if (!ownAttribute(this.db, owner, attribute, value)) return;
      this.touched.add(owner);
      this.written.attributes += 1;
    } catch (error) {
      const translated = translateConstraintError(error, attribute);
      // 🔴 The message is unchanged and the range is the STATEMENT, not the term.
      //
      // SQLite raises this; it has never seen the TypeQLite, and (measured 2026-08-29) names neither
      // the index nor the attribute. Pointing at a term we cannot actually locate would be worse
      // than pointing at the statement. The value being written is deliberately NOT quoted — this
      // report can end up in a `DomainEvent` payload, which replicates (ADR-004 D4).
      throw attachDiagnostic(
        translated,
        this.diagnostics.error(
          DiagnosticCode.constraintViolated,
          `[CNT9] Constraint '@unique' has been violated for attribute '${attribute}'.`,
          at,
        ),
      );
    }
  }

  /**
   * The one role a player can take in a relation when the insert names none — `links ($p)`: every
   * role the relation type declares or inherits that the player's type (or an ancestor) plays. None,
   * or more than one, is refused rather than guessed.
   */
  private inferRole(relation: number, player: number, variable: string, at: Range | undefined): string {
    const relationType = this.typeOfThing(relation);
    const playerTypes = this.typeFamily(this.typeOfThing(player), 'inherited');
    const candidates = new Set<string>();
    for (const declaring of this.typeFamily(relationType, 'inherited')) {
      for (const role of this.schema.roles.get(declaring) ?? []) {
        if (playerTypes.some((t) => this.schema.plays.has(playsSubject(t, roleRef(declaring, role))))) candidates.add(role);
      }
    }
    if (candidates.size === 1) return [...candidates][0];
    const message =
      candidates.size === 0
        ? `'${variable}' cannot play any role of '${relationType}', so \`links (${variable})\` has no role to take.`
        : `'${variable}' could play ${[...candidates].sort().join(' or ')} in '${relationType}'; name the role: \`links (<role>: ${variable})\`.`;
    throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.unknownRole, message, at));
  }

  /**
   * A named role on an insert must be one the relation has — declared or inherited — and one the
   * player's type (or an ancestor) plays. 🔴 Never checked before the fetch phase's audit: insert.feature
   * L1015 "passed" only because its relation was written before its player and failed as dangling.
   */
  private checkPlays(relation: number, player: number, role: string, variable: string, at: Range | undefined): string {
    const relationType = this.typeOfThing(relation);
    const declaring = this.typeFamily(relationType, 'inherited').find((t) => this.schema.roles.get(t)?.has(role));
    if (declaring === undefined) {
      const message = `Role label not found '${role}': '${relationType}' has no such role.`;
      throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.unknownRole, message, at));
    }
    // A schema that records no `plays` AND no roles predates the record; nothing to check against.
    // Roles with no `plays` left is a schema whose last `plays` was undefined — and then nothing can
    // play them (undefine.feature L1251). Every production store we have seen with roles records its `plays`.
    if (this.schema.plays.size === 0 && this.schema.roles.size === 0) return role;
    const playerType = this.typeOfThing(player);
    if (!this.typeFamily(playerType, 'inherited').some((t) => this.schema.plays.has(playsSubject(t, roleRef(declaring, role))))) {
      const message = `'${playerType}' cannot play '${roleRef(declaring, role)}', so '${variable}' cannot be the ${role} of '${relationType}'.`;
      throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.unknownRole, message, at));
    }
    return role;
  }

  private insertRoles(
    relation: number,
    roles: ReadonlyArray<{ role?: string; player: string; range?: Range }>,
    bindings: Map<string, number[]>,
  ): void {
    for (const role of roles) {
      const player = bindings.get(role.player)?.[0];
      if (player === undefined) {
        const message = isAnonymous(role.player)
          ? 'An anonymous variable is not available to a write: `$_` binds no player for a relation to link. Name it.'
          : `Refusing a dangling relation: '${role.player}' is not bound, so ${role.role === undefined ? 'it' : `role '${role.role}'`} ` +
            'has nothing to relate.';
        throw attachDiagnostic(
          new Error(message),
          this.diagnostics.error(
            DiagnosticCode.danglingRelation,
            message,
            role.range,
          ),
        );
      }
      // `touched` drives `changeLog.recordWrite`. Every caller of this method also creates the
      // relation through `insertThing`, which already marks it — this is belt and braces, and the
      // one path that did NOT create it is now refused above rather than left to skip the log.
      this.touched.add(relation);
      const name = role.role === undefined ? this.inferRole(relation, player, role.player, role.range) : this.checkPlays(relation, player, role.role, role.player, role.range);
      // A player may hold one role more than once — `(friend: $x, friend: $x)` — and each is counted
      // (insert.feature L938). A foreign-key or busy failure is rethrown as SQLite raised it.
      this.db.prepare('INSERT INTO role_player(rel, role, player) VALUES (?, ?, ?) ON CONFLICT(rel, role, player) DO UPDATE SET count = count + 1').run(relation, name, player);
      this.written.roles += 1;
    }
  }

  private runDeletes(patterns: readonly Pattern[], write: DeleteStage, bindings: Map<string, number[]>, combinations: readonly Record<string, Binding>[]): void {
    const constraints = this.constraintsOf(patterns);

    for (const deletion of write.deletions) {
      if (deletion.optional) {
        // `delete try { $f; };` — on the rows where everything it names is bound, and nowhere else.
        const named = deletion.block.flatMap((d) => [d.target, d.owner, ...(d.players?.entries.map((e) => e.player) ?? [])]).filter((v): v is string => v !== undefined);
        const ready = combinations.filter((row) => named.every((variable) => row[variable] !== undefined));
        this.runDeletes(patterns, { ...write, deletions: deletion.block } as DeleteStage, resolveEveryMatch(ready), ready);
        continue;
      }
      if (deletion.links) {
        // `delete links (friend: $x) of $r` — those edges, on every relation the match bound; a
        // relation left with no player is gone too (delete.feature L855).
        for (const combination of combinations) {
          const relation = combination[deletion.owner as string];
          if (typeof relation !== 'number') continue;
          for (const entry of deletion.players?.entries ?? []) {
            const player = combination[entry.player];
            if (typeof player !== 'number') continue;
            const boundRole = entry.roleVariable === undefined ? undefined : combination[entry.roleVariable];
            const role = entry.role ?? (typeof boundRole === 'string' ? boundRole.slice(boundRole.lastIndexOf(':') + 1) : undefined);
            // One occurrence per slot: `links (friend: $x)` of a twice-played friend leaves one
            // (delete.feature L626); `links (friend: $x, friend: $x)` removes both (L453).
            if (role === undefined) this.db.prepare('UPDATE role_player SET count = count - 1 WHERE rel = ? AND player = ?').run(relation, player);
            else this.db.prepare('UPDATE role_player SET count = count - 1 WHERE rel = ? AND player = ? AND role = ?').run(relation, player, role);
            this.db.prepare('DELETE FROM role_player WHERE rel = ? AND count <= 0').run(relation);
          }
          this.touched.add(relation);
          // Left with no player: gone now outside a transaction, and at COMMIT inside one —
          // `removePlayerlessRelations` — so the answers of this write still name it (delete.feature L2971).
          if (!this.transactionOpen && this.db.prepare('SELECT 1 FROM role_player WHERE rel = ?').get(relation) === undefined) this.deleteThing(relation);
        }
        continue;
      }
      if (deletion.target === undefined) continue;
      const target = deletion.target;
      if (deletion.owner) {
        // `delete $old of $p` — the attribute TYPE is not in the delete clause; it is whatever
        // bound `$old` in the match.
        const bound = [...constraints.flatMap((c) => c.bindings), ...this.nestedAttributeBindings(patterns)].find((b) => b.variable === target);
        // `has $a` binds an attribute of any type: the row removed is the one the combination holds.
        const attribute = bound === undefined ? undefined : (bound.attribute ?? '');
        if (attribute === undefined) {
          // `delete $v of $p` with `$v` a `let` value or nothing at all — not an attribute the
          // match bound; refused rather than a silent `Wrote 0` (review, round 10).
          this.refuse(DiagnosticCode.mixedPattern, `'${target}' is not an attribute the \`match\` bound with \`has <attribute> ${target}\`; \`delete ${target} of ${deletion.owner}\` has nothing to remove.`, rangeOf(deletion));
        }
        // 🔴 **The VALUE the match bound, on every owner it bound.** A combination carries `$old`
        // as one attribute value since Phase 06, and `$n == "Al"; delete $n of $p;` removes that
        // value and not every `name` the owner has (review, round 5). A combination without the
        // value — none here binds it — falls back to every value of the type, through the closure:
        // `$n` bound by `has name $n` may be a `first-name`, and that is the row removed.
        for (const combination of combinations) {
          const owner = combination[deletion.owner];
          if (typeof owner !== 'number') continue;
          const value = combination[target];
          if (typeof value === 'object' && value.kind === 'attribute') {
            this.db.prepare('DELETE FROM has WHERE owner = ? AND attribute = (SELECT id FROM attribute WHERE type = ? AND value = ?)').run(owner, value.attributeType, value.value);
          } else {
            this.db.prepare(`DELETE FROM has WHERE owner = ? AND type IN ${SUBTYPES_OF}`).run(owner, attribute);
          }
          // Removing an attribute changes the owner's state — an update, not a tombstone.
          this.touched.add(owner);
        }
        continue;
      }
      // 🔴 **Every match, not the first.** This read `bindings.get(deletion.target)?.[0]` and
      // deleted that one row, so `match $k isa kid, has tag "x"; delete $k;` over three matches
      // deleted one and left two — succeeding, reporting `ok`, exiting 0. `delete` in TypeQLite applies
      // to every match; `[0]` implemented an operation the language does not have.
      //
      // ⚠️ **Nothing in this repository had ever deleted over a set.** Both TypeDBLite callers match
      // on a `@key`, so their matches are single rows and they were correct by accident. The defect
      // gate's claim store was the first to delete over a non-key attribute, and it kept two of
      // three claims — `d-20260905-match-delete-removes-one-match-of`.
      for (const iid of unique(bindings.get(target) ?? [])) this.deleteThing(iid);
      // `match $n isa name "John"; delete $n;` — the attribute, once however many rows bound it.
      const attributes = new Map<string, { type: string; value: string }>();
      for (const combination of combinations) {
        const bound = combination[target];
        if (typeof bound === 'object' && bound.kind === 'attribute') attributes.set(`${bound.attributeType}\u0000${bound.value}`, { type: bound.attributeType, value: bound.value });
      }
      for (const attribute of attributes.values()) this.deleteAttribute(attribute.type, attribute.value, rangeOf(deletion));
    }
  }

  /**
   * An attribute and every ownership of it (delete.feature L1019) — each owner's state changes, so
   * each is logged. Deleting one already gone is nothing (delete.feature L749).
   *
   * 🔴 Refused when an owner holds it as its `@key`. TypeDB lets the delete run and fails the
   * COMMIT, because the owner is left without its key (delete.feature L2755); this engine validates
   * nothing at commit, so it refuses at the delete — the one point that keeps every owner keyed.
   */
  private deleteAttribute(type: string, value: string, at: Range | undefined): void {
    const id = attributeId(this.db, type, value);
    if (id === undefined) return;
    const owners = this.db.prepare('SELECT h.owner AS owner, t.type AS type FROM has h JOIN thing t ON t.iid = h.owner WHERE h.attribute = ?').all(id) as Array<{ owner: number; type: string }>;
    const attributeTypes = this.typeFamily(type, 'inherited');
    // In a caller's transaction the commit decides, as on TypeDB (`validateCommit`); a lone write has
    // no commit of its own to fail, so it is refused here.
    for (const owner of this.transactionOpen ? [] : owners) {
      const keyed = this.typeFamily(String(owner.type), 'inherited').some((ownerType) => attributeTypes.some((attribute) => this.schema.keyOwnerships.has(ownsKey(ownerType, attribute))));
      if (keyed) {
        const message = `'${type}' is the @key of a '${owner.type}', which cannot be left without its key; delete the owner, or give it another key first.`;
        throw attachDiagnostic(new Error(message), this.diagnostics.error(DiagnosticCode.constraintViolated, message, at));
      }
    }
    for (const owner of owners) this.touched.add(Number(owner.owner));
    this.db.prepare('DELETE FROM attribute WHERE id = ?').run(id);
  }

  /** A thing, and the relations it plays in — each tombstoned, as a follower must learn of each. */
  private deleteThing(iid: number): void {
    // 🔴 A deleted thing leaves every relation it played in — and a relation is deleted with it only
    // when that leaves it with no player at all (delete.feature L408: deleting Alex keeps Alex's
    // friendship with Bob, which TypeDB 3.10.4 confirms). It used to delete every such relation
    // outright; a projection's delete-then-insert of an iteration relied on that
    // when its relation had the deleted thing as its ONLY player, which is still what happens.
    const playedIn = (this.db.prepare('SELECT DISTINCT rel FROM role_player WHERE player = ? AND rel <> ?').all(iid, iid) as Array<{ rel: number }>).map((row) => Number(row.rel));
    const own = this.changeLog.identify(iid);
    if (own) this.tombstones.push(own);
    this.db.prepare('DELETE FROM role_player WHERE player = ?').run(iid);
    this.db.prepare('DELETE FROM thing WHERE iid = ?').run(iid);
    for (const relation of playedIn) {
      this.touched.add(relation);
      // Each cascaded relation is a thing in its own right and needs its own tombstone, or a follower
      // would keep a relation whose last player is gone — `deleteThing` records it.
      // Inside a transaction, at COMMIT (`removePlayerlessRelations`), as `delete links` leaves one.
      if (!this.transactionOpen && this.db.prepare('SELECT 1 FROM role_player WHERE rel = ?').get(relation) === undefined) this.deleteThing(relation);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Each `isa` with its type variable read from the combination when it is already bound. */
function resolveIsas(isas: readonly Isa[], combination: Record<string, Binding>): Isa[] {
  return isas.map((isa) => {
    const bound = isa.typeVariable === undefined ? undefined : combination[isa.typeVariable];
    return typeof bound === 'string' ? { ...isa, type: bound } : isa;
  });
}

/**
 * Every iid each variable bound, across every combination the match produced.
 *
 * 🔴 A delete applies to every combination; reading the first binding alone was how three matching
 * rows became one deleted row.
 */
function resolveEveryMatch(
  combinations: readonly Record<string, Binding>[],
): Map<string, number[]> {
  const bindings = new Map<string, number[]>();
  for (const combination of combinations) {
    for (const [variable, iid] of Object.entries(combination)) {
      // A type variable binds a label, which no write can hold.
      if (typeof iid === 'number') bindings.set(variable, [...(bindings.get(variable) ?? []), iid]);
    }
  }
  return bindings;
}

/** What an anonymous `$_` becomes — `$_#N`, which no query can write, so it collides with nothing. */
const isAnonymous = (variable: string): boolean => variable.startsWith('$_#');

/** A write reading what nothing binds — an anonymous `$_` never binds a value (insert.feature L2733). */
const unboundInWrite = (variable: string): string =>
  isAnonymous(variable)
    ? 'An anonymous variable is not available to a write: `$_` binds nothing a write could read. Name it.'
    : `The variable '${variable.slice(1)}' must be bound to a value before it's used in a write.`;

/**
 * 🔴 Each `$_` is its OWN variable — "something", never "the same something as the last `$_`".
 * `insert $_ isa person, has ref 0; $_ isa person, has ref 1;` is two people, and was refused here as
 * one variable inserted twice (disjunction.feature L172, match.feature L842). Renamed after the
 * validator has seen `$_` — it refuses `select $_` by that name (pipelines.feature L287) — and the
 * projection never answers one, as TypeDB never answers an anonymous variable.
 */
function renameAnonymous(root: LangiumNode): void {
  let counter = 0;
  for (const node of AstUtils.streamAst(root)) {
    const record = node as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith('$')) continue;
      if (value === '$_') record[key] = `$_#${(counter += 1)}`;
      else if (Array.isArray(value) && value.includes('$_')) record[key] = value.map((v) => (v === '$_' ? `$_#${(counter += 1)}` : v));
    }
  }
}

/** Whether two bindings are the one concept — a thing by iid, a type by label, an attribute or value by type and value. */
function sameConcept(left: Binding, right: Binding): boolean {
  if (typeof left !== 'object' || typeof right !== 'object') return left === right;
  const typeOf = (binding: ValueBinding): string => (binding.kind === 'attribute' ? binding.attributeType : binding.valueType);
  return left.kind === right.kind && typeOf(left) === typeOf(right) && left.value === right.value;
}

/** Every `$variable` written in a node's source text, in order — what a block mentions, bound or read. */
function variablesWritten(node: LangiumNode): string[] {
  return [...new Set<string>(node.$cstNode?.text.match(/\$[a-zA-Z0-9_][a-zA-Z0-9_-]*/g) ?? [])];
}

let hasCounter = 0;

/**
 * `has age > 5` and `has name == $n` in a match become `has age __hasN; __hasN > 5;` — a binding
 * and a comparison, which the engine already evaluates (modifiers.feature, insert.feature L312). The
 * rewritten nodes keep the source's position, so a refusal still points at what was written.
 */
function desugarHas(patterns: readonly Pattern[]): Pattern[] {
  const rewritten: Pattern[] = [];
  const comparisons: Pattern[] = [];
  for (const pattern of patterns) {
    // `iid($x) == "0x…"` — `let __iidN = iid($x); __iidN == "0x…";`, so a comparison's left stays a variable.
    if (isCallComparisonPattern(pattern)) {
      const variable = `__call${(hasCounter += 1)}`;
      rewritten.push({ $type: 'LetPattern', variable, others: [], iterate: false, expression: pattern.call, $container: pattern.$container, $cstNode: pattern.$cstNode } as unknown as Pattern);
      comparisons.push({ $type: 'ComparisonPattern', left: variable, comparator: pattern.comparator, right: pattern.right, $container: pattern.$container, $cstNode: pattern.$cstNode } as unknown as Pattern);
      continue;
    }
    const anyValued = (p: Property): boolean => isHasProperty(p) && ((p.attribute === undefined && p.value !== undefined) || p.expression !== undefined);
    if (!isThingPattern(pattern) || !pattern.properties.some((p) => ((isHasProperty(p) || isIsaProperty(p)) && p.comparator !== undefined) || anyValued(p))) {
      rewritten.push(pattern);
      continue;
    }
    const properties = pattern.properties.map((property) => {
      // `$a isa age > 18` — an attribute instance compared by its own value (ADR-006): `$a isa age;
      // $a > 18;`. A thing's `isa` takes no comparator, and the instance check refuses one there.
      if (isIsaProperty(property) && property.comparator !== undefined && property.compared !== undefined) {
        comparisons.push({ $type: 'ComparisonPattern', left: pattern.variable, comparator: property.comparator, right: property.compared, $cstNode: property.$cstNode } as unknown as Pattern);
        return { ...property, comparator: undefined, compared: undefined };
      }
      // `has age (10 + 5)` in a match — `has age == 10 + 5`.
      if (isHasProperty(property) && property.expression !== undefined) {
        const variable = `__has${(hasCounter += 1)}`;
        comparisons.push({ $type: 'ComparisonPattern', left: variable, comparator: '==', right: property.expression, $cstNode: property.$cstNode } as unknown as Pattern);
        return { ...property, expression: undefined, valueVariable: variable };
      }
      // `has $a > 5` — `has $a; $a > 5;`, on the variable itself.
      if (isHasProperty(property) && property.attribute === undefined && property.valueVariable !== undefined && property.comparator !== undefined && property.compared !== undefined) {
        comparisons.push({ $type: 'ComparisonPattern', left: property.valueVariable, comparator: property.comparator, right: property.compared, $cstNode: property.$cstNode } as unknown as Pattern);
        return { ...property, comparator: undefined, compared: undefined };
      }
      // `has $a "value"` — `has $a; $a == "value";`, an attribute of any type that holds it.
      if (isHasProperty(property) && property.attribute === undefined && property.value !== undefined && property.valueVariable !== undefined) {
        const right = { $type: 'LiteralExpression', literal: property.value, $cstNode: property.value.$cstNode } as unknown as Expression;
        comparisons.push({ $type: 'ComparisonPattern', left: property.valueVariable, comparator: '==', right, $cstNode: property.$cstNode } as unknown as Pattern);
        return { ...property, value: undefined };
      }
      if (!isHasProperty(property) || property.comparator === undefined || property.compared === undefined) return property;
      // Named like `__anonN` — no `$`, so no query can write it and the projection never shows it.
      const variable = `__has${(hasCounter += 1)}`;
      comparisons.push({ $type: 'ComparisonPattern', left: variable, comparator: property.comparator, right: property.compared, $cstNode: property.$cstNode } as unknown as Pattern);
      return { ...property, comparator: undefined, compared: undefined, valueVariable: variable };
    });
    rewritten.push({ ...pattern, properties } as Pattern);
  }
  return [...rewritten, ...comparisons];
}

/** `$x isa $t;` and nothing else said of `$x` — a thing or an attribute instance, per row. */
function isBareTypeIsa(c: ThingConstraint): boolean {
  return c.isas.length > 0 && c.isas.every((isa) => isa.type === undefined) && c.literals.length === 0 && c.bindings.length === 0 && c.roles.length === 0 && c.instance === undefined;
}

/** The type and role variables a written statement names — `isa $t`, `($r: $x)`. */
function typeVariablesWritten(pattern: Pattern): string[] {
  const roleVariables = (list: RolePlayers | undefined): string[] => (list?.entries ?? []).flatMap((e) => (e.roleVariable === undefined ? [] : [e.roleVariable]));
  if (isAnonRelationPattern(pattern)) return [...(pattern.typeVariable === undefined ? [] : [pattern.typeVariable]), ...roleVariables(pattern.players)];
  if (!isThingPattern(pattern)) return [];
  return pattern.properties.flatMap((p) =>
    isIsaProperty(p) ? [...(p.typeVariable === undefined ? [] : [p.typeVariable]), ...roleVariables(p.players)] : isLinksProperty(p) ? roleVariables(p.players) : []);
}

/**
 * A stage's patterns in an order that inserts every player before a relation that links it.
 * 🔴 TypeDB's insert is a set of statements, not a script: `insert $r isa employment, links ($p);
 * $p isa person;` is one insert, and written in that order it failed here as "$p is not bound" —
 * a refusal for the wrong reason, which passed insert.feature L996 hollowly. Stable otherwise, and
 * a cycle (a relation playing in its own player) keeps the written order for what remains.
 */
function insertionOrder(patterns: readonly Pattern[]): Pattern[] {
  const introduces = (pattern: Pattern): string | undefined => (isThingPattern(pattern) ? pattern.variable : undefined);
  const needs = (pattern: Pattern): string[] => {
    const lists = isAnonRelationPattern(pattern)
      ? [pattern.players]
      : isThingPattern(pattern)
        ? pattern.properties.flatMap((p) => (isLinksProperty(p) ? [p.players] : isIsaProperty(p) && p.players ? [p.players] : []))
        : [];
    return lists.flatMap((list) => list.entries.map((entry) => entry.player));
  };
  const introducedHere = new Set(patterns.flatMap((p) => introduces(p) ?? []));
  const placed = new Set<string>();
  const remaining = [...patterns];
  const ordered: Pattern[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((p) => needs(p).every((v) => !introducedHere.has(v) || placed.has(v) || v === introduces(p)));
    // A CYCLE — `$l1 isa loop, links (member: $l2); $l2 isa loop, links (member: $l1);` (match.feature
    // L5327). Nothing can go first whole, so the first relation goes first WITHOUT its players, and its
    // `links` come back as a statement of their own on the now-bound relation, placed when its players are.
    if (index < 0) {
      const at = remaining.findIndex((p) => isThingPattern(p) && needs(p).length > 0 && p.properties.some(isIsaProperty));
      if (at >= 0) {
        const pattern = remaining[at] as ThingPattern;
        const links = pattern.properties.flatMap((p): Property[] =>
          isLinksProperty(p) ? [p] : isIsaProperty(p) && p.players ? [{ $type: 'LinksProperty', players: p.players, $cstNode: p.$cstNode, $container: pattern } as unknown as Property] : []);
        const head = pattern.properties.filter((p) => !isLinksProperty(p)).map((p) => (isIsaProperty(p) && p.players ? ({ ...p, players: undefined } as Property) : p));
        remaining.splice(at, 1, { ...pattern, properties: links } as Pattern);
        ordered.push({ ...pattern, properties: head } as Pattern);
        placed.add(pattern.variable);
        continue;
      }
    }
    const [next] = remaining.splice(index < 0 ? 0 : index, 1);
    ordered.push(next);
    const variable = introduces(next);
    if (variable !== undefined) placed.add(variable);
  }
  return ordered;
}

/**
 * A write stage's patterns with each `try { … }` opened — the block's own patterns are written as
 * the stage's are, when it runs. A `try` inside a `try` is refused (update.feature L3042).
 */
function writtenPatterns(patterns: readonly Pattern[], refuse: Refuse): Pattern[] {
  return patterns.flatMap((pattern) => {
    if (!isOptionalPattern(pattern)) return [pattern];
    const nested = pattern.patterns.find(isOptionalPattern);
    if (nested !== undefined) refuse(DiagnosticCode.mixedPattern, 'Nested try blocks are not allowed in a write stage.', rangeOf(nested));
    return [...pattern.patterns];
  });
}

/** A delete stage's deletions with each `try { … }` opened; a `try` inside a `try` is refused. */
function openDeletions(deletions: readonly Deletion[], refuse: Refuse): Deletion[] {
  return deletions.flatMap((deletion) => {
    if (!deletion.optional) return [deletion];
    const nested = deletion.block.find((d) => d.optional);
    if (nested !== undefined) refuse(DiagnosticCode.mixedPattern, 'Nested try blocks are not allowed in a write stage.', rangeOf(nested));
    return [...deletion.block];
  });
}

/** A write stage — what `execute()` runs and `query()` refuses. */
const isWriteStage = (stage: LeadStage | Stage): stage is WriteStage =>
  stage.$type === 'InsertStage' || stage.$type === 'PutStage' || stage.$type === 'DeleteStage' || stage.$type === 'UpdateStage';

/** One key per distinct row — what `distinct` and the write dedupe compare. */
function rowKeyOf(row: Record<string, Binding>): string {
  return Object.keys(row)
    .sort()
    .map((variable) => {
      const binding = row[variable];
      return `${variable}=${typeof binding === 'object' ? `${binding.kind === 'attribute' ? binding.attributeType : binding.valueType}:${binding.value}` : String(binding)}`;
    })
    .join(String.fromCharCode(30));
}

/**
 * The first full row of each distinct assignment of what a write reads — every thing and type, and
 * the values of `keep` (see `uniqueByConcepts`). The row is kept WHOLE: later stages read the rest.
 */
function uniqueRows(rows: readonly Record<string, Binding>[], keep: ReadonlySet<string>): Record<string, Binding>[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const read: Record<string, Binding> = {};
    for (const [variable, binding] of Object.entries(row)) if (typeof binding !== 'object' || keep.has(variable)) read[variable] = binding;
    const key = rowKeyOf(read);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What `sort` can order against what: numbers whatever their type, and each other kind with itself. */
function sortClass(valueType: string): string {
  if (valueType === 'integer' || valueType === 'long' || valueType === 'double' || valueType === 'decimal') return 'number';
  if (valueType === 'date' || valueType === 'datetime') return 'datetime';
  return valueType;
}

/**
 * The combinations reduced to what a write reads — every thing and type, and the values of
 * `keep` — one per distinct assignment of those.
 */
function uniqueByConcepts(combinations: readonly Record<string, Binding>[], keep: ReadonlySet<string>): Record<string, Binding>[] {
  const seen = new Set<string>();
  const distinct: Record<string, Binding>[] = [];
  for (const combination of combinations) {
    const read: Record<string, Binding> = {};
    for (const [variable, binding] of Object.entries(combination)) {
      if (typeof binding !== 'object' || keep.has(variable)) read[variable] = binding;
    }
    const key = Object.keys(read).sort().map((v) => {
      const binding = read[v];
      return `${v}=${typeof binding === 'object' ? `${binding.kind === 'attribute' ? binding.attributeType : binding.valueType}:${binding.value}` : String(binding)}`;
    }).join(String.fromCharCode(30));
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(read);
  }
  return distinct;
}

/** The variables a write stage reads as values: `has <attribute> $v` in an insert, `delete $v of $p`. */
function valueVariablesReadBy(write: WriteStage): Set<string> {
  // Every deletion target: `delete $v of $p` reads `$v`'s value, and `delete $a` of an attribute reads
  // which attribute it is — four emails bound to `$e` are four rows, not one (delete.feature L275).
  if (write.$type === 'DeleteStage') return new Set(write.deletions.flatMap((d) => (d.optional ? d.block : [d])).flatMap((d) => (d.target !== undefined ? [d.target] : [])));
  return new Set(
    write.patterns.flatMap((p) => (isOptionalPattern(p) ? [...p.patterns] : [p])).flatMap((pattern) =>
      isThingPattern(pattern)
        ? pattern.properties.flatMap((p) =>
            // `insert $_ isa name == $v` reads `$v`, as `has name == $v` does (ADR-006).
            isIsaProperty(p) && p.comparator === '==' && p.compared !== undefined && isVariableExpression(p.compared)
              ? [p.compared.variable]
              : !isHasProperty(p)
              ? []
              : p.valueVariable
                ? [p.valueVariable]
                : p.comparator === '==' && p.compared !== undefined && isVariableExpression(p.compared)
                  ? [p.compared.variable]
                  : [],
          )
        : [],
    ),
  );
}

/** The value bindings of one combination, by variable. */
function valueBindingsOf(combination: Record<string, Binding>): Map<string, ValueBinding> {
  const values = new Map<string, ValueBinding>();
  for (const [variable, binding] of Object.entries(combination)) {
    if (typeof binding === 'object') values.set(variable, binding);
  }
  return values;
}

/** One combination as a bindings map — what `runInsert` expects: one iid per variable. */
function singleBinding(
  combination: Record<string, Binding>,
): Map<string, number[]> {
  return new Map(
    Object.entries(combination).flatMap(([variable, iid]) => (typeof iid === 'number' ? [[variable, [iid]] as const] : [])),
  );
}

/**
 * The distinct iids a variable bound, in match order.
 *
 * 🔴 A match can bind the same thing more than once — a conjunction over two attributes produces a
 * row per combination — and deleting it twice would push a second tombstone for an identity that
 * only died once.
 */
function unique(iids: readonly number[]): number[] {
  return [...new Set(iids)];
}

let patternCounter = 0;

function rolesOf(
  players: RolePlayers,
  statement: number,
): Array<{ role?: string; roleVariable?: string; player: string; statement: number; range?: Range }> {
  // 🔴 One id per PATTERN, not per role list.
  //
  // `constraintsOf` merges roles across every pattern naming a variable, so without this two
  // statements each mentioning one source are indistinguishable from one statement asking for two,
  // and `relationBindings`' same-role rule rejects a query TypeQLite answers.
  //
  // ⚠️ It was minted per `rolesOf` call, and one pattern can carry TWO role lists —
  // `$l isa link (source: $x), links (source: $y)`. Those got different ids and escaped the rule
  // entirely, so `$x` and `$y` bound to the same player: the exact false positive the rule exists
  // to close, reintroduced through the fix for the opposite one.
  return players.entries.map((entry) => ({
    role: entry.role,
    roleVariable: entry.roleVariable,
    player: entry.player,
    statement,
    // The provenance that gives `insertRoles`'s refusal a source position — see ThingConstraint.
    range: rangeOf(entry),
  }));
}

/**
 * 🔴 No `slice(1, -1)`. Langium's default value converter already strips the quotes from a
 * `STRING` terminal, so trimming again turns `"s-1"` into `-`. Found by the interpreter tests;
 * the same bug was latent in the generator, where nothing had exercised a literal yet.
 *
 * 🔴 **The fallback throws; it used to return `''`.** Adding `DatetimeLiteral` and `BooleanLiteral`
 * to the grammar made the danger concrete: a literal kind the parser accepts and this function does
 * not know silently stored an **empty string**, so `has is-latest true` would have written `''` and
 * every later match on it would simply never fire. That is ADR-002 Decision 7 exactly — *a construct
 * that parses but is not implemented must be an error, not a silent success*.
 *
 * ⚠️ The same silent fallback existed in `sqlite-generator.ts`, returning `NULL`. That whole
 * function went with `generatePipeline`, which had no callers — so there is now **one** literal
 * path, and it is this one.
 */
/** An `IntLiteral`'s digits as written — its `number` has already rounded past 2^53. */
function integerDigits(node: { value: number; $cstNode?: { text: string } }): string {
  const digits = /(\d+)\s*$/.exec(node.$cstNode?.text ?? '')?.[1];
  return digits ?? String(node.value);
}

/** A refusal thrown to be caught, recording no diagnostic — `literalAlternatives`' probe of each subtype. */
class SilentRefusal extends Error {
  constructor(readonly code: DiagnosticCodeValue, message: string) {
    super(message);
  }
}

/** `5.0` → `5`, `-0.50` → `-0.5`, `007` → `7`: a decimal's one stored spelling. */
function canonicalDecimal(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = ''] = match;
  const integer = whole.replace(/^0+(?=\d)/, '');
  const trimmed = fraction.replace(/0+$/, '');
  const zero = integer === '0' && trimmed === '';
  return `${zero ? '' : sign}${integer}${trimmed === '' ? '' : `.${trimmed}`}`;
}

function literalText(node: unknown): string {
  if (isStringLiteral(node)) return node.value;
  // 🔴 From the literal's TEXT, not its `number`: `INT returns number`, and `has age
  // 9223372036854775807` had stored `9223372036854776000` (review, round 2). Signed by the grammar,
  // not the terminal (Phase 06): `has age -5` is `negative` + `5`, and the CST text carries both.
  // The digits are the INT token's text — `has age - 5` has a space the CST text would keep
  // (review, round 4) — and the sign is the flag's.
  if (isIntLiteral(node)) return `${node.negative ? '-' : ''}${integerDigits(node)}`;
  // The DATETIME terminal admits an optional fractional part; `canonicalValue` drops a fraction
  // of zeros, so `…:13` and `…:13.000` are ONE stored text (Phase 06 review, round 14) and
  // `…:13.999` keeps its digits.
  if (isDatetimeLiteral(node)) return node.value;
  if (isDatetimeTzLiteral(node)) return node.value;
  // `61.8dec` is `61.8`: the suffix is the literal's, not the value's. The ONE stored spelling
  // per value is `canonicalValue`'s, by the attribute's type (review, rounds 9 and 10).
  if (isDecimalLiteral(node)) return `${node.negative ? '-' : ''}${node.value.slice(0, -3)}`;
  if (isDateLiteral(node)) return node.value;
  if (isDoubleLiteral(node)) return `${node.negative ? '-' : ''}${node.value}`;
  if (isBooleanLiteral(node)) return node.value;
  // `P1Y2M3DT4H5M6.789S` — spelt once by `canonicalValue`, so `P66W` and `P462D` are one attribute.
  if (isDurationLiteral(node)) return node.value;
  throw new Error(
    `TypeDBLite: unhandled literal kind '${String((node as { $type?: string })?.$type)}' — ` +
      'the grammar accepts it and the interpreter cannot store it (ADR-002 D7)',
  );
}

/**
 * 🔴 Translate a SQLite constraint failure into the message the repositories already match on.
 *
 * Consumers test for a unique constraint violation by matching `[CNT9] Constraint '@unique' has
 * been violated` **and** the attribute name. Without this translation the match fails, the catch
 * does not fire, and a duplicate registration stops being reported as a duplicate.
 *
 * Measured 2026-08-29: SQLite reports `UNIQUE constraint failed: attr.value` with `errcode` 2067
 * and names **neither** the index nor the attribute. So the attribute cannot be recovered from the
 * message — it has to come from the statement being executed, which is why this lives in the
 * interpreter and not in an adapter wrapped around it.
 */
export function translateConstraintError(
  error: unknown,
  attribute: string,
): unknown {
  const code = (error as { errcode?: number } | undefined)?.errcode;
  if (code !== 2067) return error;
  return new Error(
    `[CNT9] Constraint '@unique' has been violated for attribute '${attribute}'.`,
  );
}
