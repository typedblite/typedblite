import type { SqliteDatabase } from './sqlite-database.js';
import { hasAttributeTables, rescopeOwnerships } from './attribute-store.js';
import {
  isCapabilityOwns,
  isCapabilityPlays,
  isCapabilityRelates,
  isCapabilitySub,
  isCapabilityValue,
  isKeyAnnotation,
  isOwnsTrait,
  isRedefineAnnotations,
  isRedefineLabel,
  isRedefineRoleLabel,
  isRedefineSub,
  isRedefineTrait,
  isRedefineValue,
  isRelatesTrait,
  isUndefineAnnotation,
  isUndefineFrom,
  isUndefineOwns,
  isUndefinePlays,
  isUndefineRelates,
  isUndefineSpecialise,
  isUndefineSub,
  isUndefineType,
  isUndefineValue,
  isUniqueAnnotation,
  ADMITTED,
  type Annotation,
  type AnnotationCategory,
  type RedefineClause,
  type RedefineType,
  type UndefineClause,
  type UndefineFrom,
} from '@typedblite/language';
import { DiagnosticCode, rangeOf } from './diagnostics.js';
import { checkArgumentsFit, checkSpecialisation, type DataFacts, type Refuse, type SchemaFacts } from './schema-rules.js';
import {
  SEP,
  ownsKey,
  ownsSubject,
  playsSubject,
  recordCategory,
  recordText,
  relatesSubject,
  roleRef,
  subSubject,
  traitSubject,
  typeSubject,
  valueSubject,
} from './schema-subjects.js';

/**
 * `undefine` and `redefine` — the two schema stages Phase 04 of the conformance feature added.
 *
 * 🔴 **Every change is SQL against the `schema_*` tables inside one transaction, and the in-memory
 * model is reloaded from the tables afterwards** — never patched alongside. `define` maintains
 * its model in step with its DDL because it only ever adds; a stage that removes and renames
 * would have to mirror every table in every map, and a mirror that drifts is a schema the rules
 * read wrongly with no error anywhere. Reloading costs a few `SELECT`s per statement.
 *
 * ⚠️ The rules here are the specification's (`undefine.feature`, `redefine.feature` at the pin),
 * and each names the line it answers. Where TypeDB's message is what a scenario matches on, the
 * message carries that phrase: *"Try define instead"*, *"already defined"*, *"Nothing was
 * redefined"*, *"should be unique"*, *"no defined"*, *"must be deleted"*.
 */
export interface MutationContext {
  readonly db: SqliteDatabase;
  readonly schema: SchemaFacts;
  readonly data: DataFacts;
  readonly refuse: Refuse;
  /** Rebuild `schema` from the tables — called between the lines of one statement, inside its transaction. */
  readonly reload: () => void;
  /** A caller's transaction is open: each statement is a savepoint inside it, not a transaction of its own. */
  readonly nested?: boolean;
}

type Kind = 'entity' | 'relation' | 'attribute';

const kindOf = (name: string, facts: SchemaFacts): Kind | undefined =>
  facts.relations.has(name)
    ? 'relation'
    : facts.types.has(name)
      ? 'entity'
      : facts.attributes.has(name)
        ? 'attribute'
        : undefined;

const ancestorsOf = (type: string, facts: SchemaFacts): string[] => {
  const chain: string[] = [];
  let current = facts.parents.get(type);
  while (current !== undefined && !chain.includes(current) && current !== type) {
    chain.push(current);
    current = facts.parents.get(current);
  }
  return chain;
};

const childrenOf = (type: string, facts: SchemaFacts): string[] =>
  [...facts.parents].filter(([, parent]) => parent === type).map(([child]) => child);

/** `true` when a type owns the attribute itself — not through a parent. */
const ownsRow = (owner: string, attribute: string, facts: SchemaFacts): boolean =>
  facts.owns.has(ownsKey(owner, attribute));

const article = (word: string): string => (/^[aeiou]/.test(word) ? 'an' : 'a');

// ── redefine ───────────────────────────────────────────────────────────────

export function applyRedefine(clause: RedefineClause, context: MutationContext): void {
  const redefinition = clause.redefinition;
  if (redefinition === undefined) return; // `redefine` alone is valid, and changes nothing (L46).
  transaction(context.db, context.nested === true, () => {
    if (isRedefineRoleLabel(redefinition)) {
      renameRole(redefinition.role.relation, redefinition.role.role, redefinition.newLabel, redefinition, context);
    } else {
      redefineType(redefinition, context);
    }
  });
}

