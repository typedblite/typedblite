import type { Range } from 'vscode-languageserver';

import type {
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
import type { Binding } from './type-patterns.js';

/**
 * How much a recording keeps (ADR-014 B10, the debugger feature's invariant 5). Counts are always kept; rows and
 * per-call breakdowns are kept up to these caps, and the recording says how many it dropped.
 */
export interface RecordingLimits {
  /** Rows kept per stage and per step, summed over every call. */
  readonly rowsPerStep: number;
  /** Entries kept in a step's breakdown by call (one per incoming row of its block). */
  readonly callsPerSite: number;
  /** The recording's size as JSON, in UTF-8 bytes. Past it, every row is dropped and only counts remain. */
  readonly bytes: number;
}

/** The provisional caps of ADR-014 B10, confirmed by Phase 01's measurements. */
export const DEFAULT_RECORDING_LIMITS: RecordingLimits = { rowsPerStep: 1000, callsPerSite: 50, bytes: 16 * 1024 * 1024 };

/**
 * One binding, as recorded. A thing names its description in `Recording.things` by `ref`, which is the thing as it
 * was at that point (ADR-014 B8): the same thing before and after a write stage has two.
 */
export type RecordedValue =
  | {
      readonly kind: 'thing';
      readonly iid: string;
      /** `''` when the thing no longer existed when it was recorded (a `delete` stage's rows). */
      readonly type: string;
      /** Its key in `Recording.things`. */
      readonly ref: string;
    }
  | { readonly kind: 'type'; readonly label: string }
  | { readonly kind: 'attribute'; readonly type: string; readonly valueType: string; readonly value: string }
  | { readonly kind: 'value'; readonly valueType: string; readonly value: string }
  /** A variable a `try` left empty. */
  | { readonly kind: 'empty' };

/** One row, by variable name (with its `$`). Synthetic variables (`__…`) are left out. */
export type RecordedRow = Readonly<Record<string, RecordedValue>>;

/** A pipeline: a statement's, or every call to one function from one call site, or one `fetch` sub-query. */
export interface FrameRecord {
  readonly id: number;
  readonly kind: FrameKind;
  readonly name: string;
  readonly range?: Range;
  readonly at?: Range;
  /** How many times it ran. */
  calls: number;
  readonly stages: StageRecord[];
}

/** A stage, summed over every call of its frame. */
export interface StageRecord {
  readonly id: number;
  readonly index: number;
  readonly kind: StageKind;
  readonly range?: Range;
  readonly writes: boolean;
  readonly scope: readonly ScopeVariable[];
  rowsIn: number;
  rowsOut: number;
  /** The rows it passed on, up to `rowsPerStep`. */
  rows: RecordedRow[];
  rowsDropped: number;
  readonly blocks: BlockRecord[];
  readonly frames: FrameRecord[];
}

/** Every `combinations()` call for one block: one per incoming row. */
export interface BlockRecord {
  readonly id: number;
  readonly kind: BlockKind;
  readonly range?: Range;
  /** How many times it ran: its incoming rows. */
  calls: number;
  rowsOut: number;
  /** In the order they ran. A step that ran only in some calls sits after the step it followed there. */
  readonly steps: StepRecord[];
}

/** One step of a block, summed over every call (ADR-014 B7). */
export interface StepRecord {
  readonly id: number;
  readonly name: string;
  readonly kind: StepKind;
  readonly ranges: readonly Range[];
  rowsIn: number;
  rowsOut: number;
  rows: RecordedRow[];
  rowsDropped: number;
  /** In and out for each call of its block, up to `callsPerSite`. */
  readonly byCall: Array<{ readonly rowsIn: number; readonly rowsOut: number }>;
  byCallDropped: number;
  /** Each `let` and comparison of a `values` step. */
  readonly values: ValueRecord[];
  readonly blocks: BlockRecord[];
  readonly frames: FrameRecord[];
}

/** A `let` or a comparison, summed over every combination it saw. */
export interface ValueRecord {
  readonly id: number;
  readonly kind: 'let' | 'comparison';
  readonly name: string;
  readonly range?: Range;
  /** Combinations it was evaluated for. */
  rowsIn: number;
  /** Combinations it kept (a comparison) or answered (a `let`). */
  rowsOut: number;
}

/** Why a statement stopped, and the innermost record open when it did. */
export interface RecordedRefusal {
  readonly message: string;
  readonly code?: string;
  readonly range?: Range;
  /** The `id` of the innermost frame, stage, block or step that was open. */
  readonly at?: number;
}

/** A thing as it was when a row naming it was recorded. */
export interface RecordedThing {
  readonly iid: string;
  /** `''` when the thing no longer existed. */
  readonly type: string;
  readonly relation: boolean;
  /** Every attribute it owned, in the order they were written. */
  readonly attributes: ReadonlyArray<{ readonly type: string; readonly value: string }>;
}

/** What one statement did, as plain JSON: every record has an `id`, unique in the recording. */
export interface Recording {
  readonly version: 1;
  readonly limits: RecordingLimits;
  /** One per pipeline the statement ran. A `define` runs none. */
  readonly frames: FrameRecord[];
  /** Each thing a kept row names, once per state it was recorded in, by `ref`. */
  things: Record<string, RecordedThing>;
  readonly refusal?: RecordedRefusal;
  /** Set when the recording passed `limits.bytes` and every row was dropped. */
  readonly rowsOmitted?: true;
}

type Open =
  | { readonly type: 'frame'; readonly record: FrameRecord }
  | { readonly type: 'stage'; readonly record: StageRecord }
  | { readonly type: 'block'; readonly record: BlockRecord; last?: StepRecord }
  | { readonly type: 'step'; readonly record: StepRecord; readonly rowsIn: number };

const rangeKey = (range: Range | undefined): string =>
  range === undefined ? '' : `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;

/**
 * The step hook that records: it turns one statement's reports into a `Recording` (ADR-014 B1). Attach it, run one
 * statement, then call `finish()`.
 *
 * Calls to one block, one call site or one stage are summed into one record, found by a key that is the same from one
 * call to the next (B7). Things are described when their row is recorded, and the descriptions are read again after
 * every write stage (B8).
 *
 * @privateRemarks
 * 🔴 It never throws into the interpreter: a fault here would change an answer (the debugger feature's invariant
 * 1). Each report is guarded, and a fault is counted in `faults` for the specs to assert is zero.
 */
export class StepRecorder implements StepHook {
  readonly limits: RecordingLimits;
  /** Reports this recorder could not place, or that threw. Zero, unless something is wrong. */
  faults = 0;

  private services: StepServices | undefined;
  private readonly frames: FrameRecord[] = [];
  private readonly stack: Open[] = [];
  private readonly keyed = new WeakMap<object, Map<string, unknown>>();
  /** Each thing described since the last write stage, by its number: its `ref`. */
  private readonly described = new Map<number, string>();
  private readonly things: Record<string, RecordedThing> = {};
  /** Bumped by each write stage, so a thing described after it is a new `ref`. */
  private epoch = 0;
  private refusal: RecordedRefusal | undefined;
  private nextId = 1;

  constructor(limits: Partial<RecordingLimits> = {}) {
    this.limits = { ...DEFAULT_RECORDING_LIMITS, ...limits };
  }

  attached(services: StepServices): void {
    this.services = services;
  }

  frameStart(frame: FrameInfo): void {
    this.guard(() => {
      const top = this.top();
      const make = (): FrameRecord => compact({ id: this.id(), kind: frame.kind, name: frame.name, range: frame.range, at: frame.at, calls: 0, stages: [] });
      let record: FrameRecord;
      if (top === undefined) {
        record = make();
        this.frames.push(record);
      } else if (top.type === 'stage' || top.type === 'step') {
        record = this.child(top.record.frames, `${frame.kind}|${frame.name}|${rangeKey(frame.range)}|${rangeKey(frame.at)}`, make);
      } else {
        this.faults += 1;
        return;
      }
      record.calls += 1;
      this.stack.push({ type: 'frame', record });
    });
  }

  frameEnd(): void {
    this.guard(() => this.popTo('frame'));
  }

  stageStart(stage: StageInfo, rows: readonly StepRow[]): void {
    this.guard(() => {
      const top = this.top();
      if (top?.type !== 'frame') {
        this.faults += 1;
        return;
      }
      const record = this.child(top.record.stages, String(stage.index), (): StageRecord => compact({
        id: this.id(),
        index: stage.index,
        kind: stage.kind,
        range: stage.range,
        writes: stage.writes,
        scope: stage.scope.map(compact),
        rowsIn: 0,
        rowsOut: 0,
        rows: [],
        rowsDropped: 0,
        blocks: [],
        frames: [],
      }));
      record.rowsIn += rows.length;
      if (stage.writes) this.written();
      this.stack.push({ type: 'stage', record });
    });
  }

  stageEnd(rows: readonly StepRow[]): void {
    this.guard(() => {
      const open = this.popTo('stage');
      if (open?.type !== 'stage') return;
      // After a write, what the stage wrote is what its rows are described as.
      if (open.record.writes) this.written();
      open.record.rowsOut += rows.length;
      this.keep(open.record, rows);
    });
  }

  blockStart(block: BlockInfo, _seed: StepRow): void {
    this.guard(() => {
      const top = this.top();
      if (top?.type !== 'stage' && top?.type !== 'step') {
        this.faults += 1;
        return;
      }
      const record = this.child(top.record.blocks, `${block.kind}|${rangeKey(block.range)}`, (): BlockRecord => compact({
        id: this.id(),
        kind: block.kind,
        range: block.range,
        calls: 0,
        rowsOut: 0,
        steps: [],
      }));
      record.calls += 1;
      this.stack.push({ type: 'block', record });
    });
  }

  blockEnd(rows: readonly StepRow[]): void {
    this.guard(() => {
      const open = this.popTo('block');
      if (open?.type === 'block') open.record.rowsOut += rows.length;
    });
  }

  stepStart(step: StepInfo, rowsIn: number): void {
    this.guard(() => {
      const top = this.top();
      if (top?.type !== 'block') {
        this.faults += 1;
        return;
      }
      const after = top.last;
      const record = this.child(
        top.record.steps,
        `${step.kind}|${step.name}|${rangeKey(step.ranges[0])}`,
        (): StepRecord => ({
          id: this.id(),
          name: step.name,
          kind: step.kind,
          ranges: step.ranges,
          rowsIn: 0,
          rowsOut: 0,
          rows: [],
          rowsDropped: 0,
          byCall: [],
          byCallDropped: 0,
          values: [],
          blocks: [],
          frames: [],
        }),
        // A step first seen in a later call goes after the step it followed there, not at the end.
        after === undefined ? 0 : top.record.steps.indexOf(after) + 1,
      );
      top.last = record;
      record.rowsIn += rowsIn;
      this.stack.push({ type: 'step', record, rowsIn });
    });
  }

  stepEnd(rows: readonly StepRow[]): void {
    this.guard(() => {
      const open = this.popTo('step');
      if (open?.type !== 'step') return;
      const record = open.record;
      record.rowsOut += rows.length;
      if (record.byCall.length < this.limits.callsPerSite) record.byCall.push({ rowsIn: open.rowsIn, rowsOut: rows.length });
      else record.byCallDropped += 1;
      this.keep(record, rows);
    });
  }

  valueCompared(value: ValueInfo, passed: boolean): void {
    this.guard(() => {
      const record = this.value(value);
      if (record === undefined) return;
      record.rowsIn += 1;
      if (passed) record.rowsOut += 1;
    });
  }

  valueBound(value: ValueInfo, rowsIn: number, rowsOut: number): void {
    this.guard(() => {
      const record = this.value(value);
      if (record === undefined) return;
      record.rowsIn += rowsIn;
      record.rowsOut += rowsOut;
    });
  }

  /**
   * The statement was refused: record why, and where. Call it before `finish()`, while what was open when the
   * refusal was thrown is still open.
   */
  refused(message: string, code?: string, range?: Range): void {
    this.refusal = compact({ message, code, range, at: this.top()?.record.id });
  }

  /** The recording. Anything still open is closed as it stands. */
  finish(): Recording {
    this.stack.length = 0;
    const recording: { -readonly [K in keyof Recording]: Recording[K] } = {
      version: 1,
      limits: this.limits,
      frames: this.frames,
      things: this.things,
      ...(this.refusal === undefined ? {} : { refusal: this.refusal }),
    };
    if (sizeOf(recording) > this.limits.bytes) {
      dropRows(this.frames);
      recording.things = {};
      recording.rowsOmitted = true;
    }
    return recording;
  }

  private id(): number {
    return this.nextId++;
  }

  private top(): Open | undefined {
    return this.stack[this.stack.length - 1];
  }

  /**
   * Pop up to and including the innermost open entry of this type. Entries above it were left open by a step that
   * never ended, which only an error caught inside the interpreter could cause: they are closed as they stand.
   */
  private popTo(type: Open['type']): Open | undefined {
    for (let at = this.stack.length - 1; at >= 0; at -= 1) {
      if (this.stack[at].type !== type) continue;
      if (at !== this.stack.length - 1) this.faults += 1;
      const open = this.stack[at];
      this.stack.length = at;
      return open;
    }
    this.faults += 1;
    return undefined;
  }

  /** The record under `key` in `list`, made and inserted (at `position`, or the end) when there is none. */
  private child<T>(list: T[], key: string, make: () => T, position?: number): T {
    let index = this.keyed.get(list) as Map<string, T> | undefined;
    if (index === undefined) {
      index = new Map();
      this.keyed.set(list, index);
    }
    const known = index.get(key);
    if (known !== undefined) return known;
    const made = make();
    index.set(key, made);
    if (position === undefined || position >= list.length) list.push(made);
    else list.splice(position, 0, made);
    return made;
  }

  private value(value: ValueInfo): ValueRecord | undefined {
    const top = this.top();
    if (top?.type !== 'step') {
      this.faults += 1;
      return undefined;
    }
    return this.child(top.record.values, `${value.kind}|${value.name}|${rangeKey(value.range)}`, (): ValueRecord => compact({
      id: this.id(),
      kind: value.kind,
      name: value.name,
      range: value.range,
      rowsIn: 0,
      rowsOut: 0,
    }));
  }

  /** Keep rows up to the cap, rendering only those kept. */
  private keep(record: { rows: RecordedRow[]; rowsDropped: number }, rows: readonly StepRow[]): void {
    const room = Math.max(0, this.limits.rowsPerStep - record.rows.length);
    const kept = Math.min(room, rows.length);
    for (let i = 0; i < kept; i += 1) record.rows.push(this.render(rows[i]));
    record.rowsDropped += rows.length - kept;
  }

  private render(row: StepRow): RecordedRow {
    const rendered: Record<string, RecordedValue> = {};
    for (const [variable, binding] of Object.entries(row)) {
      if (variable.startsWith('__')) continue;
      rendered[variable] = this.valueOf(binding);
    }
    return rendered;
  }

  private valueOf(binding: Binding | undefined): RecordedValue {
    if (binding === undefined) return { kind: 'empty' };
    if (typeof binding === 'string') return { kind: 'type', label: binding };
    if (typeof binding === 'number') {
      const ref = this.describe(binding);
      const thing = this.things[ref];
      return { kind: 'thing', iid: thing.iid, type: thing.type, ref };
    }
    return binding.kind === 'attribute'
      ? { kind: 'attribute', type: binding.attributeType, valueType: binding.valueType, value: binding.value }
      : { kind: 'value', valueType: binding.valueType, value: binding.value };
  }

  /** The thing's `ref`, describing it when it has not been since the last write stage. */
  private describe(iid: number): string {
    const known = this.described.get(iid);
    if (known !== undefined) return known;
    const described: ThingDescription = this.services?.describe(iid) ?? { iid: String(iid), type: '', relation: false, attributes: [] };
    const ref = `${described.iid}#${this.epoch}`;
    this.things[ref] = { iid: described.iid, type: described.type, relation: described.relation, attributes: described.attributes.map((a) => ({ type: a.type, value: a.value })) };
    this.described.set(iid, ref);
    return ref;
  }

  /** A write stage began or ended: every thing is described again from here on. */
  private written(): void {
    this.described.clear();
    this.epoch += 1;
  }

  private guard(report: () => void): void {
    try {
      report();
    } catch {
      this.faults += 1;
    }
  }
}

