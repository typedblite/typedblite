/** Operations that change state. Each is one operation in the host's protocol (ADR-011 D4). */
/** `session.open` */
export declare class OpenSessionCommand {
    /** `:memory:`, or the path of a SQLite file. */
    readonly location: string;
    /** A `define` block to apply once the store is open. A refusal closes the session and fails the open. */
    readonly schema?: string | undefined;
    constructor(
    /** `:memory:`, or the path of a SQLite file. */
    location?: string, 
    /** A `define` block to apply once the store is open. A refusal closes the session and fails the open. */
    schema?: string | undefined);
}
/** `session.run`: exactly one statement (`statement.split` splits a source). */
export declare class RunStatementCommand {
    readonly sessionId: string;
    readonly statement: string;
    constructor(sessionId: string, statement: string);
}
/** `session.begin` */
export declare class BeginTransactionCommand {
    readonly sessionId: string;
    constructor(sessionId: string);
}
/** `session.commit` */
export declare class CommitTransactionCommand {
    readonly sessionId: string;
    constructor(sessionId: string);
}
/** `session.rollback` */
export declare class RollbackTransactionCommand {
    readonly sessionId: string;
    constructor(sessionId: string);
}
/** `session.restart` */
export declare class RestartSessionCommand {
    readonly sessionId: string;
    constructor(sessionId: string);
}
/** `session.close` */
export declare class CloseSessionCommand {
    readonly sessionId: string;
    constructor(sessionId: string);
}
//# sourceMappingURL=commands.d.ts.map