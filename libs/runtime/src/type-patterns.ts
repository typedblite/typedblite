import {
  isHasProperty,
  isIsaProperty,
  isKindPattern,
  isLabelProperty,
  isLinksProperty,
  isOwnsProperty,
  isPlaysProperty,
  isRelatesProperty,
  isValueProperty,
  isKindLabelPattern,
  isSubProperty,
  isThingPattern,
  isTypePattern,
  type Pattern,
  type Property,
} from '@typedblite/language';
import type { Range } from 'vscode-languageserver';
import { DiagnosticCode, rangeOf } from './diagnostics.js';
import type { ValueBinding } from './expressions.js';
import { valueTypeOf, type Refuse, type SchemaFacts } from './schema-rules.js';
import { ownsKey, playsSubject, roleRef } from './schema-subjects.js';

/**
 * Type variables in `match` — Phase 05 of the conformance feature.
 *
 * A type pattern constrains a variable over the SCHEMA, not the data: `$x sub person` is answered
 * from `SchemaFacts` alone, one candidate per type label. The universe is every entity, relation
 * and attribute type, and every role type as `relation:role` — the labels the spec writes as
 * `label:person` and `label:employment:employee`.
 *
 * 🔴 **A type pattern and a thing pattern share a head.** `$x sub person;` and `$x isa person;`
 * both begin `$x`; the properties say which it is, and a head that mixes `has`/`links` with
 * `sub`/`owns`/… is refused rather than guessed. `isa $t` is the bridge: a thing constraint whose
 * type is a type variable, bound here if a type pattern binds it and by the thing's own type
 * otherwise (match.feature L842: `$x isa $y` answers `label:person` for each person).
 */
export interface TypeConstraint {
  /** The variable, or a synthetic `__typeN` for a label-headed pattern (`person owns $x`). */
  readonly variable: string;
  /** A fixed label — the pattern's subject when it is a label, or its `label X`. */
  fixed?: string;
  kind?: 'entity' | 'relation' | 'attribute';
  /** Two different labels or kinds for one variable: nothing satisfies it (review, round 1). */
  impossible?: boolean;
  subs: Array<{ readonly type?: string; readonly variable?: string; readonly direct: boolean }>;
  owns: Array<{ readonly attribute?: string; readonly variable?: string }>;
  plays: Array<{ readonly role?: string; readonly variable?: string }>;
  /** `relates $r as parent` — `as` is the role the related role is, or specialises (by name, or `relation:role`). */
  relates: Array<{ readonly role?: string; readonly variable?: string; readonly as?: string; readonly asVariable?: string }>;
  /** `$x value integer` — an attribute type holding that value type, its own or inherited. */
  values?: string[];
  readonly range: Range | undefined;
}

/**
 * A combination binds a thing variable to an iid, a type variable to a label, or — Phase 06 — an
 * attribute or `let` variable to a value.
 */
export type Binding = number | string | ValueBinding;

const TYPE_PROPERTY = (property: Property): boolean =>
  isLabelProperty(property) || isSubProperty(property) || isOwnsProperty(property) ||
  isPlaysProperty(property) || isRelatesProperty(property) || isValueProperty(property);

/** Whether a variable-headed pattern is a type pattern — and a refusal when it is both. */
export function isTypeHead(pattern: Pattern, refuse: Refuse): boolean {
  if (isKindPattern(pattern) || isTypePattern(pattern) || isKindLabelPattern(pattern)) return true;
  if (!isThingPattern(pattern)) return false;
  const typed = pattern.properties.some(TYPE_PROPERTY);
  const thinged = pattern.properties.some((p) => isHasProperty(p) || isLinksProperty(p) || (isIsaProperty(p) && p.players !== undefined));
  if (typed && thinged) {
    refuse(
      DiagnosticCode.mixedPattern,
      `'${pattern.variable}' is used as a type (sub/owns/plays/relates/label) and as a thing (has/links) in one pattern; a variable is one or the other.`,
      rangeOf(pattern),
    );
  }
  return typed;
}

