import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  attachStepHook,
  StepRecorder,
  type BlockRecord,
  type FrameRecord,
  type Recording,
  type RecordingLimits,
  type StageRecord,
  type StepRecord,
} from '../src/debug.js';
import { diagnosticOf } from '../src/diagnostics.js';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * The recorder (ADR-014): what one statement's recording holds. Steps in the order they ran, each with every range it
 * consumes (B6); calls summed with a breakdown (B7); things described as they were at the step (B8); the caps (B10);
 * and a refusal placed where it happened.
 */

const SCHEMA = [
  'define',
  'attribute name, value string;',
  'attribute age, value integer;',
  'attribute nick, value string;',
  'entity person, owns name, owns age, owns nick;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $a isa person, has name "Ann", has age 30; $b isa person, has name "Bob", has age 17; $c isa person, has name "Cid", has age 45;');
});

/** Run one statement with a recorder; a refusal is recorded, as `Session.debug` records it. */
const record = (text: string, limits: Partial<RecordingLimits> = {}, write = false): { recording: Recording; recorder: StepRecorder } => {
  const recorder = new StepRecorder(limits);
  attachStepHook(engine, recorder);
  try {
    if (write) engine.execute(text);
    else engine.query(text);
  } catch (error) {
    const diagnostic = diagnosticOf(error);
    recorder.refused(error instanceof Error ? error.message : String(error), diagnostic?.code as string | undefined, diagnostic?.range);
  } finally {
    attachStepHook(engine, undefined);
  }
  const recording = recorder.finish();
  assert.equal(recorder.faults, 0);
  return { recording, recorder };
};

const stages = (recording: Recording): StageRecord[] => recording.frames.flatMap((frame) => frame.stages);
const steps = (stage: StageRecord): StepRecord[] => stage.blocks.flatMap((block) => block.steps);
const lines = (step: StepRecord): number[] => step.ranges.map((range) => range.start.line);

/** Every record in a recording, by id. */
const byId = (recording: Recording): Map<number, { kind: string; name?: string }> => {
  const found = new Map<number, { kind: string; name?: string }>();
  const blocks = (list: readonly BlockRecord[]): void => {
    for (const block of list) {
      found.set(block.id, { kind: `block:${block.kind}` });
      for (const step of block.steps) {
        found.set(step.id, { kind: `step:${step.kind}`, name: step.name });
        blocks(step.blocks);
        frames(step.frames);
      }
    }
  };
  const frames = (list: readonly FrameRecord[]): void => {
    for (const frame of list) {
      found.set(frame.id, { kind: `frame:${frame.kind}`, name: frame.name });
      for (const stage of frame.stages) {
        found.set(stage.id, { kind: `stage:${stage.kind}` });
        blocks(stage.blocks);
        frames(stage.frames);
      }
    }
  };
  frames(recording.frames);
  return found;
};

