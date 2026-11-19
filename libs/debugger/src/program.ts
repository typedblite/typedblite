import { dirname, resolve } from 'node:path';

import { outputsOf, plainOutput } from '@typedblite/notebook';

import { indexRecording, inFile, placedIn, recordAt, stopsOf, type IndexedRecord } from './records.js';
import { parseCondition, type Counts } from './conditions.js';
import { accepts, Timeline, type Motion, type Stop } from './timeline.js';
import { byCallNode, rowsNode, scopeNodes, stageNodes, stepNodes, valuesNodes, type VariableNode } from './values.js';
import type { BlockRecord, DebugResult, HostCaller, LocatedStatement, Range, Recording, RunResult } from './wire.js';

/**
 * What a `typeqlite` launch configuration says (ADR-014 B9). Paths are resolved against `cwd`, or the program's own
 * folder when there is none.
 */
export interface LaunchArguments {
  /** The `.tql` or `.typeqlite` file to run. */
  readonly program: string;
  /** Files of `define` statements, run first, in this order. */
  readonly schema?: readonly string[];
  /** Files of data (`insert`, `put`), run after the schema, in this order. */
  readonly seed?: readonly string[];
  readonly cwd?: string;
  readonly stopOnEntry?: boolean;
  /** Run Without Debugging: each statement through `session.run`, with nothing recorded. */
  readonly noDebug?: boolean;
}

/** How the debugger reads a file. The extension passes the file system; a spec passes a map. */
export interface Files {
  readFile(path: string): Promise<string>;
}

/** Where a line of output goes in the debug console. */
export type OutputCategory = 'console' | 'stdout' | 'stderr';

/** A launch that cannot start: a file that cannot be read, or a schema or seed statement the engine refused. */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchError';
  }
}

/** One statement of the program, and what it did once it has run. */
export interface ProgramStatement extends LocatedStatement {
  result?: RunResult;
  recording?: Recording;
  /** Its recording's records by id, once it has run. */
  records?: Map<number, IndexedRecord>;
}

/**
 * A line breakpoint, as the client is told of it. A breakpoint on a statement's first line is known to hold at once.
 * One on another line of a statement is known only once that statement has run and its stops are in, so until then it
 * waits, unverified, and the adapter reports the answer when it comes.
 */
export interface BreakpointState {
  readonly id: number;
  /** From 0. */
  readonly line: number;
  /** A condition on the row counts (`rowsOut == 0`): it then stops only at a stage or step whose counts meet it. */
  readonly condition?: string;
  readonly verified: boolean;
  readonly message?: string;
}

/** A line breakpoint as the client sets it: a line, from 0, and a condition on the row counts. */
export interface BreakpointSpec {
  readonly line: number;
  readonly condition?: string;
}

/** The exception breakpoints (ADR-014 B11): a refusal, and a stage or step that empties. */
export type ExceptionFilter = 'refusal' | 'empty';

/** Why the program stopped with reason `exception`, for the client's exception view. */
export interface ExceptionView {
  /** The refusal's `DiagnosticCode`, or `emptied`. */
  readonly id: string;
  readonly description: string;
}

/** A frame of the call stack at a stop, innermost first: a stage, then its statement. */
export interface FrameView {
  readonly name: string;
  /** From 0, in the program's file. */
  readonly line: number;
  readonly character: number;
  readonly statement: number;
  /** The stage, step, function or sub-query it is; nothing for the statement's own frame. */
  readonly record?: IndexedRecord;
  /** Whether `line` and `character` are its own: a record inside a function defined elsewhere has no place here. */
  readonly placed: boolean;
}

/** A scope of the Variables view, at one frame. */
export interface ScopeView {
  readonly name: string;
  readonly node: VariableNode;
  readonly expensive?: boolean;
}

/** Where a move ended: at a stop, and why; or at the end of the program, with the exit code `typedblite --file` gives. */
export type Outcome =
  | { readonly kind: 'stopped'; readonly reason: 'entry' | 'step' | 'breakpoint' | 'exception'; readonly text?: string }
  | { readonly kind: 'ended'; readonly exitCode: number };