/**
 * A recorder per statement, each finished and thrown away when the next statement starts: `TYPEDBLITE_STEP_HOOK=record`
 * attaches one to every interpreter, so a whole suite runs with the hook on. A recorder that could not place a report
 * says so once on stderr, which is how a suite run finds a recorder fault without a test of its own.
 */
export class SelfCheckingRecorder implements StepHook {
  private services: StepServices | undefined;
  private current = new StepRecorder();
  private reported = false;

  attached(services: StepServices): void {
    this.services = services;
    this.current.attached(services);
  }

  frameStart(frame: FrameInfo): void {
    // A statement's frame is always the outermost: a new statement.
    if (frame.kind === 'statement') this.rotate();
    this.current.frameStart(frame);
  }

  frameEnd(): void {
    this.current.frameEnd();
  }

  stageStart(stage: StageInfo, rows: readonly StepRow[]): void {
    this.current.stageStart(stage, rows);
  }

  stageEnd(rows: readonly StepRow[]): void {
    this.current.stageEnd(rows);
  }

  blockStart(block: BlockInfo, seed: StepRow): void {
    this.current.blockStart(block, seed);
  }

  blockEnd(rows: readonly StepRow[]): void {
    this.current.blockEnd(rows);
  }

  stepStart(step: StepInfo, rowsIn: number): void {
    this.current.stepStart(step, rowsIn);
  }

