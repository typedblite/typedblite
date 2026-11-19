import { locateStatements, Session } from '@typedblite/session';

import type { HostCaller } from '../../src/wire.js';

/**
 * The engine host's operations the debugger calls, served in-process by the same `Session` the host serves them with.
 * The DAP specs over the real host process are in `apps/vscode/test/debug-adapter.test.ts`; this keeps the adapter's
 * own specs fast, and counts the calls so a spec can see what reached the host.
 */
export class InProcessHost implements HostCaller {
  readonly sessions = new Map<string, Session>();
  readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  private counter = 0;

  async call<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ operation, input });
    const session = (): Session => {
      const found = this.sessions.get(String(input['session']));
      if (!found) throw Object.assign(new Error(`No session '${String(input['session'])}'.`), { code: 'SESSION_NOT_FOUND' });
      return found;
    };
    switch (operation) {
      case 'session.open': {
        const id = `s${(this.counter += 1)}`;
        this.sessions.set(id, new Session(String(input['location'] ?? ':memory:')));
        return { id } as T;
      }
      case 'session.run':
        return (await session().run(String(input['statement']))) as T;
      case 'session.debug': {
        const found = session();
        if (found.location !== ':memory:') throw Object.assign(new Error('not in memory'), { code: 'NOT_IN_MEMORY' });
        return (await found.debug(String(input['statement']), input['limits'] as object | undefined)) as T;
      }
      case 'session.close':
        await session().close();
        return { closed: true } as T;
      case 'statement.locate':
        return { statements: locateStatements(String(input['source'])) } as T;
      default:
        throw new Error(`InProcessHost does not serve ${operation}`);
    }
  }

  /** The operations called, in order. */
  operations(): string[] {
    return this.calls.map((call) => call.operation);
  }
}
