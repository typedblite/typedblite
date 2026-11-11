import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { TypeQLiteValidationCode } from '@typedblite/language';
import { DiagnosticCode, MAX_DIAGNOSTICS, diagnosticOf } from '../src/diagnostics.js';

const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute node-label, value string;',
  'attribute edge-id, value string;',
  'entity node, owns node-id @key, owns node-label, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key;',
].join('\n');

let engine: TypeDBLiteInterpreter;
const codesOf = (diagnostics: readonly { code?: string | number }[]) =>
  diagnostics.map((d) => d.code);

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
});

/**
 * 🔴 ADR-004 Decision 3, and the assertion that guards it.
 *
 * The guarantees ADR-001 and ADR-002 rest on are enforced by failures **propagating**. Replacing a
 * throw with a diagnostic would downgrade a failure to a warning, and every one of those guarantees
 * would quietly stop holding while the suite stayed green.
 */
describe('errors still throw, with the diagnostic attached', () => {
  const throwers: Array<[string, () => void, string]> = [
    // `@card` and `@unique` were the first two rows here, as refusals. Since 2026-09-11 they are
    // applied and reported as a fact — `annotation-not-enforced.test.ts` — and a validator ERROR
    // that still throws with its diagnostic attached is represented by the reserved keyword.
    [
      'a reserved keyword',
      () => engine.define('define\nattribute fetch, value string;'),
      TypeQLiteValidationCode.reservedKeyword,
    ],
    [
      'a parse failure',
      () => engine.execute('insert $n isa'),
      DiagnosticCode.parseFailed,
    ],
    [
      'an unknown type',
      () => engine.execute('insert $n isa nonexistent, has node-id "a";'),
      DiagnosticCode.unknownType,
    ],
    [
      'an unknown attribute',
      () => engine.execute('insert $n isa node, has nonexistent "a";'),
      DiagnosticCode.unknownAttribute,
    ],
    [
      'a dangling relation',
      () => engine.execute('insert $e isa link, links (source: $missing, target: $gone), has edge-id "e";'),
      DiagnosticCode.danglingRelation,
    ],
    [
      'a @key violation raised by SQLite',
      () => {
        engine.execute('insert $n isa node, has node-id "dup";');
        engine.execute('insert $m isa node, has node-id "dup";');
      },
      DiagnosticCode.constraintViolated,
    ],
  ];

  for (const [name, run, code] of throwers) {
    it(`${name} throws, and carries a ranged diagnostic`, () => {
      assert.throws(run, (error: unknown) => {
        const diagnostic = diagnosticOf(error);
        assert.ok(diagnostic, 'the thrown error carries no diagnostic');
        assert.equal(diagnostic.code, code);
        assert.equal(diagnostic.severity, 1, 'a throw is an Error-severity diagnostic');
        assert.ok(diagnostic.message.length > 0);
        assert.ok(error instanceof Error, 'the error class is unchanged');
        return true;
      });
    });
  }

  // Seven until 2026-09-11; `@card` and `@unique` left the list by decision, not by accident —
  // they are applied and reported now (`annotation-not-enforced.test.ts`), and one reserved-keyword
  // row stands in for the validator error that still throws.
  it('the throw count did not fall — all six still throw', () => {
    assert.equal(throwers.length, 6);
  });

  /**
   * 🔴 `isUniqueConstraintViolation` matches on this text, and two production repositories raise
   * `PrincipalAlreadyExistsError` from it. A new error class or a reworded message here would stop
   * a duplicate registration being reported as a duplicate — the 2026-07-16 failure, restored.
   */
  it('the @key violation message is unchanged, so the repositories still match it', () => {
    engine.execute('insert $n isa node, has node-id "dup";');
    assert.throws(
      () => engine.execute('insert $m isa node, has node-id "dup";'),
      /\[CNT9\] Constraint '@unique' has been violated for attribute 'node-id'\./,
    );
  });
});

describe('ranges point at the source', () => {
  it('locates a term on a multi-line statement, not just line 0', () => {
    assert.throws(
      () =>
        engine.execute(
          ['insert $n isa node,', '  has node-id "a",', '  has bogus-attr "b";'].join('\n'),
        ),
      (error: unknown) => {
        const range = diagnosticOf(error)?.range;
        assert.ok(range);
        assert.equal(range.start.line, 2, 'the range should be on the third line');
        assert.ok(range.start.character > 0, 'and indented, not at column 0');
        return true;
      },
    );
  });

  it('derives a range for a parse failure, which has no AST to read', () => {
    assert.throws(
      () => engine.execute('insert $n isa node;\n\ninsert $$$ broken'),
      (error: unknown) => {
        const range = diagnosticOf(error)?.range;
        assert.ok(range);
        assert.equal(range.start.line, 2);
        return true;
      },
    );
  });
});

