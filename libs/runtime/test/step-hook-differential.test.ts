import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { attachStepHook, StepRecorder, type BlockRecord, type FrameRecord, type Recording } from '../src/debug.js';
import { diagnosticOf } from '../src/diagnostics.js';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { buildJoinStore, JOIN_READS } from './fixtures/join-corpus.js';
import { PEOPLE_CORPUS, type CorpusStatement } from './fixtures/step-hook-corpus.js';

/**
 * 🔴 The debugger's invariant 1: attaching the step hook changes no answer. Each statement runs on two identical
 * stores, one with a recorder attached and one without, and must answer the same rows in the same order, the same
 * documents, the same facts, and the same refusal. With join planning on and off, since the steps a `match` reports
 * differ between the two (ADR-014 B6). The conformance run with `TYPEDBLITE_STEP_HOOK=record` is the other half of
 * the proof.
 */

/** What a statement answered, as text: rows, documents and facts, or the refusal and its diagnostic. */
const answer = (engine: TypeDBLiteInterpreter, [kind, text]: CorpusStatement): string => {
  try {
    const report = kind === 'define' ? engine.define(text) : kind === 'write' ? engine.execute(text) : engine.query(text);
    return JSON.stringify(report);
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message : String(error)} ${JSON.stringify(diagnosticOf(error))}`;
  }
};

/** Run one statement with a fresh recorder attached, and return its answer and its recording. */
const recorded = (engine: TypeDBLiteInterpreter, statement: CorpusStatement): { answer: string; recording: Recording; faults: number } => {
  const recorder = new StepRecorder();
  attachStepHook(engine, recorder);
  try {
    return { answer: answer(engine, statement), recording: recorder.finish(), faults: recorder.faults };
  } finally {
    attachStepHook(engine, undefined);
  }
};

const DUMP: CorpusStatement = ['read', 'match $p isa person, has name $n; try { $p has age $a; }; try { $p has nick $k; }; select $n, $a, $k;'];

/** Every step kind, block kind and frame kind a set of recordings holds. */
const kindsIn = (recordings: readonly Recording[]): Set<string> => {
  const kinds = new Set<string>();
  const blocks = (list: readonly BlockRecord[]): void => {
    for (const block of list) {
      kinds.add(`block:${block.kind}`);
      for (const step of block.steps) {
        kinds.add(`step:${step.kind}`);
        blocks(step.blocks);
        frames(step.frames);
      }
    }
  };
  const frames = (list: readonly FrameRecord[]): void => {
    for (const frame of list) {
      kinds.add(`frame:${frame.kind}`);
      for (const stage of frame.stages) {
        kinds.add(`stage:${stage.kind}`);
        blocks(stage.blocks);
        frames(stage.frames);
      }
    }
  };
  for (const recording of recordings) frames(recording.frames);
  return kinds;
};

describe('the step hook changes no answer', () => {
  for (const planJoins of [true, false]) {
    it(`over every stage, step, block, function, fetch, write and refusal (planJoins: ${planJoins})`, () => {
      const plain = new TypeDBLiteInterpreter(':memory:', 5000, { planJoins });
      const hooked = new TypeDBLiteInterpreter(':memory:', 5000, { planJoins });
      for (const statement of PEOPLE_CORPUS) {
        const run = recorded(hooked, statement);
        assert.equal(run.answer, answer(plain, statement), statement[1]);
        assert.equal(run.faults, 0, `recorder faults: ${statement[1]}`);
        // A recording is plain JSON.
        assert.deepEqual(JSON.parse(JSON.stringify(run.recording)), run.recording);
      }
      assert.equal(answer(hooked, DUMP), answer(plain, DUMP));
    });

    it(`over the join-planning corpus (planJoins: ${planJoins})`, () => {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const plain = buildJoinStore(planJoins, seed);
        const hooked = buildJoinStore(planJoins, seed);
        for (const query of JOIN_READS) {
          const statement: CorpusStatement = ['read', query];
          const run = recorded(hooked, statement);
          assert.equal(run.answer, answer(plain, statement), `seed ${seed}: ${query}`);
          assert.equal(run.faults, 0, `recorder faults, seed ${seed}: ${query}`);
        }
      }
    });
  }

  it('leaves a QueryTrace exactly as it is without the hook: describing a thing is not the query`s work', () => {
    const plain = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true });
    const hooked = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true });
    for (const statement of PEOPLE_CORPUS.slice(0, 5)) {
      answer(plain, statement);
      recorded(hooked, statement);
    }
    for (const [, query] of PEOPLE_CORPUS.filter(([kind]) => kind === 'read').slice(0, 12)) {
      recorded(hooked, ['read', query]);
      answer(plain, ['read', query]);
      assert.deepEqual(hooked.lastQueryTrace(), plain.lastQueryTrace(), query);
    }
  });

  it('is not vacuous: the corpus reports every kind of step, block, stage and frame', () => {
    const recordings: Recording[] = [];
    const engine = new TypeDBLiteInterpreter(':memory:');
    for (const statement of PEOPLE_CORPUS) recordings.push(recorded(engine, statement).recording);
    const joined = buildJoinStore(true, 3);
    for (const query of JOIN_READS) recordings.push(recorded(joined, ['read', query]).recording);
    const kinds = kindsIn(recordings);
    const expected = [
      ...['types', 'relation-filter', 'thing', 'relation', 'attribute', 'has', 'values', 'or', 'try', 'is', 'not'].map((k) => `step:${k}`),
      ...['match', 'put', 'branch', 'try', 'not'].map((k) => `block:${k}`),
      ...['match', 'insert', 'put', 'delete', 'update', 'select', 'sort', 'offset', 'limit', 'distinct', 'reduce', 'fetch'].map((k) => `stage:${k}`),
      ...['statement', 'function', 'fetch'].map((k) => `frame:${k}`),
    ];
    assert.deepEqual(expected.filter((kind) => !kinds.has(kind)), []);
  });
});