function redefineType(node: RedefineType, context: MutationContext): void {
  const { schema, refuse } = context;
  const name = node.type;
  const kind = kindOf(name, schema);
  if (kind === undefined) {
    return refuse(
      DiagnosticCode.unknownType,
      `Unknown type '${name}': nothing to redefine. Try define instead.`,
      rangeOf(node),
    );
  }
  if (node.kind !== undefined && node.kind !== kind) {
    refuse(
      DiagnosticCode.kindChanged,
      `'${name}' is ${article(kind)} ${kind} type, not ${article(node.kind)} ${node.kind} type; a label keeps its kind.`,
      rangeOf(node),
    );
  }
  const change = node.change;
  if (isRedefineLabel(change)) return renameType(name, kind, change.newLabel, node, context);
  if (isRedefineSub(change)) return redefineSub(name, kind, change.superType, node, context);
  if (isRedefineValue(change)) return redefineValue(name, kind, change.valueType, change.annotations, node, context);
  if (isRedefineAnnotations(change)) return redefineAnnotations(typeSubject(name), `'${name}'`, change.annotations, node, context);
  if (isRedefineTrait(change)) {
    const trait = change.trait;
    if (isRelatesTrait(trait) && kind !== 'relation') {
      refuse(
        DiagnosticCode.relatesOnNonRelation,
        `'${name}' is ${article(kind)} ${kind} type and relates nothing; '${trait.name}' cannot be redefined on it (L222).`,
        rangeOf(node),
      );
    }
    const { subject, name: capability } = traitSubject(name, trait);
    const exists = isOwnsTrait(trait)
      ? ownsRow(name, trait.attribute.$refText, schema)
      : isRelatesTrait(trait)
        ? schema.roles.get(name)?.has(trait.name) === true
        : schema.plays.has(playsSubject(name, roleRef(trait.role.relation.$refText, trait.role.role.$refText)));
    if (!exists) {
      refuse(
        DiagnosticCode.notDefined,
        `'${capability}' is not defined, so there is nothing to redefine. Try define instead.`,
        rangeOf(node),
      );
    }
    // `redefine part-time-employment relates part-time-role as empty-abstract-role;` — the specialisation
    // is the change (redefine.feature L630), checked as `define` checks one, against the schema without
    // the one it replaces.
    if (isRelatesTrait(trait) && trait.specialises !== undefined) {
      const key = roleRef(name, trait.name);
      const before = context.schema.specialises.get(key)?.split(':')[1];
      if (before === undefined) {
        refuse(DiagnosticCode.notDefined, `'${capability}' specialises nothing, so there is no specialisation to redefine. Try define instead.`, rangeOf(node));
      }
      if (before === trait.specialises) {
        refuse(DiagnosticCode.alreadyDefined, `'${capability} as ${trait.specialises}' is already defined; a redefine changes something. Nothing was redefined.`, rangeOf(node));
      }
      const without = new Map(context.schema.specialises);
      without.delete(key);
      checkSpecialisation(trait, trait.specialises, name, { ...context.schema, specialises: without }, refuse);
      context.db.prepare('INSERT OR REPLACE INTO schema_specialises(relation, role, specialises) VALUES (?, ?, ?)').run(name, trait.name, trait.specialises);
      return;
    }
    // `redefine person owns name[];` over `owns name` — the ordering is the change, and it is the ONLY
    // change one redefine makes: an annotation beside it is refused (redefine.feature L295).
    const ordered = (isOwnsTrait(trait) || isRelatesTrait(trait)) && trait.ordered === true;
    const wasOrdered = context.schema.ordered.has(subject);
    if ((isOwnsTrait(trait) || isRelatesTrait(trait)) && ordered !== wasOrdered) {
      if (trait.annotations.length > 0) {
        refuse(DiagnosticCode.mixedPattern, `A redefine makes one change: '${capability}' changes its ordering here, so its annotations cannot change with it.`, rangeOf(node));
      }
      // `@distinct` belongs to a list; an unordered capability cannot keep one (define.feature L1608).
      if (!ordered && context.schema.annotations.get(subject)?.has('distinct')) {
        refuse(DiagnosticCode.annotationNotAdmitted, `'${capability}' carries \`@distinct\`, which only a list admits; undefine it before redefining the ordering.`, rangeOf(node));
      }
      if (ordered) context.db.prepare('INSERT OR IGNORE INTO schema_ordered(subject) VALUES (?)').run(subject);
      else context.db.prepare('DELETE FROM schema_ordered WHERE subject = ?').run(subject);
      return;
    }
    if (trait.annotations.length === 0) {
      // `redefine person owns name;` over `owns name` — nothing else was said.
      refuse(DiagnosticCode.nothingRedefined, `Nothing was redefined: '${capability}' is stated as it is.`, rangeOf(node));
    }
    return redefineAnnotations(subject, `'${capability}'`, trait.annotations, node, context);
  }
}

/**
 * The annotations named in a redefine, each against the record: absent → *"Try define instead"*;
 * present and equal → *"already defined"*; present and different → replaced, and the arguments
 * must fit the value type as `define` requires.
 */
function redefineAnnotations(
  subject: string,
  where: string,
  annotations: readonly Annotation[],
  node: RedefineType,
  context: MutationContext,
  valueTypeNow?: string,
): void {
  const { db, schema, refuse } = context;
  // A redefine makes ONE change (redefine.feature L1831): one annotation at a time.
  if (annotations.length > 1) {
    refuse(DiagnosticCode.mixedPattern, `A redefine makes one change: ${where} names ${annotations.length} annotations here; redefine them one at a time.`, rangeOf(node));
  }
  const recorded = schema.annotations.get(subject) ?? new Map<string, string>();
  const changes: Array<[string, string, Annotation]> = [];
  const [owner, capability, attribute] = subject.split(SEP);
  // The same argument rules `define` applies (review, round 1): `@values("x")` on an integer
  // attribute is refused whichever stage writes it.
  const constrained = capability === 'owns' ? attribute : capability === 'value' ? owner : undefined;
  for (const annotation of annotations) {
    // Against the value type the statement is SETTING when it sets one — `redefine attribute age
    // value string @values("a")` over an integer `age` is one atomic change (review, round 2).
    if (constrained !== undefined) checkArgumentsFit(annotation, constrained, valueTypeNow ?? valueTypeOf(constrained, schema), refuse);
    const category = recordCategory(annotation);
    const text = recordText(annotation);
    const before = recorded.get(category);
    if (before === undefined) {
      return refuse(
        DiagnosticCode.notDefined,
        `${where} has no \`${text.replace(/\(.*$/, '')}\` to redefine. Try define instead.`,
        rangeOf(annotation),
      );
    }
    if (before === text) {
      refuse(
        DiagnosticCode.alreadyDefined,
        `\`${text}\` is already defined on ${where}; a redefine changes something. Nothing was redefined.`,
        rangeOf(annotation),
      );
    }
    changes.push([category, text, annotation]);
  }
  {
    const update = db.prepare('INSERT OR REPLACE INTO schema_annotation(subject, category, text) VALUES (?, ?, ?)');
    for (const [category, text, annotation] of changes) {
      update.run(subject, category, text);
      if (capability === 'owns' && (isKeyAnnotation(annotation) || isUniqueAnnotation(annotation))) {
        // The scoped index needs nothing here: `transaction` rescopes every ownership before COMMIT.
        if (isKeyAnnotation(annotation)) {
          db.prepare('INSERT OR IGNORE INTO schema_key_owns(type, attribute) VALUES (?, ?)').run(owner, attribute);
          db.prepare('INSERT OR IGNORE INTO key_attribute(type) VALUES (?)').run(attribute);
        }
      }
      if (capability === undefined && category === 'abstract') {
        db.prepare('INSERT OR IGNORE INTO schema_abstract(name) VALUES (?)').run(owner);
      }
    }
  }
}