describe('execution facts', () => {
  it('reports what a define applied, and how much was already present', () => {
    const report = engine.define(SCHEMA);
    const applied = report.diagnostics.find(
      (d) => d.code === DiagnosticCode.schemaApplied,
    );
    assert.ok(applied);
    assert.match(applied.message, /applied 0 new definition\(s\); 5 already present/);
    assert.equal(applied.severity, 3, 'an execution fact is Information severity');
  });

  it('reports registered key attributes', () => {
    const report = engine.define(SCHEMA);
    assert.match(
      report.diagnostics.find((d) => d.code === DiagnosticCode.keysRegistered)?.message ?? '',
      /Registered \d+ key attribute\(s\)/,
    );
  });

  /**
   * 🔴 The fact this phase exists for.
   *
   * `match … insert` is quantified over the match, so an empty match is a SUCCESS that writes
   * nothing. Nothing throws and nothing logs; before this, the caller could not tell it apart from
   * a write that happened.
   */
  it('reports that an empty match wrote nothing', () => {
    const report = engine.execute(
      'match $n isa node, has node-id "absent"; insert $n has node-label "x";',
    );
    assert.ok(codesOf(report.diagnostics).includes(DiagnosticCode.emptyMatch));
    assert.equal(engine.query('match $n isa node, has node-label $l; select $l;').rows.length, 0);
  });

  it('reports what a write touched', () => {
    const report = engine.execute('insert $n isa node, has node-id "a", has node-label "L";');
    const wrote = report.diagnostics.find((d) => d.code === DiagnosticCode.wrote);
    assert.ok(wrote);
    assert.match(wrote.message, /Wrote 1 thing\(s\), 2 attribute\(s\), 0 role player\(s\)/);
  });

  it('reports tombstones on a delete', () => {
    engine.execute('insert $n isa node, has node-id "a";');
    const report = engine.execute('match $n isa node, has node-id "a"; delete $n;');
    assert.ok(codesOf(report.diagnostics).includes(DiagnosticCode.tombstones));
  });

  // 🔴 Both queries projected `$n` — a thing variable — until 2026-09-10, so **neither returned a
  // row**, and the second assertion's own message ("a query that returned rows") described
  // something that never happened. It passed because `noCandidates` is only emitted when the
  // projection is empty *and* the candidate set is empty; with a node inserted the second half was
  // false, so the code under test was never exercised by this case. `select` now refuses a thing
  // variable, which is what surfaced it. The row count is asserted here for the same reason.
  it('distinguishes an empty candidate set from an excluded one', () => {
    const empty = engine.query(
      'match $n isa node, has node-id "nope", has node-label $l; select $l;',
    );
    assert.equal(empty.rows.length, 0);
    assert.ok(codesOf(empty.diagnostics).includes(DiagnosticCode.noCandidates));

    engine.execute('insert $n isa node, has node-id "a", has node-label "alpha";');
    const found = engine.query(
      'match $n isa node, has node-id "a", has node-label $l; select $l;',
    );
    assert.equal(found.rows.length, 1, 'the case only means anything if rows came back');
    assert.ok(
      !codesOf(found.diagnostics).includes(DiagnosticCode.noCandidates),
      'a query that returned rows must not claim it found no candidates',
    );
  });

  // 🔴 The case the test above never reached, and the one the whole diagnostic exists for.
  //
  // `candidates()` applies the literals and bindings, so a store that HAS nodes but none matching
  // `node-id "nope"` also answers 0 — and the fact then claims `isa node` matched 0 candidates
  // "before constraints were applied", which is the schema answer to a data problem. The two are
  // the only thing this diagnostic is for; reporting the wrong one is worse than reporting neither.
  it('says the constraints excluded everything when the type itself has candidates', () => {
    engine.execute('insert $n isa node, has node-id "a", has node-label "alpha";');
    const excluded = engine.query(
      'match $n isa node, has node-id "nope", has node-label $l; select $l;',
    );

    assert.equal(excluded.rows.length, 0);
    const fact = excluded.diagnostics.find(
      (d) => d.code === DiagnosticCode.noCandidates,
    );
    assert.ok(fact, 'an empty result still owes an explanation');
    assert.doesNotMatch(
      fact.message,
      /matched 0 candidate/,
      'the type had a candidate — saying otherwise blames the schema for a data problem',
    );
    assert.match(fact.message, /matched 1 candidate\(s\) before the constraints on '\$n'/);
    assert.match(fact.message, /and 0 after/);
  });

  // 🔴 The limit of what this fact can honestly say, asserted so nobody re-adds the inference.
  //
  // The candidate count says only that no candidate satisfied ALL the constraints, never which one
  // was responsible nor for how many. Successive attempts to name the culprit from it were each
  // wrong in a new way, so the fact reports the two numbers and nothing more.
  //
  // ⚠️ **This case used to use `has edge-id $e` on a node** — an attribute `node` does not own —
  // to make the point that the engine could not tell a schema fault from a data one. It can now:
  // `schema_owns` records ownership and that pattern is **refused** before it ever reaches this
  // fact. The case therefore has to be genuinely a *data* emptiness, which is what it now is: an
  // owned attribute that no instance happens to carry.
  it('reports both counts without guessing which constraint was responsible', () => {
    // `node` owns `node-label`; this one simply has not got one.
    engine.execute('insert $n isa node, has node-id "a";');
    const empty = engine.query('match $n isa node, has node-label $l; select $l;');

    assert.equal(empty.rows.length, 0);
    const fact = empty.diagnostics.find((d) => d.code === DiagnosticCode.noCandidates);
    assert.ok(fact, 'an empty result still owes an explanation');
    assert.match(fact.message, /matched 1 candidate\(s\) before the constraints on '\$n'/);
    assert.match(fact.message, /and 0 after/);
    // Naming a culprit needs more than a count, and the fact must not pretend otherwise.
    assert.doesNotMatch(fact.message, /excluded all of them/);
  });

  it('reports what a query projected', () => {
    engine.execute('insert $n isa node, has node-id "a", has node-label "L";');
    const result = engine.query(
      'match $n isa node, has node-id $i, has node-label $l; select $i, $l;',
    );
    const projected = result.diagnostics.find((d) => d.code === DiagnosticCode.projected);
    assert.ok(projected);
    assert.match(projected.message, /Matched 1 row\(s\); `select` names 2 variable\(s\)/);
  });
});