describe('a recording', () => {
  it('holds a match`s steps in the order they ran, not the source`s, each with every range it consumes (B6)', () => {
    const { recording } = record(['match', '  $p has age $a;', '  $a > 20;', '  $p isa person;', '  $p has name "Ann";'].join('\n'));
    const [match] = stages(recording);
    // The thing step runs first, though its `isa` is on line 3, and consumes both of its lines.
    assert.deepEqual(steps(match).map((step) => step.name), ['thing $p', '$p has age $a', '$a > 20']);
    assert.deepEqual(lines(steps(match)[0]), [1, 3, 4]);
    assert.deepEqual(lines(steps(match)[1]), [1]);
    assert.deepEqual(lines(steps(match)[2]), [2]);
  });

  it('counts each comparison and let inside a values step, charging a dropped row to the comparison that dropped it', () => {
    const { recording } = record('match $p isa person, has age $a; let $d = $a * 2; $d > 50; $a < 40; select $a;');
    const values = steps(stages(recording)[0]).find((step) => step.kind === 'values');
    assert.ok(values);
    assert.deepEqual(
      values.values.map((value) => [value.kind, value.name, value.rowsIn, value.rowsOut]),
      [
        // `$a < 40` reads only what the match bound, so it runs before the `let`: execution order (B6).
        ['comparison', '$a < 40', 3, 2],
        ['let', 'let $d = $a * 2', 2, 2],
        ['comparison', '$d > 50', 2, 1],
      ],
    );
    assert.deepEqual([values.rowsIn, values.rowsOut], [3, 1]);
  });

  it('sums a block`s steps over every incoming row, with a breakdown by call (B7)', () => {
    const { recording } = record('match $p isa person, has name $n; match $p has age $a; $a < 40; select $n, $a;');
    const second = stages(recording)[1];
    assert.equal(second.blocks.length, 1);
    assert.equal(second.blocks[0].calls, 3);
    const comparison = steps(second).find((step) => step.kind === 'values');
    assert.ok(comparison);
    assert.deepEqual([comparison.rowsIn, comparison.rowsOut], [3, 2]);
    assert.deepEqual(comparison.byCall, [
      { rowsIn: 1, rowsOut: 1 },
      { rowsIn: 1, rowsOut: 1 },
      { rowsIn: 1, rowsOut: 0 },
    ]);
  });

  it('holds each stage`s rows and the scope after it', () => {
    const { recording } = record('match $p isa person, has name $n; sort $n desc; limit 2; select $n;');
    const [match, sort, limit] = stages(recording);
    assert.deepEqual([match.kind, sort.kind, limit.kind], ['match', 'sort', 'limit']);
    assert.deepEqual([match.rowsIn, match.rowsOut, limit.rowsOut], [1, 3, 2]);
    assert.deepEqual(
      sort.rows.map((row) => row.$n),
      ['Cid', 'Bob', 'Ann'].map((value) => ({ kind: 'attribute', type: 'name', valueType: 'string', value })),
    );
    assert.deepEqual(match.scope.find((variable) => variable.name === '$n'), { name: '$n', kind: 'value', valueType: 'string', optional: false });
  });

  it('describes a thing as it was at the step, not as the statement left it (B8)', () => {
    const { recording } = record('match $p isa person, has name "Bob"; insert $p has nick "B";', {}, true);
    const [match, insert] = stages(recording);
    const nicks = (stage: StageRecord): string[] => {
      const thing = stage.rows[0].$p;
      assert.equal(thing.kind, 'thing');
      return thing.kind === 'thing' ? thing.attributes.filter((a) => a.type === 'nick').map((a) => a.value) : [];
    };
    assert.deepEqual(nicks(match), []);
    assert.deepEqual(nicks(insert), ['B']);
    assert.equal(insert.writes, true);
  });

  it('records a function call site as one frame over every call, and fetch sub-queries as frames of the fetch stage', () => {
    const { recording } = record('with fun names($x: person) -> { name }: match $x has name $n; return { $n }; match $p isa person; let $m in names($p); select $m;');
    const values = steps(stages(recording)[0]).find((step) => step.kind === 'values');
    assert.ok(values);
    assert.deepEqual(values.frames.map((frame) => [frame.kind, frame.name, frame.calls]), [['function', 'names', 3]]);
    assert.equal(values.frames[0].stages[0].rowsOut, 3);

    const fetched = record('match $p isa person, has name $n; fetch { "n": $n, "others": [ match $p has name $o; fetch { "o": $o }; ] };').recording;
    const fetch = stages(fetched).find((stage) => stage.kind === 'fetch');
    assert.ok(fetch);
    assert.deepEqual(fetch.frames.map((frame) => [frame.kind, frame.calls]), [['fetch', 3]]);
  });

  it('records nested blocks under the step that ran them', () => {
    const { recording } = record('match $p isa person, has name $n; not { $p has age $a; $a < 20; }; { $n == "Ann"; } or { $n == "Cid"; }; select $n;');
    const nested = steps(stages(recording)[0])
      .filter((step) => step.kind === 'or' || step.kind === 'not')
      .map((step) => [step.kind, step.rowsIn, step.rowsOut, step.blocks.map((block) => `${block.kind} x${block.calls}`)]);
    // Each branch is a block of its own, run once per incoming row; `not` runs after `or`, on what `or` kept.
    assert.deepEqual(nested, [
      ['or', 3, 2, ['branch x3', 'branch x3']],
      ['not', 2, 2, ['not x2']],
    ]);
  });

  it('records nothing for a define', () => {
    const recorder = new StepRecorder();
    attachStepHook(engine, recorder);
    engine.define('define attribute email, value string;');
    attachStepHook(engine, undefined);
    assert.deepEqual(recorder.finish().frames, []);
  });
});

