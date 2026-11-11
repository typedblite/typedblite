import {
  isFetchAllAttributes,
  isFetchAttribute,
  isFetchExpression,
  isFetchList,
  isFetchObject,
  isFetchSingle,
  isFunctionExpression,
  isVariableExpression,
  type Expression,
  type FetchObject,
  type FetchValue,
  type Pipeline,
  type ReturnStage,
} from '@typedblite/language';
import type { Range } from 'vscode-languageserver';
import { DiagnosticCode, rangeOf } from './diagnostics.js';
import { evaluate, shapeOfFunction, userFunctionOf, variablesOf, type ReturnShape, type SchemaContext, type ValueBinding } from './expressions.js';
import type { Refuse, SchemaFacts } from './schema-rules.js';
import { ownsKey, ownsSubject, relatesSubject } from './schema-subjects.js';
import { formatDuration, parseDuration } from './temporal.js';
import type { Binding } from './type-patterns.js';

/**
 * `fetch` — a JSON document per answer (fetch.feature).
 *
 * Two passes, as everywhere else in this engine: `checkFetch` refuses what it can from the query
 * and the schema alone, before any row exists (a refusal never depends on the data); then
 * `fetchDocument` builds one document per combination.
 *
 * 🔴 **A scalar `$p.x` is decided by the schema, not by the data.** The spec fetches
 * `$c.company-achievement` as a scalar although `company owns company-achievement @card(0..)`,
 * because `company owns achievement @card(0..1)` on its supertype caps it: an ownership's effective
 * upper bound is the least of every `@card` that applies to it — the owner's and its ancestors'
 * declarations, of the attribute and of its ancestors (fetch.feature L280, L597). Unannotated, an
 * ownership is `@card(0..1)`; `@key` is exactly one.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** What a `fetch` may read, from the query and the schema alone. */
export interface FetchScope {
  /** The variables the stages before `fetch` answer — the `select`, or every one the `match` names. */
  readonly available: ReadonlySet<string>;
  readonly kindOf: (variable: string) => 'thing' | 'type' | 'value' | undefined;
  /** The types a thing variable can be, schema-wide; `undefined` when nothing in the query says. */
  readonly typesOf: (variable: string) => readonly string[] | undefined;
  /** The labels a type variable can take, schema-wide; `undefined` when nothing in the query says. */
  readonly labelsOf: (variable: string) => readonly string[] | undefined;
}

/** What `fetch` needs from the interpreter. */
export interface FetchContext {
  readonly facts: SchemaFacts;
  readonly refuse: Refuse;
  /** A sub-query's scope: its stages planned on top of the parent's. */
  readonly scopeOf: (pipeline: Pipeline, parent: FetchScope) => FetchScope;
  /** A sub-query's answers from one parent answer — every stage run, seeded with it. */
  readonly rows: (pipeline: Pipeline, parent: FetchScope, seed: Record<string, Binding>) => Array<Record<string, Binding>>;
  /** What a `return` sub-query answers from one parent answer: its tuples. */
  readonly returned: (pipeline: Pipeline, parent: FetchScope, seed: Record<string, Binding>) => ReadonlyArray<ReadonlyArray<ValueBinding | undefined>>;
  /** What an expression evaluated in one answer may read — the schema, the bindings, function calls. */
  readonly contextFor: (combination: Record<string, Binding>) => SchemaContext;
  /** An owner's attributes in written order — of one type and its subtypes, or every one. */
  readonly attributes: (owner: number, attribute?: string) => Array<{ type: string; value: string }>;
  readonly typeOfThing: (iid: number) => string;
  readonly valueTypeOf: (attribute: string) => string | undefined;
}

// ── cardinality ──────────────────────────────────────────────────────────────

const selfAndAncestors = (type: string, facts: SchemaFacts): string[] => {
  const chain: string[] = [];
  for (let t: string | undefined = type; t !== undefined && !chain.includes(t); t = facts.parents.get(t)) chain.push(t);
  return chain;
};

/** The upper bound a recorded `@card` states — `@card(0..)` none, `@card(1..3)` three, `@card(2)` exactly two. */
export const cardMax = (card: string | undefined, absent = 1): number => {
  if (card === undefined) return absent;
  const range = /\(\s*\d+\s*\.\.\s*(\d*)\s*\)/.exec(card);
  if (range !== null) return range[1] === '' ? Infinity : Number(range[1]);
  const exact = /\(\s*(\d+)\s*\)/.exec(card);
  return exact === null ? absent : Number(exact[1]);
};

