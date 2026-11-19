import { Inject } from '@nestjs/common';
import { CommandHandler, QueryHandler, type ICommandHandler, type IQueryHandler } from '@nestjs/cqrs';
import {
  classifyStatement,
  splitStatements,
  SessionClosedError,
  type ControlResult,
  type RunResult,
  type StatementKind,
} from '@typedblite/session';
import type { TypeDBLiteSchemaSnapshot } from '@typedblite/runtime';

import {
  BeginTransactionCommand,
  CloseSessionCommand,
  CommitTransactionCommand,
  OpenSessionCommand,
  RestartSessionCommand,
  RollbackTransactionCommand,
  RunStatementCommand,
} from './commands.js';
import { schemaRefused, sessionClosed } from './errors.js';
import {
  ClassifyStatementQuery,
  GetSchemaQuery,
  GetSessionQuery,
  ListSessionsQuery,
  SplitStatementsQuery,
} from './queries.js';
import { SessionRegistry, type SessionInfo } from './session.registry.js';

@CommandHandler(OpenSessionCommand)
export class OpenSessionHandler implements ICommandHandler<OpenSessionCommand, SessionInfo> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}

  async execute({ location, schema }: OpenSessionCommand): Promise<SessionInfo> {
    const info = this.registry.open(location);
    if (schema === undefined) return info;
    const result = await this.registry.get(info.id).run(schema);
    if (result.kind === 'refused') {
      await this.registry.get(info.id).close();
      throw schemaRefused(result.message);
    }
    return this.registry.info(info.id);
  }
}

@CommandHandler(RunStatementCommand)
export class RunStatementHandler implements ICommandHandler<RunStatementCommand, RunResult> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}

  /**
   * A refusal, the engine's own included, is the answer and not an exception. An unknown id is an exception.
   * 🔴 Every handler is `async`, so an exception is always a rejection and never a synchronous throw.
   */
  async execute({ sessionId, statement, location }: RunStatementCommand): Promise<RunResult> {
    if (sessionId !== undefined) return this.registry.get(sessionId).run(statement);
    const session = this.registry.once(location ?? ':memory:');
    try {
      return await session.run(statement);
    } finally {
      await session.close();
    }
  }
}

@CommandHandler(BeginTransactionCommand)
export class BeginTransactionHandler implements ICommandHandler<BeginTransactionCommand, ControlResult> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute({ sessionId }: BeginTransactionCommand): Promise<ControlResult> {
    return this.registry.get(sessionId).begin();
  }
}

@CommandHandler(CommitTransactionCommand)
export class CommitTransactionHandler implements ICommandHandler<CommitTransactionCommand, ControlResult> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute({ sessionId }: CommitTransactionCommand): Promise<ControlResult> {
    return this.registry.get(sessionId).commit();
  }
}

@CommandHandler(RollbackTransactionCommand)
export class RollbackTransactionHandler implements ICommandHandler<RollbackTransactionCommand, ControlResult> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute({ sessionId }: RollbackTransactionCommand): Promise<ControlResult> {
    return this.registry.get(sessionId).rollback();
  }
}

@CommandHandler(RestartSessionCommand)
export class RestartSessionHandler implements ICommandHandler<RestartSessionCommand, ControlResult> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute({ sessionId }: RestartSessionCommand): Promise<ControlResult> {
    return this.registry.get(sessionId).restart();
  }
}

@CommandHandler(CloseSessionCommand)
export class CloseSessionHandler implements ICommandHandler<CloseSessionCommand, SessionInfo> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute({ sessionId }: CloseSessionCommand): Promise<SessionInfo> {
    await this.registry.get(sessionId).close();
    return this.registry.info(sessionId);
  }
}

@QueryHandler(GetSessionQuery)
export class GetSessionHandler implements IQueryHandler<GetSessionQuery, SessionInfo> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute({ sessionId }: GetSessionQuery): Promise<SessionInfo> {
    return this.registry.info(sessionId);
  }
}

@QueryHandler(ListSessionsQuery)
export class ListSessionsHandler implements IQueryHandler<ListSessionsQuery, SessionInfo[]> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute(): Promise<SessionInfo[]> {
    return this.registry.list();
  }
}

@QueryHandler(GetSchemaQuery)
export class GetSchemaHandler implements IQueryHandler<GetSchemaQuery, TypeDBLiteSchemaSnapshot> {
  constructor(@Inject(SessionRegistry) private readonly registry: SessionRegistry) {}
  async execute({ sessionId }: GetSchemaQuery): Promise<TypeDBLiteSchemaSnapshot> {
    try {
      return this.registry.get(sessionId).schema();
    } catch (error) {
      if (error instanceof SessionClosedError) throw sessionClosed(sessionId);
      throw error;
    }
  }
}

@QueryHandler(ClassifyStatementQuery)
export class ClassifyStatementHandler implements IQueryHandler<ClassifyStatementQuery, { kind: StatementKind }> {
  async execute({ statement }: ClassifyStatementQuery): Promise<{ kind: StatementKind }> {
    return { kind: classifyStatement(statement) };
  }
}

@QueryHandler(SplitStatementsQuery)
export class SplitStatementsHandler implements IQueryHandler<SplitStatementsQuery, { statements: string[] }> {
  async execute({ source }: SplitStatementsQuery): Promise<{ statements: string[] }> {
    return { statements: splitStatements(source) };
  }
}
