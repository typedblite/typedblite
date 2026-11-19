/** Operations that read. Each is one operation in the host's protocol (ADR-011 D4). */

/** `session.get` */
export class GetSessionQuery {
  constructor(readonly sessionId: string) {}
}

/** `session.list` */
export class ListSessionsQuery {}

/** `schema.get`: the `schemaSnapshot()` of a session's store. */
export class GetSchemaQuery {
  constructor(readonly sessionId: string) {}
}

/** `statement.classify`: what the classifier says a statement is, without running it. */
export class ClassifyStatementQuery {
  constructor(readonly statement: string) {}
}

/** `statement.locate`: the statements `statement.split` finds, each as written and where it starts. */
export class LocateStatementsQuery {
  constructor(readonly source: string) {}
}

/** `statement.split`: a source split into statements a session can run one at a time. */
export class SplitStatementsQuery {
  constructor(readonly source: string) {}
}
