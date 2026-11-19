var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable } from '@nestjs/common';
import { Session } from '@typedblite/session';
import { openFailed, sessionNotFound } from './errors.js';
/**
 * The host's sessions, by id. A session lives in this process's memory (ADR-011): when the host exits, they go.
 *
 * 🔴 Each session opens its own store, so two never share a handle (invariant 4). A closed session stays listed,
 * so a run on it is refused as `closed` rather than reported as an unknown id.
 */
let SessionRegistry = class SessionRegistry {
    sessions = new Map();
    counter = 0;
    open(location) {
        let session;
        try {
            session = new Session(location);
        }
        catch (error) {
            throw openFailed(location, error instanceof Error ? error.message : String(error));
        }
        const id = `s${(this.counter += 1)}`;
        this.sessions.set(id, session);
        return infoOf(id, session);
    }
    get(id) {
        const session = this.sessions.get(id);
        if (!session)
            throw sessionNotFound(id);
        return session;
    }
    info(id) {
        return infoOf(id, this.get(id));
    }
    list() {
        return [...this.sessions].map(([id, session]) => infoOf(id, session));
    }
    /** Releases every file the host holds. */
    async onApplicationShutdown() {
        for (const session of this.sessions.values())
            await session.close();
    }
};
SessionRegistry = __decorate([
    Injectable()
], SessionRegistry);
export { SessionRegistry };
function infoOf(id, session) {
    return { id, location: session.location, mode: session.mode, hasSchema: session.hasSchema, closed: session.closed };
}
//# sourceMappingURL=session.registry.js.map