/** The most rows of an answer the console prints. */
const CONSOLE_ROWS = 50;

/**
 * A program being debugged: a `:memory:` session on the engine host, the program's statements, and a timeline of
 * where it can stop. Everything a debug adapter does is a call on this; nothing here knows DAP.
 *
 * 🔴 It runs every statement through the host and nothing else (the initiative's rule), and only ever opens a session
 * at `:memory:` (the debugger's invariant 4; the host also refuses `session.debug` anywhere else).
 */
export class DebugProgram {
  readonly timeline: Timeline;
  /** The statement that was refused. Nothing after it runs, as `typedblite --file` stops there. */
  private failed: number | undefined;
  private closed = false;
  private breakpoints: BreakpointState[] = [];
  private readonly conditions = new Map<number, (counts: Counts) => boolean>();
  private nextBreakpoint = 1;
  private exceptionFilters = new Set<ExceptionFilter>(['refusal']);
  /** Why the program last stopped with reason `exception`. */
  exception: ExceptionView | undefined;
  /** Told when a waiting breakpoint is settled, once its statement has run. */
  breakpointChanged: (breakpoint: BreakpointState) => void = () => undefined;

  private constructor(
    private readonly host: HostCaller,
    private readonly session: string,
    readonly path: string,
    readonly statements: ProgramStatement[],
    private readonly output: (text: string, category: OutputCategory) => void,
  ) {
    this.timeline = new Timeline(statements.length);
  }