/**
 * 🔴 ADR-004 Decision 4. These reports travel into a `DomainEvent` payload, which replicates and is
 * logged. A diagnostic that quoted the statement it came from would carry attribute VALUES with it.
 */
describe('diagnostics do not leak written values', () => {
  it('never repeats an attribute value in a message', () => {
    const secret = 'super-secret-value-9f3a';
    const write = engine.execute(`insert $n isa node, has node-id "a", has node-label "${secret}";`);
    const read = engine.query('match $n isa node, has node-label $l; select $l;');
    for (const diagnostic of [...write.diagnostics, ...read.diagnostics]) {
      assert.ok(
        !diagnostic.message.includes(secret),
        `a diagnostic leaked a written value: ${diagnostic.message}`,
      );
    }
  });

  it('names the attribute but not the value on a constraint violation', () => {
    engine.execute('insert $n isa node, has node-id "collide-me";');
    assert.throws(
      () => engine.execute('insert $m isa node, has node-id "collide-me";'),
      (error: unknown) => {
        const diagnostic = diagnosticOf(error);
        assert.ok(diagnostic);
        assert.ok(diagnostic.message.includes('node-id'), 'the attribute should be named');
        assert.ok(
          !diagnostic.message.includes('collide-me'),
          'the colliding VALUE must not appear — payloads replicate',
        );
        return true;
      },
    );
  });
});

describe('the report is capped', () => {
  it('truncates past the cap and says how many it dropped', () => {
    const many = Array.from(
      { length: MAX_DIAGNOSTICS + 20 },
      (_, i) => `insert $n${i} isa node, has node-id "n${i}";`,
      // `end;` keeps them separate queries — back to back, they would be one pipeline of inserts
      // with one `wrote` fact, and nothing to truncate.
    ).join('\nend;\n');
    const report = engine.execute(many);
    const truncation = report.diagnostics.find(
      (d) => d.code === DiagnosticCode.truncated,
    );
    assert.ok(truncation, 'past the cap, a truncation marker is required');
    assert.match(truncation.message, /further diagnostics were suppressed/);
    // The cap plus the marker; errors are exempt and there are none here.
    assert.equal(report.diagnostics.length, MAX_DIAGNOSTICS + 1);
  });
});
