// 🔴 **Historical from 2026-09-01: there is no Jest in this repository any more.** The comments
// below argue for one runner over another — `tsx`/`node:test` against `ts-jest` — and that choice
// no longer exists: every suite runs under Vitest, with SWC supplying the `emitDecoratorMetadata`
// esbuild cannot and Node's real resolution supplying `node:sqlite`. The *reasoning* is kept
// because it is why the replacement had to satisfy both constraints at once, not because the
// split it describes is still real. See ADR-028.
import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TypeDBLiteInterpreter, type TypeDBLiteValue } from '../src/interpreter.js';

/**
 * 🔴 Run through `tsx`, not Jest, and the reason is specific rather than taste.
 *
 * `node:sqlite` is a builtin **only under its prefixed name** — `builtinModules` contains
 * `node:sqlite` but not `sqlite`. Jest strips the `node:` prefix before resolving and then cannot
 * find it; a `moduleNameMapper` re-enters on the shim's own `require`, and Jest patches
 * `createRequire` so that escape is mapped too. `tsx` uses Node's real resolution and has no gap.
 *
 * The language package still uses ts-jest, which is fine — it never touches `node:sqlite`.
 */

/**
 * 🔴 Deliberate copies of `@downstream/persistence-infrastructure`'s readers and predicate,
 * which is weaker than importing the real ones.
 *
 * That package is CommonJS with extensionless relative imports; this one is ESM because Langium is.
 * Bridging them here would also invert the dependency — Phase 03's adapter is what legitimately
 * depends on `persistence-infrastructure`, not the reverse.
 *
 * **Phase 03 proves these against the real, unmocked helpers**, which is where "drop-in" is
 * actually decided. If these copies drift, that phase is what catches it.
 */
type Row = Record<string, TypeDBLiteValue>;

const rowString = (row: Row, name: string): string | null =>
  row[name] ? row[name].asString() : null;

const requiredRowString = (row: Row, name: string): string => {
  const value = rowString(row, name);
  if (value === null) throw new Error(`Result row has no variable '${name}'`);
  return value;
};

const rowNumber = (row: Row, name: string): number | null => {
  const value = row[name];
  if (!value) return null;
  try {
    return value.asInteger();
  } catch {
    return null;
  }
};

const isUniqueConstraintViolation = (
  error: unknown,
  attribute: string,
): boolean =>
  error instanceof Error &&
  error.message.includes("[CNT9] Constraint '@unique' has been violated") &&
  error.message.includes(`'${attribute}'`);

const LIBS = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path: string) => readFileSync(join(LIBS, path), 'utf8');
const skillsSchema = read(
  'platform/skills/infrastructure/src/lib/skills.schema.typeqlite',
);
const iamSchema = read('platform/iam/infrastructure/src/lib/iam.schema.typeqlite');

