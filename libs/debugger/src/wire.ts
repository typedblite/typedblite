/**
 * The engine host's wire protocol, as the debugger reads it: `session.debug`'s answer and `statement.locate`'s.
 *
 * 🔴 **Shapes, not definitions** (ADR-014 B4). The debugger does not depend on the runtime or the session package: the
 * extension that bundles it never loads the engine, which runs in the host. `test/wire.test.ts` proves these shapes
 * and the runtime's own are the same, so a change on either side fails a spec rather than a session.
 */
import type { Diagnostic, HostCaller, RunResult } from '@typedblite/notebook';

export type { Diagnostic, HostCaller, RunResult };

/** LSP's: both counted from 0. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** One statement of a source, as `statement.locate` answers it. */
export interface LocatedStatement {
  /** As written, comments inside it kept. */
  readonly text: string;
  readonly line: number;
  readonly character: number;
}

export interface RecordingLimits {
  readonly rowsPerStep: number;
  readonly callsPerSite: number;
  readonly bytes: number;
}

export type RecordedValue =
  | { readonly kind: 'thing'; readonly iid: string; readonly type: string; readonly ref: string }
  | { readonly kind: 'type'; readonly label: string }
  | { readonly kind: 'attribute'; readonly type: string; readonly valueType: string; readonly value: string }
  | { readonly kind: 'value'; readonly valueType: string; readonly value: string }
  | { readonly kind: 'empty' };

export type RecordedRow = Readonly<Record<string, RecordedValue>>;

export interface RecordedThing {
  readonly iid: string;
  readonly type: string;
  readonly relation: boolean;
  readonly attributes: ReadonlyArray<{ readonly type: string; readonly value: string }>;
}

export interface ScopeVariable {
  readonly name: string;
  readonly kind?: 'thing' | 'type' | 'value';
  readonly valueType?: string;
  readonly optional: boolean;
}

export type FrameKind = 'statement' | 'function' | 'fetch';
export type StageKind = 'match' | 'insert' | 'put' | 'delete' | 'update' | 'select' | 'sort' | 'offset' | 'limit' | 'distinct' | 'require' | 'reduce' | 'fetch';
export type BlockKind = 'match' | 'put' | 'branch' | 'try' | 'not';
export type StepKind = 'types' | 'relation-filter' | 'thing' | 'relation' | 'attribute' | 'has' | 'values' | 'or' | 'try' | 'is' | 'not';

export interface FrameRecord {
  readonly id: number;
  readonly kind: FrameKind;
  readonly name: string;
  readonly range?: Range;
  readonly at?: Range;
  readonly calls: number;
  readonly stages: readonly StageRecord[];
}

export interface StageRecord {
  readonly id: number;
  readonly index: number;
  readonly kind: StageKind;
  readonly range?: Range;
  readonly writes: boolean;
  readonly scope: readonly ScopeVariable[];
  readonly rowsIn: number;
  readonly rowsOut: number;
  readonly rows: readonly RecordedRow[];
  readonly rowsDropped: number;
  readonly blocks: readonly BlockRecord[];
  readonly frames: readonly FrameRecord[];
}

export interface BlockRecord {
  readonly id: number;
  readonly kind: BlockKind;
  readonly range?: Range;
  readonly calls: number;
  readonly rowsOut: number;
  readonly steps: readonly StepRecord[];
}

export interface StepRecord {
  readonly id: number;
  readonly name: string;
  readonly kind: StepKind;
  readonly ranges: readonly Range[];
  readonly rowsIn: number;
  readonly rowsOut: number;
  readonly rows: readonly RecordedRow[];
  readonly rowsDropped: number;
  readonly byCall: ReadonlyArray<{ readonly rowsIn: number; readonly rowsOut: number }>;
  readonly byCallDropped: number;
  readonly values: readonly ValueRecord[];
  readonly blocks: readonly BlockRecord[];
  readonly frames: readonly FrameRecord[];
}

export interface ValueRecord {
  readonly id: number;
  readonly kind: 'let' | 'comparison';
  readonly name: string;
  readonly range?: Range;
  readonly rowsIn: number;
  readonly rowsOut: number;
}

export interface RecordedRefusal {
  readonly message: string;
  readonly code?: string;
  readonly range?: Range;
  readonly at?: number;
}

export interface Recording {
  readonly version: 1;
  readonly limits: RecordingLimits;
  readonly frames: readonly FrameRecord[];
  readonly things: Readonly<Record<string, RecordedThing>>;
  readonly refusal?: RecordedRefusal;
  readonly rowsOmitted?: true;
}

/** `session.debug`'s answer. */
export interface DebugResult {
  readonly result: RunResult;
  readonly recording: Recording;
}
