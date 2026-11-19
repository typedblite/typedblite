import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Session, type SessionMode } from '@typedblite/session';

import { openFailed, sessionNotFound } from './errors.js';

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
@Injectable()
export class SessionRegistry implements OnApplicationShutdown {
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  open(location: string): SessionInfo {
    let session: Session;
    try {
      session = new Session(location);
    } catch (error) {
      throw openFailed(location, error instanceof Error ? error.message : String(error));
    }
    const id = `s${(this.counter += 1)}`;
    this.sessions.set(id, session);
    return infoOf(id, session);
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw sessionNotFound(id);
    return session;
  }

  info(id: string): SessionInfo {
    return infoOf(id, this.get(id));
  }

  list(): SessionInfo[] {
    return [...this.sessions].map(([id, session]) => infoOf(id, session));
  }

  /** Releases every file the host holds. */
  async onApplicationShutdown(): Promise<void> {
    for (const session of this.sessions.values()) await session.close();
  }
}

function infoOf(id: string, session: Session): SessionInfo {
  return { id, location: session.location, mode: session.mode, hasSchema: session.hasSchema, closed: session.closed };
}