/** The type constraints of a match, merged by variable — a repeated variable narrows. */
export function typeConstraintsOf(patterns: readonly Pattern[], refuse: Refuse): TypeConstraint[] {
  const byVariable = new Map<string, TypeConstraint>();
  let synthetic = 0;
  const constraintFor = (variable: string, range: Range | undefined): TypeConstraint => {
    const existing = byVariable.get(variable);
    if (existing) return existing;
    const created: TypeConstraint = { variable, subs: [], owns: [], plays: [], relates: [], range };
    byVariable.set(variable, created);
    return created;
  };
  for (const pattern of patterns) {
    if (!isTypeHead(pattern, refuse)) continue;
    let constraint: TypeConstraint;
    if (isTypePattern(pattern)) {
      constraint = constraintFor(`__type${synthetic++}`, rangeOf(pattern));
      constraint.fixed = pattern.subject;
    } else if (isKindLabelPattern(pattern)) {
      // `entity person;` — that label, of that kind: answered once, or not at all.
      constraint = constraintFor(`__type${synthetic++}`, rangeOf(pattern));
      constraint.fixed = pattern.label;
      constraint.kind = pattern.kind as TypeConstraint['kind'];
      continue;
    } else if (isKindPattern(pattern)) {
      constraint = constraintFor(pattern.variable, rangeOf(pattern));
      if (constraint.kind !== undefined && constraint.kind !== pattern.kind) constraint.impossible = true;
      constraint.kind = pattern.kind as TypeConstraint['kind'];
    } else if (isThingPattern(pattern)) {
      constraint = constraintFor(pattern.variable, rangeOf(pattern));
    } else {
      continue;
    }
    for (const property of pattern.properties) {
      if (isLabelProperty(property)) {
        if (constraint.fixed !== undefined && constraint.fixed !== property.label) constraint.impossible = true;
        constraint.fixed = property.label;
      } else if (isSubProperty(property)) {
        // `$x sub $y` binds both: `$x` takes every label, `$y` that label and each above it (or its
        // parent, for `sub!`) — reflexive, as TypeDB's `sub` is (match.feature L210, L5229). A later
        // constraint on `$y` filters what this bound.
        // A repeated `sub` NARROWS — `$x sub writer; $x sub person;` is writer's family (review, round 1).
        constraint.subs.push({ type: property.type, variable: property.typeVariable, direct: property.direct === true });
      } else if (isOwnsProperty(property)) {
        // `$p owns name @card(5..)` parses, as TypeDB's grammar admits it; neither a match nor a write
        // can act on an annotation there (update.feature L86 — TypeDB's own match leaves it a TODO).
        if (property.annotations.length > 0) refuse(DiagnosticCode.mixedPattern, `An annotation on \`owns\` in a pattern is not supported: annotations are schema, written by \`define\`.`, rangeOf(property));
        constraint.owns.push({ attribute: property.attribute, variable: property.attributeVariable });
      }
      else if (isPlaysProperty(property)) {
        constraint.plays.push({
          role: property.role ? roleRef(property.role.relation, property.role.role) : undefined,
          variable: property.roleVariable,
        });
      } else if (isValueProperty(property)) (constraint.values ??= []).push(property.valueType === 'long' ? 'integer' : property.valueType);
      else if (isRelatesProperty(property)) constraint.relates.push({ role: property.role, variable: property.roleVariable, as: property.specialises, asVariable: property.specialisesVariable });
      else if (isIsaProperty(property) || isHasProperty(property) || isLinksProperty(property)) {
        // `person has name $n;` — a thing property on a type subject (review, round 1).
        refuse(DiagnosticCode.mixedPattern, `'${constraint.fixed ?? constraint.variable}' is a type pattern and cannot carry \`isa\`, \`has\` or \`links\`.`, rangeOf(property));
      }
    }
  }
  return [...byVariable.values()];
}

// ── the schema, as a type universe ──────────────────────────────────────────

const ancestorsOf = (type: string, facts: SchemaFacts): string[] => {
  const chain: string[] = [];
  let current = facts.parents.get(type);
  while (current !== undefined && !chain.includes(current) && current !== type) {
    chain.push(current);
    current = facts.parents.get(current);
  }
  return chain;
};