function redefineSub(name: string, kind: Kind, parent: string, node: RedefineType, context: MutationContext): void {
  const { db, schema, refuse } = context;
  const before = schema.parents.get(name);
  if (before === undefined) {
    refuse(DiagnosticCode.notDefined, `'${name}' has no supertype to redefine. Try define instead.`, rangeOf(node));
  }
  if (before === parent) {
    refuse(DiagnosticCode.alreadyDefined, `'${name} sub ${parent}' is already defined; a redefine changes something.`, rangeOf(node));
  }
  const parentKind = kindOf(parent, schema);
  if (parentKind === undefined) {
    return refuse(DiagnosticCode.unknownType, `Unknown type '${parent}': '${name} sub ${parent}' names a parent that is not applied.`, rangeOf(node));
  }
  if (parentKind !== kind) {
    refuse(
      DiagnosticCode.supertypeKind,
      `'${name} sub ${parent}': ${article(kind)} ${kind} type cannot have ${article(parentKind)} ${parentKind} type as its supertype.`,
      rangeOf(node),
    );
  }
  if (parent === name || ancestorsOf(parent, schema).includes(name)) {
    refuse(DiagnosticCode.cyclicHierarchy, `'${name} sub ${parent}' makes '${name}' its own ancestor.`, rangeOf(node));
  }
  if (kind === 'attribute') {
    const own = schema.valueTypes.get(name);
    const inherited = valueTypeOf(parent, schema);
    if (own !== undefined && inherited !== undefined && own !== inherited) {
      refuse(
        DiagnosticCode.valueTypeConflict,
        `'${name} sub ${parent}' cannot have value type '${own}': '${parent}' has value type '${inherited}'.`,
        rangeOf(node),
      );
    }
    // With no value type of its own, the attribute's effective value type is whatever the parent
    // gives — and a new parent may give a different one, over stored values that inherit it
    // (review, rounds 2 and 4; a subtype declaring its own keeps its values out of this count).
    const effective = valueTypeOf(name, schema);
    if (own === undefined && effective !== inherited && attributeValuesInheriting(db, name, schema) > 0) {
      const named = (v: string | undefined): string => (v === undefined ? 'no value type' : `'${v}'`);
      refuse(
        DiagnosticCode.hasInstances,
        `'${name}' has stored values under ${named(effective)} and would take ${named(inherited)} from '${parent}'. Delete them first.`,
        rangeOf(node),
      );
    }
    // And every descendant's DECLARED value type must agree with what the new parent gives —
    // the mirror of `redefineValue`'s check (review, round 3).
    if (inherited !== undefined) {
      for (const descendant of descendantsOf(name, schema)) {
        const theirs = schema.valueTypes.get(descendant);
        if (theirs !== undefined && theirs !== inherited && own === undefined) {
          refuse(
            DiagnosticCode.valueTypeConflict,
            `'${name} sub ${parent}' would give '${name}' value type '${inherited}', and its subtype '${descendant}' has value type '${theirs}'.`,
            rangeOf(node),
          );
        }
      }
    }
  }
  refuseIfInstancesLoseCapabilities(name, ancestorsOf(name, schema), [parent, ...ancestorsOf(parent, schema)], node, context);
  db.prepare('INSERT OR REPLACE INTO type_parent(type, parent) VALUES (?, ?)').run(name, parent);
}

/**
 * A supertype change (or removal) takes inherited capabilities away from a type; instances that
 * hold an attribute, or play a role, the type would no longer own or play become rows nothing can
 * read or delete through TypeQLite (review, round 1). Refused, like every other change over data.
 */
function refuseIfInstancesLoseCapabilities(
  name: string,
  oldChain: readonly string[],
  newChain: readonly string[],
  node: { $cstNode?: unknown },
  context: MutationContext,
): void {
  const { db, schema, refuse } = context;
  const keeps = [name, ...newChain];
  // The type and every subtype: a subtype that REDECLARES an ownership keeps it whatever happens
  // above (review, round 2), so each is asked separately and only its own instances counted.
  const family = [name, ...descendantsOf(name, schema)];
  const chainBelow = (type: string): string[] => {
    // From `type` up to (excluding) `name`, then the new chain — what `type` would inherit through.
    const between: string[] = [];
    let current: string | undefined = type;
    while (current !== undefined && current !== name) {
      between.push(current);
      current = schema.parents.get(current);
    }
    return [...between, ...keeps];
  };
  const lostOwns = [...schema.owns]
    .map((key) => key.split('\u0000'))
    .filter(([owner]) => oldChain.includes(owner) && !newChain.includes(owner))
    .map(([, attribute]) => attribute);
  for (const attribute of new Set(lostOwns)) {
    for (const type of family) {
      if (chainBelow(type).some((t) => schema.owns.has(ownsKey(t, attribute)))) continue;
      const held = ownersHoldingExactly(db, type, attribute);
      if (held > 0) {
        refuse(
          DiagnosticCode.hasInstances,
          `${held} instance(s) of '${type}' own '${attribute}', which '${type}' would no longer own. Delete them first.`,
          rangeOf(node as never),
        );
      }
    }
  }
  const lostPlays = [...schema.plays]
    .map((key) => key.split(SEP))
    .filter(([player]) => oldChain.includes(player) && !newChain.includes(player))
    .map(([, , role]) => role);
  for (const role of new Set(lostPlays)) {
    const [relation, roleName] = role.split(':');
    for (const type of family) {
      if (chainBelow(type).some((t) => schema.plays.has(playsSubject(t, role)))) continue;
      const playing = playersOfExactly(db, type, relation, roleName);
      if (playing > 0) {
        refuse(
          DiagnosticCode.hasInstances,
          `${playing} instance(s) of '${type}' play '${role}', which '${type}' would no longer play. Delete them first.`,
          rangeOf(node as never),
        );
      }
    }
  }
  // A relation losing an ancestor loses the roles that ancestor declared (review, round 2).
  const lostRoles = oldChain
    .filter((ancestor) => !newChain.includes(ancestor))
    .flatMap((ancestor) => [...(schema.roles.get(ancestor) ?? [])])
    .filter((role) => !keeps.some((t) => schema.roles.get(t)?.has(role)));
  for (const role of new Set(lostRoles)) {
    const played = rolePlayed(db, name, role);
    if (played > 0) {
      refuse(
        DiagnosticCode.hasInstances,
        `'${role}' is played in ${played} existing relation(s) of '${name}', and '${name}' would no longer relate it. Delete them first.`,
        rangeOf(node as never),
      );
    }
  }
}

function valueTypeOf(attribute: string, facts: SchemaFacts): string | undefined {
  for (const type of [attribute, ...ancestorsOf(attribute, facts)]) {
    const own = facts.valueTypes.get(type);
    if (own !== undefined) return own;
  }
  return undefined;
}

