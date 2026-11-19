import { type ICommandHandler, type IQueryHandler } from '@nestjs/cqrs';
import { type ControlResult, type RunResult, type StatementKind } from '@typedblite/session';
import type { TypeDBLiteSchemaSnapshot } from '@typedblite/runtime';
import { BeginTransactionCommand, CloseSessionCommand, CommitTransactionCommand, OpenSessionCommand, RestartSessionCommand, RollbackTransactionCommand, RunStatementCommand } from './commands.js';
import { ClassifyStatementQuery, GetSchemaQuery, GetSessionQuery, ListSessionsQuery, SplitStatementsQuery } from './queries.js';
import { SessionRegistry, type SessionInfo } from './session.registry.js';
export declare class OpenSessionHandler implements ICommandHandler<OpenSessionCommand, SessionInfo> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ location, schema }: OpenSessionCommand): Promise<SessionInfo>;
}
export declare class RunStatementHandler implements ICommandHandler<RunStatementCommand, RunResult> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    /**
     * A refusal, the engine's own included, is the answer and not an exception. An unknown id is an exception.
     * 🔴 Every handler is `async`, so an exception is always a rejection and never a synchronous throw.
     */
    execute({ sessionId, statement }: RunStatementCommand): Promise<RunResult>;
}
export declare class BeginTransactionHandler implements ICommandHandler<BeginTransactionCommand, ControlResult> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ sessionId }: BeginTransactionCommand): Promise<ControlResult>;
}
export declare class CommitTransactionHandler implements ICommandHandler<CommitTransactionCommand, ControlResult> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ sessionId }: CommitTransactionCommand): Promise<ControlResult>;
}
export declare class RollbackTransactionHandler implements ICommandHandler<RollbackTransactionCommand, ControlResult> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ sessionId }: RollbackTransactionCommand): Promise<ControlResult>;
}
export declare class RestartSessionHandler implements ICommandHandler<RestartSessionCommand, ControlResult> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ sessionId }: RestartSessionCommand): Promise<ControlResult>;
}
export declare class CloseSessionHandler implements ICommandHandler<CloseSessionCommand, SessionInfo> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ sessionId }: CloseSessionCommand): Promise<SessionInfo>;
}
export declare class GetSessionHandler implements IQueryHandler<GetSessionQuery, SessionInfo> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ sessionId }: GetSessionQuery): Promise<SessionInfo>;
}
export declare class ListSessionsHandler implements IQueryHandler<ListSessionsQuery, SessionInfo[]> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute(): Promise<SessionInfo[]>;
}
export declare class GetSchemaHandler implements IQueryHandler<GetSchemaQuery, TypeDBLiteSchemaSnapshot> {
    private readonly registry;
    constructor(registry: SessionRegistry);
    execute({ sessionId }: GetSchemaQuery): Promise<TypeDBLiteSchemaSnapshot>;
}
export declare class ClassifyStatementHandler implements IQueryHandler<ClassifyStatementQuery, {
    kind: StatementKind;
}> {
    execute({ statement }: ClassifyStatementQuery): Promise<{
        kind: StatementKind;
    }>;
}
export declare class SplitStatementsHandler implements IQueryHandler<SplitStatementsQuery, {
    statements: string[];
}> {
    execute({ source }: SplitStatementsQuery): Promise<{
        statements: string[];
    }>;
}
//# sourceMappingURL=handlers.d.ts.map