describe('the interpreter runs real repository TypeQLite', () => {
  let db: TypeDBLiteInterpreter;
  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
  });

  it('applies a production schema, and re-applying is not an error', () => {
    db.define(skillsSchema);
    assert.doesNotThrow(() => db.define(skillsSchema));
  });

  it('inserts a skill and reads its attributes back', () => {
    db.define(skillsSchema);
    db.execute(
      'insert $s isa skill, has skill-id "start-session", has skill-name "Start Session", has skill-description "Orient";',
    );
    const { rows } = db.query(
      'match $s isa skill, has skill-id "start-session", has skill-name $n, has skill-description $d;\nselect $n, $d;',
    );
    assert.equal(rows.length, 1);
    assert.equal(rowString(rows[0], 'n'), 'Start Session');
    assert.equal(requiredRowString(rows[0], 'd'), 'Orient');
  });

  it('reads a numeric attribute with rowNumber, which rowString cannot', () => {
    db.define(skillsSchema);
    db.execute(
      'insert $st isa skill-step, has step-id "s-1", has ordinal 2, has step-kind "operation";',
    );
    const { rows } = db.query(
      'match $st isa skill-step, has step-id "s-1", has ordinal $o, has step-kind $k;\nselect $o, $k;',
    );
    assert.equal(rowNumber(rows[0], 'o'), 2);
    assert.equal(rowString(rows[0], 'k'), 'operation');
  });

  it('relates two things and traverses the relation', () => {
    db.define(skillsSchema);
    db.execute(
      'insert $s isa skill, has skill-id "start-session", has skill-name "S", has skill-description "D";',
    );
    db.execute(
      'insert $st isa skill-step, has step-id "s-1", has ordinal 1, has step-kind "operation";',
    );
    db.execute(
      'match\n  $s isa skill, has skill-id "start-session";\n  $st isa skill-step, has step-id "s-1";\ninsert (owner: $s, step: $st) isa skill-composition;',
    );
    const { rows } = db.query(
      'match\n  $s isa skill, has skill-id "start-session";\n  $st isa skill-step, has step-id $id, has ordinal $o, has step-kind $k;\n  (owner: $s, step: $st) isa skill-composition;\nselect $id, $o, $k;',
    );
    assert.equal(rows.length, 1);
    assert.equal(rowString(rows[0], 'id'), 's-1');
  });

  // 🔴 The finding that shapes this phase. Two production repositories raise
  // PrincipalAlreadyExistsError off this exact match; without translation a duplicate registration
  // stops being reported as one — the hosted-app-ai-chat failure, restored by its replacement.
  describe('a @key violation is reported the way the repositories match on', () => {
    const insertDuplicate = () => {
      db.define(iamSchema);
      db.execute(
        'insert $p isa principal, has principal-id "u-1", has principal-type "user";',
      );
      try {
        db.execute(
          'insert $p isa principal, has principal-id "u-1", has principal-type "user";',
        );
      } catch (error) {
        return error;
      }
      return undefined;
    };

    it("satisfies the predicate for the attribute that was violated", () => {
      const caught = insertDuplicate();
      assert.ok(caught !== undefined, 'a duplicate @key must throw');
      assert.equal(isUniqueConstraintViolation(caught, 'principal-id'), true);
    });

    it('does NOT match a different attribute', () => {
      // An unscoped match would report an unrelated constraint as a duplicate registration,
      // sending an operator after the wrong problem — the helper's own comment warns about it.
      const caught = insertDuplicate();
      assert.equal(isUniqueConstraintViolation(caught, 'membership-key'), false);
    });
  });

  // 🔴 Corrected 2026-08-29. This originally asserted that the insert THREW, and that was wrong
  // TypeQLite: `match … insert …` is quantified over the match's results, so no results means the
  // write runs zero times and the statement succeeds. The real Skills repository suite caught it —
  // `linkDependency` relies on the no-op and then reports its own, clearer *"Refusing a dangling
  // dependency"*, which the throw was pre-empting.
  it('a relation whose role player does not exist inserts nothing, and does not throw', () => {
    db.define(skillsSchema);
    db.execute(
      'insert $st isa skill-step, has step-id "s-1", has ordinal 1, has step-kind "operation";',
    );
    assert.doesNotThrow(() =>
      db.execute(
        'match\n  $d isa skill-step, has step-id "s-1";\n  $p isa skill-step, has step-id "does-not-exist";\ninsert (dependent: $d, prerequisite: $p) isa step-dependency;',
      ),
    );
    // Nothing was written — the caller's own check is what reports the problem.
    const { rows } = db.query(
      'match $r isa step-dependency (dependent: $d, prerequisite: $p);\n  $d has step-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 0);
  });

  it('throws on a type the applied schema does not define', () => {
    db.define(iamSchema);
    assert.throws(
      () =>
        db.query(
          'match $x isa nonexistent-type, has principal-id $i;\nselect $i;',
        ),
      /Unknown type 'nonexistent-type'/,
    );
  });
});