function redefineValue(
  name: string,
  kind: Kind,
  valueType: string,
  annotations: readonly Annotation[],
  node: RedefineType,
  context: MutationContext,
): void {
  const { db, schema, refuse } = context;
  if (kind !== 'attribute') {
    refuse(DiagnosticCode.valueTypeOnThing, `'${name}' is ${article(kind)} ${kind} type and has no value type to redefine (L327).`, rangeOf(node));
  }
  const before = schema.valueTypes.get(name);
  if (before === undefined) {
    return refuse(DiagnosticCode.notDefined, `'${name}' has no value type of its own to redefine. Try define instead.`, rangeOf(node));
  }
  if (before === valueType && annotations.length === 0) {
    refuse(DiagnosticCode.alreadyDefined, `'${name} value ${valueType}' is already defined; a redefine changes something.`, rangeOf(node));
  }
  if (before !== valueType) {
    // Values of the attribute AND of every subtype that inherits its value type (review, round 2).
    const stored = attributeValuesInheriting(db, name, schema);
    if (stored > 0) {
      refuse(
        DiagnosticCode.hasInstances,
        `'${name}' or a subtype has ${stored} existing value(s), stored as '${before}'; its value type cannot become '${valueType}' over them. Delete them first.`,
        rangeOf(node),
      );
    }
    // Every subtype's declared value type must still agree with the new one.
    for (const child of descendantsOf(name, schema)) {
      const theirs = schema.valueTypes.get(child);
      if (theirs !== undefined && theirs !== valueType) {
        refuse(
          DiagnosticCode.valueTypeConflict,
          `'${name}' cannot take value type '${valueType}': its subtype '${child}' has value type '${theirs}'.`,
          rangeOf(node),
        );
      }
    }
    {
      db.prepare('INSERT OR REPLACE INTO schema_value_type(attribute, value_type) VALUES (?, ?)').run(name, valueType);
    }
  }
  if (annotations.length > 0) redefineAnnotations(valueSubject(name), `'${name} value ${valueType}'`, annotations, node, context, valueType);
}

/**
 * `redefine entity before-rename label after-rename;` — every table that carries the label, in
 * one transaction. Refused when the new label is any type's already (L106, the message the
 * scenario matches on names the kind that has it).
 */
function renameType(name: string, kind: Kind, newLabel: string, node: RedefineType, context: MutationContext): void {
  const { db, schema, refuse } = context;
  const taken = kindOf(newLabel, schema);
  if (taken !== undefined) {
    refuse(
      DiagnosticCode.duplicateLabel,
      `Label '${newLabel}' should be unique, but is already used by '${taken}'.`,
      rangeOf(node),
    );
  }
  // 🔴 A TypeDBLite limit, and a declared one. TypeDB renames a type with instances because its
  // identities are iids; here an entity's replicated identity is `<type>/<key>` (ADR-003 D3),
  // hash-chained in `change_log` and already held by every follower. Rewriting it would make the
  // old id a phantom and the next write a duplicate (review, round 1); leaving it would split one
  // entity across two names. So a type with instances — or with any history in the log — keeps
  // its label. The specification's rename scenarios rename types with neither.
  const history = db.prepare(`SELECT 1 FROM change_log WHERE entity_id LIKE ?${ESCAPE} LIMIT 1`).get(`${like(name)}/%`);
  if (context.data.instancesOf(name) > 0 || history) {
    refuse(
      DiagnosticCode.hasInstances,
      `'${name}' cannot be renamed: it has instances or replicated history, and an entity's identity ` +
        `is '${name}/<key>' (ADR-003). Delete them first, or keep the label.`,
      rangeOf(node),
    );
  }
  {
    const run = (sql: string, ...params: string[]): void => {
      db.prepare(sql).run(...params);
    };
    run('UPDATE thing SET type = ? WHERE type = ?', newLabel, name);
    run('UPDATE attribute SET type = ? WHERE type = ?', newLabel, name);
    run('UPDATE has SET type = ? WHERE type = ?', newLabel, name);
    run('UPDATE type_parent SET type = ? WHERE type = ?', newLabel, name);
    run('UPDATE type_parent SET parent = ? WHERE parent = ?', newLabel, name);
    run('UPDATE schema_element SET name = ? WHERE name = ?', newLabel, name);
    run('UPDATE schema_relation SET name = ? WHERE name = ?', newLabel, name);
    run('UPDATE schema_owns SET type = ? WHERE type = ?', newLabel, name);
    run('UPDATE schema_owns SET attribute = ? WHERE attribute = ?', newLabel, name);
    run('UPDATE schema_relates SET relation = ? WHERE relation = ?', newLabel, name);
    run('UPDATE schema_value_type SET attribute = ? WHERE attribute = ?', newLabel, name);
    run('UPDATE schema_abstract SET name = ? WHERE name = ?', newLabel, name);
    run('UPDATE schema_key_owns SET type = ? WHERE type = ?', newLabel, name);
    run('UPDATE schema_key_owns SET attribute = ? WHERE attribute = ?', newLabel, name);
    run('UPDATE key_attribute SET type = ? WHERE type = ?', newLabel, name);
    run('UPDATE schema_plays SET type = ? WHERE type = ?', newLabel, name);
    // Role references carry the relation's label: `employment:employee`.
    run("UPDATE schema_plays SET role = ? || substr(role, instr(role, ':')) WHERE substr(role, 1, instr(role, ':') - 1) = ?", newLabel, name);
    renameInSubjects(db, name, newLabel);
    // `has.scope` names an owner type; a rename of one moves the scope with it.
    run('UPDATE has SET scope = ? WHERE scope = ?', newLabel, name);
  }
}

/** `redefine relation-of-rename:before-rename label sibling-role;` — a role, through its relation (L575). */
function renameRole(relation: string, role: string, newLabel: string, node: { $cstNode?: unknown }, context: MutationContext): void {
  const { db, schema, refuse } = context;
  if (!schema.relations.has(relation)) {
    refuse(DiagnosticCode.unknownType, `Unknown relation '${relation}'.`, rangeOf(node as never));
  }
  if (!schema.roles.get(relation)?.has(role)) {
    refuse(DiagnosticCode.unknownRole, `'${relation}' declares no role '${role}' to rename.`, rangeOf(node as never));
  }
  // Unique in the hierarchy: above and below the relation, as the scenario's two refusals say.
  const family = [relation, ...ancestorsOf(relation, schema), ...descendantsOf(relation, schema)];
  for (const member of family) {
    if (schema.roles.get(member)?.has(newLabel)) {
      refuse(
        DiagnosticCode.roleRedeclared,
        `Role name of '${member}:${newLabel}' should be unique in relation type hierarchy of '${member}'.`,
        rangeOf(node as never),
      );
    }
  }
  const before = roleRef(relation, role);
  const after = roleRef(relation, newLabel);
  {
    db.prepare('UPDATE schema_relates SET role = ? WHERE relation = ? AND role = ?').run(newLabel, relation, role);
    // Instances of sub-relations inherit the role and carry its name too (review, round 1).
    db.prepare(
      'UPDATE role_player SET role = ? WHERE role = ? AND rel IN (SELECT iid FROM thing WHERE type IN ' +
        '(WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT type FROM type_parent, sub WHERE parent = sub.x) SELECT x FROM sub))',
    ).run(newLabel, role, relation);
    db.prepare('UPDATE schema_plays SET role = ? WHERE role = ?').run(after, before);
    db.prepare('UPDATE schema_annotation SET subject = ? WHERE subject = ?').run(relatesSubject(relation, newLabel), relatesSubject(relation, role));
    const plays = db.prepare(`SELECT subject FROM schema_annotation WHERE subject LIKE ?${ESCAPE}`).all(`%${SEP}plays${SEP}${like(before)}`) as Array<{ subject: string }>;
    for (const row of plays) {
      db.prepare('UPDATE schema_annotation SET subject = ? WHERE subject = ?').run(row.subject.replace(`${SEP}plays${SEP}${before}`, `${SEP}plays${SEP}${after}`), row.subject);
    }
  }
}

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

