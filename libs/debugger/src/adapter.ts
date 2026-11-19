import { basename } from 'node:path';

import {
  DebugSession,
  ExitedEvent,
  Handles,
  InitializedEvent,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { DebugProgram, firstLine, LaunchError, type Files, type LaunchArguments, type Outcome } from './program.js';
import type { Motion } from './timeline.js';
import type { HostCaller, RunResult } from './wire.js';

/** The debugger's one thread: the interpreter is single-threaded. */
export const THREAD_ID = 1;

/** What a variable reference stands for: a list of name and value pairs, built when the client asks. */
type VariableSource = () => DebugProtocol.Variable[];

/**
 * The TypeQLite debug adapter: the Debug Adapter Protocol over a {@link DebugProgram} (ADR-014). The extension runs it
 * inline (B3) and a spec runs it over a socket; either way it reaches the engine only through the host it is given.
 */
export class TypeQLiteDebugSession extends DebugSession {
  private program: DebugProgram | undefined;
  private readonly variables = new Handles<VariableSource>();
  private configured!: () => void;
  private readonly configurationDone = new Promise<void>((resolve) => (this.configured = resolve));

  constructor(
    private readonly host: HostCaller,
    private readonly files: Files,
  ) {
    super();
    // Lines and columns as LSP counts them, from 0; the client's own convention is applied at the boundary.
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
  }

  protected override initializeRequest(response: DebugProtocol.InitializeResponse): void {
    response.body = {
      ...response.body,
      supportsConfigurationDoneRequest: true,
      supportsTerminateRequest: true,
    };
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected override configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): void {
    this.sendResponse(response);
    this.configured();
  }

  protected override async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments & LaunchArguments): Promise<void> {
    // A client sends its breakpoints, then configurationDone; a launch waits for them, briefly, as other adapters do.
    await Promise.race([this.configurationDone, new Promise((resolve) => setTimeout(resolve, 1000))]);
    try {
      this.program = await DebugProgram.launch(args, this.host, this.files, (text, category) => this.sendEvent(new OutputEvent(text, category)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A launch error says which file and line; anything else is the host's own message. The user sees both.
      this.sendErrorResponse(response, { id: error instanceof LaunchError ? 1001 : 1002, format: message, showUser: true });
      this.sendEvent(new TerminatedEvent());
      return;
    }
    this.sendResponse(response);

    if (args.noDebug) {
      const exitCode = await this.guard(() => this.program!.runAll());
      if (exitCode !== undefined) this.finish({ kind: 'ended', exitCode });
      return;
    }
    if (args.stopOnEntry) {
      this.sendEvent(new StoppedEvent('entry', THREAD_ID));
      return;
    }
    await this.go('continue');
  }

  protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(THREAD_ID, 'TypeQLite')] };
    this.sendResponse(response);
  }

  protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse): void {
    const program = this.program;
    const statement = program?.statementAt();
    const frames: StackFrame[] = [];
    if (program !== undefined && statement !== undefined) {
      const source = new Source(basename(program.path), this.convertDebuggerPathToClient(program.path));
      frames.push(
        new StackFrame(
          program.timeline.index + 1,
          firstLine(statement.text),
          source,
          this.convertDebuggerLineToClient(statement.line),
          this.convertDebuggerColumnToClient(statement.character),
        ),
      );
    }
    response.body = { stackFrames: frames, totalFrames: frames.length };
    this.sendResponse(response);
  }

  protected override scopesRequest(response: DebugProtocol.ScopesResponse): void {
    const statement = this.program?.statementAt();
    const scopes: Scope[] = [];
    if (statement !== undefined) {
      scopes.push(
        new Scope(
          'Statement',
          this.variables.create(() => [
            variable('status', statusOf(statement.result)),
            variable('text', statement.text),
          ]),
          false,
        ),
      );
    }
    response.body = { scopes };
    this.sendResponse(response);
  }

  protected override variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
    const source = this.variables.get(args.variablesReference);
    response.body = { variables: source === undefined ? [] : source() };
    this.sendResponse(response);
  }

  protected override async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
    this.sendResponse(response);
    await this.go('over');
  }

  protected override async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
    this.sendResponse(response);
    await this.go('in');
  }

  protected override async stepOutRequest(response: DebugProtocol.StepOutResponse): Promise<void> {
    this.sendResponse(response);
    await this.go('out');
  }

  protected override async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
    response.body = { allThreadsContinued: true };
    this.sendResponse(response);
    await this.go('continue');
  }

  protected override async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
    await this.program?.close();
    this.sendResponse(response);
  }

  protected override async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
    await this.program?.close();
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  /** Move, and tell the client where the move ended. */
  private async go(motion: Motion): Promise<void> {
    const outcome = await this.guard(() => this.program!.move(motion));
    if (outcome !== undefined) this.finish(outcome);
  }

  private finish(outcome: Outcome): void {
    this.variables.reset();
    if (outcome.kind === 'stopped') {
      const event = new StoppedEvent(outcome.reason, THREAD_ID, outcome.text) as DebugProtocol.StoppedEvent;
      if (outcome.reason === 'exception') event.body.description = 'Refused by TypeQLite';
      this.sendEvent(event);
      return;
    }
    void this.program?.close();
    this.sendEvent(new ExitedEvent(outcome.exitCode));
    this.sendEvent(new TerminatedEvent());
  }

  /** A fault reaching the host ends the session, saying why, rather than leaving the client waiting. */
  private async guard<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.sendEvent(new OutputEvent(`The debug session ended: ${error instanceof Error ? error.message : String(error)}\n`, 'stderr'));
      void this.program?.close();
      this.sendEvent(new TerminatedEvent());
      return undefined;
    }
  }
}

function variable(name: string, value: string): DebugProtocol.Variable {
  return { name, value, variablesReference: 0 };
}

function statusOf(result: RunResult | undefined): string {
  if (result === undefined) return 'not run yet';
  if (result.kind === 'refused') return `refused: ${result.message}`;
  if (result.kind === 'rows') return `${result.documents?.length ?? result.rows.length} ${result.documents ? 'document(s)' : 'row(s)'}`;
  return result.statement === 'define' ? 'schema applied' : `written, ${result.rows.length} row(s)`;
}
