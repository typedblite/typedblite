/** Operations that change state. Each is one operation in the host's protocol (ADR-011 D4). */
/** `session.open` */
export class OpenSessionCommand {
    location;
    schema;
    constructor(
    /** `:memory:`, or the path of a SQLite file. */
    location = ':memory:', 
    /** A `define` block to apply once the store is open. A refusal closes the session and fails the open. */
    schema) {
        this.location = location;
        this.schema = schema;
    }
}
/** `session.run`: exactly one statement (`statement.split` splits a source). */
export class RunStatementCommand {
    sessionId;
    statement;
    constructor(sessionId, statement) {
        this.sessionId = sessionId;
        this.statement = statement;
    }
}
/** `session.begin` */
export class BeginTransactionCommand {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
}
/** `session.commit` */
export class CommitTransactionCommand {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
}
/** `session.rollback` */
export class RollbackTransactionCommand {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
}
/** `session.restart` */
export class RestartSessionCommand {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
}
/** `session.close` */
export class CloseSessionCommand {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
}
//# sourceMappingURL=commands.js.map