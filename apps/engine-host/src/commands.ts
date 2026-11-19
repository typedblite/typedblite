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

/** `session.run`: exactly one statement (`statement.split` splits a source). */
export class RunStatementCommand {
  constructor(
    readonly sessionId: string,
    readonly statement: string,
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