/** Every annotation subject that names the type — as the type, as an owner, as an attribute, in a role reference. */
function renameInSubjects(db: SqliteDatabase, name: string, newLabel: string): void {
  const rows = db.prepare('SELECT subject FROM schema_annotation').all() as Array<{ subject: string }>;
  const update = db.prepare('UPDATE schema_annotation SET subject = ? WHERE subject = ?');
  for (const { subject } of rows) {
    // Only the positions that hold a TYPE label: the first segment always; the third when it is
    // an owned attribute, or the relation part of a played `relation:role`. A `relates` segment
    // is a role name that may coincide with a type's (review, round 1).
    const parts = subject.split(SEP).map((part, index, all) => {
      if (index === 0 && part === name) return newLabel;
      if (index === 2 && all[1] === 'owns' && part === name) return newLabel;
      if (index === 2 && all[1] === 'plays' && part.startsWith(`${name}:`)) return `${newLabel}${part.slice(name.length)}`;
      return part;
    });
    const renamed = parts.join(SEP);
    if (renamed !== subject) update.run(renamed, subject);
  }
  // The ordered capabilities are keyed by the same subjects, renamed by the same rule.
  const ordered = db.prepare('SELECT subject FROM schema_ordered').all() as Array<{ subject: string }>;
  const move = db.prepare('UPDATE schema_ordered SET subject = ? WHERE subject = ?');
  for (const { subject } of ordered) {
    const parts = subject.split(SEP).map((part, index, all) => (index === 0 && part === name) || (index === 2 && all[1] === 'owns' && part === name) ? newLabel : part);
    const renamed = parts.join(SEP);
    if (renamed !== subject) move.run(renamed, subject);
  }
}

// ── undefine ───────────────────────────────────────────────────────────────

/**
 * 🔴 One transaction per STATEMENT, not per line: `undefine relates employee from employment;
 * employment;` is refused whole on TypeDB when the relation has instances (L566), and here a
 * refusal on the last line must leave the first ones unapplied. The model is reloaded between
 * lines — inside the transaction, where this connection sees its own uncommitted rows — so
 * `sub person from child; person;` sees `child` parentless when it reaches `person`.
 */
export function applyUndefine(clause: UndefineClause, context: MutationContext): void {
  try {
    transaction(context.db, context.nested === true, () => {
      for (const undefinition of clause.undefinitions) {
        if (isUndefineType(undefinition)) undefineType(undefinition.type, undefinition, context);
        else if (isUndefineFrom(undefinition)) undefineFrom(undefinition, context);
        context.reload();
      }
    });
  } catch (error) {
    // The model was reloaded after the lines that applied; the rollback took them back out of
    // the tables, so the model must follow — or the next statement reads a schema that is not
    // the one applied.
    context.reload();
    throw error;
  }
}

function undefineType(name: string, node: { $cstNode?: unknown }, context: MutationContext): void {
  const { db, schema, data, refuse } = context;
  const at = rangeOf(node as never);
  const kind = kindOf(name, schema);
  if (kind === undefined) return refuse(DiagnosticCode.unknownType, `Unknown type '${name}': there is no defined type to undefine.`, at);
  const instances = data.instancesOf(name);
  if (instances > 0) {
    refuse(
      DiagnosticCode.hasInstances,
      `'${name}' has ${instances} existing instance(s); all existing instances of a type must be deleted in order to undefine it.`,
      at,
    );
  }
  const children = childrenOf(name, schema);
  if (children.length > 0) {
    refuse(DiagnosticCode.hasSubtypes, `'${name}' has subtype(s) ${children.join(', ')}; undefine them first.`, at);
  }
  {
    const run = (sql: string, ...params: string[]): void => {
      db.prepare(sql).run(...params);
    };
    run('DELETE FROM schema_element WHERE name = ?', name);
    run('DELETE FROM schema_relation WHERE name = ?', name);
    run('DELETE FROM type_parent WHERE type = ?', name);
    run('DELETE FROM schema_owns WHERE type = ? OR attribute = ?', name, name);
    run('DELETE FROM schema_relates WHERE relation = ?', name);
    run('DELETE FROM schema_value_type WHERE attribute = ?', name);
    run('DELETE FROM schema_abstract WHERE name = ?', name);
    run('DELETE FROM schema_key_owns WHERE type = ? OR attribute = ?', name, name);
    run('DELETE FROM key_attribute WHERE type = ?', name);
    // Its own plays, and every other type's plays of a role it related: "undefining a relation
    // type automatically detaches any possible roleplayers" (L727).
    run("DELETE FROM schema_plays WHERE type = ? OR substr(role, 1, instr(role, ':') - 1) = ?", name, name);
    run(
      `DELETE FROM schema_annotation WHERE subject = ? OR subject LIKE ?${ESCAPE} OR subject LIKE ?${ESCAPE} OR subject LIKE ?${ESCAPE}`,
      name, `${like(name)}${SEP}%`, `%${SEP}owns${SEP}${like(name)}`, `%${SEP}plays${SEP}${like(name)}:%`,
    );
    run(`DELETE FROM schema_ordered WHERE subject LIKE ?${ESCAPE} OR subject LIKE ?${ESCAPE}`, `${like(name)}${SEP}%`, `%${SEP}owns${SEP}${like(name)}`);
    run('DELETE FROM schema_specialises WHERE relation = ?', name);
    if (kind === 'attribute') {
      for (const prefix of ['key', 'unique']) db.exec(`DROP INDEX IF EXISTS ${prefix}_${ident(name)}`);
    }
  }
}

