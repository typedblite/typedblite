import type { Range } from 'vscode-languageserver';

import type { Binding } from './type-patterns.js';

/**
 * The step hook: what the interpreter reports, while a statement runs, to something that wants to watch it run. The
 * debugger's recorder is the one implementation (`recorder.ts`, ADR-014).
 *
 * Plain data only. The runtime knows nothing of the Debug Adapter Protocol (the debugger feature's invariant 3):
 * a frame, a stage, a block and a step are this engine's own units, and what a debugger shows them as is the
 * debugger's business.
 *
 * Every report comes as a begin and an end, properly nested: a frame holds stages; a stage holds blocks (one
 * `combinations()` call each) and frames (a `fetch` sub-query, a function); a block holds steps; a step holds
 * blocks (the branches of an `or`, a `try`, a `not`), frames (a function a `let` calls) and values (each `let` and
 * comparison). When a statement is refused part-way, the ends after the refusal never come: whatever is still open
 * is where it was refused.
 *
 * @privateRemarks
 * 🔴 Two rules every hook point keeps (the debugger feature's invariants 1 and 2):
 * - **When no hook is attached, a hook point costs one `undefined` check.** Points are written `hook?.x(…)`, which
 *   evaluates no argument when `hook` is undefined.
 * - **A hook never changes an answer.** It receives rows, and must not change them; it may read the store only
 *   through `StepServices`, which never refuses and never writes.
 *
 * Not exported from the package root (ADR-014 B5): `@typedblite/runtime/debug` only, internal and unstable.
 */
export interface StepHook {
  /** Called once, when the hook is attached to an interpreter, with what it may ask of that interpreter. */
  attached(services: StepServices): void;
  /** A pipeline begins: a statement's own, a function body, or a `fetch` sub-query. */
  frameStart(frame: FrameInfo): void;
  /** The innermost open frame ends. */
  frameEnd(): void;
  /** A stage begins, with the rows it receives. */
  stageStart(stage: StageInfo, rows: readonly StepRow[]): void;
  /** The innermost open stage ends, with the rows it passes on. */
  stageEnd(rows: readonly StepRow[]): void;
  /** One `combinations()` call begins, seeded with one incoming row. */
  blockStart(block: BlockInfo, seed: StepRow): void;
  /** The innermost open block ends, with the combinations it answers. */
  blockEnd(rows: readonly StepRow[]): void;
  /** A step of a block begins, with the number of combinations it receives. */
  stepStart(step: StepInfo, rowsIn: number): void;
  /** The innermost open step ends, with the combinations it leaves. */
  stepEnd(rows: readonly StepRow[]): void;
  /** A comparison was evaluated for one combination. A combination is charged to the first comparison it fails. */
  valueCompared(value: ValueInfo, passed: boolean): void;
  /** A `let` ran over some combinations, and left this many. */
  valueBound(value: ValueInfo, rowsIn: number, rowsOut: number): void;
}

/** One row as the interpreter holds it: each variable's binding, `undefined` for one a `try` left empty. */
export type StepRow = Readonly<Record<string, Binding | undefined>>;

/** What a hook may ask of the interpreter it is attached to. */
export interface StepServices {
  /** A thing's type and attributes as they are now. Reads only, and never refuses: a deleted thing has type `''`. */
  describe(iid: number): ThingDescription;
}

/** A thing, as `StepServices.describe` reads it. */
export interface ThingDescription {
  /** TypeQL's `0x…` iid. */
  readonly iid: string;
  /** Its type, or `''` when the thing no longer exists. */
  readonly type: string;
  readonly relation: boolean;
  /** Every attribute it owns, in the order they were written. */
  readonly attributes: ReadonlyArray<{ readonly type: string; readonly value: string }>;
}

/** What kind of pipeline a frame runs. */
export type FrameKind = 'statement' | 'function' | 'fetch';

/** A pipeline about to run. */
export interface FrameInfo {
  readonly kind: FrameKind;
  /** `statement`, the function's name, or `fetch`. */
  readonly name: string;
  /** The pipeline, or the function's definition. */
  readonly range?: Range;
  /** Where it was called from: a function's call site. */
  readonly at?: Range;
}

/** A stage's keyword, and `fetch` for a pipeline's `fetch`, reported as a stage after the last. */
export type StageKind =
  | 'match'
  | 'insert'
  | 'put'
  | 'delete'
  | 'update'
  | 'select'
  | 'sort'
  | 'offset'
  | 'limit'
  | 'distinct'
  | 'require'
  | 'reduce'
  | 'fetch';

/** A stage about to run. */
export interface StageInfo {
  /** Its position in the pipeline; `fetch` is one past the last stage. */
  readonly index: number;
  readonly kind: StageKind;
  readonly range?: Range;
  /** Whether it writes: `insert`, `put`, `delete`, `update`. */
  readonly writes: boolean;
  /** What is bound after it, from the query and the schema alone. */
  readonly scope: readonly ScopeVariable[];
}

/** One variable a stage leaves bound. */
export interface ScopeVariable {
  /** With its `$`. */
  readonly name: string;
  readonly kind?: 'thing' | 'type' | 'value';
  readonly valueType?: string;
  /** May be empty: bound by a `try`, or a `given` declared `?`. */
  readonly optional: boolean;
}

/** Why `combinations()` was called: a stage's `match`, a `put`'s match, or a nested block. */
export type BlockKind = 'match' | 'put' | 'branch' | 'try' | 'not';

/** One `combinations()` call about to run. */
export interface BlockInfo {
  readonly kind: BlockKind;
  readonly range?: Range;
}

/**
 * What a step of a block does. They run in this order, not in the source's (ADR-014 B6): `types`; each thing
 * variable (`thing`), with each relation filter (`relation-filter`) as soon as its players are bound; each relation
 * binding (`relation`); attribute instances (`attribute`) and `has` reads (`has`); the `let`s and comparisons that can
 * run (`values`); each `or` and `try`; the rest of the `values`; each `is` and `not`.
 */
export type StepKind = 'types' | 'relation-filter' | 'thing' | 'relation' | 'attribute' | 'has' | 'values' | 'or' | 'try' | 'is' | 'not';

/** One step about to run. */
export interface StepInfo {
  /** Short, and stable from one call to the next: `thing $p`, `$p has name $n`. */
  readonly name: string;
  readonly kind: StepKind;
  /** Every range the step consumes, which may be on several lines. */
  readonly ranges: readonly Range[];
}

/** A `let` or a comparison, inside a `values` step. */
export interface ValueInfo {
  readonly kind: 'let' | 'comparison';
  /** Its source text. */
  readonly name: string;
  readonly range?: Range;
}
