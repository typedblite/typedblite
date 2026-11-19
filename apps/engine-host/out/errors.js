/**
 * A failure the host reports as data to a transport, not an engine refusal.
 *
 * 🔴 `code` and `exitCode` are the contract `@devx-micro/app-runtime` reads from a thrown domain error (Phase 02),
 * so a transport branches on them and never on `message`. A statement the ENGINE refuses is not one of these: it
 * comes back as a `refused` result with the engine's own message.
 */
export class HostError extends Error {
    code;
    exitCode;
    constructor(code, message, exitCode) {
        super(message);
        this.code = code;
        this.exitCode = exitCode;
        this.name = 'HostError';
    }
}
/** Exit codes follow the app-runtime convention: 2 usage, 3 conflict, 5 not found, 10 infrastructure. */
export const sessionNotFound = (id) => new HostError('SESSION_NOT_FOUND', `No session '${id}'.`, 5);
export const sessionClosed = (id) => new HostError('SESSION_CLOSED', `Session '${id}' is closed.`, 3);
export const openFailed = (location, reason) => new HostError('OPEN_FAILED', `Could not open '${location}': ${reason}`, 10);
export const schemaRefused = (message) => new HostError('SCHEMA_REFUSED', `The schema was refused: ${message}`, 2);
//# sourceMappingURL=errors.js.map