function undefineFrom(node: UndefineFrom, context: MutationContext): void {
  const { db, schema, refuse } = context;
  const type = node.type;
  const at = rangeOf(node);
  const target = node.target;
  const kind = kindOf(type, schema);
  if (kind === undefined) return refuse(DiagnosticCode.unknownType, `Unknown type '${type}': nothing is defined on it to undefine.`, at);

  if (isUndefineSub(target)) {
    const parent = schema.parents.get(type);
    if (parent !== target.superType) {
      // TypeDB's phrasing, which the scenarios match on: *"there is no defined 'person sub
      // abstract-type'"*, and *", while"* the actual supertype is named (L118, L130).
      refuse(
        DiagnosticCode.notDefined,
        parent === undefined
          ? `there is no defined '${type} sub ${target.superType}' to undefine.`
          : `there is no defined '${type} sub ${target.superType}', while '${type} sub ${parent}' is; only the direct supertype can be undefined (L117).`,
        at,
      );
    }
    refuseIfInstancesLoseCapabilities(type, ancestorsOf(type, schema), [], node, context);
    // An attribute with only an inherited value type would be left with values and no type for them.
    if (kind === 'attribute' && schema.valueTypes.get(type) === undefined && attributeValuesInheriting(db, type, schema) > 0) {
      refuse(DiagnosticCode.hasInstances, `'${type}' has stored values and no value type of its own; its supertype cannot be undefined over them.`, at);
    }
    db.prepare('DELETE FROM type_parent WHERE type = ?').run(type);
    db.prepare('DELETE FROM schema_annotation WHERE subject = ?').run(subSubject(type));
    return;
  }

  if (isUndefineValue(target)) {
    const own = schema.valueTypes.get(type);
    // TypeDB's words (undefine.feature L845, L886): none at all, or a different one.
    if (kind !== 'attribute' || own === undefined) {
      refuse(DiagnosticCode.notDefined, `there is no defined '${type} value ${target.valueType}' to undefine.`, at);
    }
    if (own !== target.valueType) {
      refuse(DiagnosticCode.notDefined, `there is no defined '${type} value ${target.valueType}', while the defined 'value' is '${own}'.`, at);
    }
    // Values of the attribute and of every subtype inheriting its value type (review, round 3).
    if (attributeValuesInheriting(db, type, schema) > 0) {
      refuse(DiagnosticCode.hasInstances, `'${type}' or a subtype has stored values; its value type cannot be undefined over them.`, at);
    }
    // A concrete attribute type keeps a value type, its own or inherited (undefine.feature L886).
    const inherited = ancestorsOf(type, schema).some((a) => schema.valueTypes.has(a));
    if (!inherited && !schema.annotations.get(typeSubject(type))?.has('abstract')) {
      refuse(DiagnosticCode.notDefined, `'${type}' should be abstract to have no value type: make it @abstract first, or keep its value type.`, at);
    }
    {
      db.prepare('DELETE FROM schema_value_type WHERE attribute = ?').run(type);
      db.prepare('DELETE FROM schema_annotation WHERE subject = ?').run(valueSubject(type));
    }
    return;
  }

  if (isUndefineOwns(target)) {
    const attribute = target.attribute;
    ownCapabilityOrRefuse(type, `owns ${attribute}`, ownsRow(type, attribute, schema), ancestorsOf(type, schema).find((a) => ownsRow(a, attribute, schema)), at, refuse);
    sameOrderOrRefuse(`${type} owns ${attribute}`, ownsSubject(type, attribute), target.ordered === true, schema, at, refuse);
    const held = ownersHolding(db, type, attribute);
    if (held > 0) refuse(DiagnosticCode.hasInstances, `${held} instance(s) of '${type}' own '${attribute}'; the ownership cannot be undefined (L1412).`, at);
    {
      db.prepare('DELETE FROM schema_owns WHERE type = ? AND attribute = ?').run(type, attribute);
      db.prepare('DELETE FROM schema_key_owns WHERE type = ? AND attribute = ?').run(type, attribute);
      db.prepare('DELETE FROM schema_annotation WHERE subject = ?').run(ownsSubject(type, attribute));
      db.prepare('DELETE FROM schema_ordered WHERE subject = ?').run(ownsSubject(type, attribute));
      dropIndexIfUnowned(db, attribute);
    }
    return;
  }

  if (isUndefinePlays(target)) {
    const role = roleRef(target.role.relation, target.role.role);
    const own = schema.plays.has(playsSubject(type, role));
    const inherited = ancestorsOf(type, schema).find((a) => schema.plays.has(playsSubject(a, role)));
    ownCapabilityOrRefuse(type, `plays ${role}`, own, inherited, at, refuse);
    const playing = playersOf(db, type, target.role.relation, target.role.role);
    if (playing > 0) refuse(DiagnosticCode.hasInstances, `${playing} instance(s) of '${type}' play '${role}'; the plays cannot be undefined (L1276).`, at);
    {
      db.prepare('DELETE FROM schema_plays WHERE type = ? AND role = ?').run(type, role);
      db.prepare('DELETE FROM schema_annotation WHERE subject = ?').run(playsSubject(type, role));
    }
    return;
  }

  if (isUndefineRelates(target)) {
    const role = target.role;
    const own = schema.roles.get(type)?.has(role) === true;
    const inherited = ancestorsOf(type, schema).find((a) => schema.roles.get(a)?.has(role));
    ownCapabilityOrRefuse(type, `relates ${role}`, own, inherited, at, refuse);
    sameOrderOrRefuse(`${type} relates ${role}`, relatesSubject(type, role), target.ordered === true, schema, at, refuse);
    const played = rolePlayed(db, type, role);
    if (played > 0) refuse(DiagnosticCode.hasInstances, `'${role}' is played in ${played} existing relation(s) of '${type}'; the role cannot be undefined (L1086).`, at);
    {
      db.prepare('DELETE FROM schema_relates WHERE relation = ? AND role = ?').run(type, role);
      db.prepare('DELETE FROM schema_ordered WHERE subject = ?').run(relatesSubject(type, role));
      db.prepare('DELETE FROM schema_specialises WHERE relation = ? AND role = ?').run(type, role);
      // "undefining a role type automatically detaches any possible roleplayers" (L1059).
      db.prepare('DELETE FROM schema_plays WHERE role = ?').run(roleRef(type, role));
      db.prepare(`DELETE FROM schema_annotation WHERE subject = ? OR subject LIKE ?${ESCAPE}`).run(relatesSubject(type, role), `%${SEP}plays${SEP}${like(roleRef(type, role))}`);
    }
    return;
  }

  if (isUndefineSpecialise(target)) {
    // `undefine as employee from part-time-employment relates part-time-employee;` (L631).
    const capability = node.capability;
    if (capability === undefined || !isCapabilityRelates(capability)) {
      return refuse(DiagnosticCode.notDefined, `\`as ${target.role}\` is undefined from a relates: \`undefine as ${target.role} from ${type} relates <role>;\`.`, at);
    }
    const role = capability.role;
    const named = `${type} relates ${role} as ${target.role}`;
    const current = schema.specialises.get(roleRef(type, role))?.split(':')[1];
    if (current === undefined) refuse(DiagnosticCode.notDefined, `there is no defined '${named}' to undefine.`, at);
    if (current !== target.role) refuse(DiagnosticCode.notDefined, `there is no defined '${named}', while '${type} relates ${role} as ${current}' is.`, at);
    db.prepare('DELETE FROM schema_specialises WHERE relation = ? AND role = ?').run(type, role);
    return;
  }

  if (isUndefineAnnotation(target)) {
    const category = target.category.slice(1) === 'meta' && target.key !== undefined ? `meta:${target.key}` : target.category.slice(1);
    const capability = node.capability;
    let subject: string;
    let where: string;
    if (capability === undefined) {
      // `undefine @regex from email;` — the annotation could never have sat on the type itself
      // (the admissibility table); TypeDB's *"Illegal annotation"* (L858).
      const subjectKind = kind === 'entity' ? 'entity type' : kind === 'relation' ? 'relation type' : 'attribute type';
      const bare = category.startsWith('meta:') ? 'meta' : category;
      if (!ADMITTED[subjectKind].has(bare as AnnotationCategory)) {
        refuse(
          DiagnosticCode.annotationNotAdmitted,
          `Illegal annotation: \`${target.category}\` cannot be set on ${article(subjectKind)} ${subjectKind}, so there is none on '${type}' to undefine.`,
          at,
        );
      }
      subject = typeSubject(type);
      where = `'${type}'`;
    } else if (isCapabilityOwns(capability)) {
      ownCapabilityOrRefuse(type, `owns ${capability.attribute}`, ownsRow(type, capability.attribute, schema), ancestorsOf(type, schema).find((a) => ownsRow(a, capability.attribute, schema)), at, refuse, 'annotation');
      sameOrderOrRefuse(`${type} owns ${capability.attribute}`, ownsSubject(type, capability.attribute), capability.ordered === true, schema, at, refuse);
      subject = ownsSubject(type, capability.attribute);
      where = `'${type} owns ${capability.attribute}'`;
    } else if (isCapabilityPlays(capability)) {
      const role = roleRef(capability.role.relation, capability.role.role);
      ownCapabilityOrRefuse(type, `plays ${role}`, schema.plays.has(playsSubject(type, role)), ancestorsOf(type, schema).find((a) => schema.plays.has(playsSubject(a, role))), at, refuse, 'annotation');
      subject = playsSubject(type, role);
      where = `'${type} plays ${role}'`;
    } else if (isCapabilityRelates(capability)) {
      ownCapabilityOrRefuse(type, `relates ${capability.role}`, schema.roles.get(type)?.has(capability.role) === true, ancestorsOf(type, schema).find((a) => schema.roles.get(a)?.has(capability.role)), at, refuse, 'annotation');
      sameOrderOrRefuse(`${type} relates ${capability.role}`, relatesSubject(type, capability.role), capability.ordered === true, schema, at, refuse);
      subject = relatesSubject(type, capability.role);
      where = `'${type} relates ${capability.role}'`;
    } else if (isCapabilitySub(capability)) {
      if (schema.parents.get(type) !== capability.superType) {
        refuse(DiagnosticCode.notDefined, `'${type} sub ${capability.superType}' is not defined.`, at);
      }
      subject = subSubject(type);
      where = `'${type} sub ${capability.superType}'`;
    } else if (isCapabilityValue(capability)) {
      if (schema.valueTypes.get(type) !== capability.valueType) {
        refuse(DiagnosticCode.notDefined, `'${type} value ${capability.valueType}' is not defined.`, at);
      }
      subject = valueSubject(type);
      where = `'${type} value ${capability.valueType}'`;
    } else {
      throw new Error('TypeDBLite: unhandled capability in undefine');
    }
    const recorded = schema.annotations.get(subject)?.get(category);
    if (recorded === undefined) {
      refuse(DiagnosticCode.notDefined, `${where} has no defined \`${target.category}\` to undefine.`, at);
    }
    {
      db.prepare('DELETE FROM schema_annotation WHERE subject = ? AND category = ?').run(subject, category);
      if (category === 'abstract' && capability === undefined) db.prepare('DELETE FROM schema_abstract WHERE name = ?').run(type);
      if (capability !== undefined && isCapabilityOwns(capability)) {
        if (category === 'key') {
          db.prepare('DELETE FROM schema_key_owns WHERE type = ? AND attribute = ?').run(type, capability.attribute);
          const others = db.prepare('SELECT 1 FROM schema_key_owns WHERE attribute = ?').get(capability.attribute);
          if (!others) {
            db.prepare('DELETE FROM key_attribute WHERE type = ?').run(capability.attribute);
            db.exec(`DROP INDEX IF EXISTS key_${ident(capability.attribute)}`);
          }
        }
        if (category === 'unique') dropUniqueIfUnowned(db, capability.attribute);
      }
    }
  }
}

