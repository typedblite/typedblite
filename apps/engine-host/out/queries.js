/** Operations that read. Each is one operation in the host's protocol (ADR-011 D4). */
/** `session.get` */
export class GetSessionQuery {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
}
/** `session.list` */
export class ListSessionsQuery {
}
/** `schema.get`: the `schemaSnapshot()` of a session's store. */
export class GetSchemaQuery {
    sessionId;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
}
/** `statement.classify`: what the classifier says a statement is, without running it. */
export class ClassifyStatementQuery {
    statement;
    constructor(statement) {
        this.statement = statement;
    }
}
/** `statement.split`: a source split into statements a session can run one at a time. */
export class SplitStatementsQuery {
    source;
    constructor(source) {
        this.source = source;
    }
}
//# sourceMappingURL=queries.js.map