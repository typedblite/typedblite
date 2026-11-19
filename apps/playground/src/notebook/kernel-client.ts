import type { HostCaller } from '@typedblite/notebook';

import type { KernelReply, KernelRequest } from './kernel-protocol.js';

/** The part of a `Worker` this uses, so a test can stand a fake in its place. */
export interface KernelWorkerLike {
  postMessage(message: KernelRequest): void;
  terminate(): void;
  onmessage: ((event: { readonly data: KernelReply }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** What a call that failed carries: the kernel's own `code` (an unknown session), or `TIMEOUT` and `STOPPED` from here. */
export class KernelCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KernelCallError';
  }
}

/**
 * The page's side of the kernel: calls the worker one at a time and ends a call that does not finish.
 *
 * 🔴 A worker cannot be interrupted from inside: the engine is synchronous, so a statement that never returns never
 * reads the next message. The only way to stop it is to terminate the worker, so a call that passes `timeoutMs` does
 * exactly that. The notebook's store lived in that worker, so it is gone: the next call finds no such session, and the
 * notebook opens a new, empty one and says so (`NotebookSessions`), as it does when the engine host is restarted.
 */
export class WorkerKernel implements HostCaller {
  private worker: KernelWorkerLike | undefined;
  private pending: { readonly id: number; readonly operation: string; readonly settle: (reply: KernelReply) => void; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  private nextId = 1;

  constructor(
    private readonly create: () => KernelWorkerLike,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  get running(): boolean {
    return this.pending !== undefined;
  }

  async call<T = unknown>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    if (this.pending) throw new KernelCallError('BUSY', 'The notebook is already running something.');
    const worker = (this.worker ??= this.start());
    const id = this.nextId++;
    const reply = await new Promise<KernelReply>((settle) => {
      const timer = setTimeout(
        () => this.end(id, { id, ok: false, code: 'TIMEOUT', message: `Stopped: the statement took longer than ${this.timeoutMs / 1000} s. The notebook's store was reset.` }, true),
        this.timeoutMs,
      );
      this.pending = { id, operation, settle, timer };
      worker.postMessage({ id, operation, input });
    });
    if (!reply.ok) throw new KernelCallError(reply.code, reply.message);
    return reply.data as T;
  }

  /** Ends what is running, if anything, as the reader's stop. The store goes with the worker. */
  stop(): void {
    if (this.pending) this.end(this.pending.id, { id: this.pending.id, ok: false, code: 'STOPPED', message: "Stopped. The notebook's store was reset." }, true);
  }

  private start(): KernelWorkerLike {
    const worker = this.create();
    worker.onmessage = ({ data }) => this.end(data.id, data, false);
    worker.onerror = ({ message }) => this.end(this.pending?.id ?? -1, { id: this.pending?.id ?? -1, ok: false, code: 'FAILED', message: message ?? 'The engine failed.' }, true);
    return worker;
  }

  private end(id: number, reply: KernelReply, discardWorker: boolean): void {
    // A late answer to a call already ended (stopped, or timed out) is ignored.
    if (this.pending?.id !== id) return;
    clearTimeout(this.pending.timer);
    const { settle } = this.pending;
    this.pending = undefined;
    if (discardWorker) {
      this.worker?.terminate();
      this.worker = undefined;
    }
    settle(reply);
  }
}