/**
 * An undefine names the capability as it is defined, ordering included: `undefine owns name[]` over
 * `owns name` is TypeDB's *"there is no defined 'person owns name[]', while 'person owns name' is"*
 * (undefine.feature L258).
 */
function sameOrderOrRefuse(capability: string, subject: string, stated: boolean, schema: SchemaFacts, at: ReturnType<typeof rangeOf>, refuse: Refuse): void {
  const applied = schema.ordered.has(subject);
  if (applied === stated) return;
  refuse(
    DiagnosticCode.notDefined,
    `there is no defined '${capability}${stated ? '[]' : ''}', while '${capability}${applied ? '[]' : ''}' is; undefine it as it is defined.`,
    at,
  );
}

/** A capability is undefined from the type that declares it — never through a subtype (L1444, L1294, L1163). */
/**
 * TypeDB words each inherited case its own way, and the scenarios match on the words: a capability
 * is *"Cannot unset 'owns email' constraint for 'user' inherited from 'person'"* (L1452, L1302) —
 * but an inherited role is simply *"there is no defined"* one (L1163) — and an annotation on an
 * inherited capability is *"'user' does not own attribute type 'email'"*, *"does not play the role"*,
 * *"The relation type … does not relate role …"* (L1466, L1316, L1185).
 */
function ownCapabilityOrRefuse(type: string, capability: string, own: boolean, inheritedFrom: string | undefined, at: ReturnType<typeof rangeOf>, refuse: Refuse, form: 'capability' | 'annotation' = 'capability'): void {
  if (own) return;
  if (inheritedFrom !== undefined) {
    const [verb, target] = [capability.slice(0, capability.indexOf(' ')), capability.slice(capability.indexOf(' ') + 1)];
    const message =
      form === 'annotation'
        ? verb === 'owns'
          ? `'${type}' does not own attribute type '${target}' itself: it inherits '${capability}' from '${inheritedFrom}', where its annotations are undefined.`
          : verb === 'plays'
            ? `'${type}' does not play the role '${target}' itself: it inherits it from '${inheritedFrom}', where its annotations are undefined.`
            : `The relation type '${type}' does not relate role '${target}' itself: it inherits it from '${inheritedFrom}', where its annotations are undefined.`
        : verb === 'relates'
          ? `there is no defined '${type} ${capability}': '${type}' inherits the role from '${inheritedFrom}', and an inherited role is undefined there.`
          : `Cannot unset '${capability}' constraint for '${type}' inherited from '${inheritedFrom}'. Undefine it from the type that declares it.`;
    refuse(DiagnosticCode.inheritedCapability, message, at);
  }
  // TypeDB's phrasing, which the scenarios match on (L218, L247, L589).
  refuse(DiagnosticCode.notDefined, `there is no defined '${type} ${capability}' to undefine.`, at);
}

