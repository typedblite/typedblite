import { type OnApplicationShutdown } from '@nestjs/common';
import { Session, type SessionMode } from '@typedblite/session';
/** What a caller is told about a session. */
export interface SessionInfo {
    readonly id: string;
    readonly location: string;
    /** `manual` while a transaction is open, so there may be uncommitted changes. */
    readonly mode: SessionMode;
    readonly hasSchema: boolean;
    readonly closed: boolean;
}
/**
 * The host's sessions, by id. A session lives in this process's memory (ADR-011): when the host exits, they go.
 *
 * 🔴 Each session opens its own store, so two never share a handle (invariant 4). A closed session stays listed,
 * so a run on it is refused as `closed` rather than reported as an unknown id.
 */
export declare class SessionRegistry implements OnApplicationShutdown {
    private readonly sessions;
    private counter;
    open(location: string): SessionInfo;
    get(id: string): Session;
    info(id: string): SessionInfo;
    list(): SessionInfo[];
    /** Releases every file the host holds. */
    onApplicationShutdown(): Promise<void>;
}
//# sourceMappingURL=session.registry.d.ts.map