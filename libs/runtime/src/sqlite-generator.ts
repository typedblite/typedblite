import {
  docCommentOf,
  isAbstractAnnotation,
  isAttributeDef,
  isEntityDef,
  isRelationDef,
  isTypeExtensionDef,
  isOwnsTrait,
  isRelatesTrait,
  isKeyAnnotation,
  isUniqueAnnotation,
  isDefineClause,
  isPlaysTrait,
  type Annotation,
  type TypeQLiteFile,
  type TypeDefinition,
  type FunctionDefinition,
  type StructDef,
} from '@typedblite/language';
import { declaredParentOf, isTypeDefinition } from './type-definitions.js';
import {
  recordCategory,
  recordText,
  roleRef,
  subSubject,
  traitSubject,
  typeSubject,
  funSubject,
  structSubject,
  structFieldSubject,
  valueSubject,
} from './schema-subjects.js';
import { ATTRIBUTE_DDL } from './attribute-store.js';

/**
 * TypeQLite → SQLite.
 *
 * The storage model mirrors TypeDB's own rather than generating a table per entity type: one
 * `thing` row per instance, attributes and role-players as separate tables. That is what makes
 * the two guarantees fall out of SQLite's own constraint machinery instead of being re-checked
 * in application code:
 *
 * - **`@key`** becomes a partial `UNIQUE INDEX` on `has(attribute)` for the attribute type: an
 *   attribute instance is owned at most once (ADR-006).
 * - **"a dangling dependency is unrepresentable"** becomes a `FOREIGN KEY` from every role
 *   player back to `thing`. This is the guarantee the GraphQLite spike (2026-08-29) failed —
 *   it accepted an edge to a non-existent node and silently wrote it between two unrelated ones.
 *
 * 🔴 `PRAGMA foreign_keys = ON` is emitted first and is not optional. SQLite defaults it OFF
 * per connection, so without it the second guarantee silently does not exist.
 */

const PRELUDE = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS thing (
  iid   INTEGER PRIMARY KEY,
  type  TEXT NOT NULL
);

