/** Operations that read. Each is one operation in the host's protocol (ADR-011 D4). */
/** `session.get` */
export declare class GetSessionQuery {
    readonly sessionId: string;
    constructor(sessionId: string);
}
/** `session.list` */
export declare class ListSessionsQuery {
}
/** `schema.get`: the `schemaSnapshot()` of a session's store. */
export declare class GetSchemaQuery {
    readonly sessionId: string;
    constructor(sessionId: string);
}
/** `statement.classify`: what the classifier says a statement is, without running it. */
export declare class ClassifyStatementQuery {
    readonly statement: string;
    constructor(statement: string);
}
/** `statement.split`: a source split into statements a session can run one at a time. */
export declare class SplitStatementsQuery {
    readonly source: string;
    constructor(source: string);
}
//# sourceMappingURL=queries.d.ts.map