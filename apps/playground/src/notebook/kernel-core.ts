import { Session, splitStatements, type SessionOptions } from '@typedblite/session';

/**
 * The browser notebook's kernel: the engine host's operations that a notebook uses, over the real `Session`.
 *
 * 🔴 A cell is run by the same session code as the CLI and the engine host (`@typedblite/session`): the same classifier,
 * the same transactions, the same refusals as data. What is different is only the store (WASM SQLite, in memory) and the
 * transport (a worker), so a cell answers here as it does in VS Code. It answers the operations by the host's own names
 * and shapes, so `@typedblite/notebook`'s runner and sessions, which the extension uses too, run on it unchanged.
 *
 * Pure of any worker, so the logic is tested on `node:sqlite`; `kernel-worker.ts` puts it on WASM.
 */
export class KernelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KernelError';
  }
}

export interface Kernel {
  call(operation: string, input?: Record<string, unknown>): Promise<unknown>;
}

const info = (id: string, session: Session) => ({ id, location: session.location, mode: session.mode, hasSchema: session.hasSchema, closed: session.closed });

export function createKernel(options: SessionOptions = {}): Kernel {
  const sessions = new Map<string, Session>();
  let counter = 0;

  const get = (input: Record<string, unknown>): Session => {
    const id = input['session'];
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) throw new KernelError('SESSION_NOT_FOUND', `No session '${String(id)}'.`);
    return session;
  };

  return {
    async call(operation, input = {}) {
      switch (operation) {
        case 'statement.split':
          return { statements: splitStatements(String(input['source'] ?? '')) };
        case 'session.open': {
          const location = input['location'] ?? ':memory:';
          // A browser has no files to open: a notebook here lives in memory, and says so rather than pretend.
          if (location !== ':memory:') throw new KernelError('OPEN_FAILED', 'This notebook runs in your browser, in memory. It cannot open a file.');
          const id = `s${(counter += 1)}`;
          const session = new Session(':memory:', options);
          sessions.set(id, session);
          return info(id, session);
        }
        case 'session.run':
          return get(input).run(String(input['statement'] ?? ''));
        case 'session.restart':
          return get(input).restart();
        case 'session.close': {
          const session = get(input);
          await session.close();
          return info(String(input['session']), session);
        }
        default:
          throw new KernelError('UNKNOWN_OPERATION', `The browser notebook has no operation '${operation}'.`);
      }
    },
  };
}
