import { describe, expect, it } from 'vitest';

import type * as Runtime from '@typedblite/runtime/debug';
import type { DebugResult as SessionDebugResult, LocatedStatement as SessionLocated } from '@typedblite/session';

import type * as Wire from '../src/wire.js';

/**
 * The wire shapes the debugger declares (ADR-014 B4) read what the runtime and the session send. Checked by the
 * compiler when this file is typechecked: a field the debugger reads that the runtime renames, retypes or drops fails
 * `typecheck`.
 *
 * @privateRemarks
 * 🔴 Plain assignment of each record on its own. A deep "same type" check over the recursive types, and an assignment
 * of `Recording` alone, both passed with `byCallDropped` retyped to a string (2026-11-19): the compiler stops at its
 * depth limit and assumes the rest related. The runtime's records are mutable while it records and the wire's are
 * read-only, so the assignment runs from the runtime's to the wire's, the direction that matters: what is sent must be
 * readable. Mutation-checked: a retyped, renamed or added field each fails the typecheck.
 */
declare const runtime: {
  recording: Runtime.Recording;
  frame: Runtime.FrameRecord;
  stage: Runtime.StageRecord;
  block: Runtime.BlockRecord;
  step: Runtime.StepRecord;
  value: Runtime.ValueRecord;
  refusal: Runtime.RecordedRefusal;
  thing: Runtime.RecordedThing;
  recorded: Runtime.RecordedValue;
  scope: Runtime.ScopeVariable;
  limits: Runtime.RecordingLimits;
};
declare const located: SessionLocated;
declare const sent: SessionDebugResult;

/**
 * What the host sends, read as the debugger reads it: each record on its own, because a field of a record reached only
 * through the recursion (a step inside a block inside a stage) is not compared at all.
 */
export const readable: {
  recording: Wire.Recording;
  frame: Wire.FrameRecord;
  stage: Wire.StageRecord;
  block: Wire.BlockRecord;
  step: Wire.StepRecord;
  value: Wire.ValueRecord;
  refusal: Wire.RecordedRefusal;
  thing: Wire.RecordedThing;
  recorded: Wire.RecordedValue;
  scope: Wire.ScopeVariable;
  limits: Wire.RecordingLimits;
  located: Wire.LocatedStatement;
  recordingOfResult: Wire.DebugResult['recording'];
} = { ...runtime, located, recordingOfResult: sent.recording };

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const proven = <T extends true>(): T => true as T;

describe('the wire shapes', () => {
  it('a located statement is the session`s, and a result`s kinds are the session`s', () => {
    expect(proven<Same<Wire.LocatedStatement, SessionLocated>>()).toBe(true);
    expect(proven<Same<Wire.DebugResult['result']['kind'], SessionDebugResult['result']['kind']>>()).toBe(true);
  });
});
