/**
 * A failure the host reports as data to a transport, not an engine refusal.
 *
 * 🔴 `code` and `exitCode` are the contract `@devx-micro/app-runtime` reads from a thrown domain error (Phase 02),
 * so a transport branches on them and never on `message`. A statement the ENGINE refuses is not one of these: it
 * comes back as a `refused` result with the engine's own message.
 */
export declare class HostError extends Error {
    readonly code: HostErrorCode;
    readonly exitCode: number;
    constructor(code: HostErrorCode, message: string, exitCode: number);
}
export type HostErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_CLOSED' | 'OPEN_FAILED' | 'SCHEMA_REFUSED';
/** Exit codes follow the app-runtime convention: 2 usage, 3 conflict, 5 not found, 10 infrastructure. */
export declare const sessionNotFound: (id: string) => HostError;
export declare const sessionClosed: (id: string) => HostError;
export declare const openFailed: (location: string, reason: string) => HostError;
export declare const schemaRefused: (message: string) => HostError;
//# sourceMappingURL=errors.d.ts.map