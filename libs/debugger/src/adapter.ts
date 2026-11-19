import { basename } from 'node:path';

import {
  Breakpoint,
  BreakpointEvent,
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

import { DebugProgram, LaunchError, type BreakpointState, type Files, type FrameView, type LaunchArguments, type Outcome } from './program.js';
import type { VariableNode } from './values.js';
import type { Motion } from './timeline.js';
import type { HostCaller } from './wire.js';

/** The debugger's one thread: the interpreter is single-threaded. */
export const THREAD_ID = 1;

/**
 * The TypeQLite debug adapter: the Debug Adapter Protocol over a {@link DebugProgram} (ADR-014). The extension runs it
 * inline (B3) and a spec runs it over a socket; either way it reaches the engine only through the host it is given.
 */
export class TypeQLiteDebugSession extends DebugSession {
  private program: DebugProgram | undefined;
  private readonly variables = new Handles<VariableNode>();
  private readonly frameHandles = new Handles<FrameView>();
  /** Breakpoints set before the launch had located the program, by file. */
  private readonly pendingBreakpoints = new Map<string, number[]>();
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
      this.program.breakpointChanged = (breakpoint) => this.sendEvent(new BreakpointEvent('changed', this.toClient(breakpoint)));
      this.applyBreakpoints();
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
    const outcome = await this.guard(() => this.program!.start());
    if (outcome !== undefined) this.finish(outcome);
  }

  protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(THREAD_ID, 'TypeQLite')] };
    this.sendResponse(response);
  }

  protected override async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    const lines = (args.breakpoints ?? []).map((breakpoint) => this.convertClientLineToDebugger(breakpoint.line));
    const path = args.source.path === undefined ? undefined : this.convertClientPathToDebugger(args.source.path);
    if (this.program === undefined) {
      // Before the launch has located the program: kept, and answered once it has (`applyBreakpoints`).
      if (path !== undefined) this.pendingBreakpoints.set(path, lines);
      response.body = { breakpoints: lines.map((line) => ({ verified: false, line: this.convertDebuggerLineToClient(line), message: 'Checked when the program starts.' })) };
      this.sendResponse(response);
      return;
    }
    response.body = { breakpoints: path === this.program.path ? this.program.setBreakpoints(lines).map((b) => this.toClient(b)) : lines.map((line) => this.elsewhere(line)) };
    this.sendResponse(response);
  }

  protected override stackTraceRequest(response: DebugProtocol.StackTraceResponse): void {
    const program = this.program;
    const frames: StackFrame[] = [];
    if (program !== undefined) {
      const source = new Source(basename(program.path), this.convertDebuggerPathToClient(program.path));
      for (const frame of program.frames()) {
        frames.push(new StackFrame(this.frameHandles.create(frame), frame.name, source, this.convertDebuggerLineToClient(frame.line), this.convertDebuggerColumnToClient(frame.character)));
      }
    }
    response.body = { stackFrames: frames, totalFrames: frames.length };
    this.sendResponse(response);
  }

  protected override scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    const frame = this.frameHandles.get(args.frameId);
    const scopes = frame === undefined || this.program === undefined ? [] : this.program.scopes(frame);
    response.body = {
      scopes: scopes.map((scope) => {
        const reference = this.variables.create(scope.node);
        return { name: scope.name, variablesReference: reference, expensive: scope.expensive ?? false, ...(scope.node.indexed === undefined ? {} : { indexedVariables: scope.node.indexed }) };
      }),
    };
    this.sendResponse(response);
  }

  protected override variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
    const node = this.variables.get(args.variablesReference);
    let children = node?.children?.() ?? [];
    // A row set is paged: the client asks for a slice of it.
    if (args.start !== undefined || args.count !== undefined) children = children.slice(args.start ?? 0, args.count === undefined ? undefined : (args.start ?? 0) + args.count);
    response.body = {
      variables: children.map((child): DebugProtocol.Variable => ({
        name: child.name,
        value: child.value,
        variablesReference: child.children === undefined ? 0 : this.variables.create(child),
        ...(child.indexed === undefined ? {} : { indexedVariables: child.indexed }),
      })),
    };
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

  /** The breakpoints set before the launch, answered now the program is located. */
  private applyBreakpoints(): void {
    const program = this.program!;
    for (const [path, lines] of this.pendingBreakpoints) {
      const states = path === program.path ? program.setBreakpoints(lines).map((b) => this.toClient(b)) : lines.map((line) => this.elsewhere(line));
      for (const state of states) this.sendEvent(new BreakpointEvent('changed', state));
    }
    this.pendingBreakpoints.clear();
  }

  private toClient(breakpoint: BreakpointState): DebugProtocol.Breakpoint {
    const shown = new Breakpoint(breakpoint.verified, this.convertDebuggerLineToClient(breakpoint.line)) as DebugProtocol.Breakpoint;
    shown.id = breakpoint.id;
    if (breakpoint.message !== undefined) shown.message = breakpoint.message;
    return shown;
  }

  private elsewhere(line: number): DebugProtocol.Breakpoint {
    return { verified: false, line: this.convertDebuggerLineToClient(line), message: 'Only the launched program stops: this file is not it.' };
  }

  private finish(outcome: Outcome): void {
    this.variables.reset();
    this.frameHandles.reset();
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
