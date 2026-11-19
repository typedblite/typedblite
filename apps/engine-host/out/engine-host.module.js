var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { BeginTransactionHandler, ClassifyStatementHandler, CloseSessionHandler, CommitTransactionHandler, GetSchemaHandler, GetSessionHandler, ListSessionsHandler, OpenSessionHandler, RestartSessionHandler, RollbackTransactionHandler, RunStatementHandler, SplitStatementsHandler, } from './handlers.js';
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
let EngineHostModule = class EngineHostModule {
};
EngineHostModule = __decorate([
    Module({ imports: [CqrsModule], providers: [SessionRegistry, ...HANDLERS] })
], EngineHostModule);
export { EngineHostModule };
//# sourceMappingURL=engine-host.module.js.map