-- Subtype closure, so \`isa doc\` also matches \`adr\` (a documentation store's \`entity adr sub doc\`).
CREATE TABLE IF NOT EXISTS type_parent (
  type   TEXT PRIMARY KEY,
  parent TEXT NOT NULL
);

-- Attribute instances, once per type and value, and the ownerships of them (ADR-006).
${ATTRIBUTE_DDL}

-- The applied schema's own vocabulary, so a FILE-BACKED database can be reopened and still know
-- what it defines. Without this the type list lives only in the process that ran define, and a
-- fresh process against an existing database believes no schema has been applied -- which makes
-- --database persist data that nothing can then query.
-- (No backticks in here: this block is a TypeScript template literal.)
CREATE TABLE IF NOT EXISTS schema_element (
  kind TEXT NOT NULL CHECK (kind IN ('type', 'attribute')),
  name TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

-- Which type owns which attribute, which schema_element cannot express.
--
-- It held two flat sets -- types, attributes -- and no relation between them, so the runtime could
-- say edge-id exists and not that a node never owns it. A match binding an attribute its type does
-- not own therefore answered zero rows with no explanation, and an attempt to infer the fault from
-- candidate counts was wrong twice before being deleted as undecidable. It is not undecidable; the
-- ownership was simply never recorded. The schema AST has had it all along.
-- (No backticks in here either -- same template literal.)
CREATE TABLE IF NOT EXISTS schema_owns (
  type      TEXT NOT NULL,
  attribute TEXT NOT NULL,
  PRIMARY KEY (type, attribute)
);

-- Which types are relations. schema_element's kind CHECK admits 'type' and 'attribute' only and
-- SQLite cannot alter a CHECK in place, so this is additive, the way key_attribute is. A projected
-- thing whose type is here is a relation cell; any other is an entity cell.
CREATE TABLE IF NOT EXISTS schema_relation (
  name TEXT PRIMARY KEY
);

-- Each attribute type's DECLARED value type. A subtype declaring none inherits its parent's, which
-- is resolved by walking type_parent -- the same table that carries a thing type's parent, because
-- TypeDB labels are unique across kinds and an attribute's sub is a sub. Additive, like the two
-- above: schema_element cannot grow a column in place. Without it define could not tell that
-- attribute name value integer contradicts the string name already applied, and accepted it.
-- (No backticks in here either -- same template literal.)
CREATE TABLE IF NOT EXISTS schema_value_type (
  attribute  TEXT PRIMARY KEY,
  value_type TEXT NOT NULL
);

-- Which roles each relation declares, so plays employment:employee can be checked against a
-- role that exists and person relates employee refused on a type that is not a relation.
CREATE TABLE IF NOT EXISTS schema_relates (
  relation TEXT NOT NULL,
  role     TEXT NOT NULL,
  PRIMARY KEY (relation, role)
);

-- Which types are abstract, so an insert of one is refused -- and, because it is refused, an
-- abstract type never has direct instances and converting a type to abstract can look at the
-- instances alone, with no memory of whether it was abstract before. Which ownerships are key,
-- so a restated @key on reopen is known to be a restatement and not a conversion the data must
-- conform to. Additive, like the tables above. (No backticks in here -- same template literal.)
CREATE TABLE IF NOT EXISTS schema_abstract (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS schema_key_owns (
  type      TEXT NOT NULL,
  attribute TEXT NOT NULL,
  PRIMARY KEY (type, attribute)
);

-- Every annotation the applied schema carries, per subject (a type, its sub, its value type, or
-- one of its traits -- see schema-subjects.ts for the keys) with the category and the text as
-- written. What undefine removes and redefine replaces. Phase 04 of the conformance feature;
-- additive like the tables above. (No backticks in here -- same template literal.)
CREATE TABLE IF NOT EXISTS schema_annotation (
  subject  TEXT NOT NULL,
  category TEXT NOT NULL,
  text     TEXT NOT NULL,
  PRIMARY KEY (subject, category)
);

-- Which types play which roles (relation:role), the third capability beside owns and relates.
CREATE TABLE IF NOT EXISTS schema_plays (
  type TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (type, role)
);

-- Which owns and relates are ORDERED, lists: owns name[], relates parent[] (define.feature L338). Keyed
-- by the capability's subject (schema-subjects.ts), so a rename, an undefine and a redefine each
-- find it where they find the capability's annotations. Additive, like the tables above.
CREATE TABLE IF NOT EXISTS schema_ordered (
  subject TEXT PRIMARY KEY
);

-- relates father as parent: the role a relation's own role SPECIALIZES, by name; the relation above it
-- that declares that name is resolved on load (define.feature L635). Additive, like the tables above.
CREATE TABLE IF NOT EXISTS schema_specialises (
  relation    TEXT NOT NULL,
  role        TEXT NOT NULL,
  specialises TEXT NOT NULL,
  PRIMARY KEY (relation, role)
);

-- count: how many times the player plays the role in this relation — TypeDB's repeated role players,
-- (friend: $x, friend: $x), a multiset (match.feature L1185, delete.feature L453).
-- define fun: each schema function's definition as written, parsed again when the schema loads.
CREATE TABLE IF NOT EXISTS schema_function (
  name   TEXT PRIMARY KEY,
  source TEXT NOT NULL
);

-- define struct: each struct's fields, as JSON — name, value type, and whether optional.
CREATE TABLE IF NOT EXISTS schema_struct (
  name   TEXT PRIMARY KEY,
  fields TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_player (
  rel    INTEGER NOT NULL REFERENCES thing(iid) ON DELETE CASCADE,
  role   TEXT NOT NULL,
  player INTEGER NOT NULL REFERENCES thing(iid),
  count  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (rel, role, player)
);

-- A relation is looked up by who plays which role in it (a planned join's candidate seed, and every relation
-- check): the primary key starts with rel, so without this each lookup scans the whole table. An existing
-- store gets it when it is next opened (the interpreter ensures it). Not a rule; a lookup path.
CREATE INDEX IF NOT EXISTS role_player_by_player ON role_player(player, role, rel);`;

export interface SchemaSql {
  readonly ddl: string;
  /** Attribute types carrying `@key`, in declaration order. */
  readonly keys: readonly string[];
}

