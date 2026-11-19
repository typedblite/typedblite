import { hasCode, type HostCaller, type RunResult } from './host-types.js';

/**
 * One engine-host session per open notebook: its kernel (ADR-012 N3). Opened when the notebook first runs a cell, in
 * memory (N5), and closed when the notebook is.
 *
 * A session lives in the host's process. If the host died, the id is gone: the next statement opens a new, empty one
 * and says so, rather than failing every cell until the user finds the restart button.
 */
export class NotebookSessions {
  private readonly sessions = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly host: HostCaller) {}

  /** The runner for one notebook, for `runCell`. */
  runnerFor(key: string): { run(statement: string): Promise<{ result: RunResult; reopened: boolean }> } {
    return { run: (statement) => this.serial(key, () => this.runOnce(key, statement)) };
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  /** Close the store and open it again: an in-memory store comes back empty. Nothing to do before a first run. */
  async restart(key: string): Promise<'restarted' | 'none'> {
    return this.serial(key, async () => {
      const id = this.sessions.get(key);
      if (id === undefined) return 'none';
      try {
        await this.host.call('session.restart', { session: id });
      } catch (error) {
        if (!hasCode(error, 'SESSION_NOT_FOUND')) throw error;
        this.sessions.delete(key);
        await this.open(key);
      }
      return 'restarted';
    });
  }

  async close(key: string): Promise<void> {
    await this.serial(key, async () => {
      const id = this.sessions.get(key);
      this.sessions.delete(key);
      if (id === undefined) return;
      await this.host.call('session.close', { session: id }).catch(() => undefined);
    });
    this.queues.delete(key);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.close(key)));
  }

  private async runOnce(key: string, statement: string): Promise<{ result: RunResult; reopened: boolean }> {
    const id = await this.ensure(key);
    try {
      return { result: await this.host.call<RunResult>('session.run', { session: id, statement }), reopened: false };
    } catch (error) {
      if (!hasCode(error, 'SESSION_NOT_FOUND')) throw error;
      this.sessions.delete(key);
      const fresh = await this.ensure(key);
      return { result: await this.host.call<RunResult>('session.run', { session: fresh, statement }), reopened: true };
    }
  }

  private async ensure(key: string): Promise<string> {
    return this.sessions.get(key) ?? this.open(key);
  }

  private async open(key: string): Promise<string> {
    const opened = await this.host.call<{ id: string }>('session.open', { location: ':memory:' });
    this.sessions.set(key, opened.id);
    return opened.id;
  }

  /** One thing at a time per notebook: the host answers one request at a time, and cells must run in order. */
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }
}
