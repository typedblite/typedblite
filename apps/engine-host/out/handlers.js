var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { CommandHandler, QueryHandler } from '@nestjs/cqrs';
import { classifyStatement, splitStatements, SessionClosedError, } from '@typedblite/session';
import { BeginTransactionCommand, CloseSessionCommand, CommitTransactionCommand, OpenSessionCommand, RestartSessionCommand, RollbackTransactionCommand, RunStatementCommand, } from './commands.js';
import { schemaRefused, sessionClosed } from './errors.js';
import { ClassifyStatementQuery, GetSchemaQuery, GetSessionQuery, ListSessionsQuery, SplitStatementsQuery, } from './queries.js';
import { SessionRegistry } from './session.registry.js';
let OpenSessionHandler = class OpenSessionHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ location, schema }) {
        const info = this.registry.open(location);
        if (schema === undefined)
            return info;
        const result = await this.registry.get(info.id).run(schema);
        if (result.kind === 'refused') {
            await this.registry.get(info.id).close();
            throw schemaRefused(result.message);
        }
        return this.registry.info(info.id);
    }
};
OpenSessionHandler = __decorate([
    CommandHandler(OpenSessionCommand),
    __metadata("design:paramtypes", [SessionRegistry])
], OpenSessionHandler);
export { OpenSessionHandler };
let RunStatementHandler = class RunStatementHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    /**
     * A refusal, the engine's own included, is the answer and not an exception. An unknown id is an exception.
     * 🔴 Every handler is `async`, so an exception is always a rejection and never a synchronous throw.
     */
    async execute({ sessionId, statement }) {
        return this.registry.get(sessionId).run(statement);
    }
};
RunStatementHandler = __decorate([
    CommandHandler(RunStatementCommand),
    __metadata("design:paramtypes", [SessionRegistry])
], RunStatementHandler);
export { RunStatementHandler };
let BeginTransactionHandler = class BeginTransactionHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ sessionId }) {
        return this.registry.get(sessionId).begin();
    }
};
BeginTransactionHandler = __decorate([
    CommandHandler(BeginTransactionCommand),
    __metadata("design:paramtypes", [SessionRegistry])
], BeginTransactionHandler);
export { BeginTransactionHandler };
let CommitTransactionHandler = class CommitTransactionHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ sessionId }) {
        return this.registry.get(sessionId).commit();
    }
};
CommitTransactionHandler = __decorate([
    CommandHandler(CommitTransactionCommand),
    __metadata("design:paramtypes", [SessionRegistry])
], CommitTransactionHandler);
export { CommitTransactionHandler };
let RollbackTransactionHandler = class RollbackTransactionHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ sessionId }) {
        return this.registry.get(sessionId).rollback();
    }
};
RollbackTransactionHandler = __decorate([
    CommandHandler(RollbackTransactionCommand),
    __metadata("design:paramtypes", [SessionRegistry])
], RollbackTransactionHandler);
export { RollbackTransactionHandler };
let RestartSessionHandler = class RestartSessionHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ sessionId }) {
        return this.registry.get(sessionId).restart();
    }
};
RestartSessionHandler = __decorate([
    CommandHandler(RestartSessionCommand),
    __metadata("design:paramtypes", [SessionRegistry])
], RestartSessionHandler);
export { RestartSessionHandler };
let CloseSessionHandler = class CloseSessionHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ sessionId }) {
        await this.registry.get(sessionId).close();
        return this.registry.info(sessionId);
    }
};
CloseSessionHandler = __decorate([
    CommandHandler(CloseSessionCommand),
    __metadata("design:paramtypes", [SessionRegistry])
], CloseSessionHandler);
export { CloseSessionHandler };
let GetSessionHandler = class GetSessionHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ sessionId }) {
        return this.registry.info(sessionId);
    }
};
GetSessionHandler = __decorate([
    QueryHandler(GetSessionQuery),
    __metadata("design:paramtypes", [SessionRegistry])
], GetSessionHandler);
export { GetSessionHandler };
let ListSessionsHandler = class ListSessionsHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute() {
        return this.registry.list();
    }
};
ListSessionsHandler = __decorate([
    QueryHandler(ListSessionsQuery),
    __metadata("design:paramtypes", [SessionRegistry])
], ListSessionsHandler);
export { ListSessionsHandler };
let GetSchemaHandler = class GetSchemaHandler {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    async execute({ sessionId }) {
        try {
            return this.registry.get(sessionId).schema();
        }
        catch (error) {
            if (error instanceof SessionClosedError)
                throw sessionClosed(sessionId);
            throw error;
        }
    }
};
GetSchemaHandler = __decorate([
    QueryHandler(GetSchemaQuery),
    __metadata("design:paramtypes", [SessionRegistry])
], GetSchemaHandler);
export { GetSchemaHandler };
let ClassifyStatementHandler = class ClassifyStatementHandler {
    async execute({ statement }) {
        return { kind: classifyStatement(statement) };
    }
};
ClassifyStatementHandler = __decorate([
    QueryHandler(ClassifyStatementQuery)
], ClassifyStatementHandler);
export { ClassifyStatementHandler };
let SplitStatementsHandler = class SplitStatementsHandler {
    async execute({ source }) {
        return { statements: splitStatements(source) };
    }
};
SplitStatementsHandler = __decorate([
    QueryHandler(SplitStatementsQuery)
], SplitStatementsHandler);
export { SplitStatementsHandler };
//# sourceMappingURL=handlers.js.map