/** Generates the DDL for a `define` clause. */
export function generateSchema(file: TypeQLiteFile): SchemaSql {
  const statements: string[] = [PRELUDE];
  const keys: string[] = [];
  const subtypes: Array<[string, string]> = [];
  const elements: Array<['type' | 'attribute', string]> = [];
  const relations: string[] = [];
  const owns: Array<[string, string]> = [];
  const valueTypes: Array<[string, string]> = [];
  const relates: Array<[string, string]> = [];
  const uniques: string[] = [];
  const abstracts: string[] = [];
  const keyOwns: Array<[string, string]> = [];
  const annotations: Array<[string, string, string]> = [];
  const plays: Array<[string, string]> = [];
  /** `owns name[]`, `relates parent[]` — their subjects. */
  const ordered: string[] = [];
  /** `relates father as parent` — [relation, role, the role it specializes]. */
  const specialises: Array<[string, string, string]> = [];
  /** `define fun …` — [name, its definition as written]; `define struct …` — [name, its fields as JSON]. */
  const functions: Array<[string, string]> = [];
  const structs: Array<[string, string]> = [];
  const record = (subject: string, list: readonly Annotation[]): void => {
    for (const annotation of list) annotations.push([subject, recordCategory(annotation), recordText(annotation)]);
  };

  for (const clause of file.clauses) {
    if (!isDefineClause(clause)) continue;

    // Schema functions and structs, and every definition's `#!` doc comment (metadata.feature L189):
    // a comment line directly above is its `@doc`, unless it states one itself.
    for (const definition of clause.definitions) {
      const doc = docCommentOf(definition);
      const hasDoc = (list: readonly Annotation[]): boolean => list.some((a) => a.$type === 'DocAnnotation');
      if (definition.$type === 'FunctionDefinition') {
        const fn = definition as FunctionDefinition;
        functions.push([fn.name, fn.$cstNode?.text ?? '']);
        record(funSubject(fn.name), fn.annotations);
        if (doc !== undefined && !hasDoc(fn.annotations)) annotations.push([funSubject(fn.name), 'doc', `@doc(${JSON.stringify(doc)})`]);
      } else if (definition.$type === 'StructDef') {
        const struct = definition as StructDef;
        structs.push([struct.name, JSON.stringify(struct.fields.map((f) => ({ name: f.name, valueType: f.valueType, optional: f.optional === true })))]);
        record(structSubject(struct.name), struct.annotations);
        for (const field of struct.fields) record(structFieldSubject(struct.name, field.name), field.annotations);
        if (doc !== undefined && !hasDoc(struct.annotations)) annotations.push([structSubject(struct.name), 'doc', `@doc(${JSON.stringify(doc)})`]);
      } else if (doc !== undefined) {
        const typeDefinition = definition as TypeDefinition;
        const name = isTypeExtensionDef(typeDefinition) ? typeDefinition.type : typeDefinition.name;
        if (!hasDoc(typeDefinition.annotations)) annotations.push([typeSubject(name), 'doc', `@doc(${JSON.stringify(doc)})`]);
      }
    }

    for (const definition of clause.definitions.filter(isTypeDefinition)) {
      if (isEntityDef(definition) || isRelationDef(definition) || isTypeExtensionDef(definition)) {
        // A re-open (`person owns ref @key;`, no kind keyword) names an existing type and adds
        // traits to it. Its owns and keys register exactly as a definition's do; only the element
        // row and the parent are the definition's alone.
        const name = isTypeExtensionDef(definition) ? definition.type : definition.name;
        if (!isTypeExtensionDef(definition)) {
          elements.push(['type', definition.name]);
          if (isRelationDef(definition)) relations.push(definition.name);
        }
        // `person sub parent;` and `name value integer;` — a re-open may assign either, and the
        // interpreter has already refused the ones TypeDB refuses. A re-open's parent is a plain
        // name; a definition's is a cross-reference.
        const superType = declaredParentOf(definition);
        if (superType) subtypes.push([name, superType]);
        if (isTypeExtensionDef(definition) && definition.valueType) {
          valueTypes.push([name, definition.valueType]);
        }
        if (definition.annotations.some(isAbstractAnnotation)) abstracts.push(name);

        record(typeSubject(name), definition.annotations);
        record(subSubject(name), definition.subAnnotations);
        record(valueSubject(name), definition.valueAnnotations);
        for (const trait of definition.traits) {
          record(traitSubject(name, trait).subject, trait.annotations);
          if ((isOwnsTrait(trait) || isRelatesTrait(trait)) && trait.ordered === true) ordered.push(traitSubject(name, trait).subject);
          if (isRelatesTrait(trait) && trait.specialises !== undefined) specialises.push([name, trait.name, trait.specialises]);
          if (isPlaysTrait(trait)) {
            plays.push([name, roleRef(trait.role.relation.$refText, trait.role.role.$refText)]);
          }
          if (isOwnsTrait(trait)) owns.push([name, trait.attribute.$refText]);
          if (isOwnsTrait(trait) && trait.annotations.some(isKeyAnnotation)) {
            // `$refText` rather than `.ref?.name`: the DDL only needs the name as written, and
            // `.ref` requires a linked document — the generator must work on a parse alone.
            keys.push(trait.attribute.$refText);
            keyOwns.push([name, trait.attribute.$refText]);
          }
          if (isOwnsTrait(trait) && trait.annotations.some(isUniqueAnnotation)) {
            uniques.push(trait.attribute.$refText);
          }
          if (isRelatesTrait(trait)) relates.push([name, trait.name]);
        }
      }
      // An attribute's instances are rows in `attr`, so it needs no table of its own — but its
      // parent and its value type are schema facts the refusals read, and `plays` is a schema-level
      // permission this model does not enforce structurally — see the honest-gaps note in the README.
      //
      // 🔴 The parent was dropped here. `attribute first-name sub name;` pushed the element row
      // and nothing else, so no `type_parent` row existed for an attribute and the closure the
      // things' reads walk had nothing to walk (`d-20260911-an-attribute-subtype-is-accepted-by`).
      if (isAttributeDef(definition)) {
        elements.push(['attribute', definition.name]);
        record(typeSubject(definition.name), definition.annotations);
        record(subSubject(definition.name), definition.subAnnotations);
        record(valueSubject(definition.name), definition.valueAnnotations);
        const superType = definition.superType?.$refText;
        if (superType) subtypes.push([definition.name, superType]);
        if (definition.valueType) valueTypes.push([definition.name, definition.valueType]);
        if (definition.annotations.some(isAbstractAnnotation)) abstracts.push(definition.name);
      }
    }
  }

  for (const [kind, name] of elements) {
    statements.push(
      `INSERT OR IGNORE INTO schema_element(kind, name) VALUES (${q(kind)}, ${q(name)});`,
    );
  }

  for (const name of relations) {
    statements.push(`INSERT OR IGNORE INTO schema_relation(name) VALUES (${q(name)});`);
  }

  for (const [type, attribute] of owns) {
    statements.push(
      `INSERT OR IGNORE INTO schema_owns(type, attribute) VALUES (${q(type)}, ${q(attribute)});`,
    );
  }

  for (const [type, parent] of subtypes) {
    statements.push(
      `INSERT OR REPLACE INTO type_parent(type, parent) VALUES (${q(type)}, ${q(parent)});`,
    );
  }

  for (const [attribute, valueType] of valueTypes) {
    statements.push(
      `INSERT OR REPLACE INTO schema_value_type(attribute, value_type) VALUES (${q(attribute)}, ${q(valueType)});`,
    );
  }

  for (const [relation, role] of relates) {
    statements.push(
      `INSERT OR IGNORE INTO schema_relates(relation, role) VALUES (${q(relation)}, ${q(role)});`,
    );
  }

  for (const name of abstracts) {
    statements.push(`INSERT OR IGNORE INTO schema_abstract(name) VALUES (${q(name)});`);
  }

  for (const [type, attribute] of keyOwns) {
    statements.push(
      `INSERT OR IGNORE INTO schema_key_owns(type, attribute) VALUES (${q(type)}, ${q(attribute)});`,
    );
  }

  for (const [subject, category, text] of annotations) {
    statements.push(
      `INSERT OR REPLACE INTO schema_annotation(subject, category, text) VALUES (${q(subject)}, ${q(category)}, ${q(text)});`,
    );
  }

  for (const [type, role] of plays) {
    statements.push(`INSERT OR IGNORE INTO schema_plays(type, role) VALUES (${q(type)}, ${q(role)});`);
  }

  for (const subject of ordered) {
    statements.push(`INSERT OR IGNORE INTO schema_ordered(subject) VALUES (${q(subject)});`);
  }

  for (const [name, source] of functions) {
    statements.push(`INSERT OR REPLACE INTO schema_function(name, source) VALUES (${q(name)}, ${q(source)});`);
  }

  for (const [name, fields] of structs) {
    statements.push(`INSERT OR REPLACE INTO schema_struct(name, fields) VALUES (${q(name)}, ${q(fields)});`);
  }

  for (const [relation, role, parent] of specialises) {
    statements.push(`INSERT OR IGNORE INTO schema_specialises(relation, role, specialises) VALUES (${q(relation)}, ${q(role)}, ${q(parent)});`);
  }

  // `@key` and `@unique` need no index of their own: `has_unique_in_scope` enforces every one, among
  // the instances of the type that declares it (ADR-006 amendment). The interpreter rescopes the
  // stored ownerships inside this same transaction, so data that does not conform refuses the define.

  return { ddl: statements.join('\n\n'), keys };
}

/**
 * 🔴 **`generatePipeline` was deleted on 2026-09-03, unused since it was written.**
 *
 * It generated SQL for a query pipeline — a second, complete implementation of literal
 * conversion, variable binding, insert and select, standing beside the one
 * `TypeDBLiteInterpreter` actually runs. **Nothing called it**: not this package, not a test, not
 * an app. It was reachable only through the runtime index.
 *
 * Found while adding boolean and datetime literals, which had to be implemented *twice* to keep
 * two implementations of one concern from drifting — and the second copy had no way to be wrong
 * visibly, because no test could reach it. Deleting it leaves one literal path, in the
 * interpreter, with the round-trip tests that exercise it.
 *
 * `generateSchema` above is the part with callers: `TypeDBLiteInterpreter.define` uses it.
 */

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_');