  /**
   * Open a fresh `:memory:` session, run the launch's schema and seed files into it, and locate the program's
   * statements. A refusal in a schema or seed file closes the session and fails the launch, naming the file and line.
   */
  static async launch(args: LaunchArguments, host: HostCaller, files: Files, output: (text: string, category: OutputCategory) => void): Promise<DebugProgram> {
    const base = args.cwd ?? dirname(args.program);
    const path = resolve(base, args.program);
    const read = async (file: string): Promise<string> => {
      try {
        return await files.readFile(file);
      } catch (error) {
        throw new LaunchError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const locate = async (source: string): Promise<LocatedStatement[]> =>
      (await host.call<{ statements: LocatedStatement[] }>('statement.locate', { source })).statements;

    const source = await read(path);
    const { id } = await host.call<{ id: string }>('session.open', { location: ':memory:' });
    try {
      for (const [role, list] of [
        ['schema', args.schema ?? []],
        ['seed', args.seed ?? []],
      ] as const) {
        for (const relative of list) {
          const file = resolve(base, relative);
          const statements = await locate(await read(file));
          for (const statement of statements) {
            const result = await host.call<RunResult>('session.run', { session: id, statement: statement.text });
            if (result.kind === 'refused') {
              throw new LaunchError(`The ${role} file ${file} was refused at line ${statement.line + 1}: ${result.message}`);
            }
          }
          output(`Ran the ${role} file ${file}: ${statements.length} statement(s).\n`, 'console');
        }
      }
      return new DebugProgram(host, id, path, await locate(source), output);
    } catch (error) {
      await host.call('session.close', { session: id }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Move forward from the current stop. Each statement the move passes is run first, recorded through
   * `session.debug`. A refusal stops the move where it happened, when the refusal filter is on, and ends the program
   * otherwise; nothing after a refused statement runs, as `typedblite --file` stops there. A stage or step that empties
   * stops it when that filter is on.
   */
  async move(motion: Motion): Promise<Outcome> {
    const from = this.timeline.current;
    let index = this.timeline.index;
    for (;;) {
      const here = this.timeline.at(index)!;
      if (here.kind === 'end') return this.end();
      if (here.kind === 'statement' && !this.timeline.isExpanded(here.statement)) {
        if (this.failed !== undefined) return this.end();
        const refused = await this.record(here.statement);
        if (refused !== undefined) {
          if (!this.exceptionFilters.has('refusal')) return this.end();
          this.timeline.moveTo(this.refusalStop(here.statement));
          return { kind: 'stopped', reason: 'exception', text: refused };
        }
      }
      index += 1;
      const next = this.timeline.at(index)!;
      if (this.failed !== undefined && next.statement > this.failed) return this.end();
      const stepped = accepts(motion, from, next);
      const emptied = this.emptied(next);
      if (stepped || this.hits(next) || emptied !== undefined) {
        this.timeline.moveTo(index);
        if (next.kind === 'end') return this.end();
        if (emptied !== undefined && !stepped) {
          this.exception = { id: 'emptied', description: emptied };
          return { kind: 'stopped', reason: 'exception', text: emptied };
        }
        return { kind: 'stopped', reason: stepped && motion !== 'continue' ? 'step' : 'breakpoint' };
      }
    }
  }

  /**
   * Move back through what has been recorded (ADR-014 B1): one stop, or to the last stop where a breakpoint holds, or
   * to the start. Nothing runs again; what is shown is what was recorded then.
   */
  back(motion: 'step' | 'reverse'): Outcome {
    let index = this.timeline.index;
    if (index === 0) return { kind: 'stopped', reason: 'entry' };
    if (motion === 'step') {
      this.timeline.moveTo(index - 1);
      return { kind: 'stopped', reason: 'step' };
    }
    for (index -= 1; index > 0; index -= 1) {
      if (this.hits(this.timeline.at(index)!)) {
        this.timeline.moveTo(index);
        return { kind: 'stopped', reason: 'breakpoint' };
      }
    }
    this.timeline.moveTo(0);
    return { kind: 'stopped', reason: 'entry' };
  }

  /** Begin a launch that does not stop on entry: at the first statement if a breakpoint holds there, else on. */
  async start(): Promise<Outcome> {
    if (this.hits(this.timeline.current)) return { kind: 'stopped', reason: 'breakpoint' };
    return this.move('continue');
  }

  /**
   * Replace the program file's breakpoints. Each is checked against what is known: a statement's first line holds at
   * once, a line in no statement never does, and any other line of a statement waits until that statement has run. A
   * breakpoint with a condition stops only at a stage or step, so it always waits for its statement; one whose
   * condition cannot be read never holds, and says why.
   */
  setBreakpoints(specs: ReadonlyArray<number | BreakpointSpec>): BreakpointState[] {
    this.conditions.clear();
    this.breakpoints = specs.map((spec) => {
      const { line, condition } = typeof spec === 'number' ? { line: spec, condition: undefined } : spec;
      const id = this.nextBreakpoint++;
      if (condition !== undefined && condition.trim() !== '') {
        const parsed = parseCondition(condition);
        if (!parsed.ok) return { id, line, condition, verified: false, message: parsed.message };
        this.conditions.set(id, parsed.test);
        return this.check({ id, line, condition, verified: false });
      }
      return this.check({ id, line, verified: false });
    });
    return this.breakpoints;
  }

  /** Which exception breakpoints are on. */
  setExceptionFilters(filters: readonly string[]): void {
    this.exceptionFilters = new Set(filters.filter((filter): filter is ExceptionFilter => filter === 'refusal' || filter === 'empty'));
  }

  /**
   * The lines a stop is on, in the program's file: where a line breakpoint stops it. A statement is on its first line; a
   * stage on its own first line; a step on every line its ranges cover (ADR-014 B6), which may be several and need not
   * be in order. A record inside a function defined elsewhere is on no line of this file.
   */
  linesOf(stop: Stop): number[] {
    const statement = this.statements[stop.statement];
    if (statement === undefined || stop.kind === 'end') return [];
    if (stop.kind === 'statement') return [statement.line];
    const records = statement.records;
    const record = records === undefined ? undefined : recordAt(stop, records);
    if (record === undefined || records === undefined || !placedIn(stop.path, records, statement.text)) return [];
    if (record.kind === 'stage') return record.record.range === undefined ? [] : [inFile(record.record.range, statement).start.line];
    if (record.kind !== 'step') return [];
    const lines = new Set<number>();
    for (const range of record.record.ranges) {
      const placed = inFile(range, statement);
      for (let line = placed.start.line; line <= placed.end.line; line += 1) lines.add(line);
    }
    return [...lines];
  }

  /**
   * The frames of the call stack at the current stop, innermost first: the step, the steps and stages around it, any
   * function or sub-query it is inside, and the statement. Nothing at the end.
   */
  frames(): FrameView[] {
    const stop = this.timeline.current;
    const statement = this.statements[stop.statement];
    if (statement === undefined) return [];
    const frames: FrameView[] = [];
    const records = statement.records;
    if (records !== undefined) {
      stop.path.forEach((id, i) => {
        const record = records.get(id);
        if (record === undefined || (record.kind === 'frame' && i === 0)) return;
        const placed = placedIn(stop.path.slice(0, i + 1), records, statement.text);
        const enclosing = placedIn(stop.path.slice(0, i), records, statement.text);
        const view = this.frameOf(record, statement, stop.statement, placed, enclosing);
        if (view !== undefined) frames.unshift(view);
      });
    }
    frames.push({ name: firstLine(statement.text), line: statement.line, character: statement.character, statement: stop.statement, placed: true });
    return frames;
  }

  /** The scopes of the Variables view at a frame. */
  scopes(frame: FrameView): ScopeView[] {
    const statement = this.statements[frame.statement]!;
    const recording = statement.recording;
    const record = frame.record;
    if (record?.kind === 'stage' && recording !== undefined) {
      const stage = record.record;
      return [
        { name: 'Rows', node: rowsNode('Rows', stage.rows, stage.rowsDropped, stage.rowsOut, recording) },
        { name: 'Stage', node: { name: 'Stage', value: stage.kind, children: () => stageNodes(stage) } },
        { name: 'Scope', node: { name: 'Scope', value: `${stage.scope.length} variable(s)`, children: () => scopeNodes(stage.scope) } },
      ];
    }
    if (record?.kind === 'step' && recording !== undefined) {
      const step = record.record;
      return [
        { name: 'Rows', node: rowsNode('Rows', step.rows, step.rowsDropped, step.rowsOut, recording) },
        { name: 'Step', node: { name: 'Step', value: step.name, children: () => stepNodes(step) } },
        ...(step.values.length === 0 ? [] : [{ name: 'Lets and comparisons', node: { name: 'Lets and comparisons', value: `${step.values.length}`, children: () => valuesNodes(step.values) } }]),
        { name: 'By incoming row', node: byCallNode(step), expensive: step.byCall.length > 20 },
      ];
    }
    if (record?.kind === 'frame') {
      const called = record.record;
      return [{ name: called.kind === 'function' ? 'Function' : 'Sub-query', node: { name: called.name, value: `${called.calls} call(s)`, children: () => [{ name: 'calls', value: String(called.calls) }] } }];
    }
    return [
      {
        name: 'Statement',
        node: {
          name: 'Statement',
          value: statusOf(statement.result),
          children: () => [
            { name: 'status', value: statusOf(statement.result) },
            { name: 'text', value: statement.text },
          ],
        },
      },
    ];
  }

  /** A record of a stop's path as a frame of the call stack. */
  private frameOf(record: IndexedRecord, statement: ProgramStatement, index: number, placed: boolean, enclosing: boolean): FrameView | undefined {
    const position = (range: Range | undefined, inText: boolean): { line: number; character: number; placed: boolean } =>
      inText && range !== undefined ? { ...inFile(range, statement).start, placed: true } : { line: statement.line, character: statement.character, placed: false };
    switch (record.kind) {
      case 'stage':
        return { name: `${record.record.kind} · ${record.record.rowsIn} → ${record.record.rowsOut} row(s)`, ...position(record.record.range, placed), statement: index, record };
      case 'step':
        return { name: `${record.record.name} · ${record.record.rowsIn} → ${record.record.rowsOut} row(s)`, ...position(record.record.ranges[0], placed), statement: index, record };
      case 'frame':
        // Shown at its call site, which is in the text around it.
        return {
          name: record.record.kind === 'function' ? `${record.record.name}() · ${record.record.calls} call(s)` : `fetch · ${record.record.calls} call(s)`,
          ...position(record.record.at ?? record.record.range, enclosing),
          statement: index,
          record,
        };
      default:
        return undefined;
    }
  }

  /**
   * Whether a breakpoint holds at a stop. A line breakpoint stops once in a statement, at its first stop on that line:
   * a statement and its first stage usually start on one line, and a breakpoint there stops before the statement runs.
   */
  private hits(stop: Stop): boolean {
    if (stop.kind === 'end' || this.breakpoints.length === 0) return false;
    const lines = this.linesOf(stop);
    const earlier = this.stopsIn(stop.statement);
    const before = earlier.slice(0, earlier.findIndex((other) => sameStop(other, stop)));
    return this.breakpoints.some((breakpoint) => {
      if (!lines.includes(breakpoint.line)) return false;
      // A conditional breakpoint stops at each stage or step on its line whose counts meet its condition.
      const condition = this.conditions.get(breakpoint.id);
      if (condition !== undefined) {
        const counts = this.countsAt(stop);
        return counts !== undefined && condition(counts);
      }
      if (breakpoint.condition !== undefined) return false;
      return !before.some((other) => this.linesOf(other).includes(breakpoint.line));
    });
  }

  /** A stage's or step's row counts, summed over every call. Nothing for a statement or the end. */
  private countsAt(stop: Stop): Counts | undefined {
    const statement = this.statements[stop.statement];
    const record = statement?.records === undefined ? undefined : recordAt(stop, statement.records);
    if (record?.kind !== 'stage' && record?.kind !== 'step') return undefined;
    return { rowsIn: record.record.rowsIn, rowsOut: record.record.rowsOut };
  }

  /**
   * Why a stop stops for the "when a step empties" filter, or nothing: a stage or step that received rows and passed
   * none on, and inside which no step did the same, so it stops where the rows ran out and not around it. Not in a
   * refused statement, whose unfinished records passed nothing on because they never finished.
   */
  private emptied(stop: Stop): string | undefined {
    if (!this.exceptionFilters.has('empty') || stop.statement === this.failed) return undefined;
    const statement = this.statements[stop.statement];
    const record = statement?.records === undefined ? undefined : recordAt(stop, statement.records);
    if (record?.kind !== 'stage' && record?.kind !== 'step') return undefined;
    if (!(record.record.rowsIn > 0 && record.record.rowsOut === 0) || anyStepEmpties(record.record.blocks)) return undefined;
    const name = record.kind === 'stage' ? record.record.kind : record.record.name;
    return `${name}: ${record.record.rowsIn} row(s) in, none out.`;
  }

  /** The stop to show a refusal at: the deepest stop of the statement at the record that was open, or around it. */
  private refusalStop(index: number): number {
    const statement = this.statements[index]!;
    const at = statement.recording?.refusal?.at;
    const first = this.timeline.statementIndex(index);
    this.exception = { id: statement.recording?.refusal?.code ?? 'refused', description: statement.result?.kind === 'refused' ? statement.result.message : 'Refused' };
    if (at === undefined || statement.records === undefined) return first;
    const around = new Set<number>();
    for (let id: number | undefined = at; id !== undefined; id = statement.records.get(id)?.parent) around.add(id);
    let best = first;
    for (let i = first + 1; this.timeline.at(i)?.statement === index; i += 1) {
      const stop = this.timeline.at(i)!;
      const last = stop.path[stop.path.length - 1];
      if (last !== undefined && around.has(last) && stop.depth >= this.timeline.at(best)!.depth) best = i;
    }
    return best;
  }

  /** A statement's stops, in order: its own, then those its recording holds once it has run. */
  private stopsIn(index: number): Stop[] {
    const recording = this.statements[index]?.recording;
    return [{ statement: index, depth: 0, kind: 'statement', path: [] }, ...(recording === undefined ? [] : stopsOf(index, recording))];
  }

  /** A breakpoint checked against what is known now. */
  private check({ id, line, condition }: BreakpointState): BreakpointState {
    // Built afresh: a settled breakpoint must not keep the message it waited with.
    const breakpoint = condition === undefined ? { id, line } : { id, line, condition };
    const index = this.statements.findIndex((statement) => breakpoint.line >= statement.line && breakpoint.line < statement.line + statement.text.split('\n').length);
    if (index < 0) return { ...breakpoint, verified: false, message: 'No statement is on this line.' };
    const statement = this.statements[index]!;
    if (breakpoint.line === statement.line && condition === undefined) return { ...breakpoint, verified: true };
    if (statement.records === undefined) return { ...breakpoint, verified: false, message: 'Checked when its statement runs.' };
    return this.stopsIn(index).some((stop) => (condition === undefined || stop.kind !== 'statement') && this.linesOf(stop).includes(breakpoint.line))
      ? { ...breakpoint, verified: true }
      : { ...breakpoint, verified: false, message: 'No stage or step of this statement is on this line.' };
  }

  /** A position in the program's file, for a range the engine reported in a statement. */
  private place(statement: ProgramStatement, range: Range | undefined): { line: number; character: number } {
    if (range === undefined) return { line: statement.line, character: statement.character };
    return inFile(range, statement).start;
  }

  /** Run Without Debugging: every statement through `session.run`, stopping at the first refusal. The exit code. */
  async runAll(): Promise<number> {
    for (const [index, statement] of this.statements.entries()) {
      const result = await this.host.call<RunResult>('session.run', { session: this.session, statement: statement.text });
      statement.result = result;
      this.print(index, result);
      if (result.kind === 'refused') return 1;
    }
    return 0;
  }

  /** The statement a stop is in, or nothing at the end. */
  statementAt(stop: Stop = this.timeline.current): ProgramStatement | undefined {
    return this.statements[stop.statement];
  }

  /** Close the host session. Safe to call more than once, and after the host has gone. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.host.call('session.close', { session: this.session }).catch(() => undefined);
  }

  /** Run one statement with a recording, and put its stops in. The refusal's message when it was refused. */
  private async record(index: number): Promise<string | undefined> {
    const statement = this.statements[index]!;
    const { result, recording } = await this.host.call<DebugResult>('session.debug', { session: this.session, statement: statement.text });
    statement.result = result;
    statement.recording = recording;
    statement.records = indexRecording(recording);
    this.timeline.expand(index, stopsOf(index, recording));
    this.print(index, result);
    // Breakpoints waiting on this statement are settled now its stops are in.
    this.breakpoints = this.breakpoints.map((breakpoint) => {
      if (breakpoint.verified || breakpoint.message !== 'Checked when its statement runs.') return breakpoint;
      const settled = this.check(breakpoint);
      if (settled.verified !== breakpoint.verified || settled.message !== breakpoint.message) this.breakpointChanged(settled);
      return settled;
    });
    if (result.kind !== 'refused') return undefined;
    this.failed = index;
    return result.message;
  }

  private end(): Outcome {
    this.timeline.moveTo(this.timeline.statementIndex(this.statements.length));
    return { kind: 'ended', exitCode: this.failed === undefined ? 0 : 1 };
  }

  private print(index: number, result: RunResult): void {
    const statement = this.statements[index]!;
    const heading = `Line ${statement.line + 1}: ${firstLine(statement.text)}`;
    this.output(`${heading}\n${plainOutput(outputsOf(result, CONSOLE_ROWS))}\n\n`, result.kind === 'refused' ? 'stderr' : 'console');
  }
}

/** A statement's first line, shortened: how a stack frame and the console name it. */
export function firstLine(text: string, width = 60): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

/** What a statement did, on one line. */
export function statusOf(result: RunResult | undefined): string {
  if (result === undefined) return 'not run yet';
  if (result.kind === 'refused') return `refused: ${result.message}`;
  if (result.kind === 'rows') return `${result.documents?.length ?? result.rows.length} ${result.documents ? 'document(s)' : 'row(s)'}`;
  return result.statement === 'define' ? 'schema applied' : `written, ${result.rows.length} row(s)`;
}

function sameStop(a: Stop, b: Stop): boolean {
  return a.statement === b.statement && a.kind === b.kind && a.path.length === b.path.length && a.path.every((id, i) => id === b.path[i]);
}

/** Whether any step in these blocks, or in the blocks inside them, received rows and passed none on. */
function anyStepEmpties(blocks: readonly BlockRecord[]): boolean {
  return blocks.some((block) => block.steps.some((step) => (step.rowsIn > 0 && step.rowsOut === 0) || anyStepEmpties(step.blocks)));
}
