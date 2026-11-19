import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import {
  BeginTransactionHandler,
  ClassifyStatementHandler,
  CloseSessionHandler,
  CommitTransactionHandler,
  GetSchemaHandler,
  GetSessionHandler,
  ListSessionsHandler,
  OpenSessionHandler,
  RestartSessionHandler,
  RollbackTransactionHandler,
  RunStatementHandler,
  SplitStatementsHandler,
} from './handlers.js';
import { SessionRegistry } from './session.registry.js';

const HANDLERS = [
  OpenSessionHandler,
  RunStatementHandler,
  BeginTransactionHandler,
  CommitTransactionHandler,
  RollbackTransactionHandler,
  RestartSessionHandler,
  CloseSessionHandler,
  GetSessionHandler,
  ListSessionsHandler,
  GetSchemaHandler,
  ClassifyStatementHandler,
  SplitStatementsHandler,
];

/**
 * The host's core: the session aggregate's commands and queries, on the CQRS buses. No transport lives here; a
 * transport sends these through the buses and nothing else (invariant 5).
 */
@Module({ imports: [CqrsModule], providers: [SessionRegistry, ...HANDLERS] })
export class EngineHostModule {}