const descendantsOf = (type: string, facts: SchemaFacts): string[] => {
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
};

/** Every type label the schema has, role types as `relation:role`. */
const universe = (facts: SchemaFacts): string[] => [
  ...facts.types,
  ...facts.attributes,
  ...[...facts.roles].flatMap(([relation, roles]) => [...roles].map((role) => roleRef(relation, role))),
];

const kindOf = (label: string, facts: SchemaFacts): 'entity' | 'relation' | 'attribute' | 'role' | undefined =>
  facts.relations.has(label)
    ? 'relation'
    : facts.types.has(label)
      ? 'entity'
      : facts.attributes.has(label)
        ? 'attribute'
        : label.includes(':')
          ? 'role'
          : undefined;

/** The attributes a type owns — its own and its ancestors'. */
const ownedBy = (type: string, facts: SchemaFacts): string[] =>
  [type, ...ancestorsOf(type, facts)].flatMap((t) =>
    [...facts.attributes].filter((attribute) => facts.owns.has(ownsKey(t, attribute))),
  );

/** The roles a type plays — its own and its ancestors' — as `relation:role`. */
const playedBy = (type: string, facts: SchemaFacts): string[] =>
  [type, ...ancestorsOf(type, facts)].flatMap((t) =>
    [...facts.plays].filter((key) => key.startsWith(playsSubject(t, ''))).map((key) => key.slice(playsSubject(t, '').length)),
  );

/**
 * The roles a relation relates — its own and its ancestors', each as the DECLARING relation's
 * `relation:role`, which is how the spec labels an inherited role (`label:employment:employee`
 * for a part-time-employment).
 */
const relatedBy = (relation: string, facts: SchemaFacts): string[] =>
  [relation, ...ancestorsOf(relation, facts)].flatMap((t) => [...(facts.roles.get(t) ?? [])].map((role) => roleRef(t, role)));

// ── solving ─────────────────────────────────────────────────────────────────

/**
 * Extend each combination with every binding of the type constraints, in order. A variable
 * already bound (by an earlier constraint, or by `isa $t` on a thing) is checked, not re-bound.
 * A fixed label the schema does not know is refused, as `checkKnown` refuses one on a thing.
 */
export function solveTypes(
  constraints: readonly TypeConstraint[],
  facts: SchemaFacts,
  combinations: Array<Record<string, Binding>>,
  refuse: Refuse,
): Array<Record<string, Binding>> {
  const labels = universe(facts);
  // Role types have parents too: `fathership:father` is below `parentship:parent` once it specialises
  // it, so `sub` and `as` walk one graph (define.feature L635, match.feature L3546).
  facts = { ...facts, parents: new Map([...facts.parents, ...facts.specialises]) };
  // Every constraint's names are checked before any is solved, so a contradiction in one cannot
  // hide a typo in another (review, round 2).
  for (const constraint of constraints) {
    for (const fixed of [constraint.fixed, ...constraint.subs.map((sub) => sub.type)]) {
      if (fixed !== undefined && !labels.includes(fixed)) {
        refuse(
          DiagnosticCode.unknownType,
          `Unknown type '${fixed}': type label '${fixed}' not found. The applied schema defines: ${[...facts.types, ...facts.attributes].sort().join(', ') || '(nothing)'}`,
          constraint.range,
        );
      }
    }
    for (const owns of constraint.owns) {
      if (owns.attribute !== undefined && !facts.attributes.has(owns.attribute)) {
        refuse(DiagnosticCode.unknownAttribute, `Unknown attribute '${owns.attribute}'.`, constraint.range);
      }
    }
    for (const plays of constraint.plays) {
      if (plays.role !== undefined && !labels.includes(plays.role)) {
        refuse(DiagnosticCode.unknownRole, `Role label not found '${plays.role}': no relation declares it.`, constraint.range);
      }
    }
    for (const relates of constraint.relates) {
      if (relates.role !== undefined && ![...facts.roles.values()].some((roles) => roles.has(relates.role as string))) {
        refuse(DiagnosticCode.unknownRole, `Role label not found '${relates.role}': no relation declares it.`, constraint.range);
      }
    }
  }
  for (const constraint of constraints) {
    if (constraint.impossible) return [];
    combinations = combinations.flatMap((combination) => {
      const bound = combination[constraint.variable];
      const candidates = typeof bound === 'string' ? [bound] : labels;
      return candidates.flatMap((label) => solveOne(constraint, label, facts, combination));
    });
  }
  return combinations;
}