/** The upper bound one declared ownership states. */
const declaredMax = (owner: string, attribute: string, facts: SchemaFacts): number => {
  const recorded = facts.annotations.get(ownsSubject(owner, attribute));
  if (recorded?.has('key')) return 1;
  return cardMax(recorded?.get('card'));
};

/**
 * How many players one relation may hold in a role — the `relates` declaration's `@card`, on the
 * relation or the ancestor that declares the role; `@card(0..1)` when unannotated, as TypeDB has it.
 */
export const roleMax = (relation: string, role: string, facts: SchemaFacts): number => {
  for (const r of selfAndAncestors(relation, facts)) {
    if (facts.roles.get(r)?.has(role)) return cardMax(facts.annotations.get(relatesSubject(r, role))?.get('card'));
  }
  return 1;
};

/** The least upper bound of every declared ownership by `owner` (or an ancestor) of a type in `attributes`. */
const cappedMax = (owner: string, attributes: readonly string[], facts: SchemaFacts): number => {
  let max = Infinity;
  for (const o of selfAndAncestors(owner, facts)) {
    for (const a of attributes) {
      if (facts.owns.has(ownsKey(o, a))) max = Math.min(max, declaredMax(o, a, facts));
    }
  }
  return max;
};

/** How many of `attribute` one `owner` may hold — its effective upper bound. */
export const ownershipMax = (owner: string, attribute: string, facts: SchemaFacts): number =>
  cappedMax(owner, selfAndAncestors(attribute, facts), facts);

/** The attribute types an `owner` may hold that are `attribute` or one of its subtypes. */
const ownedWithin = (owner: string, attribute: string, facts: SchemaFacts): string[] => {
  const owners = selfAndAncestors(owner, facts);
  return [...facts.attributes].filter(
    (a) => selfAndAncestors(a, facts).includes(attribute) && owners.some((o) => facts.owns.has(ownsKey(o, a))),
  );
};

// ── values as JSON ───────────────────────────────────────────────────────────

/** `…:05` → `…:05.000000000`; a date on a datetime attribute is its midnight. */
const nanoseconds = (datetime: string): string => {
  const [date, time = '00:00:00'] = datetime.split('T');
  const [whole, fraction = ''] = time.split('.');
  return `${date}T${whole}.${fraction.padEnd(9, '0').slice(0, 9)}`;
};

