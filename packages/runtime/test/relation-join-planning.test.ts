import { beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 A relation constraint must prune the search, not just check its end.
 *
 * `combinations()` bound EVERY thing variable first (one `candidates()` scan each, as a cartesian
 * product) and applied relation constraints afterwards, as filters. The Skills catalog's
 * `subSkillsIn` query — one skill x every skill-step x every skill — was ~211,000 combinations and
 * 32.5 s per call on a 3,423-thing store, paid by every Skill load, so `skill.define` and
 * `skill.seed` took tens of minutes.
 *
 * This asserts COUNTS from the query trace, not a time: a time is a flaky test and a count is a
 * decision. The store mirrors the real skills schema's shape at a size where the cartesian cost
 * (here 120 steps x 41 skills ~ 4,900 combinations) is unmistakable and the fixed cost is tiny.
 */
const SCHEMA = [
  'define',
  'attribute skill-id, value string;',
  'attribute skill-version-key, value string;',
  'attribute revision, value string;',
  'attribute step-id, value string;',
  'attribute skill-step-key, value string;',
  'entity skill, owns skill-version-key @key, owns skill-id, owns revision, plays skill-composition:owner, plays sub-workflow:child-skill;',
  'entity skill-step, owns skill-step-key @key, owns step-id, plays skill-composition:step, plays sub-workflow:parent-step, plays step-dependency:dependent, plays step-dependency:prerequisite;',
  'relation skill-composition, relates owner, relates step;',
  'relation sub-workflow, relates parent-step, relates child-skill;',
  'relation step-dependency, relates dependent, relates prerequisite;',
].join('\n');

const STEPS_PER_SKILL = 60;
const CHILDREN = 40;
const NESTED = 30; // every other step of the parent skill nests a child

const QUERY = `
  match
    $s isa skill, has skill-id "parent", has revision "r1";
    $st isa skill-step, has step-id $id;
    (owner: $s, step: $st) isa skill-composition;
    $child isa skill, has skill-id $cid;
    $r isa sub-workflow (parent-step: $st, child-skill: $child);
  select $id, $cid;`;

let engine: TypeDBLiteInterpreter;
const expected = new Map<string, string>();

const seed = (target: TypeDBLiteInterpreter): void => {
  target.define(SCHEMA);
  const skill = (id: string): void => {
    target.execute(`insert $s isa skill, has skill-version-key "${id}::r1", has skill-id "${id}", has revision "r1";`);
  };
  skill('parent');
  skill('other');
  for (let c = 0; c < CHILDREN; c++) skill(`child-${c}`);
  for (const owner of ['parent', 'other']) {
    for (let i = 0; i < STEPS_PER_SKILL; i++) {
      target.execute(
        `match $s isa skill, has skill-id "${owner}"; ` +
          `insert $st isa skill-step, has skill-step-key "${owner}::${i}", has step-id "${owner}-step-${i}"; ` +
          `(owner: $s, step: $st) isa skill-composition;`,
      );
    }
  }
  for (let i = 0; i < NESTED; i++) {
    const child = `child-${i % CHILDREN}`;
    target.execute(
      `match $st isa skill-step, has skill-step-key "parent::${i * 2}"; $c isa skill, has skill-id "${child}"; ` +
        `insert $r isa sub-workflow (parent-step: $st, child-skill: $c);`,
    );
    expected.set(`parent-step-${i * 2}`, child);
  }
  // A chain: step i depends on step i-1 (59 edges among the parent's 60 steps).
  for (let i = 1; i < STEPS_PER_SKILL; i++) {
    target.execute(
      `match $d isa skill-step, has skill-step-key "parent::${i}"; $p isa skill-step, has skill-step-key "parent::${i - 1}"; ` +
        `insert (dependent: $d, prerequisite: $p) isa step-dependency;`,
    );
  }
};

const asMap = (rows: ReadonlyArray<Record<string, unknown>>): Map<string, string> => {
  const text = (cell: unknown): string => String((cell as { value?: unknown }).value ?? cell);
  return new Map(rows.map((row) => [text(row['id']), text(row['cid'])]));
};

beforeAll(() => {
  engine = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true });
  seed(engine);
});

describe('a relation constraint prunes the search (subSkillsIn shape)', () => {
  it('answers the nested steps and their children', () => {
    const { rows } = engine.query(QUERY);
    assert.equal(rows.length, NESTED);
    assert.deepEqual([...asMap(rows)].sort(), [...expected].sort());
  });

  it('does not build the cartesian product of steps x skills', () => {
    engine.query(QUERY);
    const trace = engine.lastQueryTrace();
    assert.ok(trace);
    const cartesian = 2 * STEPS_PER_SKILL * (CHILDREN + 2); // 120 steps x 42 skills
    // The old engine: ~cartesian combinations, a relationHolds each, several statements each.
    assert.ok(trace.combinationsCreated <= 600, `combinations created: ${trace.combinationsCreated} (cartesian is ${cartesian})`);
    assert.ok(trace.relationHoldsCalls <= 4 * STEPS_PER_SKILL, `relationHolds calls: ${trace.relationHoldsCalls}`);
    assert.ok(trace.candidateRows <= 600, `candidate rows: ${trace.candidateRows}`);
    assert.ok(trace.statementsExecuted <= 1500, `statements executed: ${trace.statementsExecuted}`);
  });
});

describe('a relation between two bound variables prunes before the next variable multiplies it', () => {
  // `$a` and `$b` are each drawn from the skill's 60 steps (3,600 pairs); only 59 are a dependency
  // edge. `$z` is then unconstrained (42 skills). Filtering at the end is 3,600 x 42 = 151,200
  // combinations; filtering as soon as `$a` and `$b` are bound is 59 x 42.
  const PAIRS = `
    match
      $s isa skill, has skill-id "parent";
      $a isa skill-step;
      (owner: $s, step: $a) isa skill-composition;
      $b isa skill-step;
      (owner: $s, step: $b) isa skill-composition;
      (dependent: $a, prerequisite: $b) isa step-dependency;
      $z isa skill;
    select $a, $b, $z;`;

  it('answers every edge against every skill', () => {
    assert.equal(engine.query(PAIRS).rows.length, (STEPS_PER_SKILL - 1) * (CHILDREN + 2));
  });

  it('applies the filter before $z, not after', () => {
    engine.query(PAIRS);
    const trace = engine.lastQueryTrace();
    assert.ok(trace);
    assert.ok(trace.combinationsCreated <= 10_000, `combinations created: ${trace.combinationsCreated} (filtering last is 150,000+)`);
  });
});