/** Every extension of `combination` in which `label` satisfies the constraint. */
function solveOne(
  constraint: TypeConstraint,
  label: string,
  facts: SchemaFacts,
  combination: Record<string, Binding>,
): Array<Record<string, Binding>> {
  if (constraint.fixed !== undefined && constraint.fixed !== label) return [];
  const kind = kindOf(label, facts);
  if (constraint.kind !== undefined && kind !== constraint.kind) return [];

  for (const valueType of constraint.values ?? []) {
    if (kind !== 'attribute') return [];
    const held = valueTypeOf(label, facts);
    if ((held === 'long' ? 'integer' : held) !== valueType) return [];
  }

  let results: Array<Record<string, Binding>> = [{ ...combination, [constraint.variable]: label }];

  for (const { type, variable, direct } of constraint.subs) {
    if (type !== undefined) {
      // `$x sub person` — the label is `person` or below it (one step for `sub!`).
      const family = direct ? [...facts.parents].filter(([, p]) => p === type).map(([c]) => c) : [type, ...descendantsOf(type, facts)];
      if (!family.includes(label)) return [];
    } else if (variable !== undefined) {
      // `writer sub $x` — `$x` is `writer` or above it (its parent for `sub!`).
      const above = direct ? [facts.parents.get(label)].filter((p): p is string => p !== undefined) : [label, ...ancestorsOf(label, facts)];
      results = bindEach(results, variable, above);
    }
  }
  for (const owns of constraint.owns) {
    if (kind === 'attribute' || kind === 'role') return [];
    const owned = ownedBy(label, facts);
    if (owns.attribute !== undefined) {
      if (!owned.includes(owns.attribute)) return [];
    } else if (owns.variable !== undefined) {
      results = bindEach(results, owns.variable, owned);
    }
  }
  for (const plays of constraint.plays) {
    if (kind === 'attribute' || kind === 'role') return [];
    const played = playedBy(label, facts);
    if (plays.role !== undefined) {
      if (!played.includes(plays.role)) return [];
    } else if (plays.variable !== undefined) {
      results = bindEach(results, plays.variable, played);
    }
  }
  for (const relates of constraint.relates) {
    if (kind !== 'relation') return [];
    // `relates $r as parent` keeps the related roles that are `parent`, or specialise it, at any depth.
    const chain = (role: string): string[] => [role, ...ancestorsOf(role, facts)];
    const matchesAs = (role: string): boolean =>
      relates.as === undefined || chain(role).some((r) => (relates.as as string).includes(':') ? r === relates.as : r.split(':')[1] === relates.as);
    const related = relatedBy(label, facts).filter(matchesAs);
    if (relates.role !== undefined) {
      if (!related.some((r) => r.split(':')[1] === relates.role)) return [];
    } else if (relates.variable !== undefined) {
      results = bindEach(results, relates.variable, related);
    }
    if (relates.asVariable !== undefined) {
      // `relates $r as $p` — `$p` is each role the related one is or specialises.
      results = results.flatMap((row) => {
        const bound = typeof row[relates.variable ?? ''] === 'string' ? [row[relates.variable as string] as string] : related.filter((r) => relates.role === undefined || r.split(':')[1] === relates.role);
        return bindEach([row], relates.asVariable as string, bound.flatMap(chain));
      });
    }
  }
  return results;
}

/** Bind `variable` to each of `values` — or keep only the combinations where its binding is one of them. */
function bindEach(
  results: Array<Record<string, Binding>>,
  variable: string,
  values: readonly string[],
): Array<Record<string, Binding>> {
  return results.flatMap((combination) => {
    const bound = combination[variable];
    if (typeof bound === 'string') return values.includes(bound) ? [combination] : [];
    return [...new Set(values)].map((value) => ({ ...combination, [variable]: value }));
  });
}