/** A value as TypeDB's fetch writes it: numbers as numbers, a decimal with its `dec`, temporals in full. */
export function jsonOf(valueType: string, text: string): JsonValue {
  switch (valueType) {
    case 'integer':
    case 'long':
    case 'double':
      return Number(text);
    case 'boolean':
      return text === 'true';
    case 'decimal':
      return `${text}dec`;
    case 'datetime':
      return nanoseconds(text);
    case 'datetime-tz': {
      // `…+0100` → `…+01:00`; an IANA zone keeps its space.
      const zone = /^(.*?)(?: ([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)|([+-]\d{2}):?(\d{2})|Z)$/.exec(text);
      if (zone === null) return text;
      const [, local, iana, hours, minutes] = zone;
      return `${nanoseconds(local)}${iana !== undefined ? ` ${iana}` : hours !== undefined ? `${hours}:${minutes}` : 'Z'}`;
    }
    case 'duration':
      // The seconds' fraction to the nanosecond, as TypeDB writes it (fetch.feature L746).
      return formatDuration(parseDuration(text, (_c, message) => { throw new Error(message); }, undefined), true);
    default:
      return text;
  }
}

// ── functions and return sub-queries ────────────────────────────────────────

const shapeOfReturn = (stage: ReturnStage): ReturnShape => ({
  stream: stage.streamed.length > 0,
  reduce: stage.reductions.length > 0,
  width: stage.streamed.length + stage.selected.length + stage.reductions.length,
});

/**
 * Where a function's or a sub-query's answers go (fetch.feature L1961–L2930): a SCALAR position takes
 * one value — a stream "must be wrapped in `[]`", a tuple "returns a non-scalar result"; a LIST takes
 * a stream of single values, one value, or a reduction's tuple flattened — a stream of tuples is
 * refused.
 */
function checkShape(shape: ReturnShape, position: 'scalar' | 'list', what: string, subquery: boolean, refuse: Refuse, at: Range | undefined): void {
  if (position === 'scalar') {
    if (shape.stream) refuseFetch(refuse, `${what} returns a stream, which must be wrapped in \`[]\` to collect into a list.`, at);
    if (shape.width > 1) refuseFetch(refuse, `${what} returns a non-scalar result, and this fetch entry takes one value.`, at);
    return;
  }
  if (shape.width > 1 && !(shape.reduce && !shape.stream)) {
    refuseFetch(refuse, subquery && shape.stream ? `${what} returns a non-scalar non-reduce result, which a list cannot hold.` : `${what} returns a non-scalar result, which a list cannot hold.`, at);
  }
}

const tupleJson = (tuple: ReadonlyArray<ValueBinding | undefined>): JsonValue[] => tuple.map((v) => (v === undefined ? null : jsonOf(v.valueType, v.value)));

function answersJson(tuples: ReadonlyArray<ReadonlyArray<ValueBinding | undefined>>, shape: ReturnShape, position: 'scalar' | 'list'): JsonValue {
  if (position === 'scalar') return tuples[0] === undefined ? null : tupleJson(tuples[0])[0];
  // A reduction's one tuple is the list itself — `[ … return count($n), sum($a); ]` is `[2, 20]`.
  if (!shape.stream && shape.reduce) return tuples[0] === undefined ? [] : tupleJson(tuples[0]);
  return tuples.map((tuple) => tupleJson(tuple)[0]);
}

// ── the static pass ──────────────────────────────────────────────────────────

const refuseFetch = (refuse: Refuse, message: string, at: Range | undefined): never => refuse(DiagnosticCode.fetch, message, at);

const requireAvailable = (variable: string, scope: FetchScope, refuse: Refuse, at: Range | undefined): void => {
  if (!scope.available.has(variable)) refuseFetch(refuse, `The variable '${variable.slice(1)}' is not available.`, at);
};

/** An entity or relation is not a value a document can hold — TypeDB refuses it by kind. */
const refuseThing = (variable: string, scope: FetchScope, facts: SchemaFacts, refuse: Refuse, at: Range | undefined): void => {
  if (scope.kindOf(variable) !== 'thing') return;
  const types = scope.typesOf(variable);
  const relations = types !== undefined && types.length > 0 && types.every((t) => facts.relations.has(t));
  refuseFetch(refuse, `Fetching ${relations ? 'relations' : 'entities'} is not supported: fetch the attributes of '${variable.slice(1)}' instead.`, at);
};

function checkProjection(variable: string, attribute: string, scalar: boolean, scope: FetchScope, ctx: FetchContext, at: Range | undefined): void {
  const { facts, refuse } = ctx;
  requireAvailable(variable, scope, refuse, at);
  if (!facts.attributes.has(attribute)) refuse(DiagnosticCode.unknownType, `Type label '${attribute}' not found.`, at);
  if (scope.kindOf(variable) !== 'thing') {
    refuseFetch(refuse, `'${variable.slice(1)}' is not an entity or a relation, and has no attributes to fetch.`, at);
  }
  const owners = scope.typesOf(variable) ?? [...facts.types];
  let owned = false;
  for (const owner of owners) {
    const within = ownedWithin(owner, attribute, facts);
    if (within.length === 0) continue;
    owned = true;
    if (!scalar) continue;
    // One value at most: capped by an ownership of the attribute (or an ancestor), or summed over
    // the subtypes the owner may hold.
    if (cappedMax(owner, selfAndAncestors(attribute, facts), facts) <= 1) continue;
    if (within.reduce((sum, a) => sum + ownershipMax(owner, a, facts), 0) <= 1) continue;
    refuseFetch(refuse, `'${variable.slice(1)}.${attribute}' is fetched as a single value, but this attribute can be owned more than 1 time; fetch it as a list: [ ${variable}.${attribute} ].`, at);
  }
  if (!owned) {
    refuseFetch(refuse, `The attribute '${attribute}' cannot be owned by any type '${variable.slice(1)}' can be.`, at);
  }
}

function checkExpressionReads(expression: Expression, scope: FetchScope, ctx: FetchContext, position: 'scalar' | 'list' = 'scalar'): void {
  const at = rangeOf(expression);
  const definition = userFunctionOf(expression);
  if (definition !== undefined) {
    checkShape(shapeOfFunction(definition), position, `'${definition.name}'`, false, ctx.refuse, at);
    // An argument nothing binds is a value read before it is bound (fetch.feature L3127).
    for (const variable of variablesOf(expression)) {
      if (!scope.available.has(variable)) refuseFetch(ctx.refuse, `The variable '${variable.slice(1)}' must be bound to a value before it's used.`, at);
    }
  }
  for (const variable of variablesOf(expression)) requireAvailable(variable, scope, ctx.refuse, at);
  if (isVariableExpression(expression)) refuseThing(expression.variable, scope, ctx.facts, ctx.refuse, at);
}

function checkValue(value: FetchValue, scope: FetchScope, ctx: FetchContext): void {
  if (isFetchObject(value)) return checkFetch(value, scope, ctx);
  if (isFetchAttribute(value)) return checkProjection(value.variable, value.attribute, true, scope, ctx, rangeOf(value));
  if (isFetchExpression(value)) return checkExpressionReads(value.expression, scope, ctx);
  if (isFetchList(value)) {
    if (value.attribute) return checkProjection(value.attribute.variable, value.attribute.attribute, false, scope, ctx, rangeOf(value));
    if (value.expression) return checkExpressionReads(value.expression, scope, ctx, 'list');
    if (value.subquery) return checkSubquery(value.subquery, scope, ctx, 'list');
  }
  if (isFetchSingle(value)) return checkSubquery(value.subquery as unknown as Pipeline, scope, ctx, 'scalar');
}

/**
 * A list sub-query reads its parent's answers and answers documents of its own: it must end in a
 * `fetch`, and it may not write — a `fetch` is a read (fetch.feature L1478).
 */
function checkSubquery(subquery: Pipeline, parent: FetchScope, ctx: FetchContext, position: 'scalar' | 'list'): void {
  const at = rangeOf(subquery);
  if (subquery.stages.some((stage) => stage.$type === 'InsertStage' || stage.$type === 'PutStage' || stage.$type === 'DeleteStage' || stage.$type === 'UpdateStage')) {
    refuseFetch(ctx.refuse, 'A fetch sub-query reads; it may not write.', at);
  }
  // `[ match …; return { $n }; ]`, `( match …; return count($n); )` — a sub-query answering values.
  if (subquery.returnStage) {
    ctx.scopeOf(subquery, parent);
    checkShape(shapeOfReturn(subquery.returnStage), position, 'This sub-query', true, ctx.refuse, at);
    return;
  }
  if (!subquery.fetch || position === 'scalar') {
    refuseFetch(ctx.refuse, 'Invalid fetch sub-query: no fetch stage ends it, and a list sub-query answers documents.', at);
  }
  checkFetch((subquery.fetch as NonNullable<Pipeline['fetch']>).body, ctx.scopeOf(subquery, parent), ctx);
}

/** Everything a `fetch` object can be refused for before any row: see the module comment. */
export function checkFetch(object: FetchObject, scope: FetchScope, ctx: FetchContext): void {
  const keys = new Set<string>();
  for (const entry of object.entries) {
    if (isFetchAllAttributes(entry)) {
      requireAvailable(entry.variable, scope, ctx.refuse, rangeOf(entry));
      if (scope.kindOf(entry.variable) !== 'thing') {
        refuseFetch(ctx.refuse, `'${entry.variable.slice(1)}' is not an entity or a relation, and has no attributes to fetch.`, rangeOf(entry));
      }
      continue;
    }
    if (keys.has(entry.key)) {
      refuseFetch(ctx.refuse, `The fetch object has multiple mappings for one key: "${entry.key}".`, rangeOf(entry));
    }
    keys.add(entry.key);
    checkValue(entry.value, scope, ctx);
  }
}

// ── the documents ────────────────────────────────────────────────────────────

const schemaContext = (combination: Record<string, Binding>, facts: SchemaFacts): SchemaContext => ({
  facts,
  typeOf: (variable) => {
    const binding = combination[variable];
    return typeof binding === 'string' ? binding : undefined;
  },
});

function callJson(expression: Expression, combination: Record<string, Binding>, ctx: FetchContext, position: 'scalar' | 'list'): JsonValue | undefined {
  const definition = userFunctionOf(expression);
  if (definition === undefined || !isFunctionExpression(expression)) return undefined;
  const context = ctx.contextFor(combination);
  const args = expression.arguments.map((argument) => {
    if (isVariableExpression(argument)) return combination[argument.variable];
    const value = evaluate(argument, (v) => (typeof combination[v] === 'object' ? (combination[v] as ValueBinding) : undefined), ctx.refuse, context);
    return { kind: 'value' as const, valueType: value.valueType, value: value.text };
  });
  const tuples = context.call?.(definition, args, rangeOf(expression)) ?? [];
  return answersJson(tuples, shapeOfFunction(definition), position);
}

function expressionJson(expression: Expression, combination: Record<string, Binding>, ctx: FetchContext): JsonValue {
  const called = callJson(expression, combination, ctx, 'scalar');
  if (called !== undefined) return called;
  // A variable a `try` left empty makes the value empty: `null` (fetch.feature L957).
  if (variablesOf(expression).some((variable) => variable in combination && combination[variable] === undefined)) return null;
  if (isVariableExpression(expression)) {
    const binding = combination[expression.variable];
    // A type is its label; a thing was refused in `checkFetch`.
    if (typeof binding === 'string') return binding;
    if (binding === undefined || typeof binding === 'number') return null;
    return jsonOf(binding.valueType, binding.value);
  }
  const env = (variable: string): ValueBinding | undefined => {
    const binding = combination[variable];
    return typeof binding === 'object' ? binding : undefined;
  };
  const value = evaluate(expression, env, ctx.refuse, ctx.contextFor(combination));
  return jsonOf(value.valueType, value.text);
}

function projectionJson(variable: string, attribute: string, scalar: boolean, combination: Record<string, Binding>, ctx: FetchContext): JsonValue {
  const owner = combination[variable];
  const values = typeof owner === 'number' ? ctx.attributes(owner, attribute) : [];
  const json = values.map((v) => jsonOf(ctx.valueTypeOf(v.type) ?? 'string', v.value));
  return scalar ? (json[0] ?? null) : json;
}

/** `{ $p.* }` — each attribute type the thing holds, a scalar where it can hold one value, else a list. */
function allAttributes(variable: string, combination: Record<string, Binding>, ctx: FetchContext): Record<string, JsonValue> {
  const owner = combination[variable];
  if (typeof owner !== 'number') return {};
  const ownerType = ctx.typeOfThing(owner);
  const grouped = new Map<string, JsonValue[]>();
  for (const v of ctx.attributes(owner)) {
    grouped.set(v.type, [...(grouped.get(v.type) ?? []), jsonOf(ctx.valueTypeOf(v.type) ?? 'string', v.value)]);
  }
  const document: Record<string, JsonValue> = {};
  for (const [type, values] of grouped) {
    document[type] = ownershipMax(ownerType, type, ctx.facts) <= 1 ? values[0] : values;
  }
  return document;
}

function valueJson(value: FetchValue, combination: Record<string, Binding>, scope: FetchScope, ctx: FetchContext): JsonValue {
  if (isFetchObject(value)) {
    // `{ $e.* }` of a thing a `try` left empty is no object at all: `null` (fetch.feature L882).
    const [only] = value.entries;
    if (value.entries.length === 1 && isFetchAllAttributes(only) && only.variable in combination && combination[only.variable] === undefined) return null;
    return fetchDocument(value, combination, scope, ctx);
  }
  if (isFetchAttribute(value)) return projectionJson(value.variable, value.attribute, true, combination, ctx);
  if (isFetchExpression(value)) return expressionJson(value.expression, combination, ctx);
  if (isFetchList(value)) {
    if (value.attribute) return projectionJson(value.attribute.variable, value.attribute.attribute, false, combination, ctx);
    if (value.expression) return callJson(value.expression, combination, ctx, 'list') ?? [expressionJson(value.expression, combination, ctx)];
    if (value.subquery?.returnStage) {
      const subquery = value.subquery;
      return answersJson(ctx.returned(subquery, scope, seedFrom(scope, combination)), shapeOfReturn(subquery.returnStage as ReturnStage), 'list');
    }
    if (value.subquery?.fetch) {
      const subquery = value.subquery;
      const subscope = ctx.scopeOf(subquery, scope);
      // The parent's answer is the sub-query's starting point: what it binds stays bound.
      const seed = seedFrom(scope, combination);
      const body = (subquery.fetch as NonNullable<Pipeline['fetch']>).body;
      return ctx.rows(subquery, scope, seed).map((row) => fetchDocument(body, row, subscope, ctx));
    }
  }
  if (isFetchSingle(value)) {
    return answersJson(ctx.returned(value.subquery as unknown as Pipeline, scope, seedFrom(scope, combination)), shapeOfReturn(value.subquery.returnStage), 'scalar');
  }
  return null;
}

/** The parent's answer as a sub-query's starting point: what it binds stays bound. */
const seedFrom = (scope: FetchScope, combination: Record<string, Binding>): Record<string, Binding> => {
  const seed: Record<string, Binding> = {};
  // 🔴 An EMPTY variable (a `try` that matched nothing) stays present and empty: a sub-query that uses
  // it answers nothing for this row, where an absent one would be enumerated (fetch.feature L882).
  for (const variable of scope.available) if (variable in combination) seed[variable] = combination[variable];
  return seed;
};

/** One answer's document. */
export function fetchDocument(object: FetchObject, combination: Record<string, Binding>, scope: FetchScope, ctx: FetchContext): JsonValue {
  const document: Record<string, JsonValue> = {};
  for (const entry of object.entries) {
    if (isFetchAllAttributes(entry)) Object.assign(document, allAttributes(entry.variable, combination, ctx));
    else document[entry.key] = valueJson(entry.value, combination, scope, ctx);
  }
  return document;
}
