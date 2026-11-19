/** Operations that change state. Each is one operation in the host's protocol (ADR-011 D4). */

/** `session.open` */
export class OpenSessionCommand {
  constructor(
    /** `:memory:`, or the path of a SQLite file. */
    readonly location: string = ':memory:',
    /** A `define` block to apply once the store is open. A refusal closes the session and fails the open. */
    readonly schema?: string,
  ) {}
}

/**
 * `session.run`: exactly one statement (`statement.split` splits a source).
 *
 * Name the `sessionId` of an open session, or a `location`: the host then opens that store, runs the statement
 * and closes it again, so a caller with no session to keep (the one-shot CLI) still has an operation to call.
 * State across such calls is the file, not a session.
 */
export class RunStatementCommand {
  constructor(
    readonly sessionId: string | undefined,
    readonly statement: string,
    readonly location?: string,
  ) {}
}

/** The caps of a recording (ADR-014 B10); what is not given takes the recorder's default. */
export interface DebugLimits {
  readonly rowsPerStep?: number;
  readonly callsPerSite?: number;
  readonly bytes?: number;
}

/**
 * `session.debug`: exactly one statement, as `session.run` runs it, with a recording of what it did (ADR-014 B2).
 * 🔴 Only on a session at `:memory:`: a debugger never runs against a store anyone keeps (the debugger's invariant 4).
 */
export class DebugStatementCommand {
  constructor(
    readonly sessionId: string,
    readonly statement: string,
    readonly limits: DebugLimits = {},
  ) {}
}

/** `session.begin` */
export class BeginTransactionCommand {
  constructor(readonly sessionId: string) {}
}

/** `session.commit` */
export class CommitTransactionCommand {
  constructor(readonly sessionId: string) {}
}

/** `session.rollback` */
export class RollbackTransactionCommand {
  constructor(readonly sessionId: string) {}
}

/** `session.restart` */
export class RestartSessionCommand {
  constructor(readonly sessionId: string) {}
}

/** `session.close` */
export class CloseSessionCommand {
  constructor(readonly sessionId: string) {}
}
