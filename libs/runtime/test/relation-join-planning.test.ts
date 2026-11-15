import { beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 A relation constraint must prune the search, not just check its end.
 *
 * `combinations()` bound EVERY thing variable first (one `candidates()` scan each, as a cartesian
 * product) and applied relation constraints afterwards, as filters. A real nested-project query — one project x every task x every project — was ~211,000 combinations and
 * 32.5 s per call on a 3,423-thing store, paid by every Project load, so `project.define` and
 * `project.seed` took tens of minutes.
 *
 * This asserts COUNTS from the query trace, not a time: a time is a flaky test and a count is a
 * decision. The store mirrors the tracker schema's shape at a size where the cartesian cost
 * (here 120 steps x 41 projects ~ 4,900 combinations) is unmistakable and the fixed cost is tiny.
 */
const SCHEMA = [
  'define',
  'attribute project-id, value string;',
  'attribute project-key, value string;',
  'attribute revision, value string;',
  'attribute task-id, value string;',
  'attribute task-key, value string;',
  'entity project, owns project-key @key, owns project-id, owns revision, plays project-task:owner, plays subproject:child-project;',
  'entity task, owns task-key @key, owns task-id, plays project-task:task, plays subproject:parent-task, plays task-dependency:dependent, plays task-dependency:prerequisite;',
  'relation project-task, relates owner, relates task;',
  'relation subproject, relates parent-task, relates child-project;',
  'relation task-dependency, relates dependent, relates prerequisite;',
].join('\n');

const TASKS_PER_PROJECT = 60;
const CHILDREN = 40;
const NESTED = 30; // every other step of the parent project nests a child

const QUERY = `
  match
    $s isa project, has project-id "parent", has revision "r1";
    $st isa task, has task-id $id;
    (owner: $s, task: $st) isa project-task;
    $child isa project, has project-id $cid;
    $r isa subproject (parent-task: $st, child-project: $child);
  select $id, $cid;`;

let engine: TypeDBLiteInterpreter;
const expected = new Map<string, string>();

const seed = (target: TypeDBLiteInterpreter): void => {
  target.define(SCHEMA);
  const project = (id: string): void => {
    target.execute(`insert $s isa project, has project-key "${id}::r1", has project-id "${id}", has revision "r1";`);
  };
  project('parent');
  project('other');
  for (let c = 0; c < CHILDREN; c++) project(`child-${c}`);
  for (const owner of ['parent', 'other']) {
    for (let i = 0; i < TASKS_PER_PROJECT; i++) {
      target.execute(
        `match $s isa project, has project-id "${owner}"; ` +
          `insert $st isa task, has task-key "${owner}::${i}", has task-id "${owner}-step-${i}"; ` +
          `(owner: $s, task: $st) isa project-task;`,
      );
    }
  }
  for (let i = 0; i < NESTED; i++) {
    const child = `child-${i % CHILDREN}`;
    target.execute(
      `match $st isa task, has task-key "parent::${i * 2}"; $c isa project, has project-id "${child}"; ` +
        `insert $r isa subproject (parent-task: $st, child-project: $c);`,
    );
    expected.set(`parent-step-${i * 2}`, child);
  }
  // A chain: step i depends on step i-1 (59 edges among the parent's 60 steps).
  for (let i = 1; i < TASKS_PER_PROJECT; i++) {
    target.execute(
      `match $d isa task, has task-key "parent::${i}"; $p isa task, has task-key "parent::${i - 1}"; ` +
        `insert (dependent: $d, prerequisite: $p) isa task-dependency;`,
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

  it('does not build the cartesian product of steps x projects', () => {
    engine.query(QUERY);
    const trace = engine.lastQueryTrace();
    assert.ok(trace);
    const cartesian = 2 * TASKS_PER_PROJECT * (CHILDREN + 2); // 120 steps x 42 projects
    // The old engine: ~cartesian combinations, a relationHolds each, several statements each.
    assert.ok(trace.combinationsCreated <= 600, `combinations created: ${trace.combinationsCreated} (cartesian is ${cartesian})`);
    assert.ok(trace.relationHoldsCalls <= 4 * TASKS_PER_PROJECT, `relationHolds calls: ${trace.relationHoldsCalls}`);
    assert.ok(trace.candidateRows <= 600, `candidate rows: ${trace.candidateRows}`);
    assert.ok(trace.statementsExecuted <= 1500, `statements executed: ${trace.statementsExecuted}`);
  });
});

describe('a relation between two bound variables prunes before the next variable multiplies it', () => {
  // `$a` and `$b` are each drawn from the project's 60 steps (3,600 pairs); only 59 are a dependency
  // edge. `$z` is then unconstrained (42 projects). Filtering at the end is 3,600 x 42 = 151,200
  // combinations; filtering as soon as `$a` and `$b` are bound is 59 x 42.
  const PAIRS = `
    match
      $s isa project, has project-id "parent";
      $a isa task;
      (owner: $s, task: $a) isa project-task;
      $b isa task;
      (owner: $s, task: $b) isa project-task;
      (dependent: $a, prerequisite: $b) isa task-dependency;
      $z isa project;
    select $a, $b, $z;`;

  it('answers every edge against every project', () => {
    assert.equal(engine.query(PAIRS).rows.length, (TASKS_PER_PROJECT - 1) * (CHILDREN + 2));
  });

  it('applies the filter before $z, not after', () => {
    engine.query(PAIRS);
    const trace = engine.lastQueryTrace();
    assert.ok(trace);
    assert.ok(trace.combinationsCreated <= 10_000, `combinations created: ${trace.combinationsCreated} (filtering last is 150,000+)`);
  });
});