// ── the data questions undefine asks ────────────────────────────────────────

/**
 * The attribute types whose EFFECTIVE value type is this one's: itself, and every descendant
 * reached without passing a type that declares its own — a subtype restating `value string`
 * keeps it whatever happens above (review, round 4).
 */
function inheritingFamily(attribute: string, facts: SchemaFacts): string[] {
  const family = [attribute];
  for (let i = 0; i < family.length; i += 1) {
    for (const child of childrenOf(family[i], facts)) {
      if (facts.valueTypes.get(child) === undefined && !family.includes(child)) family.push(child);
    }
  }
  return family;
}

/** Stored values whose value type a change to `attribute`'s would reinterpret. */
const attributeValuesInheriting = (db: SqliteDatabase, attribute: string, facts: SchemaFacts): number => {
  const family = inheritingFamily(attribute, facts);
  const marks = family.map(() => '?').join(', ');
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM attribute WHERE type IN (${marks})`).get(...family) as { n: number }).n);
};

const ownersHolding = (db: SqliteDatabase, type: string, attribute: string): number =>
  Number(
    (db.prepare(
      `SELECT COUNT(*) AS n FROM thing t WHERE t.type IN (WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT type FROM type_parent, sub WHERE parent = sub.x) SELECT x FROM sub) ` +
        'AND EXISTS (SELECT 1 FROM has h WHERE h.owner = t.iid AND h.type = ?)',
    ).get(type, attribute) as { n: number }).n,
  );

/** Instances of EXACTLY `type` — not its subtypes — that own the attribute. */
const ownersHoldingExactly = (db: SqliteDatabase, type: string, attribute: string): number =>
  Number(
    (db.prepare(
      'SELECT COUNT(*) AS n FROM thing t WHERE t.type = ? AND EXISTS (SELECT 1 FROM has h WHERE h.owner = t.iid AND h.type = ?)',
    ).get(type, attribute) as { n: number }).n,
  );

/** Instances of EXACTLY `type` that play the role in any relation of `relation`'s closure. */
const playersOfExactly = (db: SqliteDatabase, type: string, relation: string, role: string): number =>
  Number(
    (db.prepare(
      `SELECT COUNT(*) AS n FROM role_player rp JOIN thing p ON p.iid = rp.player JOIN thing r ON r.iid = rp.rel ` +
        `WHERE rp.role = ? AND p.type = ? ` +
        `AND r.type IN (WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT type FROM type_parent, sub WHERE parent = sub.x) SELECT x FROM sub)`,
    ).get(role, type, relation) as { n: number }).n,
  );

const playersOf = (db: SqliteDatabase, type: string, relation: string, role: string): number =>
  Number(
    (db.prepare(
      `SELECT COUNT(*) AS n FROM role_player rp JOIN thing p ON p.iid = rp.player JOIN thing r ON r.iid = rp.rel ` +
        `WHERE rp.role = ? AND p.type IN (WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT type FROM type_parent, sub WHERE parent = sub.x) SELECT x FROM sub) ` +
        `AND r.type IN (WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT type FROM type_parent, sub WHERE parent = sub.x) SELECT x FROM sub)`,
    ).get(role, type, relation) as { n: number }).n,
  );

const rolePlayed = (db: SqliteDatabase, relation: string, role: string): number =>
  Number(
    (db.prepare(
      `SELECT COUNT(*) AS n FROM role_player rp JOIN thing r ON r.iid = rp.rel WHERE rp.role = ? ` +
        `AND r.type IN (WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT type FROM type_parent, sub WHERE parent = sub.x) SELECT x FROM sub)`,
    ).get(role, relation) as { n: number }).n,
  );

/** The `@key`/`@unique` index is per attribute; it goes only when no owner keeps the ownership. */
function dropIndexIfUnowned(db: SqliteDatabase, attribute: string): void {
  const keyed = db.prepare('SELECT 1 FROM schema_key_owns WHERE attribute = ?').get(attribute);
  if (!keyed) {
    db.prepare('DELETE FROM key_attribute WHERE type = ?').run(attribute);
    db.exec(`DROP INDEX IF EXISTS key_${ident(attribute)}`);
  }
  dropUniqueIfUnowned(db, attribute);
}

/** `unique_<attribute>` is shared by every owner declaring `@unique` on it; it goes with the last (review, round 1). */
function dropUniqueIfUnowned(db: SqliteDatabase, attribute: string): void {
  const unique = db
    .prepare(`SELECT 1 FROM schema_annotation WHERE category = 'unique' AND subject LIKE ?${ESCAPE}`)
    .get(`%${SEP}owns${SEP}${like(attribute)}`);
  if (!unique) db.exec(`DROP INDEX IF EXISTS unique_${ident(attribute)}`);
}

// ── plumbing ────────────────────────────────────────────────────────────────

/** One transaction per statement, `IMMEDIATE` for the reason `applySchemaDdl` gives. */
function transaction(db: SqliteDatabase, nested: boolean, body: () => void): void {
  // Inside a caller's transaction (a schema transaction that also writes, the conformance harness's
  // `connection open schema transaction`) the statement is a savepoint: it undoes alone, and the
  // caller's COMMIT or ROLLBACK decides for all of it.
  if (nested) {
    db.exec('SAVEPOINT schema_change');
    try {
      body();
      if (hasAttributeTables(db)) rescopeOwnerships(db);
      db.exec('RELEASE schema_change');
    } catch (error) {
      db.exec('ROLLBACK TO schema_change');
      db.exec('RELEASE schema_change');
      throw error;
    }
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    body();
    // A change to an ownership, a `@key`/`@unique`, a supertype or a label moves uniqueness scopes;
    // data that no longer conforms fails `has_unique_in_scope` here, and the change rolls back.
    if (hasAttributeTables(db)) rescopeOwnerships(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_');

/** A label inside a `LIKE` pattern: `_` and `%` are wildcards there, and `a_b` must not match `axb`. */
const like = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const ESCAPE = " ESCAPE '\\'";
