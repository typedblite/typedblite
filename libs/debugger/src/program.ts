import { dirname, resolve } from 'node:path';

import { outputsOf, plainOutput } from '@typedblite/notebook';

import { accepts, Timeline, type Motion, type Stop } from './timeline.js';
import type { DebugResult, HostCaller, LocatedStatement, Recording, RunResult } from './wire.js';

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
}

/** Where a move ended: at a stop, and why; or at the end of the program, with the exit code `typedblite --file` gives. */
export type Outcome =
  | { readonly kind: 'stopped'; readonly reason: 'step' | 'breakpoint' | 'exception'; readonly text?: string }
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
   * `session.debug`; a refusal stops the move at that statement. A move past the refused statement ends the program.
   */
  async move(motion: Motion): Promise<Outcome> {
    const from = this.timeline.current;
    let index = this.timeline.index;
    for (;;) {
      const here = this.timeline.at(index)!;
      if (here.kind === 'end' || (this.failed !== undefined && here.statement >= this.failed)) return this.end();
      if (here.kind === 'statement' && !this.timeline.isExpanded(here.statement)) {
        const refused = await this.record(here.statement);
        if (refused !== undefined) {
          this.timeline.moveTo(index);
          return { kind: 'stopped', reason: 'exception', text: refused };
        }
      }
      index += 1;
      const next = this.timeline.at(index)!;
      if (accepts(motion, from, next)) {
        this.timeline.moveTo(index);
        return next.kind === 'end' ? this.end() : { kind: 'stopped', reason: 'step' };
      }
    }
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
    this.timeline.expand(index, []);
    this.print(index, result);
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
