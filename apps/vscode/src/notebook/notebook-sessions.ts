import { hasCode, type HostCaller, type RunResult } from './host-types.js';

/**
 * When a write to a file store becomes permanent (ADR-012 N5). `auto`: each statement commits as it succeeds. `manual`: a
 * transaction is held open, and nothing is permanent until the user commits it.
 */
export type StoreMode = 'auto' | 'manual';

/** The file a notebook was told to run against, and the mode its writes commit in. A notebook with none is in memory. */
export interface StoreChoice {
  readonly location: string;
  readonly mode: StoreMode;
}

/** What `commit` and `rollback` did. A refused commit is the engine's: its checks failed, and the changes were rolled back. */
export type EndOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'not-manual' };

/** What the host answers to `session.begin`, `commit` and `rollback`. */
interface ControlResult {
  readonly kind: 'ok' | 'refused';
  readonly message?: string;
}

/** The store as the notebook's status says it: where it is, and when a write is permanent. */
export const describeStore = (choice: StoreChoice | undefined): string =>
  choice === undefined
    ? 'In-memory store'
    : `${choice.location.split(/[\\/]/).pop()} · ${choice.mode === 'auto' ? 'commits each statement' : 'holds changes until you commit'}`;

/**
 * One engine-host session per open notebook: its kernel (ADR-012 N3). Opened when the notebook first runs a cell, in
 * memory (N5), and closed when the notebook is.
 *
 * A session lives in the host's process. If the host died, the id is gone: the next statement opens a new, empty one
 * and says so, rather than failing every cell until the user finds the restart button.
 */
export class NotebookSessions {
  private readonly sessions = new Map<string, string>();
  private readonly stores = new Map<string, StoreChoice>();
  private readonly listeners = new Set<(key: string) => void>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly host: HostCaller) {}

  /** The runner for one notebook, for `runCell`. */
  runnerFor(key: string): { run(statement: string): Promise<{ result: RunResult; reopened: boolean }> } {
    return { run: (statement) => this.serial(key, () => this.runOnce(key, statement)) };
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  /** The file store this notebook was told to use, or nothing for the in-memory one it starts with. */
  storeOf(key: string): StoreChoice | undefined {
    return this.stores.get(key);
  }

  /** Called with a notebook's key whenever its store choice changes. Dispose it to stop the calls. */
  onDidChangeStore(listener: (key: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /**
   * Run this notebook against a file store, or, with no choice, back against a fresh in-memory one. The session it had is
   * ended first (what it held in memory, or in a transaction not yet committed, is gone), and the new one is opened now,
   * so a file that will not open is reported here and not at the next cell. If it will not open, the notebook keeps the
   * store it had.
   *
   * 🔴 This is the only way a notebook gets a store other than memory, and it is only ever called with a choice the user
   * made (feature invariant 3). It is never written into the notebook, and never remembered.
   */
  async useStore(key: string, choice: StoreChoice | undefined): Promise<void> {
    await this.serial(key, async () => {
      const previous = this.sessions.get(key);
      const had = this.stores.get(key);
      // The same file again: the session it has may hold its write lock, so it is ended first. Anything else is opened
      // before the old session is touched, so a path that will not open costs the notebook nothing.
      const sameFile = choice !== undefined && had?.location === choice.location;
      if (sameFile && previous !== undefined) {
        await this.host.call('session.close', { session: previous }).catch(() => undefined);
        this.sessions.delete(key);
      }
      const fresh = choice === undefined ? undefined : await this.openSession(choice);
      if (!sameFile && previous !== undefined) await this.host.call('session.close', { session: previous }).catch(() => undefined);
      this.sessions.delete(key);
      if (fresh === undefined) this.stores.delete(key);
      else this.sessions.set(key, fresh);
      if (choice !== undefined) this.stores.set(key, choice);
    });
    this.changed(key);
  }

  /** Make a manual store's changes permanent, and hold a new transaction for the next ones. */
  commit(key: string): Promise<EndOutcome> {
    return this.end(key, 'session.commit');
  }

  /** Discard a manual store's changes, and hold a new transaction for the next ones. */
  rollback(key: string): Promise<EndOutcome> {
    return this.end(key, 'session.rollback');
  }

  /** Close the store and open it again: an in-memory store comes back empty. Nothing to do before a first run. */
  async restart(key: string): Promise<'restarted' | 'none'> {
    return this.serial(key, async () => {
      const id = this.sessions.get(key);
      if (id === undefined) return 'none';
      try {
        const done = await this.host.call<ControlResult>('session.restart', { session: id });
        if (done.kind === 'refused') throw new Error(done.message ?? 'The store could not be restarted.');
        // A restart reopens in auto mode: a notebook that holds its changes holds them again.
        if (this.stores.get(key)?.mode === 'manual') await this.host.call('session.begin', { session: id });
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
    const id = await this.openSession(this.stores.get(key));
    this.sessions.set(key, id);
    return id;
  }

  /** A session on a store, in the mode asked for: a manual store has its transaction open before anything runs. */
  private async openSession(store: StoreChoice | undefined): Promise<string> {
    const opened = await this.host.call<{ id: string }>('session.open', { location: store?.location ?? ':memory:' });
    if (store?.mode === 'manual') {
      try {
        await this.host.call('session.begin', { session: opened.id });
      } catch (error) {
        await this.host.call('session.close', { session: opened.id }).catch(() => undefined);
        throw error;
      }
    }
    return opened.id;
  }

  private end(key: string, operation: 'session.commit' | 'session.rollback'): Promise<EndOutcome> {
    return this.serial(key, async () => {
      const id = this.sessions.get(key);
      if (id === undefined) return { kind: 'none' };
      if (this.stores.get(key)?.mode !== 'manual') return { kind: 'not-manual' };
      const done = await this.host.call<ControlResult>(operation, { session: id });
      // Either way the transaction is over (a refused commit is rolled back), so the next changes get a new one.
      await this.host.call('session.begin', { session: id });
      return done.kind === 'ok' ? { kind: 'done' } : { kind: 'refused', message: done.message ?? 'The commit was refused.' };
    });
  }

  private changed(key: string): void {
    for (const listener of this.listeners) listener(key);
  }

  /** One thing at a time per notebook: the host answers one request at a time, and cells must run in order. */
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }
}
