/**
 * A failure the host reports as data to a transport, not an engine refusal.
 *
 * 🔴 `code` and `exitCode` are the contract `@devx-micro/app-runtime` reads from a thrown domain error (Phase 02),
 * so a transport branches on them and never on `message`. A statement the ENGINE refuses is not one of these: it
 * comes back as a `refused` result with the engine's own message.
 */
export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

export type HostErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_CLOSED' | 'OPEN_FAILED' | 'SCHEMA_REFUSED';

/** Exit codes follow the app-runtime convention: 2 usage, 3 conflict, 5 not found, 10 infrastructure. */
export const sessionNotFound = (id: string): HostError => new HostError('SESSION_NOT_FOUND', `No session '${id}'.`, 5);
export const sessionClosed = (id: string): HostError => new HostError('SESSION_CLOSED', `Session '${id}' is closed.`, 3);
export const openFailed = (location: string, reason: string): HostError =>
  new HostError('OPEN_FAILED', `Could not open '${location}': ${reason}`, 10);
export const schemaRefused = (message: string): HostError =>
  new HostError('SCHEMA_REFUSED', `The schema was refused: ${message}`, 2);
