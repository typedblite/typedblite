/**
 * `@typedblite/runtime/debug` — the step hook and the recorder the TypeQLite debugger is built on (ADR-014).
 *
 * **Internal and unstable.** Nothing here is covered by semver, and it may change in any release: it exists for this
 * repository's own debugger, through `@typedblite/session` and the engine host. It is not in the API reference, and
 * the package root exports none of it (ADR-014 B5).
 *
 * @module @typedblite/runtime/debug
 */
import type { TypeDBLiteInterpreter } from './interpreter.js';
import type { StepHook } from './step-hook.js';

export {
  DEFAULT_RECORDING_LIMITS,
  StepRecorder,
  type BlockRecord,
  type FrameRecord,
  type RecordedRefusal,
  type RecordedRow,
  type RecordedThing,
  type RecordedValue,
  type Recording,
  type RecordingLimits,
  type StageRecord,
  type StepRecord,
  type ValueRecord,
} from './recorder.js';
export type {
  BlockInfo,
  BlockKind,
  FrameInfo,
  FrameKind,
  ScopeVariable,
  StageInfo,
  StageKind,
  StepHook,
  StepInfo,
  StepKind,
  StepRow,
  StepServices,
  ThingDescription,
  ValueInfo,
} from './step-hook.js';

/** Attach a step hook to an interpreter, or detach it with `undefined`. One hook at a time. */
export function attachStepHook(interpreter: TypeDBLiteInterpreter, hook: StepHook | undefined): void {
  interpreter.setStepHook(hook);
}