  stepEnd(rows: readonly StepRow[]): void {
    this.current.stepEnd(rows);
  }

  valueCompared(value: ValueInfo, passed: boolean): void {
    this.current.valueCompared(value, passed);
  }

  valueBound(value: ValueInfo, rowsIn: number, rowsOut: number): void {
    this.current.valueBound(value, rowsIn, rowsOut);
  }

  private rotate(): void {
    // A refused statement leaves its records open: a fault only when a statement that finished left one.
    this.current.finish();
    if (this.current.faults > 0 && !this.reported) {
      this.reported = true;
      console.error(`TYPEDBLITE_STEP_HOOK: the step recorder could not place ${this.current.faults} report(s).`);
    }
    this.current = new StepRecorder();
    if (this.services !== undefined) this.current.attached(this.services);
  }
}

/** The object without its `undefined` properties, so a record is the same before and after a JSON round trip. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) if (value[key] === undefined) delete value[key];
  return value;
}

function sizeOf(recording: Recording): number {
  const json = JSON.stringify(recording);
  // A JSON character is at most three UTF-8 bytes here (no lone surrogates survive `stringify`'s escaping of them).
  return json.length * 3 <= recording.limits.bytes ? json.length : new TextEncoder().encode(json).length;
}

function dropRows(frames: readonly FrameRecord[]): void {
  const blocks = (list: readonly BlockRecord[]): void => {
    for (const block of list) {
      for (const step of block.steps) {
        step.rowsDropped += step.rows.length;
        step.rows = [];
        blocks(step.blocks);
        dropRows(step.frames);
      }
    }
  };
  for (const frame of frames) {
    for (const stage of frame.stages) {
      stage.rowsDropped += stage.rows.length;
      stage.rows = [];
      blocks(stage.blocks);
      dropRows(stage.frames);
    }
  }
}