describe('a refusal', () => {
  it('is placed at the innermost record open when it was thrown', () => {
    engine.execute('insert $z isa person, has name "Zed", has age 0;');
    const { recording } = record('match $p isa person, has age $a; let $x = 10 / $a; select $x;');
    assert.equal(recording.refusal?.code, 'typedblite.value-out-of-range');
    const at = recording.refusal?.at;
    assert.ok(at !== undefined);
    assert.deepEqual(byId(recording).get(at), { kind: 'step:values', name: 'let $x = 10 / $a' });
  });

  it('inside a function is placed inside that function`s frame', () => {
    engine.execute('insert $z isa person, has name "Zed", has age 0;');
    const { recording } = record('with fun f($n: integer) -> integer: match let $r = 10 / $n; return first $r; match $p isa person, has age $a; let $y = f($a); select $y;');
    const at = recording.refusal?.at;
    assert.ok(at !== undefined);
    const values = steps(stages(recording)[0]).find((step) => step.kind === 'values');
    const inner = values?.frames[0].stages[0].blocks[0].steps[0];
    assert.equal(inner?.id, at);
  });

  it('found before anything ran has no record to be placed at', () => {
    const { recording } = record('match $p isa person, has age $a; $a > "x"; select $a;');
    assert.equal(recording.refusal?.code, 'typedblite.value-type-conflict');
    assert.equal(recording.refusal?.at, undefined);
    assert.deepEqual(recording.frames, []);
  });
});

describe('the caps (B10)', () => {
  it('keep rows up to rowsPerStep, and say how many they dropped', () => {
    const { recording } = record('match $p isa person, has name $n; select $n;', { rowsPerStep: 2 });
    const [match] = stages(recording);
    assert.deepEqual([match.rows.length, match.rowsDropped, match.rowsOut], [2, 1, 3]);
    const thing = steps(match)[0];
    assert.deepEqual([thing.rows.length, thing.rowsDropped], [2, 1]);
  });

  it('keep a breakdown up to callsPerSite', () => {
    const { recording } = record('match $p isa person; match $p has age $a; select $a;', { callsPerSite: 1 });
    const step = steps(stages(recording)[1])[0];
    assert.deepEqual([step.byCall.length, step.byCallDropped], [1, 2]);
  });

  it('drop every row past the byte ceiling, keeping the counts', () => {
    const { recording } = record('match $p isa person, has name $n; select $n;', { bytes: 1500 });
    assert.equal(recording.rowsOmitted, true);
    const [match] = stages(recording);
    assert.deepEqual([match.rows.length, match.rowsDropped, match.rowsOut], [0, 3, 3]);
    assert.equal(steps(match)[0].rows.length, 0);
  });
});

describe('attaching', () => {
  it('detaches with undefined: nothing more is recorded', () => {
    const recorder = new StepRecorder();
    attachStepHook(engine, recorder);
    attachStepHook(engine, undefined);
    engine.query('match $p isa person; select $p;');
    assert.deepEqual(recorder.finish().frames, []);
  });

  it('a recorder that is not attached describes a thing by its number alone', () => {
    const recorder = new StepRecorder();
    recorder.frameStart({ kind: 'statement', name: 'statement' });
    recorder.stageStart({ index: 0, kind: 'match', writes: false, scope: [] }, []);
    recorder.stageEnd([{ $x: 7 }]);
    recorder.frameEnd();
    assert.deepEqual(recorder.finish().frames[0].stages[0].rows, [{ $x: { kind: 'thing', iid: '7', type: '', relation: false, attributes: [] } }]);
  });

  it('counts a report it cannot place as a fault, and never throws', () => {
    const recorder = new StepRecorder();
    recorder.stepStart({ name: 'thing $x', kind: 'thing', ranges: [] }, 1);
    recorder.stepEnd([]);
    recorder.blockEnd([]);
    recorder.valueCompared({ kind: 'comparison', name: '$x > 1' }, true);
    assert.equal(recorder.faults, 4);
  });
});
